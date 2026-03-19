import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import type { AtheismConfig, AtheismMessage, OnlineAgent, EvalLock, AgentProfile } from "./types.js";
import { resolveAgentProfiles } from "./types.js";
import { fetchAtheismMessages, claimEvalLock, releaseEvalLock, cleanupZombieStreaming, getRecentAgentJobIds, postResumeMessage } from "./send.js";
import { handleAtheismMessage, getActiveJobForAgent, getAllActiveJobs, abortActiveJob, setMaxConcurrent, isMessageProcessed, markMessageProcessed, isAgentMentioned } from "./bot.js";
import { readFileSync, writeFileSync } from "fs";

// ─── @human 暂停状态持久化（跨 Gateway 重启） ───────────────

const PAUSED_SESSIONS_FILE = '/tmp/atheism-paused-sessions.json';

function loadPausedSessions(): Map<string, { pausedAt: number; pausedBy: string }> {
  try {
    const data = JSON.parse(readFileSync(PAUSED_SESSIONS_FILE, 'utf-8'));
    return new Map(Object.entries(data));
  } catch {
    return new Map();
  }
}

function savePausedSessions(map: Map<string, { pausedAt: number; pausedBy: string }>): void {
  try {
    writeFileSync(PAUSED_SESSIONS_FILE, JSON.stringify(Object.fromEntries(map)));
  } catch (err) { console.error("atheism: [WARN] failed to save paused sessions:", err); }
}

// ─── @mention 解析（复用 bot.ts 的 isAgentMentioned） ───

/**
 * 解析消息文本中的 @mentions。
 * 返回被 @ 的 agent_id 列表和是否 @human。
 */
export function parseMentions(text: string, onlineAgents: OnlineAgent[]): {
  mentionedAgentIds: string[];
  mentionsHuman: boolean;
} {
  if (!text) return { mentionedAgentIds: [], mentionsHuman: false };

  const mentionsHuman = /@human\b/i.test(text);
  const mentionedAgentIds: string[] = [];

  for (const agent of onlineAgents) {
    if (agent.agent_id === 'human') continue;
    if (isAgentMentioned(text, agent.agent_id, agent.name)) {
      mentionedAgentIds.push(agent.agent_id);
    }
  }

  return { mentionedAgentIds, mentionsHuman };
}

// 完成信号去重：per-agent 防止同一条完成消息反复触发
const processedCompletions = new Set<string>();
setInterval(() => {
  if (processedCompletions.size > 500) {
    const arr = [...processedCompletions];
    for (const id of arr.slice(0, arr.length - 200)) processedCompletions.delete(id);
  }
}, 60000);

// 🆕 Completion signal cooldown: per-agent-per-session 防止级联触发
// 当 Agent X 已经在 session S 中评估过（包括 NO_REPLY），短时间内不再被 completion signal 触发
// 这将 O(N²) 级联降为 O(N)：每个 agent 每轮只评估一次
const COMPLETION_COOLDOWN_MS = 30_000; // 30s cooldown
const lastCompletionEval = new Map<string, number>(); // key: `${agentId}:${sessionId}` → timestamp
setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of lastCompletionEval) {
    if (now - ts > COMPLETION_COOLDOWN_MS * 2) lastCompletionEval.delete(key);
  }
}, 60000);

export type MonitorAtheismOpts = {
  config: ClawdbotConfig;
  abortSignal?: AbortSignal;
};

/** 解析 spaceId 配置为数组 */
function resolveSpaceIds(config: AtheismConfig): string[] {
  const raw = config.spaceId;
  if (!raw) return ["default"];
  if (Array.isArray(raw)) return raw;
  if (raw === "*") return [];
  return [raw];
}

/** 获取所有 space（当 spaceId="*" 时） */
async function fetchAllSpaceIds(apiUrl: string): Promise<string[]> {
  try {
    const res = await fetch(`${apiUrl.replace(/\/api$/, "")}/api/spaces`);
    if (!res.ok) return [];
    const { spaces } = await res.json();
    return spaces.map((s: any) => s.space_id);
  } catch {
    return [];
  }
}

export async function monitorAtheism(opts: MonitorAtheismOpts): Promise<void> {
  const { config: cfg, abortSignal } = opts;
  const log = console.log;
  const error = console.error;

  const atheismConfig = cfg.channels?.atheism as AtheismConfig | undefined;

  if (!atheismConfig?.enabled) {
    log("atheism: channel not enabled, skipping monitor");
    return;
  }
  if (!atheismConfig.apiUrl) {
    error("atheism: apiUrl not configured");
    return;
  }

  // 🆕 解析 Agent 集群
  const agentProfiles = resolveAgentProfiles(atheismConfig);
  if (agentProfiles.length === 0) {
    error("atheism: no agents configured (need agentId or agents[])");
    return;
  }

  const pollIntervalMs = atheismConfig.pollIntervalMs ?? 1000;
  const maxConcurrent = Math.max(1, Math.min(10, atheismConfig.maxConcurrent ?? 3));
  setMaxConcurrent(maxConcurrent);

  // ═══ Per-Space Exponential Backoff & Circuit Breaker ═══
  // 每个 space 独立退避：space A 挂了不影响 space B 的正常轮询
  const MAX_BACKOFF_MS = 60000; // 最大退避 60s
  const CIRCUIT_BREAKER_THRESHOLD = 10; // 连续 10 次失败触发熔断
  const CIRCUIT_BREAKER_RESET_MS = 60000; // 熔断后 60s 探活
  type SpaceHealth = {
    consecutiveFailures: number;
    currentBackoffMs: number;
    circuitOpen: boolean;
    circuitOpenedAt: number;
    lastPollAt: number;
  };
  const spaceHealth = new Map<string, SpaceHealth>();
  const getSpaceHealth = (spaceId: string): SpaceHealth => {
    if (!spaceHealth.has(spaceId)) {
      spaceHealth.set(spaceId, {
        consecutiveFailures: 0,
        currentBackoffMs: pollIntervalMs,
        circuitOpen: false,
        circuitOpenedAt: 0,
        lastPollAt: 0,
      });
    }
    return spaceHealth.get(spaceId)!;
  };

  // 解析要监听的 spaces
  let spaceIds = resolveSpaceIds(atheismConfig);
  if (spaceIds.length === 0) {
    spaceIds = await fetchAllSpaceIds(atheismConfig.apiUrl);
    if (spaceIds.length === 0) {
      error("atheism: no spaces found");
      return;
    }
    log(`atheism: discovered ${spaceIds.length} spaces: ${spaceIds.join(", ")}`);
  }

  const agentNames = agentProfiles.map(a => a.agentName || a.agentId).join(", ");
  log(`atheism: starting monitor (spaces: [${spaceIds.join(", ")}], agents: [${agentNames}] (${agentProfiles.length}), interval: ${pollIntervalMs}ms, maxConcurrent: ${maxConcurrent})`);

  // 每个 agent × space 独立的 lastTimestamp
  // key: `${agentId}:${spaceId}`
  // 初始化 since 为 5 分钟前，避免重启后丢失未处理的消息
  const initSince = Date.now() - 5 * 60 * 1000;
  const lastTimestamps = new Map<string, number>();
  // 🆕 @human 暂停状态持久化（跨 poll 轮次 + 跨 Gateway 重启）
  // key: sessionId → { pausedAt, pausedBy }
  const pausedSessions = loadPausedSessions();
  if (pausedSessions.size > 0) {
    log(`atheism: [STARTUP] restored ${pausedSessions.size} paused session(s) from disk`);
  }

  // 🆕 首轮 poll 标记：重启后第一次 poll 只处理 human 消息，跳过 completion signal
  // 防止老 session 的 completion 在重启后产生风暴
  const firstPollDone = new Set<string>(); // key: `${agentId}:${spaceId}`
  for (const agent of agentProfiles) {
    for (const sid of spaceIds) {
      lastTimestamps.set(`${agent.agentId}:${sid}`, initSince);
    }
  }

  // 🆕 Space membership 缓存：agent 在哪些 space 是成员
  // key: agentId → Set<spaceId>
  const membershipCache = new Map<string, Set<string>>();
  let lastMembershipRefresh = 0;
  const MEMBERSHIP_REFRESH_MS = 30000; // 30s 刷新一次

  // ═══ Startup cleanup: 清理重启前残留的 zombie streaming 消息 ═══
  // 这是修复"重启后同一 session 出现两个 streaming"问题的关键步骤：
  // 1. 找到所有 streaming=true 的 placeholder → finalize 它们
  // 2. 将对应的 trigger message 标记为已处理 → 防止重复处理
  log('atheism: [STARTUP] cleaning up zombie streaming messages...');
  let totalCleaned = 0;
  // 收集被中断的 session（用于 auto-resume）
  // key: sessionId → { agentIds, hadContent, spaceConfig }
  const interruptedSessions = new Map<string, { agentIds: string[]; hadContent: boolean; spaceConfig: AtheismConfig }>();
  
  for (const agent of agentProfiles) {
    for (const sid of spaceIds) {
      try {
        const spaceConfig = { ...atheismConfig, spaceId: sid } as AtheismConfig;
        const cleaned = await cleanupZombieStreaming({ config: spaceConfig, agentId: agent.agentId });
        for (const { jobId, sessionId, hadContent } of cleaned) {
          if (jobId) {
            markMessageProcessed(agent.agentId, jobId);
          }
          // 记录被中断的 session
          const key = `${sid}:${sessionId}`;
          if (!interruptedSessions.has(key)) {
            interruptedSessions.set(key, { agentIds: [], hadContent: false, spaceConfig });
          }
          const entry = interruptedSessions.get(key)!;
          entry.agentIds.push(agent.agentId);
          if (hadContent) entry.hadContent = true;
        }
        totalCleaned += cleaned.length;
      } catch (err) {
        error(`atheism: [STARTUP] cleanup error for ${agent.agentId}@${sid}: ${err}`);
      }
    }
  }
  if (totalCleaned > 0) {
    log(`atheism: [STARTUP] cleaned ${totalCleaned} zombie streaming messages`);
  } else {
    log('atheism: [STARTUP] no zombie streaming messages found');
  }

  // ═══ Startup step 1.5: Auto-resume — 向被中断的 session 注入恢复消息 ═══
  const autoResume = atheismConfig.autoResume !== false; // 默认开启
  if (autoResume && interruptedSessions.size > 0) {
    log(`atheism: [RESUME] auto-resuming ${interruptedSessions.size} interrupted session(s)...`);
    let resumeCount = 0;
    for (const [key, { agentIds, hadContent, spaceConfig }] of interruptedSessions) {
      const sessionId = key.split(':').slice(1).join(':'); // 去掉 spaceId 前缀
      const agentLabel = agentIds.join(', ');
      try {
        const msgId = await postResumeMessage({
          config: spaceConfig,
          sessionId,
          interruptedAgentId: agentLabel,
          hadContent,
        });
        if (msgId) resumeCount++;
        // 错开恢复消息，避免同时拉起太多任务（concurrency limiter 也会兜底）
        if (interruptedSessions.size > 1) {
          await new Promise(r => setTimeout(r, 500));
        }
      } catch (err) {
        error(`atheism: [RESUME] failed for session ${sessionId}: ${err}`);
      }
    }
    log(`atheism: [RESUME] posted ${resumeCount} resume message(s)`);
  } else if (!autoResume && interruptedSessions.size > 0) {
    log(`atheism: [RESUME] auto-resume disabled, ${interruptedSessions.size} interrupted session(s) not resumed`);
  }

  // ═══ Startup step 2: 标记所有近期已处理的 trigger message ═══
  // 修复"重启后重复处理同一消息"的 bug：
  // processedMessages 是内存中的 Set，重启后清空。
  // 如果只标记 zombie 的 job_id，已完成的 response 对应的 trigger 会被重新处理，
  // 导致同一 session 出现两个 streaming 响应。
  log('atheism: [STARTUP] marking recently-processed messages...');
  let totalMarked = 0;
  for (const agent of agentProfiles) {
    for (const sid of spaceIds) {
      try {
        const spaceConfig = { ...atheismConfig, spaceId: sid } as AtheismConfig;
        const jobIds = await getRecentAgentJobIds({ config: spaceConfig, agentId: agent.agentId });
        for (const jobId of jobIds) {
          markMessageProcessed(agent.agentId, jobId);
        }
        totalMarked += jobIds.length;
      } catch (err) {
        error(`atheism: [STARTUP] mark error for ${agent.agentId}@${sid}: ${err}`);
      }
    }
  }
  log(`atheism: [STARTUP] marked ${totalMarked} recently-processed trigger messages`);

  async function refreshMembership() {
    const now = Date.now();
    if (now - lastMembershipRefresh < MEMBERSHIP_REFRESH_MS) return;
    
    // 🆕 动态发现新 space（spaceId="*" 时）
    if (resolveSpaceIds(atheismConfig!).length === 0) {
      try {
        const allIds = await fetchAllSpaceIds(atheismConfig!.apiUrl!);
        for (const sid of allIds) {
          if (!spaceIds.includes(sid)) {
            spaceIds.push(sid);
            for (const agent of agentProfiles) {
              lastTimestamps.set(`${agent.agentId}:${sid}`, Date.now() - 60 * 1000);
            }
            log(`atheism: [discovery] new space detected: ${sid}`);
          }
        }
      } catch {}
    }

    let success = false;
    for (const sid of spaceIds) {
      try {
        const url = `${atheismConfig.apiUrl}/spaces/${sid}/members`;
        const res = await fetch(url);
        if (!res.ok) { log(`atheism: [membership] ${sid} HTTP ${res.status}`); continue; }
        const { members } = await res.json() as { members: Array<{ agent_id: string }> };
        const memberIds = new Set(members.map((m: { agent_id: string }) => m.agent_id));
        for (const agent of agentProfiles) {
          if (!membershipCache.has(agent.agentId)) membershipCache.set(agent.agentId, new Set());
          if (memberIds.has(agent.agentId)) {
            membershipCache.get(agent.agentId)!.add(sid);
          } else {
            membershipCache.get(agent.agentId)!.delete(sid);
          }
        }
        success = true;
      } catch (err) {
        log(`atheism: [membership] failed to fetch ${sid}: ${err}`);
      }
    }
    // 只在至少成功一次时更新刷新时间，否则下次 poll 立即重试
    if (success) {
      lastMembershipRefresh = now;
      // 日志：输出缓存状态
      const summary = [...membershipCache.entries()].map(([aid, spaces]) => `${aid}:[${[...spaces].join(',')}]`).join(' ');
      log(`atheism: [membership] refreshed: ${summary}`);
    }
  }

  return new Promise<void>((resolve) => {
    if (abortSignal) {
      abortSignal.addEventListener("abort", () => { log("atheism: monitor aborted"); resolve(); });
    }

    const poll = async () => {
      if (abortSignal?.aborted) { resolve(); return; }

      // 🆕 刷新 membership 缓存
      await refreshMembership();

      // 🆕 遍历每个逻辑 Agent（随机打乱顺序，防止锁饥饿）
      const shuffledProfiles = [...agentProfiles].sort(() => Math.random() - 0.5);
      for (const agentProfile of shuffledProfiles) {
        const agentId = agentProfile.agentId;


        for (const spaceId of spaceIds) {
          // ═══ Per-Space Circuit Breaker Check ═══
          const health = getSpaceHealth(spaceId);
          const now = Date.now();
          if (health.circuitOpen) {
            const elapsed = now - health.circuitOpenedAt;
            if (elapsed < CIRCUIT_BREAKER_RESET_MS) {
              continue; // 该 space 熔断中，跳过（不影响其他 space）
            }
            log(`atheism: [circuit-breaker] ${spaceId}: attempting recovery probe...`);
            health.circuitOpen = false;
          }
          // Per-space backoff: 如果距上次 poll 不够退避间隔，跳过
          if (now - health.lastPollAt < health.currentBackoffMs) continue;

          // 🆕 只在已加入的 space 工作（发心跳 + 处理消息）
          // 如果缓存存在且非空，才做过滤；缓存为空（首次/失败）则全部放行
          const agentSpaces = membershipCache.get(agentId);
          if (agentSpaces && agentSpaces.size > 0 && !agentSpaces.has(spaceId)) continue;
          try {
            health.lastPollAt = now;
            const spaceConfig = { ...atheismConfig, spaceId } as AtheismConfig;
            const tsKey = `${agentId}:${spaceId}`;
            const since = lastTimestamps.get(tsKey) || Date.now();

            // 每个 Agent 独立 poll（server 为每个 agent_id 分别做心跳）
            const { messages, next_since, online_agents, eval_locks, session_mutes } = await fetchAtheismMessages({
              config: spaceConfig,
              since,
              agentProfile,
            });

            if (messages.length > 0) {
              log(`atheism: [${agentId}@${spaceId}] received ${messages.length} message(s), online: [${online_agents.map(a => a.agent_id).join(', ')}]`);
            }

            // 判断是否只有自己在线（排除同一 OpenClaw 实例的所有逻辑 Agent）
            const selfAgentIds = new Set(agentProfiles.map(a => a.agentId));
            const externalAgents = online_agents.filter(a => !selfAgentIds.has(a.agent_id));
            // 多 Agent 模式下：同实例的兄弟 Agent 也算"多人"
            const amAlone = online_agents.length <= 1;

            // 按 session 分组（排除自己的消息）
            const bySession = new Map<string, AtheismMessage[]>();
            const sessionsWithCompletions = new Set<string>();
            let hasUnprocessedMessages = false; // 🆕 追踪是否有消息因锁被拒未处理
            
            for (const msg of messages) {
              if (msg.from_agent === agentId) continue;
              // 🆕 过滤掉占位消息（streaming=true 且内容为 ⏳）— 防止互相触发无限循环
              if (msg.content?.streaming === true) continue;
              // 🆕 过滤掉 [NO_REPLY] 静默响应 — 不作为可触发消息，防止 NO_REPLY 链式循环
              const msgResult = typeof msg.content?.result === 'string' ? msg.content.result : '';
              if (/^\s*(\[?NO_REPLY\]?|NO)\s*$/i.test(msgResult) && msg.type === 'human_job_response') continue;
              
              const sid = msg.session_id || "session_default";
              
              // 完成信号检测 — 排除 [NO_REPLY] 静默响应，避免链式触发
              const completionKey = `${agentId}:${msg.message_id}`;
              const resultText = typeof msg.content?.result === 'string' ? msg.content.result : '';
              const isSilentCompletion = /^\s*(\[?NO_REPLY\]?|NO)\s*$/i.test(resultText);
              const isCompletionCandidate = msg.type === 'human_job_response' && 
                  msg.content?.streaming === false && 
                  msg.updated_at;
              
              // 🆕 重启后首轮 poll 跳过 completion signal — 防止老 session 风暴
              const fpKey = `${agentId}:${spaceId}`;
              if (isCompletionCandidate && !isSilentCompletion && !firstPollDone.has(fpKey)) {
                continue;
              }
              
              // 🆕 已处理过 completion 的 agent 消息不再作为普通消息触发
              // 防止：completion 已处理 → 消息仍在窗口 → 作为普通消息触发 → 空转循环
              if (isCompletionCandidate && processedCompletions.has(completionKey) && msg.from_agent !== 'human') {
                continue;
              }
              
              if (!bySession.has(sid)) bySession.set(sid, []);
              bySession.get(sid)!.push(msg);
              
              if (isCompletionCandidate &&
                  !processedCompletions.has(completionKey) &&
                  !isSilentCompletion) {
                sessionsWithCompletions.add(sid);
              }
            }

            for (const [sid, sessionMsgs] of bySession) {
              // 🆕 Mute 检查：如果该 Agent 在该 session 被 mute，跳过
              const mutedInSession = (session_mutes || {})[sid] || [];
              if (mutedInSession.includes(agentId)) {
                continue;
              }
              
              const hasHumanMsg = sessionMsgs.some(m => m.from_agent === "human");

              // ─── @human 暂停检查（持久化） ───
              // 1. 人类发消息 → 解除该 session 的暂停
              if (hasHumanMsg && pausedSessions.has(sid)) {
                log(`atheism: [${agentId}@${sid}] human message received, resuming paused session (was paused by ${pausedSessions.get(sid)!.pausedBy})`);
                pausedSessions.delete(sid);
                savePausedSessions(pausedSessions);
              }
              // 2. 检测新的 @human → 标记暂停 + 中止所有在途 Agent
              if (!hasHumanMsg) {
                // 检查当前 poll 窗口是否有新 @human
                for (const m of sessionMsgs) {
                  const t = String(m.content?.result || m.content?.job || m.content?.message || m.content?.text || '');
                  if (/@human\b/i.test(t) && !pausedSessions.has(sid)) {
                    pausedSessions.set(sid, { pausedAt: Date.now(), pausedBy: m.from_agent || 'unknown' });
                    savePausedSessions(pausedSessions);
                    log(`atheism: [${agentId}@${sid}] @human detected from ${m.from_agent}, pausing collaboration until human input`);
                    // 🆕 立即中止该 session 所有在途 Agent（发出 @human 的除外）
                    const allJobs = getAllActiveJobs();
                    for (const [, job] of allJobs) {
                      if (job.sessionId === sid && job.agentId !== m.from_agent) {
                        log(`atheism: [${agentId}@${sid}] @human pause: aborting in-flight ${job.agentId}`);
                        await abortActiveJob(sid, "@human 暂停协作，中止在途任务", job.agentId);
                      }
                    }
                  }
                }
              }
              // 3. 如果 session 已暂停（无论新旧），跳过
              if (pausedSessions.has(sid) && !hasHumanMsg) {
                continue;
              }

              const existingJob = getActiveJobForAgent(agentId, sid);

              // ---- 该 Agent 在该 session 正在处理 ----
              if (existingJob) {
                // 🆕 @human 暂停：session 被暂停 + 没有新 human 消息 → 中止在途任务
                if (pausedSessions.has(sid) && !hasHumanMsg) {
                  log(`atheism: [${agentId}@${sid}] session paused by @human, aborting in-flight job ${existingJob.jobId}`);
                  await abortActiveJob(sid, "@human 暂停协作，中止在途任务", agentId);
                  continue;
                }
                if (hasHumanMsg) {
                  const newHumanMsg = sessionMsgs.filter(m => m.from_agent === "human").pop()!;
                  // 🆕 Fix: 如果 human 消息就是当前正在处理的消息，不中断（防止自己中断自己导致级联）
                  if (newHumanMsg.message_id === existingJob.jobId) {
                    continue;
                  }
                  log(`atheism: [INTERRUPT] ${agentId}@${sid}: NEW human message ${newHumanMsg.message_id}, aborting ${existingJob.jobId}`);
                  await abortActiveJob(sid, "新消息到达，中断当前任务", agentId);
                  await new Promise(r => setTimeout(r, 200));
                  // 🆕 @mention 优先级：新 human 消息 @了特定 Agent 且我不在其中 → 让步
                  const interruptText = newHumanMsg.content?.job || newHumanMsg.content?.message || newHumanMsg.content?.text || '';
                  const interruptMentions = parseMentions(interruptText, online_agents);
                  if (interruptMentions.mentionedAgentIds.length > 0 && !interruptMentions.mentionedAgentIds.includes(agentId)) {
                    const mentionedOnline = interruptMentions.mentionedAgentIds.some(mid =>
                      online_agents.some(a => a.agent_id === mid)
                    );
                    if (mentionedOnline) {
                      log(`atheism: [${agentId}@${sid}] human msg @mentions [${interruptMentions.mentionedAgentIds.join(',')}], deferring`);
                      continue;
                    }
                  }
                  const started = await processSessionMessage(cfg, spaceConfig, sid, newHumanMsg, online_agents, eval_locks, agentId, amAlone, agentProfile);
                  // 🆕 Human message 处理也更新 cooldown，防止紧随其后的 completion 重复触发
                  if (started) lastCompletionEval.set(`${agentId}:${sid}`, Date.now());
                  if (!started) hasUnprocessedMessages = true;
                }
                continue;
              }

              // ---- 该 Agent 在该 session 空闲 ----
              const latestHuman = sessionMsgs.filter(m => m.from_agent === "human").pop();

              // 🆕 Bug fix: 如果 human 消息已经被处理过（在 processedMessages 中），
              // 不应让它遮盖 completion signal。
              // 场景：human_job 和 agent 的 completion 出现在同一个 poll 窗口中，
              // human_job 被当作 trigger 但已 dedup → completion signal 被静默丢弃。
              const humanAlreadyProcessed = latestHuman && isMessageProcessed(agentId, latestHuman.message_id);
              const effectiveHuman = humanAlreadyProcessed ? undefined : latestHuman;
              const latestMsg = effectiveHuman || sessionMsgs[sessionMsgs.length - 1];

              if (latestMsg) {
                // ─── @mention 优先级：触发消息 @了特定 Agent 且我不在其中 → 让步 ───
                // 被 @ 的 Agent 优先拿到 eval lock，其他 Agent 等 completion signal
                const triggerText = latestMsg.content?.job || latestMsg.content?.result || latestMsg.content?.message || latestMsg.content?.text || '';
                const mentions = parseMentions(triggerText, online_agents);
                if (mentions.mentionedAgentIds.length > 0 && !mentions.mentionedAgentIds.includes(agentId)) {
                  const mentionedOnline = mentions.mentionedAgentIds.some(mid =>
                    online_agents.some(a => a.agent_id === mid)
                  );
                  if (mentionedOnline) {
                    log(`atheism: [${agentId}@${sid}] deferring to @mentioned [${mentions.mentionedAgentIds.join(',')}]`);
                    continue;
                  }
                  // 被 @ 的 Agent 全部不在线 → 回退到正常流程
                }

                const isCompletionSignal = sessionsWithCompletions.has(sid) && !effectiveHuman;
                
                // 🆕 Completion cooldown: 如果该 agent 最近已评估过该 session，跳过 completion signal
                // 这将 O(N²) 级联降为 O(N)：agent A 完成 → 触发 B-H，但 B 完成后不会再触发 C-H（因为它们刚评估过）
                if (isCompletionSignal) {
                  const cooldownKey = `${agentId}:${sid}`;
                  const lastEval = lastCompletionEval.get(cooldownKey) || 0;
                  if (Date.now() - lastEval < COMPLETION_COOLDOWN_MS) {
                    log(`atheism: [${agentId}@${sid}] completion signal skipped (cooldown, last eval ${Math.round((Date.now() - lastEval) / 1000)}s ago)`);
                    // 仍然标记为已消费，防止反复触发
                    for (const m of sessionMsgs) {
                      const isCandidate = m.type === 'human_job_response' && 
                          m.content?.streaming === false && m.updated_at;
                      if (isCandidate) {
                        processedCompletions.add(`${agentId}:${m.message_id}`);
                      }
                    }
                    continue;
                  }
                }
                
                const triggerMsg = isCompletionSignal 
                  ? { ...latestMsg, message_id: `${latestMsg.message_id}_completed_${agentId}_${Date.now()}` }
                  : latestMsg;
                
                if (isCompletionSignal) {
                  log(`atheism: [${agentId}@${sid}] completion signal from ${latestMsg.from_agent}, triggering re-evaluation`);
                }
                
                // 🆕 Bug fix: humanAlreadyProcessed + no completion signal = nothing to do
                // 之前这里会 fall through 到 processSessionMessage，用 stale message 当 trigger。
                // 如果 eval lock 被拒，hasUnprocessedMessages=true → since 不推进 → 空转循环。
                // 实测产生 961 次/1.5h 的无效 poll（每次都触发 LLM 调用浪费 token）。
                // 修复：直接跳过，不尝试处理。下次有新 completion 或新 human message 时自然触发。
                if (humanAlreadyProcessed && !isCompletionSignal) {
                  continue;
                }
                
                // 🆕 Completion signal 无论是否拿到锁，都标记为已消费
                // 防止 lock 被拒 → since 不推进 → 同一 completion 无限重触发
                // 理由：completion 是"check if you want to respond"信号，不是关键消息
                // 错过一次不影响正确性 — 对话历史仍在，后续消息会触发新一轮
                if (isCompletionSignal) {
                  // 🆕 Fix: 消费该 session 所有 completion candidate，不只是 latestMsg
                  // 防止 N 条完成消息中只标记 1 条，其余 N-1 条反复触发
                  let consumed = 0;
                  for (const m of sessionMsgs) {
                    const isCandidate = m.type === 'human_job_response' && 
                        m.content?.streaming === false && m.updated_at;
                    if (isCandidate) {
                      processedCompletions.add(`${agentId}:${m.message_id}`);
                      consumed++;
                    }
                  }
                  if (consumed > 1) {
                    log(`atheism: [${agentId}@${sid}] consumed ${consumed} completion candidates (batch)`);
                  }
                }
                
                const started = await processSessionMessage(cfg, spaceConfig, sid, triggerMsg, online_agents, eval_locks, agentId, amAlone, agentProfile);
                
                // 🆕 记录 completion 评估时间（无论是否拿到锁）
                // 用于 cooldown 判断，防止同一 agent 在短时间内被多次 completion 触发
                if (isCompletionSignal) {
                  lastCompletionEval.set(`${agentId}:${sid}`, Date.now());
                }
                
                // 🆕 只有非 completion 的消息（如 human message）锁被拒时才阻止 since 推进
                // completion signal 已在上面被标记，不需要阻止 since
                if (!started && !isCompletionSignal) hasUnprocessedMessages = true;
              }
            }

            // 🆕 只在所有消息都成功处理（或无消息）时推进 since
            // 如果有消息因锁被拒未处理，保持 since 不变，下次 poll 重试
            if (!hasUnprocessedMessages) {
              lastTimestamps.set(tsKey, next_since);
            }
            // 🆕 标记首轮 poll 完成，后续 poll 允许 completion signal
            firstPollDone.add(tsKey);
            // ═══ Per-Space Backoff: 成功 → 重置 ═══
            if (health.consecutiveFailures > 0) {
              log(`atheism: [backoff] ${spaceId}: recovered after ${health.consecutiveFailures} failures`);
            }
            health.consecutiveFailures = 0;
            health.currentBackoffMs = pollIntervalMs;
          } catch (err) {
            error(`atheism: [${agentId}@${spaceId}] poll error: ${err}`);
            // ═══ Per-Space Backoff: 失败 → 退避 ═══
            health.consecutiveFailures++;
            health.currentBackoffMs = Math.min(health.currentBackoffMs * 2, MAX_BACKOFF_MS);
            if (health.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
              health.circuitOpen = true;
              health.circuitOpenedAt = Date.now();
              log(`atheism: [circuit-breaker] ${spaceId}: OPEN after ${health.consecutiveFailures} failures, probe in ${CIRCUIT_BREAKER_RESET_MS/1000}s`);
            } else {
              log(`atheism: [backoff] ${spaceId}: failed (${health.consecutiveFailures}x), next in ${health.currentBackoffMs}ms`);
            }
          }
        }
      }

      if (!abortSignal?.aborted) {
        setTimeout(poll, pollIntervalMs);
      } else {
        resolve();
      }
    };

    poll();
  });
}

/** 
 * 处理单个 Agent 在单个 session 的消息，带评估锁逻辑
 * 返回 true 表示成功开始处理（拿到锁或 solo 模式），false 表示锁被拒
 */
async function processSessionMessage(
  cfg: ClawdbotConfig,
  spaceConfig: AtheismConfig,
  sessionId: string,
  message: AtheismMessage,
  onlineAgents: OnlineAgent[],
  evalLocks: EvalLock[],
  agentId: string,
  amAlone: boolean,
  agentProfile: AgentProfile,
): Promise<boolean> {
  const log = console.log;
  const error = console.error;

  if (amAlone) {
    log(`atheism: [${agentId}@${sessionId}] solo mode, processing directly`);
    handleAtheismMessage({ cfg, message, config: spaceConfig, onlineAgents, agentProfile })
      .catch(err => error(`atheism: [BG] error: ${err}`));
    return true;
  }

  // 多人在线 → 评估锁
  const sessionLock = evalLocks.find(l => l.session_id === sessionId);
  
  if (sessionLock && sessionLock.holder !== agentId) {
    log(`atheism: [${agentId}@${sessionId}] eval lock held by ${sessionLock.holder}, skipping`);
    return false;
  }

  const claim = await claimEvalLock({ config: spaceConfig, sessionId, agentId });
  
  if (!claim.granted) {
    log(`atheism: [${agentId}@${sessionId}] eval lock denied (held by: ${claim.held_by}), will retry`);
    return false;
  }

  log(`atheism: [${agentId}@${sessionId}] eval lock acquired, processing`);

  // 🆕 锁续期定时器：每 30s 续一次，防止长任务（写代码等）超过 60s TTL 被回收
  const renewInterval = setInterval(async () => {
    try {
      await claimEvalLock({ config: spaceConfig, sessionId, agentId });
    } catch {}
  }, 30000);

  // fire-and-forget: 不阻塞 poll 循环，让其他 space/agent 继续工作
  handleAtheismMessage({ cfg, message, config: spaceConfig, onlineAgents, agentProfile })
    .catch(err => error(`atheism: [${agentId}@${sessionId}] error during locked processing: ${err}`))
    .finally(async () => {
      clearInterval(renewInterval);
      await releaseEvalLock({ config: spaceConfig, sessionId, agentId });
      log(`atheism: [${agentId}@${sessionId}] eval lock released`);
    });
  return true;
}

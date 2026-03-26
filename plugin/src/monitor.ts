import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { A2ASpaceConfig, A2AMessage, OnlineAgent, EvalLock, AgentProfile, WsEvent } from "./types.js";
import { resolveAgentProfiles } from "./types.js";
import { fetchA2AMessages, claimEvalLock, releaseEvalLock, cleanupZombieStreaming, getRecentAgentJobIds, postResumeMessage, checkRecentResumeMessage, checkRecentNudgeMessage, fetchOrphanedSessions, postOrphanNudge, finalizeAgentStreaming } from "./send.js";
import { handleA2AMessage, getActiveJobForAgent, getAllActiveJobs, abortActiveJob, setMaxConcurrent, isMessageProcessed, markMessageProcessed, isAgentMentioned } from "./bot.js";
import { readFileSync, writeFileSync } from "fs";
import { WebSocket } from "ws";

// ─── @human 暂停状态持久化（跨 Gateway 重启） ───────────────

const PAUSED_SESSIONS_FILE = '/tmp/a2a-paused-sessions.json';

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
 * 从文本中剥离代码块（```...```）、行内代码（`...`）和引用块（> ...）。
 * 用于在 @mention 检测前过滤掉示例/引用中的误触。
 */
export function stripQuotedContent(text: string): string {
  if (!text) return '';
  let result = text;
  // 1. 剥离 fenced code blocks（```...```）
  result = result.replace(/```[\s\S]*?```/g, '');
  // 2. 剥离 inline code（`...`）
  result = result.replace(/`[^`\n]+`/g, '');
  // 3. 剥离 blockquote 行（以 > 开头的行）
  result = result.replace(/^>.*$/gm, '');
  // 4. 剥离 markdown 表格行（以 | 开头且包含 | 分隔的行，常见于协议/文档表格）
  result = result.replace(/^\|.*\|.*$/gm, '');
  // 5. 剥离 markdown 标题行（### @human 这种文档标题）
  result = result.replace(/^#{1,6}\s.*$/gm, '');
  // 6. 剥离「示例」「典型场景」等文档上下文中的 bullet points
  //    匹配以 - 开头且包含反引号引用的行（通常是文档示例行）
  result = result.replace(/^-\s.*`[^`]*@human[^`]*`.*$/gmi, '');
  // 7. 剥离讨论性引用 @human 的行（agent 在讨论协议的 @human 功能，而非真正请求人类介入）
  //    匹配 @human 前有讨论性前缀（的/中的/关于/对于/涉及/协议的/@mention 和）或
  //    @human 后紧跟功能性名词（机制/功能/检测/暂停/逻辑/方案/特性/检查/触发/标记/信号）
  result = result.replace(/^.*(?:的|中的|关于|对于|涉及|协议.*|@mention\s*和?\s*)@human\b.*$/gmi, '');
  result = result.replace(/^.*@human\s*(?:机制|功能|检测|暂停|逻辑|方案|特性|检查|触发|标记|信号|pause|detect|feature|mechanism).*$/gmi, '');
  // 8. 剥离含 @human 的 bullet list 行（协议文档中的说明性条目）
  //    匹配以 - 开头且包含 @human 的行（比 step 6 更宽泛，step 6 只匹配有反引号的）
  result = result.replace(/^[-*]\s.*@human.*$/gmi, '');
  // 9. 剥离中文引号内的内容（「...@human...」、"...@human..."）
  result = result.replace(/[「「].*@human.*[」」]/gi, '');
  result = result.replace(/["""].*@human.*[""]/gi, '');
  return result;
}

/**
 * 解析消息文本中的 @mentions。
 * 返回被 @ 的 agent_id 列表和是否 @human。
 */
export function parseMentions(text: string, onlineAgents: OnlineAgent[]): {
  mentionedAgentIds: string[];
  mentionsHuman: boolean;
} {
  if (!text) return { mentionedAgentIds: [], mentionsHuman: false };

  const stripped = stripQuotedContent(text);
  const mentionsHuman = /@human\b/i.test(stripped);
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
  if (processedCompletions.size > 300) {
    const arr = [...processedCompletions];
    for (const id of arr.slice(0, arr.length - 100)) processedCompletions.delete(id);
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

// ─── Processing Guard: 防止同一 agent 在同一 session 被并发 dispatch ───
// 修复 WS event 和 retry queue drain 的竞态：两条路径同时通过 getActiveJobForAgent
// 检查（此时 activeJobs 尚未被 handleA2AMessage 设置），导致同一 agent 创建两条 streaming 消息。
// 这个 Set 在 processSessionMessage 入口同步设置，在 handleA2AMessage.finally() 中清除。
const processingGuard = new Set<string>(); // key: `${agentId}:${sessionId}`

// ─── Eval Lock Retry Queue ───
// When an agent is denied the eval lock during WS event handling, we store the
// pending evaluation here. When `eval_lock_released` arrives, we drain the queue
// for that session. A periodic sweep (every 5s) acts as defensive fallback.
interface PendingRetry {
  agentProfile: AgentProfile;
  spaceId: string;
  sessionId: string;
  triggerMsg: A2AMessage;
  onlineAgents: OnlineAgent[];
  addedAt: number;
}
const wsRetryQueue = new Map<string, PendingRetry[]>(); // key: sessionId → pending entries
const WS_RETRY_MAX_AGE_MS = 60_000; // Drop entries older than 60s (stale)
let retryQueueProcessing = false; // Mutex: prevents sweep and handleLockReleased from racing

export type MonitorA2ASpaceOpts = {
  config: OpenClawConfig;
  abortSignal?: AbortSignal;
};

/** 解析 spaceId 配置为数组 */
function resolveSpaceIds(config: A2ASpaceConfig): string[] {
  const raw = config.spaceId;
  if (!raw) return ["default"];
  if (Array.isArray(raw)) return raw;
  if (raw === "*") return [];
  return [raw];
}

/** 获取所有 space（当 spaceId="*" 时） */
async function fetchAllSpaceIds(apiUrl: string): Promise<string[]> {
  try {
    const res = await fetch(`${apiUrl.replace(/\/api$/, "")}/api/spaces`, {
      headers: { "ngrok-skip-browser-warning": "true" },
    });
    if (!res.ok) return [];
    const { spaces } = await res.json();
    return spaces.map((s: any) => s.space_id);
  } catch {
    return [];
  }
}

export async function monitorA2ASpace(opts: MonitorA2ASpaceOpts): Promise<void> {
  const { config: cfg, abortSignal } = opts;
  const log = console.log;
  const error = console.error;

  const a2aConfig = cfg.channels?.a2aspace as A2ASpaceConfig | undefined;

  if (!a2aConfig?.enabled) {
    log("atheism: channel not enabled, skipping monitor");
    return;
  }
  if (!a2aConfig.apiUrl) {
    error("atheism: apiUrl not configured");
    return;
  }

  // 🆕 解析 Agent 集群
  const agentProfiles = resolveAgentProfiles(a2aConfig);
  if (agentProfiles.length === 0) {
    error("atheism: no agents configured (need agentId or agents[])");
    return;
  }

  const pollIntervalMs = a2aConfig.pollIntervalMs ?? 1000;
  const maxConcurrent = Math.max(1, Math.min(10, a2aConfig.maxConcurrent ?? 3));
  setMaxConcurrent(maxConcurrent);

  // 解析要监听的 spaces
  let spaceIds = resolveSpaceIds(a2aConfig);
  if (spaceIds.length === 0) {
    spaceIds = await fetchAllSpaceIds(a2aConfig.apiUrl);
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
  const interruptedSessions = new Map<string, { agentIds: string[]; hadContent: boolean; spaceConfig: A2ASpaceConfig }>();
  
  for (const agent of agentProfiles) {
    for (const sid of spaceIds) {
      try {
        const spaceConfig = { ...a2aConfig, spaceId: sid } as A2ASpaceConfig;
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
          if (!entry.agentIds.includes(agent.agentId)) {
            entry.agentIds.push(agent.agentId);
          }
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

  // ═══ P1: Stability Gate — 等待稳定窗口后再执行恢复动作 ═══
  // 如果 Gateway 在 15s 内再次被 kill，recovery 动作不会执行，避免 restart storm 放大
  const STABILITY_GATE_MS = a2aConfig.stabilityGateMs ?? 15_000;
  if (STABILITY_GATE_MS > 0 && (interruptedSessions.size > 0 || (a2aConfig.autoResume !== false))) {
    log(`atheism: [STARTUP] stability gate: waiting ${STABILITY_GATE_MS}ms before recovery actions...`);
    await new Promise(r => setTimeout(r, STABILITY_GATE_MS));
    if (abortSignal?.aborted) {
      log('atheism: [STARTUP] aborted during stability gate, skipping recovery');
      return;
    }
    log('atheism: [STARTUP] stability gate passed, proceeding with recovery');
  }

  // ═══ Startup step 1.5: Auto-resume — 向被中断的 session 注入恢复消息 ═══
  const autoResume = a2aConfig.autoResume !== false; // 默认开启
  if (autoResume && interruptedSessions.size > 0) {
    log(`atheism: [RESUME] auto-resuming ${interruptedSessions.size} interrupted session(s)...`);
    let resumeCount = 0;
    let skippedCount = 0;
    for (const [key, { agentIds, hadContent, spaceConfig }] of interruptedSessions) {
      const sessionId = key.split(':').slice(1).join(':'); // 去掉 spaceId 前缀
      const agentLabel = agentIds.join(', ');
      try {
        // ═══ P0: Resume Debounce — 检查近期是否已有恢复消息，防止 restart storm 堆积 ═══
        const RESUME_DEBOUNCE_MS = 5 * 60 * 1000; // 5 分钟内不重复注入
        const hasRecentResume = await checkRecentResumeMessage({
          config: spaceConfig,
          sessionId,
          windowMs: RESUME_DEBOUNCE_MS,
        });
        if (hasRecentResume) {
          log(`atheism: [RESUME] skipping session ${sessionId} — resume message already posted within ${RESUME_DEBOUNCE_MS / 1000}s`);
          skippedCount++;
          continue;
        }

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
    log(`atheism: [RESUME] posted ${resumeCount} resume message(s)${skippedCount > 0 ? `, skipped ${skippedCount} (debounced)` : ''}`);
  } else if (!autoResume && interruptedSessions.size > 0) {
    log(`atheism: [RESUME] auto-resume disabled, ${interruptedSessions.size} interrupted session(s) not resumed`);
  }

  // ═══ Startup step 1.7: Orphan detection — 找到 Gateway 宕机期间发送的未回复人类消息 ═══
  // 场景：Gateway 宕机超过 initSince 回看窗口（5min），人类消息不在 poll 窗口内，
  // 且没有 zombie streaming（因为根本没有 agent 开始处理），所以 auto-resume 也抓不到。
  // 修复：直接查 server 端的 session 状态，找到"最后消息是人类发的、无 lock、未 quiesced"的 session。
  if (autoResume) {
    log('atheism: [ORPHAN] scanning for orphaned sessions (unanswered human messages)...');
    let totalOrphans = 0;
    let totalNudged = 0;
    const nudgedSessionIds = new Set<string>();
    for (const sid of spaceIds) {
      try {
        const spaceConfig = { ...a2aConfig, spaceId: sid } as A2ASpaceConfig;
        const orphans = await fetchOrphanedSessions({ config: spaceConfig, maxAgeHours: 6 });

        // Skip sessions already handled by auto-resume
        const resumedSessionIds = new Set(
          [...interruptedSessions.keys()].map(k => k.split(':').slice(1).join(':'))
        );
        const newOrphans = orphans.filter(o => !resumedSessionIds.has(o.session_id));

        totalOrphans += newOrphans.length;
        for (const orphan of newOrphans) {
          if (nudgedSessionIds.has(orphan.session_id)) continue; // 跨 space 去重
          // P0: Orphan nudge debounce — 防止连续重启时同一 session 收到多条 nudge
          const hasRecentNudge = await checkRecentNudgeMessage({
            config: spaceConfig,
            sessionId: orphan.session_id,
            windowMs: 5 * 60 * 1000,
          });
          if (hasRecentNudge) {
            log(`atheism: [ORPHAN] skipping session ${orphan.session_id} — nudge already posted within 5min`);
            nudgedSessionIds.add(orphan.session_id);
            continue;
          }
          const msgId = await postOrphanNudge({
            config: spaceConfig,
            sessionId: orphan.session_id,
            messagePreview: orphan.message_preview,
          });
          if (msgId) {
            totalNudged++;
            nudgedSessionIds.add(orphan.session_id);
          }
          // 错开避免同时拉起太多
          if (newOrphans.length > 1) {
            await new Promise(r => setTimeout(r, 500));
          }
        }
      } catch (err) {
        error(`atheism: [ORPHAN] error scanning space ${sid}: ${err}`);
      }
    }
    if (totalOrphans > 0) {
      log(`atheism: [ORPHAN] found ${totalOrphans} orphaned session(s), nudged ${totalNudged}`);
    } else {
      log('atheism: [ORPHAN] no orphaned sessions found');
    }
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
        const spaceConfig = { ...a2aConfig, spaceId: sid } as A2ASpaceConfig;
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
    
    // 🆕 动态发现新 space（spaceId="*" 时）— 双向同步：增+删
    if (resolveSpaceIds(a2aConfig!).length === 0) {
      try {
        const allIds = await fetchAllSpaceIds(a2aConfig!.apiUrl!);
        const serverSet = new Set(allIds);

        // 移除 server 端已不存在的 space（修复只增不删的内存泄漏）
        const removed: string[] = [];
        for (let i = spaceIds.length - 1; i >= 0; i--) {
          if (!serverSet.has(spaceIds[i])) {
            const sid = spaceIds[i];
            spaceIds.splice(i, 1);
            for (const agent of agentProfiles) {
              lastTimestamps.delete(`${agent.agentId}:${sid}`);
              membershipCache.get(agent.agentId)?.delete(sid);
            }
            removed.push(sid);
          }
        }
        if (removed.length > 0) {
          log(`atheism: [discovery] removed ${removed.length} stale space(s): ${removed.join(", ")}`);
        }

        // 添加新发现的 space（WS 模式下无需 cap，订阅所有 space）
        for (const sid of allIds) {
          if (spaceIds.includes(sid)) continue;
          spaceIds.push(sid);
          for (const agent of agentProfiles) {
            lastTimestamps.set(`${agent.agentId}:${sid}`, Date.now() - 60 * 1000);
          }
          log(`atheism: [discovery] new space detected: ${sid}`);
        }
      } catch {}
    }

    let success = false;
    for (const sid of spaceIds) {
      try {
        const url = `${a2aConfig.apiUrl}/spaces/${sid}/members`;
        const res = await fetch(url, { headers: { "ngrok-skip-browser-warning": "true" } });
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

  // ═══ WebSocket Push Client ═══
  // Real-time push mode: server broadcasts events, client processes them directly.
  // Polling becomes fallback only (30s interval when WS connected).

  let wsConnected = false;
  let wsCatchUpNeeded = false; // Set on reconnect; cleared after one HTTP poll cycle
  let wsReconnectDelay = 1000;
  const WS_MAX_RECONNECT_DELAY = 30000;
  const WS_HEARTBEAT_MS = 25000;
  let wsHeartbeatTimer: ReturnType<typeof setInterval> | null = null;

  function connectWebSocket() {
    if (!a2aConfig?.apiUrl) return;

    // Convert HTTP URL to WS URL
    const wsUrl = a2aConfig.apiUrl
      .replace(/^http:/, 'ws:')
      .replace(/^https:/, 'wss:')
      .replace(/\/api$/, '')
      + '/ws?agent_ids=' + agentProfiles.map(a => a.agentId).join(',');

    log(`atheism: [WS] connecting to ${wsUrl}`);

    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      error(`atheism: [WS] failed to create connection: ${err}`);
      scheduleReconnect();
      return;
    }

    ws.on('open', () => {
      log(`atheism: [WS] connected, push mode active`);
      wsConnected = true;
      wsCatchUpNeeded = true; // Signal poll loop to do one catch-up HTTP fetch
      wsReconnectDelay = 1000; // Reset backoff

      // Send subscription message
      ws.send(JSON.stringify({
        type: 'subscribe',
        agent_ids: agentProfiles.map(a => a.agentId),
      }));

      // Start heartbeat
      if (wsHeartbeatTimer) clearInterval(wsHeartbeatTimer);
      wsHeartbeatTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'heartbeat' }));
        }
      }, WS_HEARTBEAT_MS);
    });

    ws.on('message', async (raw) => {
      try {
        const event = JSON.parse(raw.toString()) as any;
        if (event.type === 'pong') return; // Ignore pong responses

        if (event.type === 'new_message' || event.type === 'message_updated') {
          await handleWsEvent(event);
        } else if (event.type === 'eval_lock_released') {
          await handleLockReleased(event);
        } else if (event.type === 'session_interrupted') {
          await handleSessionInterrupted(event);
        } else if (event.type === 'summary_request') {
          await handleSummaryRequest(event);
        }
      } catch (err) {
        error(`atheism: [WS] error processing event: ${err}`);
      }
    });

    ws.on('close', () => {
      log(`atheism: [WS] disconnected, falling back to polling`);
      wsConnected = false;
      if (wsHeartbeatTimer) { clearInterval(wsHeartbeatTimer); wsHeartbeatTimer = null; }
      scheduleReconnect();
    });

    ws.on('error', (err) => {
      error(`atheism: [WS] error: ${err.message}`);
    });
  }

  function scheduleReconnect() {
    if (abortSignal?.aborted) return;
    log(`atheism: [WS] reconnecting in ${wsReconnectDelay}ms...`);
    setTimeout(() => {
      if (!abortSignal?.aborted) connectWebSocket();
    }, wsReconnectDelay);
    wsReconnectDelay = Math.min(wsReconnectDelay * 2, WS_MAX_RECONNECT_DELAY);
  }

  // Handle WebSocket push events
  async function handleWsEvent(event: WsEvent & { space_id?: string; session_id?: string; message?: A2AMessage; online_agents?: OnlineAgent[]; session_mutes?: Record<string, string[]> }) {
    if (event.type !== 'new_message' && event.type !== 'message_updated') return;
    if (!event.message || !event.space_id || !event.session_id) return;

    const msg = event.message;
    const spaceId = event.space_id;
    const sessionId = event.session_id;
    const onlineAgents = event.online_agents || [];
    const sessionMutes = event.session_mutes || {};

    // Skip streaming placeholders
    if (msg.content?.streaming === true) return;
    // Skip NO_REPLY
    const resultText = typeof msg.content?.result === 'string' ? msg.content.result : '';
    if (/^\s*(\[?NO_REPLY\]?|NO)\s*$/i.test(resultText) && msg.type === 'human_job_response') return;

    const isCompletion = event.type === 'message_updated' &&
      msg.type === 'human_job_response' &&
      msg.content?.streaming === false;
    const isHumanMsg = msg.from_agent === 'human';

    log(`atheism: [WS] ${event.type} in ${spaceId}/${sessionId} from ${msg.from_agent}`);

    // Check @human pause — only agent completion messages can trigger pause
    // @human is an agent→human signal; skip human messages, moderator messages, and non-response types
    const msgText = msg.content?.job || msg.content?.result || msg.content?.message || '';
    const isModerator = msg.content?.metadata?.moderator === true || (msg as any).metadata?.moderator === true;
    const isAgentResponse = msg.type === 'human_job_response';
    // Defense-in-depth: require BOTH "is agent response" AND "not from human/moderator"
    if (isAgentResponse && !isHumanMsg && !isModerator && /@human\b/i.test(stripQuotedContent(msgText)) && !pausedSessions.has(sessionId)) {
      pausedSessions.set(sessionId, { pausedAt: Date.now(), pausedBy: msg.from_agent || 'unknown' });
      savePausedSessions(pausedSessions);
      log(`atheism: [WS] @human detected, pausing session ${sessionId}`);
      // Abort in-flight agents
      const allJobs = getAllActiveJobs();
      for (const [, job] of allJobs) {
        if (job.sessionId === sessionId && job.agentId !== msg.from_agent) {
          await abortActiveJob(sessionId, "@human 暂停协作", job.agentId);
        }
      }
      return;
    }

    // Human message resets pause
    if (isHumanMsg && pausedSessions.has(sessionId)) {
      log(`atheism: [WS] human message received, resuming paused session ${sessionId}`);
      pausedSessions.delete(sessionId);
      savePausedSessions(pausedSessions);
    }

    // Skip if session is paused and not a human message
    if (pausedSessions.has(sessionId) && !isHumanMsg) return;

    // ── Fix 1b: Human message preemption ──
    // When a new human message arrives, clear completion-triggered retry queue entries
    // for this session. Human messages have absolute priority — completion signals
    // are "nice to evaluate" but human messages are "must process now."
    if (isHumanMsg) {
      const pending = wsRetryQueue.get(sessionId);
      if (pending && pending.length > 0) {
        log(`atheism: [WS] human message preemption: clearing ${pending.length} completion-queued entries for ${sessionId}`);
        wsRetryQueue.delete(sessionId);
      }
    }

    // Process for each local agent
    const shuffledProfiles = [...agentProfiles].sort(() => Math.random() - 0.5);
    for (const agentProfile of shuffledProfiles) {
      const agentId = agentProfile.agentId;

      // Skip own messages
      if (msg.from_agent === agentId) continue;

      // Check membership
      const agentSpaces = membershipCache.get(agentId);
      if (!agentSpaces || !agentSpaces.has(spaceId)) continue;

      // Check mute
      const mutedInSession = sessionMutes[sessionId] || [];
      if (mutedInSession.includes(agentId)) continue;

      // Completion cooldown + dedup
      if (isCompletion) {
        const cooldownKey = `${agentId}:${sessionId}`;
        const lastEval = lastCompletionEval.get(cooldownKey) || 0;
        if (Date.now() - lastEval < COMPLETION_COOLDOWN_MS) {
          continue;
        }
        // Synchronous dedup: if another WS event for the same completion
        // arrived while processSessionMessage was awaited, skip it.
        const completionKey = `${agentId}:${msg.message_id}`;
        if (processedCompletions.has(completionKey)) {
          log(`atheism: [WS] ${agentId}@${sessionId}: completion already processed (${msg.message_id}), skipping`);
          continue;
        }
        processedCompletions.add(completionKey);
      }

      // Check active job
      const existingJob = getActiveJobForAgent(agentId, sessionId);
      if (existingJob) {
        if (isHumanMsg && msg.message_id !== existingJob.jobId) {
          log(`atheism: [WS] ${agentId}@${sessionId}: human message, aborting ${existingJob.jobId}`);
          await abortActiveJob(sessionId, "新消息到达", agentId);
          await new Promise(r => setTimeout(r, 200));
        } else {
          continue; // Already processing
        }
      }

      // @mention priority
      const mentions = parseMentions(msgText, onlineAgents);
      if (mentions.mentionedAgentIds.length > 0 && !mentions.mentionedAgentIds.includes(agentId)) {
        const mentionedOnline = mentions.mentionedAgentIds.some(mid =>
          onlineAgents.some(a => a.agent_id === mid)
        );
        if (mentionedOnline) continue;
      }

      // Build config and process
      const spaceConfig = { ...a2aConfig, spaceId } as A2ASpaceConfig;
      const selfAgentIds = new Set(agentProfiles.map(a => a.agentId));
      const amAlone = onlineAgents.length <= 1;

      // Synthetic trigger for completion signals
      const triggerMsg = isCompletion
        ? { ...msg, message_id: `${msg.message_id}_completed_${agentId}_${Date.now()}` }
        : msg;

      // ── Fix 3b: Completion signals only update retry queue, don't directly trigger ──
      // This eliminates the dual-trigger race between handleWsEvent (completion) and
      // handleLockReleased (lock release). Lock release is the SOLE trigger path.
      // Completion signals just ensure the agent is in the queue with a fresh trigger.
      if (isCompletion) {
        const pending = wsRetryQueue.get(sessionId) || [];
        const existingIdx = pending.findIndex(p => p.agentProfile.agentId === agentId);
        const entry: PendingRetry = {
          agentProfile,
          spaceId,
          sessionId,
          triggerMsg,
          onlineAgents,
          addedAt: Date.now(),
        };
        if (existingIdx >= 0) {
          pending[existingIdx] = entry;
        } else {
          pending.push(entry);
        }
        wsRetryQueue.set(sessionId, pending);
        lastCompletionEval.set(`${agentId}:${sessionId}`, Date.now());
        log(`atheism: [WS] ${agentId}@${sessionId} completion signal → queued for lock-release drain (${pending.length} pending)`);
        continue; // Don't call processSessionMessage — wait for handleLockReleased
      }

      // ── Human messages: process directly (claim lock) ──
      const started = await processSessionMessage(
        cfg, spaceConfig, sessionId, triggerMsg, onlineAgents, [], agentId, amAlone, agentProfile
      );

      // 🆕 Lock denied in WS mode → queue for retry when lock is released
      if (!started) {
        const pending = wsRetryQueue.get(sessionId) || [];
        // Deduplicate: only one entry per agent per session
        const existingIdx = pending.findIndex(p => p.agentProfile.agentId === agentId);
        const entry: PendingRetry = {
          agentProfile,
          spaceId,
          sessionId,
          triggerMsg,
          onlineAgents,
          addedAt: Date.now(),
        };
        if (existingIdx >= 0) {
          pending[existingIdx] = entry; // Replace with fresher trigger
        } else {
          pending.push(entry);
        }
        wsRetryQueue.set(sessionId, pending);
        log(`atheism: [WS] ${agentId}@${sessionId} lock denied, queued for retry (${pending.length} pending)`);
      }
    }
  }

  // 📋 Handle summary_request: quiesce hook triggers designated reporter to summarize
  async function handleSummaryRequest(event: { space_id?: string; session_id?: string; reporter?: string }) {
    const sessionId = event.session_id;
    const spaceId = event.space_id;
    const reporter = event.reporter;
    if (!sessionId || !spaceId || !reporter) return;

    log(`atheism: [WS] 📋 summary_request for ${reporter} in ${sessionId}`);

    // Find the reporter agent profile
    const reporterProfile = agentProfiles.find(p => p.agentId === reporter);
    if (!reporterProfile) {
      log(`atheism: [WS] 📋 reporter ${reporter} not in local agent profiles, ignoring`);
      return;
    }

    // Skip if reporter is busy
    const existingJob = getActiveJobForAgent(reporter, sessionId);
    if (existingJob) {
      log(`atheism: [WS] 📋 reporter ${reporter} is busy, skipping summary request`);
      return;
    }

    // Create synthetic trigger message for the reporter
    const synthMsgId = `summary_request_${sessionId}_${Date.now()}`;
    const synthMessage: A2AMessage = {
      message_id: synthMsgId,
      session_id: sessionId,
      space_id: spaceId,
      type: 'human_job',
      from_agent: 'system',
      from_name: 'System',
      content: {
        job: `[SUMMARY_REQUEST] 所有 Agent 已完成讨论。作为本次任务的汇报人，请整合前面所有讨论内容，向人类提供简洁的任务总结。`,
        job_id: synthMsgId,
      },
      timestamp: new Date().toISOString(),
    };

    // Fetch current online agents and eval locks
    let onlineAgents: OnlineAgent[] = [];
    let evalLocks: EvalLock[] = [];
    try {
      const res = await fetch(`${a2aConfig!.apiUrl}/spaces/${spaceId}/status`);
      if (res.ok) {
        const data = await res.json() as any;
        onlineAgents = data.online_agents || [];
        evalLocks = data.eval_locks || [];
      }
    } catch {}

    const spaceConfig = { ...a2aConfig, spaceId } as A2ASpaceConfig;
    const amAlone = onlineAgents.length <= 1;

    // Go through processSessionMessage to properly handle eval lock
    const started = await processSessionMessage(
      cfg, spaceConfig, sessionId, synthMessage,
      onlineAgents, evalLocks, reporter, amAlone, reporterProfile,
    );
    if (!started) {
      log(`atheism: [WS] 📋 summary request for ${reporter} could not start (lock busy?), queuing retry`);
      // Add to retry queue so it gets picked up when the lock is released
      const pending = wsRetryQueue.get(sessionId) || [];
      pending.push({
        agentProfile: reporterProfile,
        spaceId,
        sessionId,
        triggerMsg: synthMessage,
        onlineAgents,
        addedAt: Date.now(),
      });
      wsRetryQueue.set(sessionId, pending);
    }
  }

  // ⏹ Handle session_interrupted: hard-interrupt all active jobs for the session
  async function handleSessionInterrupted(event: { space_id?: string; session_id?: string; released_locks?: string[]; finalized_messages?: number }) {
    const sessionId = event.session_id;
    if (!sessionId) return;
    
    log(`atheism: [WS] ⏹ session_interrupted: ${sessionId} (locks: ${event.released_locks?.join(',') || 'none'}, msgs: ${event.finalized_messages || 0})`);
    
    // Abort ALL active jobs for this session
    // skipMessageUpdate=true: server already finalized all streaming messages during interrupt.
    // If we send another PUT here, the non-NO_REPLY result triggers resetQuiesce on the server,
    // which clears BOTH quiesce AND the poison pill — undoing the entire interrupt.
    const allJobs = getAllActiveJobs();
    let aborted = 0;
    for (const [, job] of allJobs) {
      if (job.sessionId === sessionId) {
        await abortActiveJob(sessionId, "用户硬中断", job.agentId, /* skipMessageUpdate */ true);
        aborted++;
      }
    }
    
    // Also clear any pending retry queue entries for this session
    wsRetryQueue.delete(sessionId);
    
    log(`atheism: [WS] ⏹ session ${sessionId}: aborted ${aborted} active jobs, cleared retry queue`);
  }

  // 🆕 Handle eval_lock_released: drain retry queue for the released session
  async function handleLockReleased(event: { space_id?: string; session_id?: string; released_by?: string; online_agents?: OnlineAgent[] }) {
    const sessionId = event.session_id;
    const spaceId = event.space_id;
    if (!sessionId || !spaceId) return;

    const pending = wsRetryQueue.get(sessionId);
    if (!pending || pending.length === 0) return;

    // Mutex: skip if sweep is already draining
    if (retryQueueProcessing) {
      // 🩹 Fix: refresh addedAt BEFORE deferring to prevent expiry during the wait.
      // Without this, a sweep running during the 200ms deferral could filter out
      // entries whose addedAt > 60s ago, permanently losing queued agents.
      const deferPending = wsRetryQueue.get(sessionId);
      if (deferPending) {
        const deferNow = Date.now();
        wsRetryQueue.set(sessionId, deferPending.map(p => ({ ...p, addedAt: deferNow })));
      }
      log(`atheism: [WS] handleLockReleased deferred for ${sessionId} — sweep in progress, TTL refreshed`);
      setTimeout(() => handleLockReleased(event), 200);
      return;
    }
    retryQueueProcessing = true;

    try {
      const now = Date.now();
      const validEntries = pending.filter(p => now - p.addedAt < WS_RETRY_MAX_AGE_MS);
      if (validEntries.length === 0) {
        wsRetryQueue.delete(sessionId);
        return;
      }

      log(`atheism: [WS] eval_lock_released by ${event.released_by} in ${sessionId}, retrying ${validEntries.length} pending agents`);

      // Use fresh online_agents from the event if available
      const freshOnlineAgents = event.online_agents || validEntries[0].onlineAgents;

      // Shuffle to avoid lock starvation (same agent always first)
      const shuffled = [...validEntries].sort(() => Math.random() - 0.5);

      // Track which agents we've processed (success or skip)
      const processedAgentIds = new Set<string>();
      let lockTaken = false;

      for (const entry of shuffled) {
        const { agentProfile, spaceId: entrySpaceId, triggerMsg } = entry;
        const agentId = agentProfile.agentId;

        // Skip the agent that just released (they already processed)
        if (agentId === event.released_by) {
          processedAgentIds.add(agentId);
          continue;
        }

        // Skip if agent now has an active job in this session
        const existingJob = getActiveJobForAgent(agentId, sessionId);
        if (existingJob) {
          processedAgentIds.add(agentId);
          continue;
        }

        // Skip if paused
        if (pausedSessions.has(sessionId)) {
          processedAgentIds.add(agentId);
          continue;
        }

        const spaceConfig = { ...a2aConfig, spaceId: entrySpaceId } as A2ASpaceConfig;
        const amAlone = freshOnlineAgents.length <= 1;

        const started = await processSessionMessage(
          cfg, spaceConfig, sessionId, triggerMsg, freshOnlineAgents, [], agentId, amAlone, agentProfile
        );

        if (started) {
          log(`atheism: [WS] retry succeeded for ${agentId}@${sessionId}`);
          processedAgentIds.add(agentId);
          lockTaken = true;
          break; // Only one agent can hold the lock, stop here
        }
        // If lock denied (started=false), DON'T mark as processed — keep in queue for next release
      }

      // Update queue: remove only successfully processed agents, keep the rest
      const remaining = validEntries
        .filter(e => !processedAgentIds.has(e.agentProfile.agentId));
      if (remaining.length > 0) {
        // Fix 1a: Only refresh TTL when a lock was taken (someone is processing,
        // remaining agents genuinely need to wait). When no lock taken, let entries
        // naturally expire via WS_RETRY_MAX_AGE_MS to prevent infinite queue.
        const finalRemaining = lockTaken
          ? remaining.map(e => ({ ...e, addedAt: Date.now() }))
          : remaining;
        wsRetryQueue.set(sessionId, finalRemaining);
        if (lockTaken) {
          log(`atheism: [WS] ${remaining.length} agents re-queued for ${sessionId} (TTL refreshed)`);
        }
      } else {
        wsRetryQueue.delete(sessionId);
      }
    } finally {
      retryQueueProcessing = false;
    }
  }

  // Start WebSocket connection (non-blocking)
  connectWebSocket();

  // 🆕 Defensive sweep: periodically drain stale retry queue entries
  // Handles edge cases where eval_lock_released WS event is lost
  const retrySweepTimer = setInterval(async () => {
    // Mutex: skip if handleLockReleased is already draining
    if (retryQueueProcessing) return;
    retryQueueProcessing = true;
    try {
      const now = Date.now();
      for (const [sessionId, pending] of wsRetryQueue) {
        // Remove expired entries
        const valid = pending.filter(p => now - p.addedAt < WS_RETRY_MAX_AGE_MS);
        if (valid.length === 0) {
          wsRetryQueue.delete(sessionId);
          continue;
        }
        // Try processing — shuffle to avoid head-of-queue starvation
        const shuffled = [...valid].sort(() => Math.random() - 0.5);
        let anyStarted = false;
        const processedAgentIds = new Set<string>();
        for (const entry of shuffled) {
          const spaceConfig = { ...a2aConfig, spaceId: entry.spaceId } as A2ASpaceConfig;
          const amAlone = entry.onlineAgents.length <= 1;
          const started = await processSessionMessage(
            cfg, spaceConfig, sessionId, entry.triggerMsg, entry.onlineAgents, [], entry.agentProfile.agentId, amAlone, entry.agentProfile
          );
          if (started) {
            log(`atheism: [SWEEP] retry succeeded for ${entry.agentProfile.agentId}@${sessionId}`);
            processedAgentIds.add(entry.agentProfile.agentId);
            anyStarted = true;
            break; // One agent got the lock, others wait for next cycle
          }
        }
        // Remove processed entries, keep the rest
        if (anyStarted) {
          // Fix 1a: Refresh addedAt when someone got the lock — remaining agents
          // genuinely need to wait for this lock holder to finish.
          const remaining = valid
            .filter(e => !processedAgentIds.has(e.agentProfile.agentId))
            .map(e => ({ ...e, addedAt: Date.now() }));
          if (remaining.length > 0) {
            wsRetryQueue.set(sessionId, remaining);
          } else {
            wsRetryQueue.delete(sessionId);
          }
        } else {
          // Fix 1a: Nobody could get the lock AND nobody started processing.
          // DON'T refresh addedAt — let entries naturally expire via WS_RETRY_MAX_AGE_MS.
          // This prevents infinite queue accumulation when the session is stuck
          // (e.g., orphaned lock, interrupted session).
          // The entries will be retried each sweep cycle until they expire.
          wsRetryQueue.set(sessionId, valid); // Keep as-is, no TTL refresh
        }
      }
    } finally {
      retryQueueProcessing = false;
    }
  }, 5000); // Every 5s

  return new Promise<void>((resolve) => {
    if (abortSignal) {
      abortSignal.addEventListener("abort", () => {
        clearInterval(retrySweepTimer);
        log("atheism: monitor aborted");
        resolve();
      });
    }

    // 🆕 Per-combo 退避：每个 agentId:spaceId 独立跟踪错误状态
    // 替代旧的全局 consecutiveErrors，避免一个 space 故障拖慢所有 space
    // 也避免恢复时 240 个 combo 同时 thundering herd
    const comboBackoff = new Map<string, { errors: number; lastError: number }>();
    const MAX_BACKOFF_MS = 30_000; // 最大 30s

    const poll = async () => {
      if (abortSignal?.aborted) { resolve(); return; }

      // 🆕 刷新 membership 缓存
      await refreshMembership();

      // 🆕 WebSocket push mode: skip HTTP polling when connected
      // Exception: wsCatchUpNeeded — run one HTTP poll cycle after reconnect to cover the gap
      if (wsConnected && !wsCatchUpNeeded) {
        if (!abortSignal?.aborted) {
          setTimeout(poll, pollIntervalMs * 30); // Slower fallback (30x normal interval)
        }
        return;
      }
      if (wsCatchUpNeeded) {
        log(`atheism: [WS] catch-up poll running to cover disconnect gap`);
        wsCatchUpNeeded = false;
      }

      // 🆕 遍历每个逻辑 Agent（随机打乱顺序，防止锁饥饿）
      const shuffledProfiles = [...agentProfiles].sort(() => Math.random() - 0.5);
      for (const agentProfile of shuffledProfiles) {
        const agentId = agentProfile.agentId;


        for (const spaceId of spaceIds) {
          // 🆕 只在已加入的 space 工作（发心跳 + 处理消息）
          // 🔒 缓存为空时也跳过——防止重启时全量 poll 触发 server 自动注册
          const agentSpaces = membershipCache.get(agentId);
          if (!agentSpaces || !agentSpaces.has(spaceId)) continue;
          // 🆕 Per-combo 退避：跳过处于退避期的组合
          const comboKey = `${agentId}:${spaceId}`;
          const backoff = comboBackoff.get(comboKey);
          if (backoff) {
            const backoffDelay = Math.min(pollIntervalMs * Math.pow(2, backoff.errors), MAX_BACKOFF_MS);
            if (Date.now() - backoff.lastError < backoffDelay) continue;
          }
          try {
            const spaceConfig = { ...a2aConfig, spaceId } as A2ASpaceConfig;
            const tsKey = `${agentId}:${spaceId}`;
            const since = lastTimestamps.get(tsKey) || Date.now();

            // 每个 Agent 独立 poll（server 为每个 agent_id 分别做心跳）
            const { messages, next_since, online_agents, eval_locks, session_mutes } = await fetchA2AMessages({
              config: spaceConfig,
              since,
              agentProfile,
            });

            // 🆕 成功 → 清除该组合的退避状态
            comboBackoff.delete(comboKey);

            if (messages.length > 0) {
              log(`atheism: [${agentId}@${spaceId}] received ${messages.length} message(s), online: [${online_agents.map(a => a.agent_id).join(', ')}]`);
            }

            // 判断是否只有自己在线（排除同一 OpenClaw 实例的所有逻辑 Agent）
            const selfAgentIds = new Set(agentProfiles.map(a => a.agentId));
            const externalAgents = online_agents.filter(a => !selfAgentIds.has(a.agent_id));
            // 多 Agent 模式下：同实例的兄弟 Agent 也算"多人"
            const amAlone = online_agents.length <= 1;

            // 按 session 分组（排除自己的消息）
            const bySession = new Map<string, A2AMessage[]>();
            const sessionsWithCompletions = new Set<string>();
            let hasUnprocessedMessages = false; // 🆕 追踪是否有消息因锁被拒未处理
            
            for (const msg of messages) {
              if (msg.from_agent === agentId) continue;
              // 🛡️ 跳过残缺消息（缺少 content/type 的 zombie placeholder）
              if (!msg.content || !msg.type) continue;
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
                // 检查当前 poll 窗口是否有新 @human（跳过 human/moderator 消息）
                for (const m of sessionMsgs) {
                  const t = String(m.content?.result || m.content?.job || m.content?.message || '');
                  const isMod = m.content?.metadata?.moderator === true || (m as any).metadata?.moderator === true;
                  const isFromHuman = m.from_agent === 'human';
                  const isAgentResp = m.type === 'human_job_response';
                  // Defense-in-depth: only agent responses can trigger @human pause
                  if (isAgentResp && !isFromHuman && !isMod && /@human\b/i.test(stripQuotedContent(t)) && !pausedSessions.has(sid)) {
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
                  const interruptText = newHumanMsg.content?.job || newHumanMsg.content?.message || '';
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
                  if (!started) {
                    hasUnprocessedMessages = true;
                    // 🆕 Bridge polling → WS retry queue: catch-up poll 中被拒的 agent
                    // 不会被 WS retry 机制覆盖，导致锁释放后无人重试（死信）。
                    // 写入 retry queue 后，handleLockReleased 可以 drain 它们。
                    if (wsConnected) {
                      const pending = wsRetryQueue.get(sid) || [];
                      const existingIdx = pending.findIndex(p => p.agentProfile.agentId === agentId);
                      const entry: PendingRetry = { agentProfile, spaceId, sessionId: sid, triggerMsg: newHumanMsg, onlineAgents: online_agents, addedAt: Date.now() };
                      if (existingIdx >= 0) pending[existingIdx] = entry; else pending.push(entry);
                      wsRetryQueue.set(sid, pending);
                      log(`atheism: [POLL→WS] ${agentId}@${sid} lock denied in poll, bridged to WS retry queue (${pending.length} pending)`);
                    } else {
                      log(`atheism: [POLL] ${agentId}@${sid} human msg lock denied, WS disconnected — relying on since-hold for next poll retry`);
                    }
                  }
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
                const triggerText = latestMsg.content?.job || latestMsg.content?.result || latestMsg.content?.message || '';
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
                
                // ── Fix 3b (poll path): Completion signals only queue, don't process directly ──
                // Same as the WS path: decouple completion signals from direct processSessionMessage calls.
                // Lock release (via handleLockReleased or sweep) is the sole trigger for queued agents.
                if (isCompletionSignal) {
                  const triggerMsg = { ...latestMsg, message_id: `${latestMsg.message_id}_completed_${agentId}_${Date.now()}` };
                  // Consume all completion candidates to prevent re-triggering
                  for (const m of sessionMsgs) {
                    const isCandidate = m.type === 'human_job_response' && 
                        m.content?.streaming === false && m.updated_at;
                    if (isCandidate) {
                      processedCompletions.add(`${agentId}:${m.message_id}`);
                    }
                  }
                  lastCompletionEval.set(`${agentId}:${sid}`, Date.now());
                  // Queue for retry (WS or sweep will drain)
                  if (wsConnected) {
                    const pending = wsRetryQueue.get(sid) || [];
                    const existingIdx = pending.findIndex(p => p.agentProfile.agentId === agentId);
                    const entry: PendingRetry = { agentProfile, spaceId, sessionId: sid, triggerMsg, onlineAgents: online_agents, addedAt: Date.now() };
                    if (existingIdx >= 0) pending[existingIdx] = entry; else pending.push(entry);
                    wsRetryQueue.set(sid, pending);
                  }
                  log(`atheism: [${agentId}@${sid}] completion signal from ${latestMsg.from_agent} → queued (not direct-processed)`);
                  continue;
                }
                
                // 🆕 Bug fix: humanAlreadyProcessed + no completion signal = nothing to do
                if (humanAlreadyProcessed) {
                  continue;
                }
                
                const started = await processSessionMessage(cfg, spaceConfig, sid, latestMsg, online_agents, eval_locks, agentId, amAlone, agentProfile);
                
                // Human message 锁被拒时阻止 since 推进
                if (!started) {
                  hasUnprocessedMessages = true;
                  // Bridge polling → WS retry queue
                  if (wsConnected) {
                    const pending = wsRetryQueue.get(sid) || [];
                    const existingIdx = pending.findIndex(p => p.agentProfile.agentId === agentId);
                    const entry: PendingRetry = { agentProfile, spaceId, sessionId: sid, triggerMsg: latestMsg, onlineAgents: online_agents, addedAt: Date.now() };
                    if (existingIdx >= 0) pending[existingIdx] = entry; else pending.push(entry);
                    wsRetryQueue.set(sid, pending);
                    log(`atheism: [POLL→WS] ${agentId}@${sid} lock denied in poll, bridged to WS retry queue (${pending.length} pending)`);
                  } else {
                    log(`atheism: [POLL] ${agentId}@${sid} lock denied, WS disconnected — relying on since-hold for next poll retry`);
                  }
                }
              }
            }

            // 🆕 只在所有消息都成功处理（或无消息）时推进 since
            // 如果有消息因锁被拒未处理，保持 since 不变，下次 poll 重试
            if (!hasUnprocessedMessages) {
              lastTimestamps.set(tsKey, next_since);
            } else if (!lastTimestamps.has(tsKey)) {
              // 🆕 Fix: 重启后首次 poll 用 Date.now() 作为 since。如果有消息因锁被拒，
              // since 不推进但 lastTimestamps 从未初始化 → 下次 poll 再用 Date.now()
              // → 时间已过 → 消息落在 since 后面，永远无法被 poll 到。
              // 修复：锁定当前 since 值，使后续 poll 能重新拿到同一批消息。
              lastTimestamps.set(tsKey, since);
            }
            // 🆕 标记首轮 poll 完成，后续 poll 允许 completion signal
            firstPollDone.add(tsKey);
          } catch (err) {
            error(`atheism: [${agentId}@${spaceId}] poll error: ${err}`);
            // 🆕 Per-combo 退避：该组合独立退避，不影响其他 space
            const prev = comboBackoff.get(comboKey);
            const errCount = (prev?.errors || 0) + 1;
            comboBackoff.set(comboKey, { errors: errCount, lastError: Date.now() });
            if (errCount === 1 || errCount % 10 === 0) {
              const nextDelay = Math.min(pollIntervalMs * Math.pow(2, errCount), MAX_BACKOFF_MS);
              error(`atheism: [${agentId}@${spaceId}] backoff: ${errCount} consecutive errors, next retry in ${nextDelay}ms`);
            }
          }
        }
      }

      if (!abortSignal?.aborted) {
        // 🆕 固定 poll 间隔：退避由 per-combo 独立处理
        // 处于退避的组合被 skip，不产生 HTTP 请求，所以 poll 循环本身轻量
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
  cfg: OpenClawConfig,
  spaceConfig: A2ASpaceConfig,
  sessionId: string,
  message: A2AMessage,
  onlineAgents: OnlineAgent[],
  evalLocks: EvalLock[],
  agentId: string,
  amAlone: boolean,
  agentProfile: AgentProfile,
): Promise<boolean> {
  const log = console.log;
  const error = console.error;

  // ── Fix 3a: Synchronous processing guard ──
  // Prevents the same agent from being dispatched twice for the same session
  // when WS event and retry queue drain race past the async getActiveJobForAgent check.
  const guardKey = `${agentId}:${sessionId}`;
  if (processingGuard.has(guardKey)) {
    log(`atheism: [${agentId}@${sessionId}] processing guard hit, skipping duplicate trigger`);
    return false;
  }
  processingGuard.add(guardKey);

  if (amAlone) {
    log(`atheism: [${agentId}@${sessionId}] solo mode, processing directly`);
    handleA2AMessage({ cfg, message, config: spaceConfig, onlineAgents, agentProfile })
      .catch(err => error(`atheism: [BG] error: ${err}`))
      .finally(() => processingGuard.delete(guardKey));
    return true;
  }

  // 多人在线 → 评估锁
  // P2 fix: wrap multi-agent path in try-catch to prevent processingGuard leak
  // if claimEvalLock (HTTP call) throws, the guard key must be cleaned up
  try {
  const sessionLock = evalLocks.find(l => l.session_id === sessionId);
  
  if (sessionLock && sessionLock.holder !== agentId) {
    log(`atheism: [${agentId}@${sessionId}] eval lock held by ${sessionLock.holder}, skipping`);
    processingGuard.delete(guardKey);
    return false;
  }

  const claim = await claimEvalLock({ config: spaceConfig, sessionId, agentId });
  
  if (!claim.granted) {
    // 🆕 Hard limit denial: 不重试，直接放弃
    if (claim.reason === 'round_response_hard_limit') {
      log(`atheism: [${agentId}@${sessionId}] eval DENIED: round response hard limit (${claim.responders_count} responders), skipping`);
      processingGuard.delete(guardKey);
      // 通知 server NO_REPLY 用于 quiesce 追踪
      try {
        const { apiUrl, spaceId } = spaceConfig;
        await fetch(`${apiUrl}/spaces/${spaceId}/sessions/${sessionId}/no-reply`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agent_id: agentId }),
        });
      } catch {}
      return true; // 返回 true 表示"已处理"，不进入 retry queue
    }
    log(`atheism: [${agentId}@${sessionId}] eval lock denied (held by: ${claim.held_by}), will retry`);
    processingGuard.delete(guardKey);
    return false;
  }

  log(`atheism: [${agentId}@${sessionId}] eval lock acquired, processing`);

  // 🆕 First Responder: 从 eval/claim 响应中提取
  const firstResponder = claim.first_responder || null;
  // 🆕 Lock version: _nonce for orphan write prevention
  const lockVersion = claim.lock_version;
  // 🆕 Round response limit info
  const respondersCount = claim.responders_count;
  const responseLimit = claim.response_limit;
  const isMentioned = claim.is_mentioned;
  const responders = claim.responders;

  // 🆕 锁续期定时器：每 30s 续一次，防止长任务（写代码等）超过 60s TTL 被回收
  const renewInterval = setInterval(async () => {
    try {
      const renewal = await claimEvalLock({ config: spaceConfig, sessionId, agentId });
      if (!renewal.granted) {
        error(`atheism: [${agentId}@${sessionId}] ⚠️ lock renewal DENIED (held by: ${renewal.held_by}), aborting job`);
        await abortActiveJob(sessionId, "锁续期被拒，其他 Agent 已接管", agentId);
        clearInterval(renewInterval);
      }
    } catch (err) {
      error(`atheism: [${agentId}@${sessionId}] ⚠️ lock renewal FAILED: ${err}, aborting job (treat as lock lost)`);
      await abortActiveJob(sessionId, "锁续期请求失败（网络/server 异常），视为锁丢失", agentId);
      clearInterval(renewInterval);
    }
  }, 30000);

  // fire-and-forget: 不阻塞 poll 循环，让其他 space/agent 继续工作
  handleA2AMessage({ cfg, message, config: spaceConfig, onlineAgents, agentProfile, firstResponder, lockVersion, respondersCount, responseLimit, isMentioned, responders })
    .catch(err => error(`atheism: [${agentId}@${sessionId}] error during locked processing: ${err}`))
    .finally(async () => {
      clearInterval(renewInterval);
      processingGuard.delete(guardKey);
      // P0: 释放 lock 前，确保自己的 streaming 消息已 finalize
      // Fix 2b: 检查 activeJob 是否已被清除（abort/interrupt 路径会先清 activeJob）
      // 如果已清除，说明 abort 路径已经处理了 streaming cleanup，这里只需释放锁
      const jobStillActive = getActiveJobForAgent(agentId, sessionId);
      if (jobStillActive) {
        try {
          const cleaned = await finalizeAgentStreaming({ config: spaceConfig, sessionId, agentId });
          if (cleaned > 0) log(`atheism: [${agentId}@${sessionId}] P0 finalized ${cleaned} streaming msg(s) before lock release`);
        } catch {}
      } else {
        log(`atheism: [${agentId}@${sessionId}] job already cleared (abort/complete), skipping streaming finalize in finally`);
      }
      await releaseEvalLock({ config: spaceConfig, sessionId, agentId, lockVersion });
      log(`atheism: [${agentId}@${sessionId}] eval lock released (nonce: ${lockVersion || 'none'})`);
    });
  return true;
  } catch (err) {
    // P2: claimEvalLock or other async call threw — clean up guard to prevent permanent deadlock
    error(`atheism: [${agentId}@${sessionId}] processSessionMessage error, clearing guard: ${err}`);
    processingGuard.delete(guardKey);
    throw err; // re-throw to preserve existing caller error semantics
  }
}

import type { A2ASpaceConfig, A2ASession, PollResponse, AgentProfile } from "./types.js";

export async function fetchA2AMessages(params: {
  config: A2ASpaceConfig;
  since: number;
  sessionId?: string;
  /** 当前轮询的 Agent 身份（多 Agent 模式下每个 Agent 独立 poll） */
  agentProfile?: AgentProfile;
}): Promise<PollResponse> {
  const { config, since, sessionId, agentProfile } = params;
  const { apiUrl, spaceId } = config;

  // 优先使用传入的 agentProfile，否则回退到 config 顶层字段
  const agentId = agentProfile?.agentId || config.agentId;
  const agentName = agentProfile?.agentName || config.agentName;
  const capabilities = agentProfile?.capabilities || config.capabilities;
  const description = agentProfile?.description || config.description;

  let url = `${apiUrl}/spaces/${spaceId}/messages?since=${since}`;
  
  // 附带 agent 信息 → server 用于心跳 + 自动注册
  if (agentId) url += `&agent_id=${encodeURIComponent(agentId)}`;
  if (agentName) url += `&agent_name=${encodeURIComponent(agentName)}`;
  if (capabilities?.length) url += `&agent_capabilities=${encodeURIComponent(JSON.stringify(capabilities))}`;
  if (description) url += `&agent_description=${encodeURIComponent(description)}`;
  
  if (sessionId) url += `&session_id=${sessionId}`;
  
  const res = await fetch(url, {
    headers: { "ngrok-skip-browser-warning": "true" },
  });

  if (!res.ok) {
    throw new Error(`Atheism API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  return {
    messages: data.messages || [],
    next_since: data.next_since ?? Date.now(),
    online_agents: data.online_agents || [],
    eval_locks: data.eval_locks || [],
    session_mutes: data.session_mutes || {},
  };
}

export async function fetchA2ASessions(params: {
  config: A2ASpaceConfig;
  status?: string;
}): Promise<{ sessions: A2ASession[] }> {
  const { config, status } = params;
  const { apiUrl, spaceId } = config;

  let url = `${apiUrl}/spaces/${spaceId}/sessions`;
  if (status) {
    url += `?status=${status}`;
  }
  
  const res = await fetch(url, {
    headers: { "ngrok-skip-browser-warning": "true" },
  });

  if (!res.ok) {
    throw new Error(`Atheism API error: ${res.status} ${res.statusText}`);
  }

  return res.json();
}

export async function createA2ASession(params: {
  config: A2ASpaceConfig;
  title?: string;
  createdBy?: string;
}): Promise<A2ASession> {
  const { config, title, createdBy } = params;
  const { apiUrl, spaceId } = config;

  const url = `${apiUrl}/spaces/${spaceId}/sessions`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "ngrok-skip-browser-warning": "true",
    },
    body: JSON.stringify({
      title,
      created_by: createdBy || "agent",
    }),
  });

  if (!res.ok) {
    throw new Error(`Atheism API error: ${res.status} ${res.statusText}`);
  }

  return res.json();
}

/** Usage metadata attached to agent responses */
export type MessageUsage = {
  model?: string;
  provider?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  cost_usd?: number;
  duration_ms?: number;
};

export async function createA2AResponse(params: {
  config: A2ASpaceConfig;
  jobId: string;
  sessionId: string;
  initialResult: string;
  /** 发送消息的 Agent ID（多 Agent 模式） */
  agentId?: string;
  /** Token usage metadata */
  usage?: MessageUsage;
  /** 🆕 Lock version for orphan write prevention */
  lockVersion?: string;
}): Promise<string> {
  const { config, jobId, sessionId, initialResult, agentId, usage, lockVersion } = params;
  const { apiUrl, spaceId } = config;
  const fromAgent = agentId || config.agentId;

  const content: Record<string, unknown> = {
    job_id: jobId,
    result: initialResult,
    streaming: true,
  };
  if (usage) content.usage = usage;

  const body: Record<string, unknown> = {
    from: fromAgent,
    type: "human_job_response",
    session_id: sessionId,
    content,
  };
  if (lockVersion) body.lock_version = lockVersion;

  const url = `${apiUrl}/spaces/${spaceId}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "ngrok-skip-browser-warning": "true",
    },
    body: JSON.stringify(body),
  });

  if (res.status === 409) {
    // 🆕 Lock version mismatch — orphan write, silently discard
    throw new Error('LOCK_VERSION_MISMATCH');
  }

  if (!res.ok) {
    throw new Error(`Atheism API error: ${res.status} ${res.statusText}`);
  }

  const { message_id } = await res.json();
  return message_id;
}

export async function updateA2AMessage(params: {
  config: A2ASpaceConfig;
  messageId: string;
  result?: string;
  streaming?: boolean;
  /** Message metadata (model/token info), attached on final delivery */
  metadata?: Record<string, unknown>;
  /** 🆕 Lock version for orphan write prevention */
  lockVersion?: string;
}): Promise<void> {
  const { config, messageId, result, streaming, metadata, lockVersion } = params;
  const { apiUrl, spaceId } = config;

  const url = `${apiUrl}/spaces/${spaceId}/messages/${messageId}`;

  const body: Record<string, unknown> = {};
  if (result !== undefined) {
    body.content = { result, streaming: streaming ?? false };
  }
  if (metadata) {
    body.metadata = metadata;
  }
  if (lockVersion) {
    body.lock_version = lockVersion;
  }

  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "ngrok-skip-browser-warning": "true",
    },
    body: JSON.stringify(body),
  });

  if (res.status === 409) {
    // 🆕 Lock version mismatch — orphan write, silently discard
    throw new Error('LOCK_VERSION_MISMATCH');
  }

  // 404 = message already deleted or session cleaned up — stale reference, silently discard
  if (res.status === 404) {
    return;
  }

  if (!res.ok) {
    throw new Error(`Atheism API error: ${res.status} ${res.statusText}`);
  }
}

/** 获取 session 的完整消息历史 */
export async function fetchSessionMessages(params: {
  config: A2ASpaceConfig;
  sessionId: string;
  limit?: number;
}): Promise<A2AMessage[]> {
  const { config, sessionId, limit = 30 } = params;
  const { apiUrl, spaceId } = config;

  const url = `${apiUrl}/spaces/${spaceId}/sessions/${sessionId}/messages?limit=${limit}`;
  const res = await fetch(url, {
    headers: { "ngrok-skip-browser-warning": "true" },
  });

  if (!res.ok) {
    throw new Error(`Atheism API error: ${res.status} ${res.statusText}`);
  }

  const { messages } = await res.json();
  return messages;
}

/** 删除一条消息（用于撤回 NO_REPLY 的占位消息） */
export async function deleteA2AMessage(params: {
  config: A2ASpaceConfig;
  messageId: string;
}): Promise<void> {
  const { config, messageId } = params;
  const { apiUrl, spaceId } = config;

  const url = `${apiUrl}/spaces/${spaceId}/messages/${messageId}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: { "ngrok-skip-browser-warning": "true" },
  });

  // 404 = already deleted, that's fine
  if (!res.ok && res.status !== 404) {
    throw new Error(`Atheism API error: ${res.status} ${res.statusText}`);
  }
}

/** 获取 space 的自定义规则 */
export async function fetchCustomRules(params: {
  config: A2ASpaceConfig;
}): Promise<string> {
  const { config } = params;
  const { apiUrl, spaceId } = config;

  const url = `${apiUrl}/spaces/${spaceId}/system-prompt`;
  const res = await fetch(url, {
    headers: { "ngrok-skip-browser-warning": "true" },
  });

  if (!res.ok) return "";

  const { custom_rules } = await res.json();
  return custom_rules || "";
}

// ─── 评估锁 API ─────────────────────────────────────────

/** 尝试获取 session 评估锁 */
export async function claimEvalLock(params: {
  config: A2ASpaceConfig;
  sessionId: string;
  /** 用哪个 Agent 身份 claim（多 Agent 模式） */
  agentId?: string;
}): Promise<{
  granted: boolean;
  held_by?: string;
  reason?: string;
  lock_version?: string;
  first_responder?: { agent_id: string; agent_name?: string; responded_at: number } | null;
  responders_count?: number;
  response_limit?: 'normal' | 'soft_limited' | 'hard_limited';
  is_mentioned?: boolean;
  responders?: Array<{ agent_id: string; agent_name: string }>;
}> {
  const { config, sessionId, agentId } = params;
  const { apiUrl, spaceId } = config;
  const claimAgent = agentId || config.agentId;

  try {
    const url = `${apiUrl}/spaces/${spaceId}/sessions/${sessionId}/eval/claim`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "ngrok-skip-browser-warning": "true",
      },
      body: JSON.stringify({ agent_id: claimAgent }),
    });

    if (!res.ok) {
      return { granted: false };
    }

    return res.json();
  } catch {
    return { granted: false };
  }
}

/** 释放 session 评估锁 */
export async function releaseEvalLock(params: {
  config: A2ASpaceConfig;
  sessionId: string;
  /** 用哪个 Agent 身份 release（多 Agent 模式） */
  agentId?: string;
  /** 传入 acquire 时返回的 lock_version，server 端 nonce 不匹配时拒绝释放（防止旧 job 释放新 job 的锁） */
  lockVersion?: string;
}): Promise<void> {
  const { config, sessionId, agentId, lockVersion } = params;
  const { apiUrl, spaceId } = config;
  const releaseAgent = agentId || config.agentId;

  try {
    const url = `${apiUrl}/spaces/${spaceId}/sessions/${sessionId}/eval/release`;
    const body: Record<string, string> = { agent_id: releaseAgent };
    if (lockVersion) body.lock_version = lockVersion;
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "ngrok-skip-browser-warning": "true",
      },
      body: JSON.stringify(body),
    });
  } catch {
    // best-effort release
  }
}

/** 获取 session summary */
export async function fetchSessionSummary(params: {
  config: A2ASpaceConfig;
  sessionId: string;
}): Promise<{ summary_text: string; last_message_id: string | null; message_count: number } | null> {
  const { config, sessionId } = params;
  const { apiUrl, spaceId } = config;
  try {
    const res = await fetch(`${apiUrl}/spaces/${spaceId}/sessions/${sessionId}/summary`, {
      headers: { "ngrok-skip-browser-warning": "true" },
    });
    if (!res.ok) return null;
    const { summary } = await res.json();
    return summary;
  } catch {
    return null;
  }
}

/** 更新 session summary */
export async function updateSessionSummary(params: {
  config: A2ASpaceConfig;
  sessionId: string;
  summaryText: string;
  lastMessageId?: string;
  messageCount?: number;
  agentId: string;
  title?: string;
}): Promise<boolean> {
  const { config, sessionId, summaryText, lastMessageId, messageCount, agentId, title } = params;
  const { apiUrl, spaceId } = config;
  try {
    const body: Record<string, unknown> = {
      summary_text: summaryText,
      last_message_id: lastMessageId,
      message_count: messageCount,
      agent_id: agentId,
    };
    if (title) body.title = title;
    const res = await fetch(`${apiUrl}/spaces/${spaceId}/sessions/${sessionId}/summary`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "ngrok-skip-browser-warning": "true" },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** 获取 space 的 Skill 目录（带 60s 内存缓存） */
const directoryCache = new Map<string, { content: string; ts: number }>();
const DIRECTORY_CACHE_TTL = 60_000;

export async function fetchSkillDirectory(params: {
  config: A2ASpaceConfig;
}): Promise<string | null> {
  const { config } = params;
  const { apiUrl, spaceId } = config;
  const cacheKey = `${apiUrl}:${spaceId}`;
  
  const cached = directoryCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < DIRECTORY_CACHE_TTL) {
    return cached.content;
  }
  
  try {
    const res = await fetch(`${apiUrl}/spaces/${spaceId}/skill-directory`, {
      headers: { "ngrok-skip-browser-warning": "true" },
    });
    if (!res.ok) return null;
    const data = await res.json() as { exists: boolean; content: string };
    if (!data.exists || !data.content) return null;
    directoryCache.set(cacheKey, { content: data.content, ts: Date.now() });
    return data.content;
  } catch {
    return null;
  }
}

/** Fetch rendered collaboration ledger for a session */
export async function fetchLedgerRendered(params: {
  config: A2ASpaceConfig;
  sessionId: string;
}): Promise<string | null> {
  const { config, sessionId } = params;
  const { apiUrl, spaceId } = config;
  try {
    const res = await fetch(`${apiUrl}/spaces/${spaceId}/sessions/${sessionId}/ledger`, {
      headers: { "ngrok-skip-browser-warning": "true" },
    });
    if (!res.ok) return null;
    const data = await res.json() as { rendered: string | null };
    return data.rendered;
  } catch {
    return null;
  }
}

/**
 * 轻量级 NO_REPLY 通知：仅通知 server 用于 quiesce 追踪，不创建任何消息。
 * 替代之前的 "创建 placeholder → 更新为 [NO_REPLY]" 模式，消除可见噪声。
 */
export async function notifyNoReply(params: {
  config: A2ASpaceConfig;
  sessionId: string;
  agentId: string;
}): Promise<{ quiesced: boolean }> {
  const { config, sessionId, agentId } = params;
  const { apiUrl, spaceId } = config;
  try {
    const url = `${apiUrl}/spaces/${spaceId}/sessions/${sessionId}/no-reply`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "ngrok-skip-browser-warning": "true",
      },
      body: JSON.stringify({ agent_id: agentId }),
    });
    if (!res.ok) return { quiesced: false };
    return res.json();
  } catch {
    return { quiesced: false };
  }
}

/**
 * P0 兜底：finalize 指定 agent 在指定 session 内的所有 streaming 消息。
 * 在 processSessionMessage 的 finally 块调用，确保 lock 释放前 streaming 已清理。
 * 与 cleanupZombieStreaming 不同：这个是 session 级精准清理，不改 result 内容。
 */
export async function finalizeAgentStreaming(params: {
  config: A2ASpaceConfig;
  sessionId: string;
  agentId: string;
}): Promise<number> {
  const { config, sessionId, agentId } = params;
  const { apiUrl, spaceId } = config;

  try {
    const url = `${apiUrl}/spaces/${spaceId}/sessions/${sessionId}/messages?limit=50`;
    const res = await fetch(url, {
      headers: { "ngrok-skip-browser-warning": "true" },
    });
    if (!res.ok) return 0;

    const { messages } = await res.json() as { messages: any[] };
    const stuck = (messages || []).filter((m: any) =>
      m.from_agent === agentId &&
      m.content?.streaming === true
    );

    for (const m of stuck) {
      try {
        await updateA2AMessage({
          config,
          messageId: m.message_id,
          streaming: false,
        });
        console.log(`atheism: [P0-FINALIZE] cleared streaming on ${m.message_id} from ${agentId} in ${sessionId}`);
      } catch (e) {
        console.warn(`atheism: [P0-FINALIZE] failed to clear streaming on ${m.message_id}:`, e);
      }
    }
    return stuck.length;
  } catch (e) {
    console.warn(`atheism: [P0-FINALIZE] finalizeAgentStreaming failed for ${agentId}@${sessionId}:`, e);
    return 0;
  }
}

/**
 * 清理 zombie streaming 消息：重启后残留的 streaming=true 的 placeholder。
 * 将它们 finalize（streaming=false），返回被清理的 job_id 列表。
 */
export async function cleanupZombieStreaming(params: {
  config: A2ASpaceConfig;
  agentId: string;
  windowMs?: number;
}): Promise<{ messageId: string; jobId: string; sessionId: string; hadContent: boolean }[]> {
  const { config, agentId, windowMs = 30 * 60 * 1000 } = params;
  const { apiUrl, spaceId } = config;
  const since = Date.now() - windowMs;

  try {
    const url = `${apiUrl}/spaces/${spaceId}/messages?since=${since}&limit=200`;
    const res = await fetch(url, {
      headers: { "ngrok-skip-browser-warning": "true" },
    });
    if (!res.ok) return [];

    const { messages } = await res.json() as { messages: any[] };
    const zombies = (messages || []).filter((m: any) =>
      m.from_agent === agentId &&
      m.content?.streaming === true &&
      m.type === "human_job_response"
    );

    const cleaned: { messageId: string; jobId: string; sessionId: string; hadContent: boolean }[] = [];
    for (const zombie of zombies) {
      try {
        const existingResult = zombie.content?.result || "";
        const isPlaceholder = existingResult === "⏳ 正在处理..." || existingResult.trim() === "";
        const newResult = isPlaceholder
          ? "⚡ 服务重启，任务已中断"
          : `${existingResult}\n\n---\n⚡ 服务重启，响应被截断`;

        await updateA2AMessage({
          config,
          messageId: zombie.message_id,
          result: newResult,
          streaming: false,
        });

        cleaned.push({
          messageId: zombie.message_id,
          jobId: zombie.content?.job_id || "",
          sessionId: zombie.session_id || "session_default",
          hadContent: !isPlaceholder,
        });

        console.log(`atheism: [CLEANUP] finalized zombie ${zombie.message_id} (job: ${zombie.content?.job_id}, session: ${zombie.session_id}) from ${agentId}`);
      } catch (err) {
        console.error(`atheism: [CLEANUP] failed to finalize ${zombie.message_id}: ${err}`);
      }
    }

    return cleaned;
  } catch (err) {
    console.error(`atheism: [CLEANUP] error querying zombies for ${agentId}@${spaceId}: ${err}`);
    return [];
  }
}

/**
 * P0 Resume Debounce: 检查指定 session 近期是否已有恢复消息。
 * 防止 restart storm 时每次重启都往同一 session 注入 resume 消息。
 */
export async function checkRecentResumeMessage(params: {
  config: A2ASpaceConfig;
  sessionId: string;
  windowMs?: number;
}): Promise<boolean> {
  const { config, sessionId, windowMs = 5 * 60 * 1000 } = params;
  const { apiUrl, spaceId } = config;
  const since = Date.now() - windowMs;

  try {
    const url = `${apiUrl}/spaces/${spaceId}/messages?session_id=${sessionId}&since=${since}&limit=50`;
    const res = await fetch(url, {
      headers: { "ngrok-skip-browser-warning": "true" },
    });
    if (!res.ok) return false;

    const { messages } = await res.json() as { messages: any[] };
    return (messages || []).some((m: any) =>
      m.from_agent === 'human' &&
      m.type === 'human_job' &&
      typeof m.content?.job === 'string' &&
      m.content.job.includes('[系统自动恢复]')
    );
  } catch {
    return false; // 查不到就不阻塞，允许注入
  }
}

/**
 * P0 fix: Orphan nudge debounce — 检查近期是否已有 nudge 消息，
 * 防止连续重启时同一 session 收到多条 orphan nudge。
 * 复用 checkRecentResumeMessage 的模式，匹配 nudge 特征文本。
 */
export async function checkRecentNudgeMessage(params: {
  config: A2ASpaceConfig;
  sessionId: string;
  windowMs?: number;
}): Promise<boolean> {
  const { config, sessionId, windowMs = 5 * 60 * 1000 } = params;
  const { apiUrl, spaceId } = config;
  const since = Date.now() - windowMs;

  try {
    const url = `${apiUrl}/spaces/${spaceId}/messages?session_id=${sessionId}&since=${since}&limit=50`;
    const res = await fetch(url, {
      headers: { "ngrok-skip-browser-warning": "true" },
    });
    if (!res.ok) return false;

    const { messages } = await res.json() as { messages: any[] };
    return (messages || []).some((m: any) =>
      m.from_agent === 'human' &&
      m.type === 'human_job' &&
      typeof m.content?.job === 'string' &&
      m.content.job.includes('检测到未回复的人类消息')
    );
  } catch {
    return false;
  }
}

/**
 * 重启后自动恢复：向被中断的 session 注入一条 human_job 消息，
 * 让 poll 循环自动将其作为新任务触发 agent 继续工作。
 */
export async function postResumeMessage(params: {
  config: A2ASpaceConfig;
  sessionId: string;
  interruptedAgentId: string;
  hadContent: boolean;
}): Promise<string | null> {
  const { config, sessionId, interruptedAgentId, hadContent } = params;
  const { apiUrl, spaceId } = config;

  const resumeText = hadContent
    ? `[系统自动恢复] 上次 ${interruptedAgentId} 的响应被重启截断（部分内容已保留在上方）。请检查上方截断的内容，继续完成未完成的工作。`
    : `[系统自动恢复] 上次 ${interruptedAgentId} 的任务被重启中断（尚未产出内容）。请继续执行之前的任务。`;

  try {
    const url = `${apiUrl}/spaces/${spaceId}/messages`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "ngrok-skip-browser-warning": "true",
      },
      body: JSON.stringify({
        from: "human",
        type: "human_job",
        session_id: sessionId,
        content: {
          job: resumeText,
        },
      }),
    });

    if (!res.ok) {
      console.error(`atheism: [RESUME] failed to post resume message to ${sessionId}: ${res.status}`);
      return null;
    }

    const { message_id } = await res.json();
    console.log(`atheism: [RESUME] posted resume message ${message_id} to session ${sessionId}`);
    return message_id;
  } catch (err) {
    console.error(`atheism: [RESUME] error posting resume to ${sessionId}: ${err}`);
    return null;
  }
}

/**
 * 获取某个 Agent 近期所有 response 的 job_id（包括已完成的和 zombie）。
 * 用于重启时将已处理的 trigger message 标记为 processed，防止重复处理。
 */
export async function getRecentAgentJobIds(params: {
  config: A2ASpaceConfig;
  agentId: string;
  windowMs?: number;
}): Promise<string[]> {
  const { config, agentId, windowMs = 30 * 60 * 1000 } = params;
  const { apiUrl, spaceId } = config;
  const since = Date.now() - windowMs;

  try {
    const url = `${apiUrl}/spaces/${spaceId}/messages?since=${since}&limit=200`;
    const res = await fetch(url, {
      headers: { "ngrok-skip-browser-warning": "true" },
    });
    if (!res.ok) return [];

    const { messages } = await res.json() as { messages: any[] };
    return (messages || [])
      .filter((m: any) =>
        m.from_agent === agentId &&
        m.type === "human_job_response" &&
        m.content?.job_id
      )
      .map((m: any) => m.content.job_id as string);
  } catch {
    return [];
  }
}

/**
 * 查询孤立 session — 人类发了消息但无 agent 响应的活跃 session。
 * 用于 Gateway 重启后追回被遗漏的人类消息。
 */
export async function fetchOrphanedSessions(params: {
  config: A2ASpaceConfig;
  maxAgeHours?: number;
}): Promise<Array<{ session_id: string; last_human_message_id: string; last_human_message_at: string; message_preview: string }>> {
  const { config, maxAgeHours = 24 } = params;
  const { apiUrl, spaceId } = config;

  try {
    const url = `${apiUrl}/spaces/${spaceId}/sessions/orphaned?max_age_hours=${maxAgeHours}`;
    const res = await fetch(url, {
      headers: { "ngrok-skip-browser-warning": "true" },
    });
    if (!res.ok) {
      console.error(`atheism: [ORPHAN] HTTP ${res.status} fetching orphaned sessions`);
      return [];
    }
    const { orphaned_sessions } = await res.json() as { orphaned_sessions: any[] };
    return orphaned_sessions || [];
  } catch (err) {
    console.error(`atheism: [ORPHAN] error fetching orphaned sessions: ${err}`);
    return [];
  }
}

/**
 * 向孤立 session 注入触发消息，让 agent 重新评估。
 */
export async function postOrphanNudge(params: {
  config: A2ASpaceConfig;
  sessionId: string;
  messagePreview: string;
}): Promise<string | null> {
  const { config, sessionId, messagePreview } = params;
  const { apiUrl, spaceId } = config;

  const nudgeText = `[系统自动恢复] 检测到未回复的人类消息（服务中断期间发送）。请查看上方消息并回复。`;

  try {
    const url = `${apiUrl}/spaces/${spaceId}/messages`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "ngrok-skip-browser-warning": "true",
      },
      body: JSON.stringify({
        from: "human",
        type: "human_job",
        session_id: sessionId,
        content: {
          job: nudgeText,
        },
      }),
    });

    if (!res.ok) {
      console.error(`atheism: [ORPHAN] failed to post nudge to ${sessionId}: ${res.status}`);
      return null;
    }

    const { message_id } = await res.json();
    console.log(`atheism: [ORPHAN] posted nudge ${message_id} to session ${sessionId}`);
    return message_id;
  } catch (err) {
    console.error(`atheism: [ORPHAN] error posting nudge to ${sessionId}: ${err}`);
    return null;
  }
}

import type { AtheismConfig, AtheismSession, PollResponse, AgentProfile } from "./types.js";

export async function fetchAtheismMessages(params: {
  config: AtheismConfig;
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
  
  const res = await fetch(url);

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

export async function fetchAtheismSessions(params: {
  config: AtheismConfig;
  status?: string;
}): Promise<{ sessions: AtheismSession[] }> {
  const { config, status } = params;
  const { apiUrl, spaceId } = config;

  let url = `${apiUrl}/spaces/${spaceId}/sessions`;
  if (status) {
    url += `?status=${status}`;
  }
  
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Atheism API error: ${res.status} ${res.statusText}`);
  }

  return res.json();
}

export async function createAtheismSession(params: {
  config: AtheismConfig;
  title?: string;
  createdBy?: string;
}): Promise<AtheismSession> {
  const { config, title, createdBy } = params;
  const { apiUrl, spaceId } = config;

  const url = `${apiUrl}/spaces/${spaceId}/sessions`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
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

export async function createA2AResponse(params: {
  config: AtheismConfig;
  jobId: string;
  sessionId: string;
  initialResult: string;
  /** 发送消息的 Agent ID（多 Agent 模式） */
  agentId?: string;
}): Promise<string> {
  const { config, jobId, sessionId, initialResult, agentId } = params;
  const { apiUrl, spaceId } = config;
  const fromAgent = agentId || config.agentId;

  const url = `${apiUrl}/spaces/${spaceId}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: fromAgent,
      type: "human_job_response",
      session_id: sessionId,
      content: {
        job_id: jobId,
        result: initialResult,
        streaming: true,
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`Atheism API error: ${res.status} ${res.statusText}`);
  }

  const { message_id } = await res.json();
  return message_id;
}

export async function updateAtheismMessage(params: {
  config: AtheismConfig;
  messageId: string;
  result: string;
  streaming: boolean;
}): Promise<void> {
  const { config, messageId, result, streaming } = params;
  const { apiUrl, spaceId } = config;

  const url = `${apiUrl}/spaces/${spaceId}/messages/${messageId}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      content: { result, streaming },
    }),
  });

  if (!res.ok) {
    throw new Error(`Atheism API error: ${res.status} ${res.statusText}`);
  }
}

/** 获取 session 的完整消息历史 */
export async function fetchSessionMessages(params: {
  config: AtheismConfig;
  sessionId: string;
  limit?: number;
}): Promise<AtheismMessage[]> {
  const { config, sessionId, limit = 30 } = params;
  const { apiUrl, spaceId } = config;

  const url = `${apiUrl}/spaces/${spaceId}/sessions/${sessionId}/messages?limit=${limit}`;
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Atheism API error: ${res.status} ${res.statusText}`);
  }

  const { messages } = await res.json();
  return messages;
}

/** 删除一条消息（用于撤回 NO_REPLY 的占位消息） */
export async function deleteAtheismMessage(params: {
  config: AtheismConfig;
  messageId: string;
}): Promise<void> {
  const { config, messageId } = params;
  const { apiUrl, spaceId } = config;

  const url = `${apiUrl}/spaces/${spaceId}/messages/${messageId}`;
  const res = await fetch(url, {
    method: "DELETE",
  });

  // 404 = already deleted, that's fine
  if (!res.ok && res.status !== 404) {
    throw new Error(`Atheism API error: ${res.status} ${res.statusText}`);
  }
}

/** 获取 space 的自定义规则 */
export async function fetchCustomRules(params: {
  config: AtheismConfig;
}): Promise<string> {
  const { config } = params;
  const { apiUrl, spaceId } = config;

  const url = `${apiUrl}/spaces/${spaceId}/system-prompt`;
  const res = await fetch(url);

  if (!res.ok) return "";

  const { custom_rules } = await res.json();
  return custom_rules || "";
}

// ─── 评估锁 API ─────────────────────────────────────────

/** 尝试获取 session 评估锁 */
export async function claimEvalLock(params: {
  config: AtheismConfig;
  sessionId: string;
  /** 用哪个 Agent 身份 claim（多 Agent 模式） */
  agentId?: string;
}): Promise<{ granted: boolean; held_by?: string }> {
  const { config, sessionId, agentId } = params;
  const { apiUrl, spaceId } = config;
  const claimAgent = agentId || config.agentId;

  try {
    const url = `${apiUrl}/spaces/${spaceId}/sessions/${sessionId}/eval/claim`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
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
  config: AtheismConfig;
  sessionId: string;
  /** 用哪个 Agent 身份 release（多 Agent 模式） */
  agentId?: string;
}): Promise<void> {
  const { config, sessionId, agentId } = params;
  const { apiUrl, spaceId } = config;
  const releaseAgent = agentId || config.agentId;

  try {
    const url = `${apiUrl}/spaces/${spaceId}/sessions/${sessionId}/eval/release`;
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ agent_id: releaseAgent }),
    });
  } catch {
    // best-effort release
  }
}

/** 获取 session summary */
export async function fetchSessionSummary(params: {
  config: AtheismConfig;
  sessionId: string;
}): Promise<{ summary_text: string; last_message_id: string | null; message_count: number } | null> {
  const { config, sessionId } = params;
  const { apiUrl, spaceId } = config;
  try {
    const res = await fetch(`${apiUrl}/spaces/${spaceId}/sessions/${sessionId}/summary`);
    if (!res.ok) return null;
    const { summary } = await res.json();
    return summary;
  } catch {
    return null;
  }
}

/** 更新 session summary */
export async function updateSessionSummary(params: {
  config: AtheismConfig;
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
  config: AtheismConfig;
}): Promise<string | null> {
  const { config } = params;
  const { apiUrl, spaceId } = config;
  const cacheKey = `${apiUrl}:${spaceId}`;
  
  const cached = directoryCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < DIRECTORY_CACHE_TTL) {
    return cached.content;
  }
  
  try {
    const res = await fetch(`${apiUrl}/spaces/${spaceId}/skill-directory`);
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
  config: AtheismConfig;
  sessionId: string;
}): Promise<string | null> {
  const { config, sessionId } = params;
  const { apiUrl, spaceId } = config;
  try {
    const res = await fetch(`${apiUrl}/spaces/${spaceId}/sessions/${sessionId}/ledger`);
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
  config: AtheismConfig;
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
 * 清理 zombie streaming 消息：重启后残留的 streaming=true 的 placeholder。
 * 将它们 finalize（streaming=false），返回被清理的 job_id 列表。
 */
export async function cleanupZombieStreaming(params: {
  config: AtheismConfig;
  agentId: string;
  windowMs?: number;
}): Promise<{ messageId: string; jobId: string; sessionId: string; hadContent: boolean }[]> {
  const { config, agentId, windowMs = 30 * 60 * 1000 } = params;
  const { apiUrl, spaceId } = config;
  const since = Date.now() - windowMs;

  try {
    const url = `${apiUrl}/spaces/${spaceId}/messages?since=${since}&limit=200`;
    const res = await fetch(url);
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

        await updateAtheismMessage({
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
 * 重启后自动恢复：向被中断的 session 注入一条 human_job 消息，
 * 让 poll 循环自动将其作为新任务触发 agent 继续工作。
 */
export async function postResumeMessage(params: {
  config: AtheismConfig;
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
  config: AtheismConfig;
  agentId: string;
  windowMs?: number;
}): Promise<string[]> {
  const { config, agentId, windowMs = 30 * 60 * 1000 } = params;
  const { apiUrl, spaceId } = config;
  const since = Date.now() - windowMs;

  try {
    const url = `${apiUrl}/spaces/${spaceId}/messages?since=${since}&limit=200`;
    const res = await fetch(url);
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

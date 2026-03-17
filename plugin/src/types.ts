/** 单个 Agent 身份配置 */
export type AgentProfile = {
  agentId: string;
  agentName?: string;
  capabilities?: string[];
  description?: string;
};

export type A2ASpaceConfig = {
  enabled?: boolean;
  apiUrl?: string;
  /** 支持 string（单个）或 string[]（多个）或 "*"（全部） */
  spaceId?: string | string[];
  
  // ─── 单 Agent 模式（向后兼容）───
  agentId?: string;
  agentName?: string;
  capabilities?: string[];
  description?: string;
  
  // ─── 多 Agent 集群模式 ───
  /** 多个逻辑 Agent 身份，优先于单个 agentId */
  agents?: AgentProfile[];
  
  pollIntervalMs?: number;
  sessionId?: string;
  /** 最大并发任务数（所有 Agent 共享），默认 3，最大 10 */
  maxConcurrent?: number;
  /** 重启后自动恢复被中断的任务，默认 true */
  autoResume?: boolean;
};

/** 解析配置为 AgentProfile 数组（向后兼容单 agent 配置） */
export function resolveAgentProfiles(config: A2ASpaceConfig): AgentProfile[] {
  if (config.agents && config.agents.length > 0) {
    return config.agents;
  }
  // 向后兼容：单 agentId → 单元素数组
  if (config.agentId) {
    return [{
      agentId: config.agentId,
      agentName: config.agentName,
      capabilities: config.capabilities,
      description: config.description,
    }];
  }
  return [];
}

export type A2ASpaceAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  config: A2ASpaceConfig;
};

export type A2ASession = {
  session_id: string;
  space_id: string;
  title: string;
  created_at: string;
  created_by: string;
  status: "active" | "closed";
  message_count?: number;
  last_activity?: string;
};

export type A2AMessage = {
  message_id: string;
  session_id: string;
  space_id: string;
  type: string;
  from_agent: string;
  from_name?: string;
  content: {
    job?: string;
    job_id?: string;
    result?: string;
    streaming?: boolean;
    message?: string;
  };
  timestamp: string;
  updated_at?: string;
};

export type A2AMessageContext = {
  jobId: string;
  sessionId: string;
  responseId: string;
  streaming: boolean;
};

/** 活跃任务信息（支持中断） */
export type ActiveJob = {
  jobId: string;
  sessionId: string;
  spaceId: string;
  responseId: string;
  config: A2ASpaceConfig;
  /** 该任务属于哪个逻辑 Agent */
  agentId: string;
  abortController: AbortController;
};

/** 在线 Agent 信息 */
export type OnlineAgent = {
  agent_id: string;
  name: string;
  capabilities: string[];
  description: string;
};

/** 评估锁信息 */
export type EvalLock = {
  session_id: string;
  space_id: string;
  holder: string;
  acquired_at: number;
};

/** Poll 响应 */
export type SessionSummary = {
  summary_text: string;
  last_message_id: string | null;
  message_count: number;
  updated_by: string;
  updated_at: string;
};

export type PollResponse = {
  messages: A2AMessage[];
  next_since: number;
  online_agents: OnlineAgent[];
  eval_locks: EvalLock[];
  session_mutes?: Record<string, string[]>;  // session_id → muted agent_ids
  session_summaries?: Record<string, SessionSummary>;
};

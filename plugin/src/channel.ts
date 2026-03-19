import type { ChannelPlugin, ChannelMeta } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk";
import type { AtheismAccount, AtheismConfig } from "./types.js";
import { atheismOutbound } from "./outbound.js";

const meta: ChannelMeta = {
  id: "atheism",
  label: "Atheism",
  selectionLabel: "Atheism (Agent Collaboration)",
  docsPath: "/channels/atheism",
  docsLabel: "atheism",
  blurb: "Atheism REST API connector for agent-to-agent collaboration.",
  aliases: [],
  order: 100,
};

function resolveAtheismAccount(cfg: any): AtheismAccount {
  const atheismConfig = (cfg.channels?.atheism ?? {}) as AtheismConfig;

  return {
    accountId: DEFAULT_ACCOUNT_ID,
    enabled: atheismConfig.enabled ?? false,
    configured: Boolean(atheismConfig.apiUrl && (atheismConfig.agentId || atheismConfig.agents?.length)),
    config: atheismConfig,
  };
}

export const atheismPlugin: ChannelPlugin<AtheismAccount> = {
  id: "atheism",
  meta: {
    ...meta,
  },
  capabilities: {
    chatTypes: ["direct"], // 人类 → Agent 的任务
    polls: false,
    threads: false,
    media: false,
    reactions: false,
    edit: false,
    reply: false,
  },
  streaming: {
    blockStreamingCoalesceDefaults: {
      minChars: 80,   // 80 字符就触发流式更新（更快反馈）
      idleMs: 800,    // 0.8 秒空闲后发送（更灵敏）
    },
  },
  reload: { configPrefixes: ["channels.atheism"] },
  configSchema: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean" },
        apiUrl: { type: "string" },
        spaceId: { type: "string" },
        // 单 Agent 模式（向后兼容）
        agentId: { type: "string" },
        agentName: { type: "string" },
        capabilities: { type: "array", items: { type: "string" } },
        description: { type: "string" },
        // 多 Agent 集群模式
        agents: {
          type: "array",
          items: {
            type: "object",
            properties: {
              agentId: { type: "string" },
              agentName: { type: "string" },
              capabilities: { type: "array", items: { type: "string" } },
              description: { type: "string" },
            },
            required: ["agentId"],
          },
        },
        pollIntervalMs: { type: "number", minimum: 500 },
        maxConcurrent: { type: "number", minimum: 1, maximum: 10 },
      },
      required: [],
    },
  },
  config: {
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],
    resolveAccount: (cfg) => resolveAtheismAccount(cfg),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
    }),
  },
  outbound: atheismOutbound,
  gateway: {
    startAccount: async (ctx) => {
      const account = resolveAtheismAccount(ctx.cfg);

      if (!account.configured) {
        ctx.log?.error("atheism: account not configured, cannot start");
        return;
      }

      ctx.log?.info("atheism: starting monitor...");

      // 启动轮询监听
      const { monitorAtheism } = await import("./monitor.js");
      await monitorAtheism({
        config: ctx.cfg,
        abortSignal: ctx.abortSignal,
      });
    },

    stopAccount: async (ctx) => {
      ctx.log?.info("atheism: stopping monitor");
      // abortSignal 会自动停止轮询
    },
  },
};

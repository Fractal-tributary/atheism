/** Local ChannelOutbound type — the generic outbound adapter contract used by OpenClaw's reply pipeline.
 *  TODO: re-import from SDK when openclaw/plugin-sdk/core re-exports ChannelOutbound.
 *  This local definition was introduced during the subpath exports migration (2026-03-24)
 *  because ChannelOutbound was removed from SDK public API. ctx is typed as any — type safety
 *  for outbound callbacks currently depends on runtime, not compile-time checks. */
type ChannelOutbound<TAccount = unknown> = {
  deliveryMode: "direct" | "gateway" | "hybrid";
  sendText?: (ctx: any) => Promise<{ ok: boolean }>;
  sendStreamingChunk?: (ctx: any) => Promise<{ ok: boolean }>;
};
import type { A2ASpaceAccount } from "./types.js";
import { updateA2AMessage } from "./send.js";
import { clearActiveJob, getActiveJob } from "./bot.js";

export const a2aSpaceOutbound: ChannelOutbound<A2ASpaceAccount> = {
  deliveryMode: "direct",

  sendText: async (ctx) => {
    const { text, metadata } = ctx;
    const config = ctx.account.config;

    // 尝试从 metadata 或活跃任务获取 responseId
    let responseId = metadata?.responseId;
    if (!responseId) {
      // 遍历活跃任务找匹配的
      const { getAllActiveJobs } = await import("./bot.js");
      for (const [, job] of getAllActiveJobs()) {
        responseId = job.responseId;
        break;
      }
    }

    if (!responseId) {
      ctx.log?.error("atheism: no responseId available for sendText");
      return { ok: false };
    }

    try {
      await updateA2AMessage({
        config,
        messageId: responseId,
        result: text,
        streaming: false,
      });

      ctx.log?.info(`atheism: sent final result to ${responseId}`);
      return { ok: true };
    } catch (err) {
      ctx.log?.error(`atheism: error sending text: ${String(err)}`);
      return { ok: false };
    }
  },

  sendStreamingChunk: async (ctx) => {
    const { text, metadata } = ctx;
    const config = ctx.account.config;

    let responseId = metadata?.responseId;
    if (!responseId) {
      const { getAllActiveJobs } = await import("./bot.js");
      for (const [, job] of getAllActiveJobs()) {
        responseId = job.responseId;
        break;
      }
    }

    if (!responseId) {
      ctx.log?.error("atheism: no responseId available for streaming chunk");
      return { ok: false };
    }

    try {
      await updateA2AMessage({
        config,
        messageId: responseId,
        result: text,
        streaming: true,
      });

      return { ok: true };
    } catch (err) {
      ctx.log?.error(`atheism: error sending streaming chunk: ${String(err)}`);
      return { ok: false };
    }
  },
};

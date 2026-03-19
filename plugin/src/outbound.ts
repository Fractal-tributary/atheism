import type { ChannelOutbound } from "openclaw/plugin-sdk";
import type { AtheismAccount } from "./types.js";
import { updateAtheismMessage } from "./send.js";
import { clearActiveJob, getActiveJob } from "./bot.js";

export const atheismOutbound: ChannelOutbound<AtheismAccount> = {
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
      await updateAtheismMessage({
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
      await updateAtheismMessage({
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

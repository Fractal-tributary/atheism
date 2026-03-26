import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import type { A2ASpaceConfig } from "./types.js";
import { updateA2AMessage } from "./send.js";
import { getA2ARuntime } from "./runtime.js";

export type CreateA2AReplyDispatcherParams = {
  cfg: OpenClawConfig;
  agentId: string;
  responseId: string;  // Can be "" for deferred mode
  config: A2ASpaceConfig;
  /** Callback to create response on first substantive output (deferred mode) */
  createResponse?: (initialText: string) => Promise<string>;
  onComplete?: () => void;
  onSilent?: () => Promise<void>;  // Agent 决定静默时调用
  /** 获取消息元数据（model/token），在 final delivery 时附带 */
  getMetadata?: () => Record<string, unknown> | null;
  /** 🆕 Lock version for orphan write prevention */
  lockVersion?: string;
};

export function createA2AReplyDispatcher(params: CreateA2AReplyDispatcherParams) {
  const core = getA2ARuntime();
  const { cfg, agentId, config, onComplete, onSilent, createResponse, getMetadata, lockVersion } = params;
  const log = console.log;
  const error = console.error;

  // Mutable responseId: starts empty in deferred mode, gets set on first substantive output
  let responseId = params.responseId;

  let accumulatedText = "";
  let statusLine = "";
  let lastUpdateText = "";
  let isCompleted = false;
  let isSilentResponse = false;
  let updateInProgress = false;
  let consecutiveDeliverErrors = 0;
  let circuitOpenUntil = 0;
  let finalDeliveryCount = 0;
  let hasReceivedText = false;
  let toolCallHistory: string[] = [];
  let lastDeliverTime = 0;
  let completedBlocksText = "";  // Finalized text blocks (accumulated across tool calls)
  let currentPartial = "";       // Current streaming block text
  let receivedFinalKind = false; // 是否收到过 kind="final" 的 deliver 调用
  let hasErrorOccurred = false;  // 是否发生过 onError
  let aborted = false;           // 是否被 ABORT 中断（新消息到达等）
  let responseCreateInProgress = false;  // 🆕 防止并发 createResponse 竞态（Bug fix: 12x duplicate create）

  // 🆕 Model tracking — captured via onModelSelected callback
  let modelInfo: { provider?: string; model?: string; thinkLevel?: string } = {};

  // 🆕 audience 自标注：agent 在文本中写 [audience:user] 或 [audience:agent]，
  // plugin 提取后剥离标签，写入 metadata.audience
  let detectedAudience: string | undefined;

  const extractAudience = (text: string): { cleaned: string; audience?: string } => {
    const match = text.match(/\[audience:(user|agent)\]/i);
    if (!match) return { cleaned: text };
    return {
      cleaned: text.replace(match[0], '').trim(),
      audience: match[1].toLowerCase(),
    };
  };

  // Get full accumulated text (completed blocks + current streaming partial)
  const getFullText = (): string => {
    if (completedBlocksText && currentPartial) {
      return completedBlocksText + "\n\n" + currentPartial;
    }
    return completedBlocksText || currentPartial;
  };

  // NO_REPLY / 静默检测
  // 🆕 Bug fix: 添加 "NO" 匹配。LLM 经常将 NO_REPLY 简写为 NO，
  // 不匹配会导致 "NO" 被当作实质内容创建消息（66/96 噪声的根因）
  const SILENT_PATTERNS = [
    /^\s*NO_REPLY\s*$/i,
    /^\s*HEARTBEAT_OK\s*$/i,
    /^\s*NO\s*$/i,
  ];

  const isSilentText = (text: string): boolean => {
    return SILENT_PATTERNS.some(p => p.test(text.trim()));
  };

  // 检测文本是否被截断（仅在未收到 kind="final" 时判定）
  const detectTruncation = (text: string): { truncated: boolean } => {
    if (!text || text.trim().length < 30) return { truncated: false };
    
    // 只有流式输出未收到 kind="final" 结束信号才判定为截断
    // （如服务重启导致流中断）
    if (!receivedFinalKind) {
      return { truncated: true };
    }
    
    return { truncated: false };
  };

  // 最后一次 deliver 调用的时间

  // 工具名映射为人类可读描述
  const TOOL_LABELS: Record<string, string> = {
    web_search: "🔍 正在搜索网页...",
    web_fetch: "🌐 正在读取网页内容...",
    exec: "⚙️ 正在执行命令...",
    read: "📖 正在读取文件...",
    write: "📝 正在写入文件...",
    edit: "✏️ 正在编辑文件...",
    browser: "🖥️ 正在操作浏览器...",
    image: "🖼️ 正在分析图片...",
    memory_search: "🧠 正在搜索记忆...",
    memory_get: "🧠 正在读取记忆...",
    session_status: "📊 正在获取状态...",
    tts: "🔊 正在生成语音...",
    feishu_doc: "📄 正在操作飞书文档...",
    feishu_wiki: "📚 正在查询知识库...",
    feishu_drive: "☁️ 正在访问云盘...",
    feishu_bitable_list_records: "📊 正在查询多维表格...",
    nodes: "📡 正在通信节点...",
    sessions_spawn: "🤖 正在启动子任务...",
  };

  const getToolLabel = (name: string): string => {
    return TOOL_LABELS[name] || `🔧 正在使用 ${name}...`;
  };

  // 构建带状态行的显示文本
  const buildDisplayText = (): string => {
    const parts: string[] = [];

    if (accumulatedText) {
      parts.push(accumulatedText);
    }

    if (statusLine && !isCompleted) {
      if (parts.length > 0) parts.push("");  // 空行分隔
      parts.push("---");
      parts.push(statusLine);
      if (toolCallHistory.length > 1) {
        // 显示已完成的工具调用历史（最近 3 个）
        const recent = toolCallHistory.slice(-4, -1);
        if (recent.length > 0) {
          parts.push(`\n*已完成: ${recent.join(" → ")}*`);
        }
      }
    }

    return parts.join("\n") || "⏳ 正在处理...";
  };

  // 🆕 Extracted helper: ensure deferred response exists, creating it on first substantive output.
  // Centralizes the responseCreateInProgress guard so onToolStart, onReasoningStream, and
  // deliverToA2A all share one race-safe code path. Returns true if responseId is available.
  const ensureDeferredResponse = async (initialText: string): Promise<boolean> => {
    if (responseId) return true;
    if (!createResponse) return false;
    if (responseCreateInProgress) return false; // Another call is already creating
    if (isSilentText(initialText)) {
      log(`atheism: [DELIVER] preventing deferred response creation for silent text: "${initialText}"`);
      return false;
    }

    responseCreateInProgress = true;
    try {
      responseId = await createResponse(initialText);
      log(`atheism: [DELIVER] deferred response created: ${responseId}`);
      return true;
    } catch (err) {
      responseCreateInProgress = false;
      if (err instanceof Error && err.message === 'LOCK_VERSION_MISMATCH') {
        log(`atheism: [DELIVER] lock version mismatch on deferred create — orphan discarded`);
        isCompleted = true;
        return false;
      }
      error(`atheism: [DELIVER] failed to create deferred response: ${err}`);
      return false;
    }
  };

  const deliverToA2A = async (text: string, streaming: boolean) => {
    if (isCompleted) return;
    if (isSilentResponse) return;  // 🆕 Already flagged as silent, don't create messages

    // Circuit breaker: skip streaming updates while server is unreachable
    // Final delivery is never skipped — must guarantee eventual delivery
    if (streaming && Date.now() < circuitOpenUntil) return;
    
    // Deferred creation: create response on first substantive delivery
    if (!responseId) {
      const created = await ensureDeferredResponse(text);
      if (!created) return;  // Silent text, lock mismatch, or creation in progress
      // createResponse already sets the initial text, so for streaming we're done
      if (!streaming) {
        log(`atheism: [DELIVER] ✅ FINAL response delivered (deferred, ${text.length} chars)`);
        isCompleted = true;
        onComplete?.();
      }
      return;
    }
    
    // No responseId and no callback — nothing to deliver
    if (!responseId) return;
    
    if (updateInProgress) {
      if (!streaming) {
        const waitForUpdate = () => new Promise<void>((resolve) => {
          const check = () => {
            if (!updateInProgress) { resolve(); return; }
            setTimeout(check, 50);
          };
          setTimeout(check, 50);
        });
        await waitForUpdate();
        if (isCompleted) return;
      } else {
        return;
      }
    }
    
    if (text === lastUpdateText && streaming) return;
    
    lastUpdateText = text;
    updateInProgress = true;

    try {
      // 🆕 audience 标签提取：从文本中剥离 [audience:user/agent]，存入 metadata
      const { cleaned: deliveryText, audience: audienceFromText } = extractAudience(text);
      if (audienceFromText) {
        detectedAudience = audienceFromText;
        log(`atheism: [AUDIENCE] detected: ${audienceFromText}`);
      }

      // 🆕 Final delivery 时附带 metadata（model/token 信息）
      const metadata = !streaming ? (getMetadata?.() ?? undefined) : undefined;
      // Merge model info captured by onModelSelected
      const finalMetadata = !streaming ? {
        ...(modelInfo.model ? { model: modelInfo.model, provider: modelInfo.provider } : {}),
        ...(metadata || {}),
        ...(detectedAudience ? { audience: detectedAudience } : {}),
      } : undefined;
      const hasMetadata = finalMetadata && Object.keys(finalMetadata).length > 0;

      await updateA2AMessage({
        config,
        messageId: responseId,
        result: deliveryText,
        streaming,
        ...(hasMetadata ? { metadata: finalMetadata } : {}),
        lockVersion,
      });

      // Success — reset circuit breaker
      consecutiveDeliverErrors = 0;
      circuitOpenUntil = 0;
      
      if (!streaming) {
        log(`atheism: [DELIVER] ✅ FINAL response delivered (${text.length} chars)`);
        isCompleted = true;
        onComplete?.();
      }
    } catch (err) {
      // 🆕 Lock version mismatch → orphan write, silently give up (don't retry, don't show error)
      if (err instanceof Error && err.message === 'LOCK_VERSION_MISMATCH') {
        log(`atheism: [DELIVER] lock version mismatch — orphan write silently discarded`);
        isCompleted = true;
        return;
      }
      // 🆕 404 = stale message reference (deleted session/message) — silently discard
      if (err instanceof Error && err.message.startsWith('Atheism API error: 404')) {
        log(`atheism: [DELIVER] 404 stale message — silently discarded`);
        isCompleted = true;
        return;
      }
      consecutiveDeliverErrors++;
      if (consecutiveDeliverErrors >= 3) {
        circuitOpenUntil = Date.now() + 5000;
        error(`atheism: [DELIVER] circuit open for 5s after ${consecutiveDeliverErrors} consecutive failures`);
      }
      error(`atheism: [DELIVER] error: ${err}`);
      // Final delivery failure propagates so upper layer can retry
      if (!streaming) throw err;
    } finally {
      updateInProgress = false;
    }
  };

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, agentId),
      
      onReplyStart: () => {
        // 不再发状态更新（由 onToolStart 真实事件驱动）
      },

      deliver: async (payload: ReplyPayload, info) => {
        const text = payload.text?.trim() ?? "";
        if (!text) return;

        const kind = info?.kind ?? "unknown";
        finalDeliveryCount++;
        hasReceivedText = true;
        lastDeliverTime = Date.now();
        if (kind === "final") receivedFinalKind = true;
        log(`atheism: [DELIVER] (${kind}) #${finalDeliveryCount}: ${text.substring(0, 100)}${text.length > 100 ? "..." : ""}`);

        // 🆕 Early silent detection: prevent creating deferred messages for NO_REPLY/NO
        // This is critical for deferred mode (completion signals) where deliver() would
        // trigger createResponse() and create a visible "NO" message in the chat.
        // Must check BEFORE accumulating text, so onIdle sees empty accumulated text
        // and triggers the silent handler path cleanly.
        if (isSilentText(text)) {
          log(`atheism: [DELIVER] silent text detected ("${text}"), flagging as silent — no message will be created`);
          isSilentResponse = true;
          return;
        }

        // Accumulate text blocks across tool calls instead of overwriting
        currentPartial = "";  // This block is finalized by deliver
        if (completedBlocksText && text !== completedBlocksText && !text.startsWith(completedBlocksText)) {
          // New text block (e.g., text after a tool call) — append
          completedBlocksText += "\n\n" + text;
        } else {
          // First block or streaming update (superset of existing)
          completedBlocksText = text;
        }
        accumulatedText = completedBlocksText;
        statusLine = "";  // 收到文本后清除工具状态

        if (kind === "final") {
          await deliverToA2A(accumulatedText, true);
        } else if (kind === "block") {
          await deliverToA2A(accumulatedText, true);
        }
      },

      onError: async (err, info) => {
        error(`atheism: [ERROR] (${info.kind}): ${err}`);
        hasErrorOccurred = true;
        if (!isCompleted) {
          await deliverToA2A(`❌ 处理出错: ${String(err)}`, false);
        }
      },

      onIdle: async () => {
        // 🆕 Bug 1+2 fix: 如果已经被 ABORT，不再 deliver，避免覆盖 abortActiveJob 写入的 ⚡ 标记
        if (aborted) {
          log(`atheism: [DISPATCHER] onIdle skipped — job was aborted`);
          return;
        }
        
        // 🆕 Early exit if deliver() already flagged as silent (e.g., "NO" detected in deliver callback)
        if (isSilentResponse && !isCompleted) {
          log(`atheism: [DISPATCHER] onIdle: deliver flagged silent, triggering silent handler`);
          isCompleted = true;
          await onSilent?.();
          return;
        }
        
        accumulatedText = getFullText();  // Ensure we have the full accumulated text
        log(`atheism: [DISPATCHER] onIdle (accumulated ${accumulatedText.length} chars, completed=${isCompleted}, finalKind=${receivedFinalKind}, error=${hasErrorOccurred}, responseId=${!!responseId})`);
        // 延迟 600ms，等待可能的后续 deliver() 调用
        await new Promise(resolve => setTimeout(resolve, 600));
        
        // 🆕 再检查一次，600ms 期间可能被 abort
        if (aborted) {
          log(`atheism: [DISPATCHER] onIdle skipped after delay — job was aborted`);
          return;
        }
        
        if (!isCompleted && accumulatedText) {
          // 检测是否为静默响应
          if (isSilentText(accumulatedText)) {
            log(`atheism: [DISPATCHER] detected NO_REPLY, triggering silent handler`);
            isSilentResponse = true;
            isCompleted = true;
            await onSilent?.();
            return;
          }
          
          // 🆕 截断检测：流未正常结束时标注
          if (!hasErrorOccurred) {
            const truncation = detectTruncation(accumulatedText);
            if (truncation.truncated) {
              const annotation = '\n\n---\n⚠️ *此回复未正常完成（生成过程异常中断），可能需要其他 Agent 补完。*';
              log(`atheism: [DISPATCHER] truncation detected (no final kind received), annotating response`);
              accumulatedText += annotation;
            }
          }
          
          log(`atheism: [DISPATCHER] delivering final response from onIdle (${accumulatedText.length} chars after delay)`);
          await deliverToA2A(accumulatedText, false);
        } else if (!isCompleted && !accumulatedText) {
          // 没有任何文本输出 → 也视为静默
          log(`atheism: [DISPATCHER] no text output, triggering silent handler`);
          isSilentResponse = true;
          isCompleted = true;
          await onSilent?.();
        }
      },

      onCleanup: () => {
        log(`atheism: [DISPATCHER] onCleanup`);
      },
    });

  // 构建包含真实事件回调的 replyOptions
  const enhancedReplyOptions = {
    ...replyOptions,

    // 🆕 Model 选定回调 — 捕获 model 名称
    onModelSelected: (ctx: { provider: string; model: string; thinkLevel?: string }) => {
      modelInfo = {
        provider: ctx.provider,
        model: ctx.model,
        thinkLevel: ctx.thinkLevel,
      };
      log(`atheism: [MODEL] ${ctx.provider}/${ctx.model} (think: ${ctx.thinkLevel ?? 'off'})`);
    },

    // 🔧 工具开始调用（真实事件！）
    onToolStart: (payload: { name?: string; phase?: string }) => {
      if (isCompleted) return;
      const toolName = payload.name || "unknown";
      const phase = payload.phase || "";
      
      log(`atheism: [TOOL] ${toolName} (phase: ${phase})`);
      
      const label = getToolLabel(toolName);
      toolCallHistory.push(label.split(" ").slice(1).join(" ").replace("...", ""));
      statusLine = label;

      const displayText = buildDisplayText();

      // 🆕 In deferred mode, trigger response creation so tool progress is visible immediately
      if (!responseId) {
        ensureDeferredResponse(displayText).then((created) => {
          if (!created) return;
          // Response just created with displayText as initial content — no additional update needed
        }).catch((err) => {
          error(`atheism: [TOOL] deferred create error: ${err}`);
        });
        return;
      }

      deliverToA2A(displayText, true).catch((err) => {
        error(`atheism: [TOOL] update error: ${err}`);
      });
    },

    // 💭 推理/思考内容流式输出
    onReasoningStream: (payload: ReplyPayload) => {
      if (isCompleted) return;
      const text = payload.text?.trim();
      if (!text) return;

      log(`atheism: [THINKING] ${text.substring(0, 60)}...`);
      
      statusLine = `💭 正在思考...\n> ${text.length > 100 ? text.substring(0, 100) + "..." : text}`;

      const displayText = buildDisplayText();

      // 🆕 In deferred mode, trigger response creation so thinking is visible immediately
      if (!responseId) {
        ensureDeferredResponse(displayText).then((created) => {
          if (!created) return;
        }).catch((err) => {
          error(`atheism: [THINKING] deferred create error: ${err}`);
        });
        return;
      }

      deliverToA2A(displayText, true).catch((err) => {
        error(`atheism: [THINKING] update error: ${err}`);
      });
    },

    // 💭 推理结束
    onReasoningEnd: () => {
      log(`atheism: [THINKING] reasoning ended`);
      if (!responseId) return;  // Creation still in progress (responseCreateInProgress), nothing to update yet
      if (statusLine.startsWith("💭")) {
        statusLine = "📝 正在生成回复...";
        const displayText = buildDisplayText();
        deliverToA2A(displayText, true).catch(() => {});
      }
    },

    // 📝 新的 assistant 消息开始
    onAssistantMessageStart: () => {
      log(`atheism: [MSG] new assistant message start`);
      if (responseId && !hasReceivedText && !statusLine) {
        statusLine = "⏳ 正在思考...";
        const displayText = buildDisplayText();
        deliverToA2A(displayText, true).catch(() => {});
      }
    },

    // 📡 部分回复流式
    onPartialReply: (payload: ReplyPayload) => {
      const text = payload.text?.trim();
      if (!text || text === lastUpdateText) return;
      
      hasReceivedText = true;
      currentPartial = text;  // Update current streaming block
      accumulatedText = getFullText();  // Full text = completed blocks + current partial
      statusLine = "";  // 有文本输出了，清除状态
      deliverToA2A(accumulatedText, true).catch((err) => {
        error(`atheism: [PARTIAL] error: ${err}`);
      });
    },
  };

  // 🆕 ABORT 感知：外部通知 dispatcher 当前 job 已被中断
  const markDispatchAborted = () => {
    aborted = true;
    log(`atheism: [DISPATCHER] markDispatchAborted called — will skip onIdle delivery`);
  };

  return {
    dispatcher,
    replyOptions: enhancedReplyOptions,
    markDispatchIdle,
    markDispatchAborted,
    isCompleted: () => isCompleted,
    isSilent: () => isSilentResponse,
    getResponseId: () => responseId,
  };
}

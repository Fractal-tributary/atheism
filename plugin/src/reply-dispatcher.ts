import type { ClawdbotConfig, ReplyPayload } from "openclaw/plugin-sdk";
import type { AtheismConfig } from "./types.js";
import { updateAtheismMessage } from "./send.js";
import { getAtheismRuntime } from "./runtime.js";

export type CreateAtheismReplyDispatcherParams = {
  cfg: ClawdbotConfig;
  agentId: string;
  responseId: string;  // Can be "" for deferred mode
  config: AtheismConfig;
  /** Callback to create response on first substantive output (deferred mode) */
  createResponse?: (initialText: string) => Promise<string>;
  onComplete?: () => void;
  onSilent?: () => Promise<void>;  // Agent 决定静默时调用
};

export function createAtheismReplyDispatcher(params: CreateAtheismReplyDispatcherParams) {
  const core = getAtheismRuntime();
  const { cfg, agentId, config, onComplete, onSilent, createResponse } = params;
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

  const deliverToAtheism = async (text: string, streaming: boolean) => {
    if (isCompleted) return;
    if (isSilentResponse) return;  // 🆕 Already flagged as silent, don't create messages
    
    // 🆕 Defense-in-depth: don't create deferred response for text matching silent patterns
    // Catches cases where onPartialReply streams "NO" before deliver() can flag it
    if (!responseId && createResponse && isSilentText(text)) {
      log(`atheism: [DELIVER] preventing deferred response creation for silent text: "${text}"`);
      return;
    }
    
    // Deferred creation: create response on first substantive delivery
    // 🆕 Race condition guard: responseCreateInProgress prevents concurrent createResponse calls
    // (Bug fix: without this, multiple concurrent deliver/onPartialReply calls could each
    //  pass the !responseId check before the first await completes → 12x duplicate creates)
    if (!responseId && createResponse && !responseCreateInProgress) {
      responseCreateInProgress = true;
      try {
        responseId = await createResponse(text);
        log(`atheism: [DELIVER] deferred response created: ${responseId}`);
        // createResponse already sets the initial text, so for streaming we're done
        if (!streaming) {
          // Final delivery — need to mark as complete
          log(`atheism: [DELIVER] ✅ FINAL response delivered (deferred, ${text.length} chars)`);
          isCompleted = true;
          onComplete?.();
        }
        return;
      } catch (err) {
        responseCreateInProgress = false;
        error(`atheism: [DELIVER] failed to create deferred response: ${err}`);
        return;
      }
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
      await updateAtheismMessage({
        config,
        messageId: responseId,
        result: text,
        streaming,
      });
      
      if (!streaming) {
        log(`atheism: [DELIVER] ✅ FINAL response delivered (${text.length} chars)`);
        isCompleted = true;
        onComplete?.();
      }
    } catch (err) {
      error(`atheism: [DELIVER] error: ${err}`);
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
          await deliverToAtheism(accumulatedText, true);
        } else if (kind === "block") {
          await deliverToAtheism(accumulatedText, true);
        }
      },

      onError: async (err, info) => {
        error(`atheism: [ERROR] (${info.kind}): ${err}`);
        hasErrorOccurred = true;
        if (!isCompleted) {
          await deliverToAtheism(`❌ 处理出错: ${String(err)}`, false);
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
          await deliverToAtheism(accumulatedText, false);
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

    // 🔧 工具开始调用（真实事件！）
    onToolStart: (payload: { name?: string; phase?: string }) => {
      if (isCompleted) return;
      const toolName = payload.name || "unknown";
      const phase = payload.phase || "";
      
      log(`atheism: [TOOL] ${toolName} (phase: ${phase})`);
      
      const label = getToolLabel(toolName);
      toolCallHistory.push(label.split(" ").slice(1).join(" ").replace("...", ""));
      statusLine = label;

      // Skip visual updates in deferred mode (no placeholder created yet)
      if (!responseId) return;

      const displayText = buildDisplayText();
      deliverToAtheism(displayText, true).catch((err) => {
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

      // Skip visual updates in deferred mode (no placeholder created yet)
      if (!responseId) return;

      const displayText = buildDisplayText();
      deliverToAtheism(displayText, true).catch((err) => {
        error(`atheism: [THINKING] update error: ${err}`);
      });
    },

    // 💭 推理结束
    onReasoningEnd: () => {
      log(`atheism: [THINKING] reasoning ended`);
      if (responseId && statusLine.startsWith("💭")) {
        statusLine = "📝 正在生成回复...";
        const displayText = buildDisplayText();
        deliverToAtheism(displayText, true).catch(() => {});
      }
    },

    // 📝 新的 assistant 消息开始
    onAssistantMessageStart: () => {
      log(`atheism: [MSG] new assistant message start`);
      if (responseId && !hasReceivedText && !statusLine) {
        statusLine = "⏳ 正在思考...";
        const displayText = buildDisplayText();
        deliverToAtheism(displayText, true).catch(() => {});
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
      deliverToAtheism(accumulatedText, true).catch((err) => {
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

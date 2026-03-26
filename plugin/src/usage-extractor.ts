/**
 * 从 OpenClaw session transcript 提取 LLM usage 数据
 * 用于回填 A2A message metadata 的 token 用量
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

interface UsageData {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

interface AssistantMessage {
  role: string;
  usage?: UsageData;
  model?: string;
  provider?: string;
}

interface TranscriptEntry {
  type: string;
  message?: AssistantMessage;
}

/**
 * 从 OpenClaw agent sessions.json 中查找 session 的 transcript 文件路径
 */
function findSessionFile(agentId: string, sessionKey: string): string | null {
  try {
    const stateDir = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");
    const sessionsJsonPath = path.join(stateDir, "agents", agentId, "sessions", "sessions.json");
    
    if (!fs.existsSync(sessionsJsonPath)) {
      return null;
    }
    
    const sessionsData = JSON.parse(fs.readFileSync(sessionsJsonPath, "utf-8"));
    // sessions.json keys are stored lowercase; sessionKey from plugin may have mixed case
    const normalizedKey = sessionKey.toLowerCase();
    const sessionEntry = sessionsData[normalizedKey] || sessionsData[sessionKey];
    
    if (!sessionEntry || !sessionEntry.sessionFile) {
      console.warn(`[usage-extractor] Key not found in sessions.json. normalizedKey=${normalizedKey}, totalKeys=${Object.keys(sessionsData).length}`);
      return null;
    }
    
    return sessionEntry.sessionFile;
  } catch (err) {
    console.error(`[usage-extractor] Error finding session file: ${err}`);
    return null;
  }
}

/**
 * 从 transcript .jsonl 文件提取最后一条 assistant 消息的 usage 数据
 */
export async function extractUsageFromTranscript(params: {
  agentId: string;
  sessionKey: string;
}): Promise<{ input_tokens: number; output_tokens: number; cost?: number } | null> {
  const { agentId, sessionKey } = params;
  
  try {
    console.log(`[usage-extractor] Looking up: agentId=${agentId}, sessionKey=${sessionKey}`);
    const sessionFile = findSessionFile(agentId, sessionKey);
    if (!sessionFile) {
      console.warn(`[usage-extractor] Session file not found for agentId=${agentId}, sessionKey=${sessionKey}`);
      return null;
    }
    console.log(`[usage-extractor] Found session file: ${sessionFile}`);
    
    // 读取 transcript 文件的最后若干行（避免读取整个大文件）
    const content = fs.readFileSync(sessionFile, "utf-8");
    const lines = content.trim().split("\n").filter(l => l.trim());
    
    // 从后往前找最新的 assistant 消息（带 usage）
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry: TranscriptEntry = JSON.parse(lines[i]);
        if (entry.type === "message" && entry.message?.role === "assistant" && entry.message.usage) {
          const usage = entry.message.usage;
          // input_tokens = input + cacheRead + cacheWrite
          // cacheWrite = tokens sent as input AND written to cache (first request)
          // cacheRead  = tokens served from cache (subsequent requests)
          // input      = non-cacheable input tokens
          // All three contribute to the actual input token count.
          const inputTokens = (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
          // Fallback: use totalTokens - output if individual fields missing
          const finalInput = inputTokens > 0 ? inputTokens
            : (usage.totalTokens && usage.output ? usage.totalTokens - usage.output : 0);
          return {
            input_tokens: finalInput,
            output_tokens: usage.output || 0,
            cost: usage.cost?.total || 0,
          };
        }
      } catch {
        // 跳过解析失败的行
      }
    }
    
    console.warn(`[usage-extractor] No assistant message with usage found in ${sessionFile}`);
    return null;
  } catch (err) {
    console.error(`[usage-extractor] Error extracting usage: ${err}`);
    return null;
  }
}

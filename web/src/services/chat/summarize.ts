import { streamMessage } from "../api/client.js";
import type { ChatModel } from "../api/types.js";
import {
  SUMMARY_SYSTEM_PROMPT,
  chunkRounds,
  summaryUserPrompt,
  type CompactionPlan,
} from "./compaction.js";

/** 摘要的输出上限；提示词里要求控制在约 4,000 词以内。 */
const MAX_SUMMARY_TOKENS = 8192;

/**
 * 逐块迭代摘要：第一块连同之前的摘要一起交给模型，之后每块接着上一份结果更新。
 * 摘要请求不声明任何工具、不要标题、不开思考；保留与普通请求一致的安全审核。
 */
export const summarize = async (
  plan: CompactionPlan,
  options: { token: string; model: ChatModel; window: number; signal: AbortSignal },
): Promise<string> => {
  let notes = plan.previousSummary;
  for (const chunk of chunkRounds(plan.toSummarize, options.window)) {
    let text = "";
    const events = streamMessage(
      options.token,
      {
        model: options.model,
        system: SUMMARY_SYSTEM_PROMPT,
        messages: [{ role: "user", content: summaryUserPrompt(chunk, notes) }],
        thinking: { type: "disabled" },
        safety_check: { level: "high" },
        max_tokens: MAX_SUMMARY_TOKENS,
      },
      options.signal,
    );
    for await (const event of events) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        text += event.delta.text;
      }
    }
    notes = text.trim();
    if (!notes) {
      throw new Error("The summary came back empty");
    }
  }
  if (!notes) {
    throw new Error("Nothing to summarize");
  }
  return notes;
};

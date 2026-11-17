import type {
  AssistantBlockParam,
  MessageParam,
  MessageStreamEvent,
  ToolResultBlockParam,
} from "../api/types.js";
import { findClientTool } from "./registry.js";
import type { ToolContext, ToolOutcome } from "./tools.js";

/** 一条用户消息最多允许的工具往返轮数（含第一次请求之后的每一轮）。 */
export const MAX_AGENT_ROUNDS = 8;
/** 回传给模型和存进轨迹的工具输出上限。 */
const MAX_OUTPUT = 30_000;

export type ToolCall = {
  id: string;
  name: string;
  input: unknown;
  /** 参数不是合法 JSON 时的说明；此时不执行，直接回报错误 */
  inputError?: string;
};

export type Round = { content: AssistantBlockParam[]; results: ToolResultBlockParam[] };

type Pending =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "tool_use"; id: string; name: string; startInput: unknown; json: string };

/**
 * 从一次请求的流里收集“原样回传所需的内容”：思考（含签名）、正文和客户端工具调用。
 * 与界面用的 applyEvent 相互独立：界面展示可以合并、丢弃，回传必须保持协议原样。
 * 搜索等服务端工具块不在这里收集。
 */
export const createRoundCollector = () => {
  const blocks = new Map<number, Pending>();
  return {
    push(event: MessageStreamEvent) {
      if (event.type === "content_block_start") {
        const block = event.content_block;
        if (block.type === "text") {
          blocks.set(event.index, { type: "text", text: block.text });
        } else if (block.type === "thinking") {
          blocks.set(event.index, {
            type: "thinking",
            thinking: block.thinking,
            signature: block.signature ?? "",
          });
        } else if (block.type === "tool_use") {
          blocks.set(event.index, {
            type: "tool_use",
            id: block.id,
            name: block.name,
            startInput: block.input,
            json: "",
          });
        }
        return;
      }
      if (event.type !== "content_block_delta") {
        return;
      }
      const block = blocks.get(event.index);
      const { delta } = event;
      if (block?.type === "text" && delta.type === "text_delta") {
        block.text += delta.text;
      } else if (block?.type === "thinking" && delta.type === "thinking_delta") {
        block.thinking += delta.thinking;
      } else if (block?.type === "thinking" && delta.type === "signature_delta") {
        block.signature += delta.signature;
      } else if (block?.type === "tool_use" && delta.type === "input_json_delta") {
        block.json += delta.partial_json;
      }
    },
    /** 按块出现的顺序回传：思考、正文、工具调用。空正文不回传。 */
    result(): { content: AssistantBlockParam[]; calls: ToolCall[] } {
      const content: AssistantBlockParam[] = [];
      const calls: ToolCall[] = [];
      for (const [, block] of [...blocks].sort(([a], [b]) => a - b)) {
        if (block.type === "text") {
          if (block.text) {
            content.push({ type: "text", text: block.text });
          }
        } else if (block.type === "thinking") {
          content.push({ type: "thinking", thinking: block.thinking, signature: block.signature });
        } else {
          let input: unknown = block.startInput ?? {};
          let inputError: string | undefined;
          if (block.json.trim()) {
            try {
              input = JSON.parse(block.json);
            } catch {
              input = {};
              inputError = "The arguments were not valid JSON.";
            }
          }
          content.push({ type: "tool_use", id: block.id, name: block.name, input });
          calls.push({ id: block.id, name: block.name, input, inputError });
        }
      }
      return { content, calls };
    },
  };
};

const clip = (text: string) =>
  text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n[output truncated]` : text;

/** 执行一个客户端工具；任何失败都转成 is_error 的结果，保证每个 tool_use 都有对应的 tool_result。 */
export const runToolCall = async (context: ToolContext, call: ToolCall): Promise<ToolOutcome> => {
  if (call.inputError) {
    return { text: call.inputError, isError: true };
  }
  const tool = findClientTool(call.name);
  if (!tool) {
    return { text: `Unknown tool: ${call.name}`, isError: true };
  }
  try {
    const outcome = await tool.run(context, call.input);
    return { ...outcome, text: clip(outcome.text) };
  } catch (error) {
    return {
      text: `The tool failed: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
  }
};

/** 已完成的往返接在基础消息之后：assistant 的完整内容，然后是紧随其后的 user 工具结果。 */
export const appendRounds = (base: MessageParam[], rounds: Round[]): MessageParam[] => [
  ...base,
  ...rounds.flatMap((round): MessageParam[] => [
    { role: "assistant", content: round.content },
    { role: "user", content: round.results },
  ]),
];

/**
 * 假的 DeepSeek Anthropic 兼容接口：按脚本回放流式回复，并记录收到的请求。
 * 事件结构与 src/services/agent/fixtures 里录制的真实流一致。
 */
export type ScriptedToolCall = { id: string; name: string; input: Record<string, unknown> };

export type ScriptedReply = {
  /** 按块依次发出，块之间等待 gapMs，便于断言流式中间状态 */
  chunks: string[];
  gapMs?: number;
  thinking?: string;
  /** 正文之后发出的客户端工具调用；有则以 tool_use 结束，没有则 end_turn */
  toolCalls?: ScriptedToolCall[];
};

export type RecordedRequest = { path: string; body: any; headers: Headers };

const encoder = new TextEncoder();

const frame = (event: string, data: object) =>
  encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

const usage = (output: number, input = 10) => ({
  input_tokens: input,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: output,
  service_tier: "standard",
});

/** 摘要请求由系统提示词识别（与应用里的 SUMMARY_SYSTEM_PROMPT 对应）。 */
export const isSummaryRequest = (body: any) =>
  typeof body?.system === "string" && body.system.includes("long-term memory");

export const createMockDeepseek = () => {
  const queue: ScriptedReply[] = [];
  const requests: RecordedRequest[] = [];
  let counter = 0;
  let failingSummaries = 0;
  let overflowArmed = false;

  const stream = (
    script: ScriptedReply,
    signal: AbortSignal,
    thinkingEnabled: boolean,
    promptTokens: number,
  ) => {
    const id = `mock-${++counter}`;
    return new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: string, data: object) => controller.enqueue(frame(event, data));
        try {
          send("message_start", {
            type: "message_start",
            message: {
              id,
              type: "message",
              role: "assistant",
              model: "deepseek-flash",
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: usage(0, promptTokens),
            },
          });
          let index = 0;
          // 开启思考时真实接口总会先发一个带签名的思考块（正文可能为空），回传时必须原样带回。
          if (script.thinking || thinkingEnabled) {
            send("content_block_start", {
              type: "content_block_start",
              index,
              content_block: { type: "thinking", thinking: "" },
            });
            if (script.thinking) {
              send("content_block_delta", {
                type: "content_block_delta",
                index,
                delta: { type: "thinking_delta", thinking: script.thinking },
              });
            }
            send("content_block_delta", {
              type: "content_block_delta",
              index,
              delta: { type: "signature_delta", signature: id },
            });
            send("content_block_stop", { type: "content_block_stop", index });
            index++;
          }
          send("content_block_start", {
            type: "content_block_start",
            index,
            content_block: { type: "text", text: "" },
          });
          send("ping", { type: "ping" });
          for (const [i, text] of script.chunks.entries()) {
            if (i > 0 && script.gapMs) {
              await new Promise((resolve) => setTimeout(resolve, script.gapMs));
            }
            if (signal.aborted) return controller.close();
            send("content_block_delta", {
              type: "content_block_delta",
              index,
              delta: { type: "text_delta", text },
            });
          }
          send("content_block_stop", { type: "content_block_stop", index });
          for (const call of script.toolCalls ?? []) {
            index++;
            send("content_block_start", {
              type: "content_block_start",
              index,
              content_block: { type: "tool_use", id: call.id, name: call.name, input: {} },
            });
            // 参数分两段到达，和真实流一样需要拼接。
            const json = JSON.stringify(call.input);
            const cut = Math.max(1, Math.floor(json.length / 2));
            for (const part of [json.slice(0, cut), json.slice(cut)]) {
              send("content_block_delta", {
                type: "content_block_delta",
                index,
                delta: { type: "input_json_delta", partial_json: part },
              });
            }
            send("content_block_stop", { type: "content_block_stop", index });
          }
          send("message_delta", {
            type: "message_delta",
            delta: {
              stop_reason: script.toolCalls?.length ? "tool_use" : "end_turn",
              stop_sequence: null,
            },
            usage: usage(Math.ceil(script.chunks.join("").length / 4), promptTokens),
          });
          send("message_stop", { type: "message_stop" });
          controller.close();
        } catch {
          // 客户端中途取消
        }
      },
    });
  };

  return {
    requests,
    /** 追加下一次请求要回放的脚本；队列为空时返回一句固定的默认回复。 */
    reply: (script: ScriptedReply) => void queue.push(script),
    reset: () => {
      queue.length = 0;
      requests.length = 0;
      counter = 0;
      failingSummaries = 0;
      overflowArmed = false;
    },
    /** 接下来 n 个摘要请求返回 500 */
    failSummaries: (n: number) => void (failingSummaries = n),
    /** 下一个普通请求返回上下文溢出错误（400） */
    overflowOnce: () => void (overflowArmed = true),
    async handle(req: Request, path: string): Promise<Response> {
      if (req.method !== "POST" || path !== "/anthropic/v1/messages") {
        return Response.json({ error: { message: "mock: not found" } }, { status: 404 });
      }
      const body = await req.json();
      requests.push({ path, body, headers: req.headers });
      // 与真实接口一致（src/services/agent/fixtures/matrix-*.json）：客户端工具与 safety_check、
      // 服务端工具或 title 同时出现时，必须开启思考。
      const tools: any[] = Array.isArray(body.tools) ? body.tools : [];
      const hasClientTool = tools.some((tool) => !tool.type);
      const hasExtended = tools.some((tool) => tool.type) || body.safety_check || body.title;
      if (hasClientTool && hasExtended && body.thinking?.type !== "enabled") {
        return Response.json(
          {
            type: "error",
            error: {
              type: "invalid_request_error",
              message:
                "tools: client tools can only be used together with `deepseek_web_search`, `deepseek_read_url`, `safety_check` or `title` in thinking mode (request_id: mock)",
            },
          },
          { status: 400 },
        );
      }
      // 与真实接口一样按请求内容报告用量（约 4 个字符一个 token，加固定开销），
      // 这样压缩之后上下文确实变小，应用据此判断是否还需要压缩。
      const promptTokens = Math.ceil(JSON.stringify(body.messages).length / 4) + 1500;
      // 摘要请求由系统提示词识别，直接给一份固定的笔记，不占用脚本队列。
      const isSummary = isSummaryRequest(body);
      if (isSummary && failingSummaries > 0) {
        failingSummaries--;
        return Response.json(
          { type: "error", error: { type: "api_error", message: "mock: summary failed" } },
          { status: 500 },
        );
      }
      if (!isSummary && overflowArmed) {
        overflowArmed = false;
        return Response.json(
          {
            type: "error",
            error: {
              type: "invalid_request_error",
              message:
                "This model's maximum context length is 1048576 tokens. However, your messages resulted in more tokens (mock).",
            },
          },
          { status: 400 },
        );
      }
      const script = isSummary
        ? { chunks: ["SCRIPTED-SUMMARY: notes about the earlier part of the conversation."] }
        : (queue.shift() ?? { chunks: ["(mock default reply)"] });
      return new Response(
        stream(script, req.signal, body.thinking?.type === "enabled", promptTokens),
        {
          headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" },
        },
      );
    },
  };
};

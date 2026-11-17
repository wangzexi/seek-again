/**
 * 假的 DeepSeek Anthropic 兼容接口：按脚本回放流式回复，并记录收到的请求。
 */
export type ScriptedReply = {
  /** 按块依次发出，块之间等待 gapMs，便于断言流式中间状态 */
  chunks: string[];
  gapMs?: number;
  thinking?: string;
};

export type RecordedRequest = { path: string; body: any; headers: Headers };

const encoder = new TextEncoder();

const frame = (event: string, data: object) =>
  encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

const usage = (output: number) => ({
  input_tokens: 10,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: output,
  service_tier: "standard",
});

export const createMockDeepseek = () => {
  const queue: ScriptedReply[] = [];
  const requests: RecordedRequest[] = [];
  let counter = 0;

  const stream = (script: ScriptedReply, signal: AbortSignal) => {
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
              usage: usage(0),
            },
          });
          let index = 0;
          if (script.thinking) {
            send("content_block_start", {
              type: "content_block_start",
              index,
              content_block: { type: "thinking", thinking: "" },
            });
            send("content_block_delta", {
              type: "content_block_delta",
              index,
              delta: { type: "thinking_delta", thinking: script.thinking },
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
          send("message_delta", {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: usage(script.chunks.join("").length),
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
    },
    async handle(req: Request, path: string): Promise<Response> {
      if (req.method !== "POST" || path !== "/anthropic/v1/messages") {
        return Response.json({ error: { message: "mock: not found" } }, { status: 404 });
      }
      const body = await req.json();
      requests.push({ path, body, headers: req.headers });
      const script = queue.shift() ?? { chunks: ["(mock default reply)"] };
      return new Response(stream(script, req.signal), {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" },
      });
    },
  };
};

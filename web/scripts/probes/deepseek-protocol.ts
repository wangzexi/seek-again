/**
 * 阶段 A 协议探针：用真实 DeepSeek Anthropic 兼容接口验证客户端工具往返与文件块的组合。
 * 用法：DEEPSEEK_API_KEY=sk-... bun scripts/probes/deepseek-protocol.ts
 * 每次请求与响应（流式按事件）录成 src/services/agent/fixtures/*.json；密钥不会写入夹具。
 */
const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) throw new Error("Set DEEPSEEK_API_KEY");

const base = "https://api.deepseek.com/anthropic/v1";
const outDir = new URL("../../src/services/agent/fixtures/", import.meta.url);
const FILES_BETA = "files-api-2025-04-14";
const MODEL = "deepseek-flash";

type Json = Record<string, any>;
type Result = { status: number; body: any; events?: { event: string; data: any }[] };

const scrub = (value: string) => value.split(apiKey).join("<redacted>");

async function save(name: string, request: Json, result: Result) {
  const text = scrub(
    JSON.stringify(
      { name, recordedAt: new Date().toISOString(), model: MODEL, request, response: result },
      null,
      2,
    ),
  );
  await Bun.write(new URL(name + ".json", outDir), text + "\n");
}

async function readSse(response: Response) {
  const events: { event: string; data: any }[] = [];
  for (const chunk of (await response.text()).split(/\r?\n\r?\n/)) {
    let event = "";
    const data: string[] = [];
    for (const line of chunk.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (!data.length) continue;
    const raw = data.join("\n");
    try {
      events.push({ event, data: JSON.parse(raw) });
    } catch {
      events.push({ event, data: raw });
    }
  }
  return events;
}

async function messages(name: string, body: Json, opts: { stream?: boolean; beta?: boolean } = {}) {
  const request = { ...body, ...(opts.stream ? { stream: true } : {}) };
  const response = await fetch(base + "/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey!,
      "Content-Type": "application/json",
      ...(opts.beta ? { "anthropic-beta": FILES_BETA } : {}),
    },
    body: JSON.stringify(request),
  });
  let result: Result;
  if (opts.stream && response.ok) {
    result = { status: response.status, body: null, events: await readSse(response) };
  } else {
    const text = await response.text();
    let parsed: any = text;
    try {
      parsed = JSON.parse(text);
    } catch {}
    result = { status: response.status, body: parsed };
  }
  await save(name, { method: "POST", path: "/messages", beta: !!opts.beta, body: request }, result);
  return result;
}

/** 把流式事件合并成与非流式相同的 content 数组，便于继续往返。 */
function assemble(events: NonNullable<Result["events"]>) {
  const blocks: Json[] = [];
  const partial: string[] = [];
  let stop: string | undefined;
  for (const { data } of events) {
    if (data?.type === "content_block_start") {
      blocks[data.index] = structuredClone(data.content_block);
      partial[data.index] = "";
    } else if (data?.type === "content_block_delta") {
      const block = blocks[data.index];
      const delta = data.delta;
      if (delta.type === "text_delta") block.text = (block.text ?? "") + delta.text;
      else if (delta.type === "thinking_delta")
        block.thinking = (block.thinking ?? "") + delta.thinking;
      else if (delta.type === "signature_delta")
        block.signature = (block.signature ?? "") + delta.signature;
      else if (delta.type === "input_json_delta") partial[data.index] += delta.partial_json;
    } else if (data?.type === "content_block_stop") {
      const block = blocks[data.index];
      if (block?.type === "tool_use" && partial[data.index])
        block.input = JSON.parse(partial[data.index]);
    } else if (data?.type === "message_delta") {
      stop = data.delta?.stop_reason;
    }
  }
  return { content: blocks.filter(Boolean), stop };
}

async function upload(name: string, file: File, fields: Record<string, string> = {}) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value); // purpose 必须在 file 之前
  form.append("file", file);
  const response = await fetch(base + "/files", {
    method: "POST",
    headers: { "x-api-key": apiKey!, "anthropic-beta": FILES_BETA },
    body: form,
  });
  const text = await response.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {}
  await save(
    name,
    {
      method: "POST",
      path: "/files",
      fields,
      file: { name: file.name, type: file.type, size: file.size },
    },
    { status: response.status, body: parsed },
  );
  return { status: response.status, body: parsed };
}

const textOf = (content: Json[] | undefined) =>
  (content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

/** 最小的单页 PDF，正文为 "SECRET-PDF-42"。 */
function tinyPdf(word: string) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = `BT /F1 18 Tf 20 70 Td (Secret code word: ${word}) Tj ET`;
  objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new File([pdf], "report.pdf", { type: "application/pdf" });
}

const readFileTool = {
  name: "read_file",
  description: "Read a text file from the local virtual filesystem.",
  input_schema: {
    type: "object",
    properties: { path: { type: "string", description: "file path" } },
    required: ["path"],
  },
};

const readAttachmentTool = {
  name: "read_attachment",
  description: "Read an attached document. The file content will be provided to you.",
  input_schema: {
    type: "object",
    properties: { path: { type: "string" }, purpose: { type: "string" } },
    required: ["path"],
  },
};

const summary: Record<string, string> = {};
const note = (name: string, text: string) => {
  summary[name] = text;
  console.log(name.padEnd(34), text);
};
const run = async (name: string, fn: () => Promise<string>) => {
  try {
    note(name, await fn());
  } catch (error) {
    note(name, "THREW " + scrub(String(error)));
  }
};
const brief = (r: Result) =>
  `${r.status}` +
  (r.status === 200 && r.body
    ? ` stop=${r.body.stop_reason} blocks=${r.body.content?.map((b: Json) => b.type).join(",")}`
    : r.events
      ? " (stream)"
      : " " + JSON.stringify(r.body).slice(0, 220));

const ask = "Use the read_file tool to read notes.txt, then tell me its first line.";
const notes = "first line: HELLO-123\nsecond line: bye";
const common = { model: MODEL, max_tokens: 1024, system: "You are a helpful assistant." };

// ---------- A：客户端工具往返 ----------
let a1: Json[] = [];
let a1Id = "";
await run("A1 tool_use (non-stream)", async () => {
  const r = await messages("a1-tool-use", {
    ...common,
    thinking: { type: "disabled" },
    tools: [readFileTool],
    messages: [{ role: "user", content: ask }],
  });
  a1 = r.body?.content ?? [];
  a1Id = a1.find((b) => b.type === "tool_use")?.id ?? "";
  return brief(r);
});

await run("A2 tool_result roundtrip", async () => {
  const r = await messages("a2-tool-roundtrip", {
    ...common,
    thinking: { type: "disabled" },
    tools: [readFileTool],
    messages: [
      { role: "user", content: ask },
      { role: "assistant", content: a1 },
      { role: "user", content: [{ type: "tool_result", tool_use_id: a1Id, content: notes }] },
    ],
  });
  return brief(r) + " text=" + JSON.stringify(textOf(r.body?.content).slice(0, 80));
});

await run("A3 tool_use (stream)", async () => {
  const r = await messages(
    "a3-tool-use-stream",
    {
      ...common,
      thinking: { type: "disabled" },
      tools: [readFileTool],
      messages: [{ role: "user", content: ask }],
    },
    { stream: true },
  );
  const { content, stop } = assemble(r.events ?? []);
  return `${r.status} stop=${stop} blocks=${content.map((b) => b.type).join(",")} input=${JSON.stringify(content.find((b) => b.type === "tool_use")?.input)}`;
});

let a4: Json[] = [];
let a4Id = "";
await run("A4 thinking + tool_use (stream)", async () => {
  const r = await messages(
    "a4-thinking-tool-use-stream",
    {
      ...common,
      thinking: { type: "enabled" },
      tools: [readFileTool],
      messages: [{ role: "user", content: ask }],
    },
    { stream: true },
  );
  const merged = assemble(r.events ?? []);
  a4 = merged.content;
  a4Id = a4.find((b) => b.type === "tool_use")?.id ?? "";
  return `${r.status} stop=${merged.stop} blocks=${a4.map((b) => b.type).join(",")}`;
});

await run("A5 thinking roundtrip (full content)", async () => {
  const r = await messages("a5-thinking-roundtrip-full", {
    ...common,
    thinking: { type: "enabled" },
    tools: [readFileTool],
    messages: [
      { role: "user", content: ask },
      { role: "assistant", content: a4 },
      { role: "user", content: [{ type: "tool_result", tool_use_id: a4Id, content: notes }] },
    ],
  });
  return brief(r) + " text=" + JSON.stringify(textOf(r.body?.content).slice(0, 80));
});

await run("A6 thinking roundtrip (thinking dropped)", async () => {
  const r = await messages("a6-thinking-roundtrip-dropped", {
    ...common,
    thinking: { type: "enabled" },
    tools: [readFileTool],
    messages: [
      { role: "user", content: ask },
      { role: "assistant", content: a4.filter((b) => b.type !== "thinking") },
      { role: "user", content: [{ type: "tool_result", tool_use_id: a4Id, content: notes }] },
    ],
  });
  return brief(r);
});

await run("A7 parallel tool calls", async () => {
  const prompt =
    "Read BOTH a.txt and b.txt using read_file (call them in the same turn), then tell me both first lines.";
  const first = await messages("a7-parallel-tool-use", {
    ...common,
    thinking: { type: "disabled" },
    tools: [readFileTool],
    messages: [{ role: "user", content: prompt }],
  });
  const uses = (first.body?.content ?? []).filter((b: Json) => b.type === "tool_use");
  if (uses.length < 1) return brief(first);
  const second = await messages("a7-parallel-roundtrip", {
    ...common,
    thinking: { type: "disabled" },
    tools: [readFileTool],
    messages: [
      { role: "user", content: prompt },
      { role: "assistant", content: first.body.content },
      {
        role: "user",
        content: uses.map((u: Json) => ({
          type: "tool_result",
          tool_use_id: u.id,
          content: `content of ${u.input?.path}: LINE-${u.input?.path}`,
        })),
      },
    ],
  });
  return `calls=${uses.length} then ${brief(second)} text=${JSON.stringify(textOf(second.body?.content).slice(0, 80))}`;
});

await run("A8 tool_result is_error + array content", async () => {
  const r = await messages("a8-tool-result-error", {
    ...common,
    thinking: { type: "disabled" },
    tools: [readFileTool],
    messages: [
      { role: "user", content: ask },
      { role: "assistant", content: a1 },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: a1Id,
            is_error: true,
            content: [{ type: "text", text: "ENOENT: no such file" }],
          },
        ],
      },
    ],
  });
  return brief(r) + " text=" + JSON.stringify(textOf(r.body?.content).slice(0, 100));
});

// ---------- B：Files API 与文件块 ----------
const fileIds: string[] = [];
await run("B1 upload text with expiry", async () => {
  const r = await upload(
    "b1-upload-text-expiry",
    new File([notes], "notes.txt", { type: "text/plain" }),
    {
      purpose: "user_data",
      "expires_after[anchor]": "created_at",
      "expires_after[seconds]": "3600",
    },
  );
  if (r.body?.id) fileIds.push(r.body.id);
  return `${r.status} ${JSON.stringify(r.body).slice(0, 220)}`;
});

let textFileId = fileIds[0] ?? "";
if (!textFileId) {
  await run("B1b upload text (no expiry)", async () => {
    const r = await upload(
      "b1b-upload-text",
      new File([notes], "notes.txt", { type: "text/plain" }),
      {
        purpose: "user_data",
      },
    );
    if (r.body?.id) {
      fileIds.push(r.body.id);
      textFileId = r.body.id;
    }
    return `${r.status} ${JSON.stringify(r.body).slice(0, 220)}`;
  });
}

let pdfId = "";
await run("B2 upload pdf (text_recognition)", async () => {
  const r = await upload("b2-upload-pdf", tinyPdf("SECRET-PDF-42"), {
    purpose: "text_recognition",
  });
  if (r.body?.id) {
    fileIds.push(r.body.id);
    pdfId = r.body.id;
  }
  return `${r.status} ${JSON.stringify(r.body).slice(0, 220)}`;
});

const docBlock = { type: "document", source: { type: "file", file_id: pdfId } };
const attachPrompt =
  "Call read_attachment for report.pdf, then tell me the secret code word in it.";

await run("B3 document block directly", async () => {
  const r = await messages(
    "b3-document-direct",
    {
      ...common,
      thinking: { type: "disabled" },
      messages: [
        {
          role: "user",
          content: [docBlock, { type: "text", text: "What is the secret code word?" }],
        },
      ],
    },
    { beta: true },
  );
  return brief(r) + " text=" + JSON.stringify(textOf(r.body?.content).slice(0, 80));
});

let b4Use: Json[] = [];
let b4Id = "";
await run("B4a read_attachment tool_use", async () => {
  const r = await messages("b4a-read-attachment-tool-use", {
    ...common,
    thinking: { type: "disabled" },
    tools: [readAttachmentTool],
    messages: [{ role: "user", content: attachPrompt }],
  });
  b4Use = r.body?.content ?? [];
  b4Id = b4Use.find((b) => b.type === "tool_use")?.id ?? "";
  return brief(r);
});

await run("B4b tool_result + document SAME user msg", async () => {
  const r = await messages(
    "b4b-tool-result-plus-document",
    {
      ...common,
      thinking: { type: "disabled" },
      tools: [readAttachmentTool],
      messages: [
        { role: "user", content: attachPrompt },
        { role: "assistant", content: b4Use },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: b4Id,
              content: "report.pdf has been uploaded; see the attached document.",
            },
            docBlock,
          ],
        },
      ],
    },
    { beta: true },
  );
  return brief(r) + " text=" + JSON.stringify(textOf(r.body?.content).slice(0, 100));
});

await run("B5 doc in FOLLOWING user message", async () => {
  const r = await messages(
    "b5-document-in-following-user-message",
    {
      ...common,
      thinking: { type: "disabled" },
      tools: [readAttachmentTool],
      messages: [
        { role: "user", content: attachPrompt },
        { role: "assistant", content: b4Use },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: b4Id,
              content: "Uploaded. The document follows in the next message.",
            },
          ],
        },
        { role: "user", content: [docBlock, { type: "text", text: "Here is report.pdf." }] },
      ],
    },
    { beta: true },
  );
  return brief(r) + " text=" + JSON.stringify(textOf(r.body?.content).slice(0, 100));
});

await run("B6 document block + thinking enabled", async () => {
  const r = await messages(
    "b6-document-with-thinking",
    {
      ...common,
      thinking: { type: "enabled" },
      messages: [
        {
          role: "user",
          content: [docBlock, { type: "text", text: "What is the secret code word?" }],
        },
      ],
    },
    { beta: true },
  );
  return brief(r);
});

await run("B7 text file as document block", async () => {
  const r = await messages(
    "b7-text-file-document",
    {
      ...common,
      thinking: { type: "disabled" },
      messages: [
        {
          role: "user",
          content: [
            { type: "document", source: { type: "file", file_id: textFileId } },
            { type: "text", text: "What is the first line?" },
          ],
        },
      ],
    },
    { beta: true },
  );
  return brief(r) + " text=" + JSON.stringify(textOf(r.body?.content).slice(0, 80));
});

// ---------- 清理 ----------
for (const id of fileIds) {
  const response = await fetch(`${base}/files/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { "x-api-key": apiKey!, "anthropic-beta": FILES_BETA },
  });
  console.log("cleanup delete", id.slice(0, 12), response.status);
}

await Bun.write(new URL("_summary.json", outDir), JSON.stringify(summary, null, 2) + "\n");

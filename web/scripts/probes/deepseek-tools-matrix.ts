/**
 * 探针：客户端工具与 thinking、safety_check、服务端工具、title 的组合限制。
 * 起因：真实接口对“客户端工具 + safety_check + deepseek_read_url + 关闭思考”返回 400。
 * 用法：DEEPSEEK_API_KEY=sk-... bun scripts/probes/deepseek-tools-matrix.ts
 * 每个组合的请求和响应录进 src/services/agent/fixtures/matrix-*.json；密钥不写入夹具。
 */
const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) throw new Error("Set DEEPSEEK_API_KEY");

const url = "https://api.deepseek.com/anthropic/v1/messages";
const outDir = new URL("../../src/services/agent/fixtures/", import.meta.url);

const clientTool = {
  name: "read_file",
  description: "Read a text file.",
  input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};
const readUrl = { type: "deepseek_read_url", name: "deepseek_read_url" };
const webSearch = { type: "deepseek_web_search", name: "deepseek_web_search" };
const safety = { level: "high" };

type Case = { name: string; thinking: "enabled" | "disabled"; tools: object[]; extra?: object };

const cases: Case[] = [
  { name: "client-only/think-off", thinking: "disabled", tools: [clientTool] },
  { name: "client-only/think-on", thinking: "enabled", tools: [clientTool] },
  {
    name: "client+safety/think-off",
    thinking: "disabled",
    tools: [clientTool],
    extra: { safety_check: safety },
  },
  {
    name: "client+safety/think-on",
    thinking: "enabled",
    tools: [clientTool],
    extra: { safety_check: safety },
  },
  { name: "client+readurl/think-off", thinking: "disabled", tools: [readUrl, clientTool] },
  { name: "client+readurl/think-on", thinking: "enabled", tools: [readUrl, clientTool] },
  {
    name: "client+title/think-off",
    thinking: "disabled",
    tools: [clientTool],
    extra: { title: { enabled: true } },
  },
  {
    name: "client+title/think-on",
    thinking: "enabled",
    tools: [clientTool],
    extra: { title: { enabled: true } },
  },
  {
    name: "app-request(client+readurl+safety+title)/think-off",
    thinking: "disabled",
    tools: [readUrl, clientTool],
    extra: { safety_check: safety, title: { enabled: true } },
  },
  {
    name: "app-request(client+readurl+safety+title)/think-on",
    thinking: "enabled",
    tools: [readUrl, clientTool],
    extra: { safety_check: safety, title: { enabled: true } },
  },
  {
    name: "app-request+search(client+readurl+websearch+safety+title)/think-on",
    thinking: "enabled",
    tools: [readUrl, webSearch, clientTool],
    extra: { safety_check: safety, title: { enabled: true } },
  },
  {
    name: "app-request+search(client+readurl+websearch+safety+title)/think-off",
    thinking: "disabled",
    tools: [readUrl, webSearch, clientTool],
    extra: { safety_check: safety, title: { enabled: true } },
  },
];

const summary: Record<string, string> = {};
for (const c of cases) {
  const body = {
    model: "deepseek-flash",
    max_tokens: 512,
    system: "You are a helpful assistant.",
    thinking: { type: c.thinking },
    tools: c.tools,
    messages: [{ role: "user", content: "Use the read_file tool to read notes.txt." }],
    ...c.extra,
  };
  const response = await fetch(url, {
    method: "POST",
    headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {}
  const file = "matrix-" + c.name.replace(/[^a-z0-9+-]+/gi, "_") + ".json";
  await Bun.write(
    new URL(file, outDir),
    JSON.stringify(
      {
        name: c.name,
        recordedAt: new Date().toISOString(),
        request: { body },
        response: { status: response.status, body: parsed },
      },
      null,
      2,
    )
      .split(apiKey)
      .join("<redacted>") + "\n",
  );
  const stop = response.ok
    ? `stop=${parsed.stop_reason} blocks=${parsed.content?.map((b: any) => b.type).join(",")}`
    : JSON.stringify(parsed?.error?.message ?? parsed).slice(0, 170);
  summary[c.name] = `${response.status} ${stop}`;
  console.log(c.name.padEnd(70), response.status, stop);
}
await Bun.write(new URL("matrix-_summary.json", outDir), JSON.stringify(summary, null, 2) + "\n");

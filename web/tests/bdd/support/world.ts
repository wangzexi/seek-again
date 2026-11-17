import {
  chromium,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  type Route,
} from "playwright-core";
import { createMockDeepseek } from "./mockDeepseek.js";

/**
 * fixture：浏览器 + 假服务端，确定、不需要密钥（默认）。
 * real：浏览器 + 真实 DeepSeek 接口，需要 DEEPSEEK_API_KEY；输出不确定，断言只看结构。
 */
export const mode: "fixture" | "real" = process.env.BDD_MODE === "real" ? "real" : "fixture";
export const strict = mode === "fixture";

const dist = process.env.BDD_DIST
  ? new URL("./", Bun.pathToFileURL(process.env.BDD_DIST + "/index.html"))
  : new URL("../../../../dist/", import.meta.url);
const upstream = "https://api.deepseek.com";
const prefix = "/api/deepseek";
// 真实模式由测试服务注入密钥。
const fixtureKey = "sk-bdd-fixture";

export const mock = createMockDeepseek();

let server: ReturnType<typeof Bun.serve> | undefined;
let browser: Browser | undefined;

export const start = async () => {
  if (mode === "real" && !process.env.DEEPSEEK_API_KEY) {
    throw new Error("BDD_MODE=real needs DEEPSEEK_API_KEY");
  }
  if (!(await Bun.file(new URL("index.html", dist)).exists())) {
    throw new Error("Run `bun run build` before the BDD tests.");
  }
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.startsWith(prefix + "/")) {
        const path = url.pathname.slice(prefix.length);
        if (mode === "fixture") return mock.handle(req, path);
        // 测试服务转发真实模式的请求。
        const headers = new Headers({ "x-api-key": process.env.DEEPSEEK_API_KEY! });
        for (const name of ["content-type", "anthropic-beta", "anthropic-version"]) {
          const value = req.headers.get(name);
          if (value) headers.set(name, value);
        }
        const result = await fetch(upstream + path, {
          method: req.method,
          headers,
          body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
          signal: req.signal,
        });
        const responseHeaders = new Headers({ "Cache-Control": "no-store" });
        for (const name of ["content-type", "retry-after"]) {
          const value = result.headers.get(name);
          if (value) responseHeaders.set(name, value);
        }
        return new Response(result.body, { status: result.status, headers: responseHeaders });
      }
      const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const file = Bun.file(new URL(name, dist));
      if (!new URL(name, dist).href.startsWith(dist.href) || !(await file.exists())) {
        return new Response(null, { status: 404 });
      }
      return new Response(file, { headers: { "Cache-Control": "no-store" } });
    },
  });
  browser = await chromium.launch({ channel: "chrome", headless: true });
};

export const stop = async () => {
  await browser?.close();
  await server?.stop(true);
};

export type App = { context: BrowserContext; page: Page; close: () => Promise<void> };

/** 每个场景一个全新的浏览器环境（独立的 localStorage 与 IndexedDB），并已带上登录凭证。 */
export const openApp = async (
  options?: { thinking?: boolean; contextWindow?: number } | ((route: Route) => Promise<void>),
): Promise<App> => {
  const setup = typeof options === "function" ? options : undefined;
  const thinking = typeof options === "object" ? (options.thinking ?? false) : false;
  const contextWindow = typeof options === "object" ? options.contextWindow : undefined;
  if (!browser || !server) throw new Error("world not started");
  mock.reset();
  const context = await browser.newContext({
    viewport: { width: 1100, height: 800 },
    locale: "en-US",
  });
  await context.addInitScript(
    ({ token, upstream, prefix, thinking, contextWindow }) => {
      window.fetch = new Proxy(window.fetch, {
        apply(fetch, receiver, args) {
          const url = args[0];
          if (typeof url === "string" && url.startsWith(upstream + "/")) {
            args[0] = prefix + url.slice(upstream.length);
          }
          return Reflect.apply(fetch, receiver, args);
        },
      });
      try {
        if (token && localStorage.getItem("chat-demo:access-token") === null) {
          localStorage.setItem("chat-demo:access-token", token);
          if (contextWindow)
            localStorage.setItem("chat-demo:context-window", String(contextWindow));
        }
        localStorage.setItem("chat-demo:locale", "en-US");
        if (localStorage.getItem("chat-demo:thinking") === null) {
          localStorage.setItem("chat-demo:thinking", String(thinking));
        }
        if (localStorage.getItem("chat-demo:search") === null) {
          localStorage.setItem("chat-demo:search", "false");
        }
      } catch {}
    },
    { token: setup ? null : fixtureKey, upstream, prefix, thinking, contextWindow },
  );
  if (setup) await context.route("**/api/deepseek-import/**", setup);
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.port}/`);
  await page.getByPlaceholder("Enter a message").waitFor();
  return { context, page, close: () => context.close() };
};

/** 页面上可以做的事，用与界面一致的无障碍名称定位。 */
export const actions = (page: Page) => ({
  send: async (text: string) => {
    await page.getByPlaceholder("Enter a message").fill(text);
    await page.getByRole("button", { name: "Send" }).click();
  },
  /** 回复结束：停止按钮消失，且最后一条回复有重新生成按钮。 */
  waitForReplyDone: async () => {
    await page.getByRole("button", { name: "Regenerate" }).last().waitFor();
    await page.getByRole("button", { name: "Stop" }).waitFor({ state: "detached" });
  },
  /** 会话列表里的第一项（最近的会话）。类名是 `名字-哈希`，按前缀匹配。 */
  firstSession: () => page.locator('div[class^="sectionHeader-"] + div[class^="item-"]').first(),
  regenerate: () => page.getByRole("button", { name: "Regenerate" }).last().click(),
  versionCount: () => page.getByLabel("Message versions").locator("span").first(),
  previousVersion: () => page.getByRole("button", { name: "Previous version" }).click(),
  nextVersion: () => page.getByRole("button", { name: "Next version" }).click(),
});

/** 等待元素可见；超时抛错，错误里带上定位器，便于看出是哪一步没出现。 */
export const see = async (locator: Locator, timeout = 15_000) => {
  try {
    await locator.waitFor({ state: "visible", timeout });
  } catch (error) {
    throw new Error(
      `expected to see ${locator.toString()}\n${error instanceof Error ? error.message.split("\n")[0] : ""}`,
    );
  }
};

/** 轮询直到元素文本与预期完全一致。 */
export const hasText = async (locator: Locator, expected: string, timeout = 15_000) => {
  const limit = Date.now() + timeout;
  let actual: string | null = null;
  while (Date.now() < limit) {
    actual = await locator.textContent({ timeout: 1000 }).catch(() => null);
    if (actual?.replace(/\s+/g, " ").trim() === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `expected ${locator.toString()} to have text ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
};

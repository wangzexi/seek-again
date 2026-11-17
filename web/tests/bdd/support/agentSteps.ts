import type { Page } from "playwright-core";
import { mock } from "./world.js";

type Param = { role: string; content: any };

/** 第 index 个请求里发给模型的 messages */
export const messagesOf = (index: number): Param[] => mock.requests[index].body.messages;

/** 第 index 个请求里最后一条 user 消息的 tool_result 块 */
export const toolResults = (index: number): any[] => {
  const content = messagesOf(index).at(-1)?.content;
  return Array.isArray(content) ? content.filter((block) => block.type === "tool_result") : [];
};

/** 最后一个请求就是带 tool_result 的那一次（最后一次提问之后的往返）。 */
export const lastToolResults = () => toolResults(mock.requests.length - 1);

/** 时间线里某个工具的调用行 */
export const toolRow = (page: Page, name: string, status = "done") =>
  page.locator(`[data-agent-tool="${name}"][data-agent-status="${status}"]`);

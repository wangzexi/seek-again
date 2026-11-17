import type { CreateMessageRequest, RequestTool } from "../api/types.js";
import { shellTools, type ClientTool } from "./tools.js";

/** 界面上的两个开关（深度思考、智能搜索）；回复创建时快照到回复上。 */
export type Toggles = { thinking: boolean; search: boolean };

/** 请求的上下文条件。续写在末尾已有 assistant 前缀，不能再声明客户端工具。 */
export type RequestContext = { clientTools: boolean };

/**
 * 能力注册表：每项能力说明它怎样出现在请求里，以及由哪个开关或条件启用。
 * - option：请求参数，模型不能调用（深度思考）；
 * - server：DeepSeek 服务端执行的工具（智能搜索、阅读链接）；
 * - client：在浏览器里执行的工具（对话目录里的文件）。
 */
type Capability =
  | { id: "deep_think"; kind: "option"; enabled: (toggles: Toggles) => boolean }
  | {
      id: "read_url" | "smart_search";
      kind: "server";
      tools: RequestTool[];
      enabled: (toggles: Toggles) => boolean;
    }
  | {
      id: "shell";
      kind: "client";
      tools: ClientTool[];
      enabled: (toggles: Toggles, context: RequestContext) => boolean;
    };

export const capabilities: Capability[] = [
  { id: "deep_think", kind: "option", enabled: ({ thinking }) => thinking },
  {
    // 阅读链接始终开启，智能搜索开关只控制是否另行声明搜索工具（含边想边搜）。
    id: "read_url",
    kind: "server",
    tools: [{ type: "deepseek_read_url", name: "deepseek_read_url" }],
    enabled: () => true,
  },
  {
    id: "smart_search",
    kind: "server",
    tools: [{ type: "deepseek_web_search", name: "deepseek_web_search" }],
    enabled: ({ search }) => search,
  },
  {
    // 参照 DeepSeek Harness 极简模式：模型只有一个 bash，在 Worker 里运行 just-bash，只看得到当前对话目录。
    // 接口限制（真实探针 src/services/agent/fixtures/matrix-*.json）：请求里只要同时有 safety_check、
    // deepseek_read_url、deepseek_web_search 或 title 之一，客户端工具就必须开启思考，否则返回 400。
    // 应用的每个请求都带 safety_check 和 deepseek_read_url，所以 bash 依赖深度思考。
    id: "shell",
    kind: "client",
    tools: shellTools,
    enabled: ({ thinking }, { clientTools }) => clientTools && thinking,
  },
];

/** 由开关和上下文生成请求里的 thinking 与 tools；声明顺序与注册表一致。 */
export const buildRequestParts = (
  toggles: Toggles,
  context: RequestContext,
): Pick<CreateMessageRequest, "thinking" | "tools"> => {
  const tools: RequestTool[] = [];
  let thinking = false;
  for (const capability of capabilities) {
    if (capability.kind === "option") {
      thinking = capability.enabled(toggles);
    } else if (capability.kind === "server") {
      if (capability.enabled(toggles)) {
        tools.push(...capability.tools);
      }
    } else if (capability.enabled(toggles, context)) {
      tools.push(...capability.tools.map((tool) => tool.definition));
    }
  }
  return { thinking: { type: thinking ? "enabled" : "disabled" }, tools };
};

/** 模型返回的客户端工具名对应的实现；未注册的名字返回 undefined，由调用方回报错误。 */
export const findClientTool = (name: string): ClientTool | undefined => {
  for (const capability of capabilities) {
    if (capability.kind === "client") {
      const tool = capability.tools.find((item) => item.definition.name === name);
      if (tool) {
        return tool;
      }
    }
  }
  return undefined;
};

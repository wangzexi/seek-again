import type { ClientToolDefinition } from "../api/types.js";
import type { ToolFs } from "./fs.js";
import { runShell } from "./shell/client.js";
import type { ShellState } from "./shell/protocol.js";

export type ToolOutcome = { text: string; isError: boolean };

/** 跨命令的 shell 状态：从上一条命令结束时的状态开始，每条命令之后保存新的。 */
export type ShellSession = { state: ShellState | undefined; save: (state: ShellState) => void };

/** 工具运行时能用到的东西；signal 在用户点停止时触发。 */
export type ToolContext = { fs: ToolFs; signal?: AbortSignal; shell?: ShellSession };

export type ClientTool = {
  definition: ClientToolDefinition;
  run: (context: ToolContext, input: unknown) => Promise<ToolOutcome>;
};

const ok = (text: string): ToolOutcome => ({ text, isError: false });
const fail = (text: string): ToolOutcome => ({ text, isError: true });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const MAX_COMMAND = 10_000;
/** 命令结果里最多逐个列出的文件变化数 */
const MAX_LISTED_CHANGES = 20;
/** 回传给模型的命令输出上限，与 DeepSeek Harness 的 bash 默认值一致（stdout 与 stderr 合计）。 */
const MAX_OUTPUT = 16_000;

const clipOutput = (text: string) =>
  text.length > MAX_OUTPUT
    ? `${text.slice(0, MAX_OUTPUT)}\n[output truncated at ${MAX_OUTPUT} characters; narrow the command, e.g. with grep -m, head or a more specific path]`
    : text;

/**
 * 模型唯一的客户端工具，对齐 DeepSeek Harness 极简模式的 bash：同样的名字和参数、同样的描述要点、
 * 当前目录和变量跨命令保留、单条命令 300 秒、输出 16,000 字符。读、写、删、搜索都用命令完成。
 * 与官方的差别在描述里写明：这是浏览器里的沙箱，没有网络和 Python，也没有后台任务和函数持久化。
 */
const bash: ClientTool = {
  definition: {
    name: "bash",
    description: [
      "Run commands in a bash shell. The current directory starts as this conversation's folder.",
      '* When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.',
      "* There is no network access, and no Python or Node: this is a sandboxed shell in the browser.",
      "* State is persistent across command calls and discussions with the user: the current directory and shell variables are kept. Shell functions and aliases are not, and there are no background jobs.",
      "* Files you create or change (with >, >>, tee, sed -i, mv, cp, rm, mkdir, touch) are kept for this conversation and follow the branch of the story you are on. Only this folder is visible; anything written outside it (such as /tmp) is discarded after the command.",
      "* To inspect a particular line range of a file, e.g. lines 10-25, try 'sed -n 10,25p /path/to/the/file'.",
      "* Please avoid commands that may produce a very large amount of output.",
    ].join("\n"),
    input_schema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The bash command to run. Relative path is preferred in the command.",
        },
      },
      required: ["command"],
    },
  },
  async run({ fs, signal, shell }, input) {
    const command = isRecord(input) ? input.command : undefined;
    if (typeof command !== "string" || !command.trim()) {
      return fail('Invalid arguments: "command" must be a non-empty string.');
    }
    if (command.length > MAX_COMMAND) {
      return fail(
        `The command is too long (${command.length} characters; the limit is ${MAX_COMMAND}).`,
      );
    }
    const result = await runShell(fs.manifest(), command, { signal, state: shell?.state });
    shell?.save(result.state);

    const summary: string[] = [];
    const before = new Set(fs.manifest().keys());
    for (const change of result.changes) {
      // 以 / 结尾的是空目录的占位：新建空目录要告诉模型，占位因为目录里有了文件而移除则不必提。
      const isMarker = change.path.endsWith("/");
      if (change.content === null) {
        if ((await fs.remove(change.path)) && !isMarker) {
          summary.push(`deleted ${change.path}`);
        }
      } else {
        const existed = before.has(change.path);
        const previous = existed ? await fs.read(change.path) : null;
        if (previous !== change.content) {
          await fs.write(change.path, change.content);
          summary.push(`${existed ? "modified" : "created"} ${change.path}`);
        }
      }
    }

    const output = [result.stdout, result.stderr ? `[stderr]\n${result.stderr}` : ""]
      .filter(Boolean)
      .join("\n");
    const parts: string[] = [output ? clipOutput(output) : "(no output)"];
    if (result.exitCode !== 0) {
      parts.push(`[exit code ${result.exitCode}]`);
    }
    if (summary.length > 0) {
      // 一条命令可能改动成百上千个文件，只列前面几个，避免白白占用上下文。
      const shown = summary.slice(0, MAX_LISTED_CHANGES).join(", ");
      const more = summary.length - MAX_LISTED_CHANGES;
      parts.push(`[files: ${shown}${more > 0 ? `, and ${more} more` : ""}]`);
    }
    parts.push(...result.notes);
    // 退出码非 0 不算工具出错：grep 没有匹配也是 1。退出码已写在输出里，由模型自己判断。
    return ok(parts.join("\n"));
  },
};

export const shellTools: ClientTool[] = [bash];

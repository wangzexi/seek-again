import ShellWorker from "./worker.ts?worker&inline";
import type { ShellRequest, ShellResponse, ShellState } from "./protocol.js";

/**
 * 整条命令的硬性期限。just-bash 自己的期限是 300 秒（与 DeepSeek Harness 一致），这里再留 10 秒：
 * Worker 里的 JS 无法被抢占，真的卡死时只能终止整个 Worker。
 */
const HARD_TIMEOUT_MS = 310_000;

export type ShellRun = Extract<ShellResponse, { ok: true }>;

let worker: Worker | undefined;
let nextId = 1;

const stopWorker = () => {
  worker?.terminate();
  worker = undefined;
};

/**
 * 在 Worker 里执行一条 Shell 命令。Worker 第一次用到时才创建（只在首次运行时创建 Worker），
 * 之后复用；超时或被中止时终止它，下次调用再重建。同一时间只有一个命令在跑，工具调用本来就是顺序的。
 */
export const runShell = (
  files: ReadonlyMap<string, string>,
  command: string,
  options: { signal?: AbortSignal; state?: ShellState } = {},
): Promise<ShellRun> =>
  new Promise((resolve, reject) => {
    const { signal, state } = options;
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    worker ??= new ShellWorker();
    const current = worker;
    const id = nextId++;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = () => {
      clearTimeout(timer);
      current.removeEventListener("message", onMessage);
      current.removeEventListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const onMessage = (event: MessageEvent<ShellResponse>) => {
      if (event.data.id !== id) {
        return;
      }
      finish();
      if (event.data.ok) {
        resolve(event.data);
      } else {
        reject(new Error(event.data.error));
      }
    };
    const onError = (event: ErrorEvent) => {
      finish();
      stopWorker();
      reject(new Error(event.message || "The shell worker failed to start"));
    };
    const onAbort = () => {
      finish();
      stopWorker();
      reject(signal?.reason);
    };

    current.addEventListener("message", onMessage);
    current.addEventListener("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      finish();
      stopWorker();
      reject(
        new Error(
          `The command did not finish within ${Math.round((HARD_TIMEOUT_MS - 10_000) / 1000)} seconds and was stopped.`,
        ),
      );
    }, HARD_TIMEOUT_MS);
    const request: ShellRequest = { id, command, files: Object.fromEntries(files), state };
    current.postMessage(request);
  });

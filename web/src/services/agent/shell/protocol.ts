/** Shell Worker 与主线程之间的消息。路径都是相对对话目录的相对路径。 */

/**
 * 跨命令保留的 shell 状态：当前目录和环境变量（含没有 export 的）。函数和别名带不过去
 * （just-bash 序列化不出函数体），后台任务也不存在。cwd 相对对话目录，空串表示根。
 */
export type ShellState = { cwd: string; env: Record<string, string> };

export type ShellRequest = {
  id: number;
  command: string;
  /**
   * 当前对话目录的清单：路径 → 内容哈希。Worker 只读内容，不写存储。
   * 以 / 结尾的路径是空目录的占位（清单里只有文件，没有文件的目录要靠它保留），不是文件。
   */
  files: Record<string, string>;
  /** 上一条命令结束时的状态；没有时从对话目录根、默认环境开始 */
  state?: ShellState;
};

/** 命令执行后文件系统的变化；content 为 null 表示删除。 */
export type ShellChange = { path: string; content: string | null };

export type ShellResponse =
  | {
      id: number;
      ok: true;
      stdout: string;
      stderr: string;
      exitCode: number;
      changes: ShellChange[];
      /** 命令结束时的状态，下一条命令从这里继续 */
      state: ShellState;
      /** 没能保存的改动等需要告诉模型的说明 */
      notes: string[];
    }
  | { id: number; ok: false; error: string };

/** 命令挂载的根目录，也是 cwd；对话目录里的 a/b.md 在 Shell 里是 /work/a/b.md。 */
export const SHELL_ROOT = "/work";

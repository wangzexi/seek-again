import { getWorkspaceBlob, putWorkspaceBlob } from "../chat/db.js";
import type { FileOp, Manifest } from "../workspace/layers.js";
import { sha256Hex } from "./hash.js";

/** 工具看到的当前对话目录。路径已规范化；内容以 UTF-8 文本读写。 */
export type ToolFs = {
  /** 路径 → 内容哈希；Shell 的 Worker 据此按需读取内容 */
  manifest(): ReadonlyMap<string, string>;
  /** 不存在时返回 null */
  read(path: string): Promise<string | null>;
  write(path: string, text: string): Promise<void>;
  /** 文件不存在时返回 false */
  remove(path: string): Promise<boolean>;
};

const encoder = new TextEncoder();

/** 先写内容、再记引用：崩溃时最坏只留下没人引用的内容，不会出现悬空引用。 */
export const putText = async (text: string): Promise<string> => {
  const bytes = encoder.encode(text);
  const hash = await sha256Hex(bytes);
  await putWorkspaceBlob(hash, new Blob([bytes]));
  return hash;
};

export const getText = async (hash: string): Promise<string | undefined> =>
  (await getWorkspaceBlob(hash))?.text();

/**
 * 以某条消息之后的目录状态为起点；本轮的写入先累积在内存的清单里，并通过 onOps 交给调用方记进回复的提交。
 * 起点来自 resolveDirectory，所以不同分支看到各自的文件。
 */
export const createAgentFs = (base: Manifest, onOps: (ops: FileOp[]) => void): ToolFs => {
  const current = new Map(base);
  return {
    manifest: () => current,
    async read(path) {
      const hash = current.get(path);
      if (hash === undefined) {
        return null;
      }
      const text = await getText(hash);
      if (text === undefined) {
        throw new Error(`content of ${path} is missing from local storage`);
      }
      return text;
    },
    async write(path, text) {
      const hash = await putText(text);
      // 内容没变就不记提交：Shell 的 sed -i 之类可能原样写回。
      if (current.get(path) === hash) {
        return;
      }
      current.set(path, hash);
      onOps([{ path, hash }]);
    },
    async remove(path) {
      if (!current.delete(path)) {
        return false;
      }
      onOps([{ path, hash: null }]);
      return true;
    },
  };
};

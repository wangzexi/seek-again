import { getVisibleMessages, normalizeSession } from "../chat/branches.js";
import type { Message, Session } from "../chat/types.js";

/** `hash` 为 null 表示删除该路径。 */
export type FileOp = { path: string; hash: string | null };

/** 一条消息带来的文件变化；只追加，后写的操作覆盖先写的同一路径。 */
export type Commit = { ops: readonly FileOp[]; status: "partial" | "complete" };

/** 路径（相对对话目录）到内容哈希。 */
export type Manifest = ReadonlyMap<string, string>;

type Committed = Pick<Message, "id" | "parentId"> & { commit?: Commit };
type CommittedSession = Omit<Session, "messages"> & { messages: Committed[] };

type Entry = { commit: Commit | undefined; parent: Manifest; manifest: Manifest };

/** 按消息 ID 缓存的解析结果，仅存于内存；提交被替换或祖先变化时自动失效，丢失可重算。 */
export type DirectoryCache = Map<string, Entry>;

const EMPTY: Manifest = new Map();

export const createDirectoryCache = (): DirectoryCache => new Map();

/** 规范化对话目录内的相对路径；越出目录或为空时返回 null。 */
export const normalizePath = (path: string): string | null => {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      if (!parts.pop()) {
        return null;
      }
      continue;
    }
    parts.push(part);
  }
  return parts.length ? parts.join("/") : null;
};

/** 追加操作，返回新的提交（旧提交不变，便于按引用判断缓存是否有效）。 */
export const appendOps = (
  commit: Commit | undefined,
  ops: readonly FileOp[],
  status: Commit["status"] = "partial",
): Commit => ({ ops: [...(commit?.ops ?? []), ...ops], status });

const apply = (base: Manifest, commit: Commit): Manifest => {
  const next = new Map(base);
  for (const { path, hash } of commit.ops) {
    if (hash === null) {
      next.delete(path);
    } else {
      next.set(path, hash);
    }
  }
  return next;
};

/** 从根到目标消息（含）的祖先链；数据缺失或成环时在断点处截断。 */
export const pathTo = (session: Session, messageId: string): Message[] => {
  const normalized = normalizeSession(session);
  const byId = new Map(normalized.messages.map((message) => [message.id, message]));
  const path: Message[] = [];
  const seen = new Set<string>();
  let id: string | null | undefined = messageId;
  while (id && !seen.has(id)) {
    const message = byId.get(id);
    if (!message) {
      break;
    }
    seen.add(id);
    path.push(message);
    id = message.parentId;
  }
  return path.reverse();
};

/**
 * 目录在某条消息之后的状态：沿根到该消息的路径依次叠加提交，含该消息自己的提交。
 * 要得到某条回复开始生成之前的状态，传它的父消息 ID。
 */
export const resolveDirectory = (
  session: CommittedSession,
  messageId: string,
  cache?: DirectoryCache,
): Manifest => {
  let manifest = EMPTY;
  for (const message of pathTo(session as Session, messageId) as Committed[]) {
    const entry = cache?.get(message.id);
    if (entry && entry.commit === message.commit && entry.parent === manifest) {
      manifest = entry.manifest;
      continue;
    }
    const parent = manifest;
    manifest = message.commit ? apply(parent, message.commit) : parent;
    cache?.set(message.id, { commit: message.commit, parent, manifest });
  }
  return manifest;
};

/** 当前选中分支末尾的目录状态。 */
export const resolveVisibleDirectory = (session: CommittedSession, cache?: DirectoryCache) => {
  const last = getVisibleMessages(session as Session).at(-1);
  return last ? resolveDirectory(session, last.id, cache) : EMPTY;
};

import { describe, expect, test } from "bun:test";
import { appendBranch, selectVersion } from "../chat/branches.js";
import type { Message, Session } from "../chat/types.js";
import {
  appendOps,
  createDirectoryCache,
  normalizePath,
  pathTo,
  resolveDirectory,
  resolveVisibleDirectory,
  type Commit,
  type FileOp,
} from "./layers.js";

type Node = Message & { commit?: Commit };
type TestSession = Omit<Session, "messages"> & { messages: Node[] };

const empty = (): TestSession => ({
  id: "s",
  title: "t",
  createdAt: 0,
  updatedAt: 0,
  messages: [],
  rootMessageId: null,
});

const user = (id: string, commit?: Commit): Node =>
  ({ id, role: "user", content: id, files: [], createdAt: 0, commit }) as Node;

const reply = (id: string, commit?: Commit): Node =>
  ({ id, role: "assistant", blocks: [], createdAt: 0, commit }) as unknown as Node;

const add = (session: TestSession, parentId: string | null, ...messages: Node[]): TestSession =>
  appendBranch(session as Session, parentId, messages) as TestSession;

const write = (path: string, hash: string): FileOp => ({ path, hash });
const del = (path: string): FileOp => ({ path, hash: null });
const commit = (...ops: FileOp[]): Commit => ({ ops, status: "complete" });
const entries = (manifest: ReadonlyMap<string, string>) =>
  Object.fromEntries([...manifest].sort(([a], [b]) => a.localeCompare(b)));

describe("normalizePath", () => {
  test("resolves relative segments", () => {
    expect(normalizePath("a/./b//c")).toBe("a/b/c");
    expect(normalizePath("a/b/../c")).toBe("a/c");
  });

  test("rejects escaping the conversation directory and empty paths", () => {
    expect(normalizePath("..")).toBeNull();
    expect(normalizePath("a/../../b")).toBeNull();
    expect(normalizePath("")).toBeNull();
    expect(normalizePath("./")).toBeNull();
  });
});

describe("resolveDirectory", () => {
  test("overlays commits along the path; later ops win; tombstones delete", () => {
    let s = add(empty(), null, user("u1"), reply("a1", commit(write("x", "h1"), write("y", "h2"))));
    s = add(s, "a1", user("u2"), reply("a2", commit(write("x", "h3"), del("y"))));
    expect(entries(resolveDirectory(s, "a1"))).toEqual({ x: "h1", y: "h2" });
    expect(entries(resolveDirectory(s, "a2"))).toEqual({ x: "h3" });
    expect(entries(resolveVisibleDirectory(s))).toEqual({ x: "h3" });
  });

  test("within one commit the last op for a path wins", () => {
    const s = add(
      empty(),
      null,
      user("u1"),
      reply("a1", commit(write("x", "h1"), del("x"), write("x", "h2"))),
    );
    expect(entries(resolveDirectory(s, "a1"))).toEqual({ x: "h2" });
  });

  test("regenerated replies are isolated siblings that share the parent state", () => {
    let s = add(empty(), null, user("u0", commit(write("card.md", "c0"))), reply("a0"));
    s = add(s, "a0", user("u1"), reply("a1", commit(write("card.md", "c1"))));
    s = add(s, "u1", reply("a1b", commit(write("note.md", "n1"))));
    expect(entries(resolveDirectory(s, "a1"))).toEqual({ "card.md": "c1" });
    expect(entries(resolveDirectory(s, "a1b"))).toEqual({ "card.md": "c0", "note.md": "n1" });
    // 生成 a1b 之前看到的状态是它的父消息之后的状态
    expect(entries(resolveDirectory(s, "u1"))).toEqual({ "card.md": "c0" });
  });

  test("switching the visible version changes the directory", () => {
    let s = add(empty(), null, user("u1"), reply("a1", commit(write("x", "h1"))));
    s = add(s, "u1", reply("a1b", commit(write("y", "h2"))));
    expect(entries(resolveVisibleDirectory(s))).toEqual({ y: "h2" });
    s = selectVersion(s as Session, "a1") as TestSession;
    expect(entries(resolveVisibleDirectory(s))).toEqual({ x: "h1" });
  });

  test("edited prompts branch from the same parent and do not see the old branch", () => {
    let s = add(empty(), null, user("u1"), reply("a1", commit(write("x", "h1"))));
    s = add(s, "a1", user("u2"), reply("a2", commit(write("z", "h9"))));
    s = add(s, "a1", user("u2b", commit(write("upload.txt", "h5"))), reply("a2b"));
    expect(entries(resolveDirectory(s, "a2b"))).toEqual({ x: "h1", "upload.txt": "h5" });
    expect(entries(resolveDirectory(s, "a2"))).toEqual({ x: "h1", z: "h9" });
  });

  test("files from a shared ancestor are visible in every branch", () => {
    let s = add(empty(), null, user("u1", commit(write("world.md", "w"))), reply("a1"));
    s = add(s, "a1", user("u2"), reply("a2"));
    s = add(s, "a1", user("u2b"), reply("a2b"));
    expect(entries(resolveDirectory(s, "a2"))).toEqual({ "world.md": "w" });
    expect(entries(resolveDirectory(s, "a2b"))).toEqual({ "world.md": "w" });
  });

  test("works on legacy linear sessions without branch fields", () => {
    const s = {
      id: "s",
      title: "t",
      createdAt: 0,
      updatedAt: 0,
      messages: [
        user("u1"),
        reply("a1", commit(write("x", "h1"))),
        user("u2"),
        reply("a2", commit(del("x"))),
      ],
    } as TestSession;
    expect(entries(resolveDirectory(s, "a1"))).toEqual({ x: "h1" });
    expect(entries(resolveDirectory(s, "a2"))).toEqual({});
  });

  test("empty session and unknown ids resolve to an empty directory", () => {
    expect(resolveVisibleDirectory(empty()).size).toBe(0);
    expect(resolveDirectory(empty(), "nope").size).toBe(0);
  });

  test("missing parents and cycles terminate", () => {
    const s = {
      ...empty(),
      rootMessageId: "a",
      messages: [
        { ...user("a"), parentId: "b" },
        { ...reply("b", commit(write("x", "h"))), parentId: "a" },
      ],
    } as TestSession;
    expect(pathTo(s as Session, "a").length).toBeLessThanOrEqual(2);
    expect(() => resolveDirectory(s, "a")).not.toThrow();
    const orphan = {
      ...empty(),
      messages: [{ ...reply("c"), parentId: "gone" }],
      rootMessageId: "c",
    } as TestSession;
    expect(resolveDirectory(orphan, "c").size).toBe(0);
  });
});

describe("continued replies (commit extended in place)", () => {
  test("appendOps does not mutate the previous commit", () => {
    const first = appendOps(undefined, [write("x", "h1")]);
    const second = appendOps(first, [write("y", "h2")], "complete");
    expect(first.ops).toHaveLength(1);
    expect(first.status).toBe("partial");
    expect(second.ops).toHaveLength(2);
    expect(second.status).toBe("complete");
  });

  test("the cache is invalidated when a message commit is replaced", () => {
    const cache = createDirectoryCache();
    let s = add(empty(), null, user("u1"), reply("a1", appendOps(undefined, [write("x", "h1")])));
    expect(entries(resolveDirectory(s, "a1", cache))).toEqual({ x: "h1" });
    const extended = appendOps(
      s.messages.find((m) => m.id === "a1")?.commit,
      [write("y", "h2")],
      "complete",
    );
    s = { ...s, messages: s.messages.map((m) => (m.id === "a1" ? { ...m, commit: extended } : m)) };
    expect(entries(resolveDirectory(s, "a1", cache))).toEqual({ x: "h1", y: "h2" });
  });

  test("descendants are recomputed when an ancestor commit changes", () => {
    const cache = createDirectoryCache();
    let s = add(empty(), null, user("u1", commit(write("x", "h1"))), reply("a1"));
    s = add(s, "a1", user("u2"), reply("a2", commit(write("y", "h2"))));
    expect(entries(resolveDirectory(s, "a2", cache))).toEqual({ x: "h1", y: "h2" });
    s = {
      ...s,
      messages: s.messages.map((m) =>
        m.id === "u1" ? { ...m, commit: commit(write("x", "h7")) } : m,
      ),
    };
    expect(entries(resolveDirectory(s, "a2", cache))).toEqual({ x: "h7", y: "h2" });
  });

  test("manifests are shared by reference across messages without commits", () => {
    const cache = createDirectoryCache();
    const s = add(empty(), null, user("u1", commit(write("x", "h1"))), reply("a1"));
    expect(resolveDirectory(s, "a1", cache)).toBe(resolveDirectory(s, "u1", cache));
  });
});

// 固定种子的伪随机数，失败时可复现。
const prng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** 参照实现：不用缓存，直接沿祖先链逐条叠加。 */
const reference = (s: TestSession, id: string): Record<string, string> => {
  const byId = new Map(s.messages.map((m) => [m.id, m]));
  const chain: Node[] = [];
  for (let cur = byId.get(id); cur; cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
    chain.unshift(cur);
  }
  const out = new Map<string, string>();
  for (const m of chain) {
    for (const op of m.commit?.ops ?? []) {
      if (op.hash === null) {
        out.delete(op.path);
      } else {
        out.set(op.path, op.hash);
      }
    }
  }
  return entries(out);
};

const randomOps = (rand: () => number): FileOp[] =>
  Array.from({ length: Math.floor(rand() * 4) }, () => {
    const path = "f" + Math.floor(rand() * 5);
    return rand() < 0.25 ? del(path) : write(path, "h" + Math.floor(rand() * 1000));
  });

describe("property: random branch trees", () => {
  test("cached and uncached resolution match the reference for every message", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const rand = prng(seed);
      let s = empty();
      let n = 0;
      const ids: string[] = [];
      for (let step = 0; step < 40; step++) {
        const parent =
          ids.length === 0 || rand() < 0.15 ? null : ids[Math.floor(rand() * ids.length)];
        const parentMessage = s.messages.find((m) => m.id === parent);
        // 用户与助手交替：助手之后接用户，用户之后接助手（重新生成时挂在用户下）
        const nextRole =
          !parentMessage || parentMessage.role === "assistant" ? "user" : "assistant";
        const make = nextRole === "user" ? user : reply;
        const id = (nextRole === "user" ? "u" : "a") + ++n;
        const ops = randomOps(rand);
        s = add(s, parent, make(id, ops.length ? commit(...ops) : undefined));
        ids.push(id);
      }

      const cache = createDirectoryCache();
      const order = [...ids].sort(() => rand() - 0.5);
      for (const id of order) {
        expect(entries(resolveDirectory(s, id))).toEqual(reference(s, id));
        expect(entries(resolveDirectory(s, id, cache))).toEqual(reference(s, id));
      }

      // 缓存已预热后修改随机消息的提交（模拟继续生成），结果仍须与参照一致
      for (let round = 0; round < 5; round++) {
        const target = ids[Math.floor(rand() * ids.length)];
        const extra = randomOps(rand);
        s = {
          ...s,
          messages: s.messages.map((m) =>
            m.id === target ? { ...m, commit: appendOps(m.commit, extra, "complete") } : m,
          ),
        };
        for (const id of ids) {
          expect(entries(resolveDirectory(s, id, cache))).toEqual(reference(s, id));
        }
      }
    }
  });
});

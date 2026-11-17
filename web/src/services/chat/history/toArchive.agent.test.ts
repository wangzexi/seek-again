import { expect, test } from "bun:test";
import { appendBranch } from "../branches.js";
import type { AssistantMessage, Session, UserMessage } from "../types.js";
import { toSessionFile } from "./toArchive.js";

const question: UserMessage = {
  id: "u1",
  role: "user",
  content: "Save a note",
  files: [],
  createdAt: 1,
};

const reply = (extra: Partial<AssistantMessage> = {}): AssistantMessage => ({
  id: "a1",
  role: "assistant",
  createdAt: 2,
  model: "deepseek-flash",
  thinking: true,
  prefix: false,
  status: "done",
  blocks: [{ type: "text", text: "Saved." }],
  stopReason: "end_turn",
  ...extra,
});

const session = (assistant: AssistantMessage): Session =>
  appendBranch(
    { id: "s", title: "T", createdAt: 0, updatedAt: 3, messages: [], rootMessageId: null },
    null,
    [question, assistant],
  );

// 导出要能被别的 DeepSeek 导入：Agent 的提交和工具轨迹只存在本地，不能出现在标准格式里。
test("exporting a conversation with agent data and compaction gives exactly the plain DeepSeek format", () => {
  const plain = toSessionFile(session(reply()), () => null);
  const withAgent = toSessionFile(
    session(
      reply({
        commit: { ops: [{ path: "notes/world.md", hash: "abc123" }], status: "complete" },
        compaction: {
          summary: "SECRET-NOTES about the early story",
          firstKeptMessageId: "u1",
          tokensBefore: 123456,
        },
        agent: {
          calls: [
            {
              id: "call_1",
              name: "bash",
              input: { command: "echo secret > notes/world.md" },
              at: 0,
              status: "done",
              output: "Created notes/world.md",
            },
          ],
        },
      }),
    ),
    () => null,
  );
  expect(withAgent).toEqual(plain);
  const text = JSON.stringify(withAgent);
  for (const leak of [
    "commit",
    "agent",
    "bash",
    "abc123",
    "notes/world.md",
    "secret",
    "compaction",
    "SECRET-NOTES",
    "firstKept",
    "123456",
  ]) {
    expect(text).not.toContain(leak);
  }
});

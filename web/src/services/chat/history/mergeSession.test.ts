import { expect, test } from "bun:test";
import { getVisibleMessages } from "../branches.js";
import type { AssistantMessage, Session, UserMessage } from "../types.js";
import { mergeImportedSession } from "./mergeSession.js";

const user = (
  id: string,
  content: string,
  parentId: string | null,
  createdAt: number,
): UserMessage => ({
  id,
  content,
  parentId,
  createdAt,
  role: "user",
  files: [],
});
const reply = (
  id: string,
  text: string,
  parentId: string,
  createdAt: number,
): AssistantMessage => ({
  id,
  parentId,
  createdAt,
  role: "assistant",
  model: null,
  prefix: false,
  status: "done",
  blocks: [{ type: "text", text }],
});
const session = (messages: Session["messages"], rootMessageId: string): Session => ({
  id: "same-session",
  title: "Local title",
  createdAt: 1,
  updatedAt: messages.length,
  messages,
  rootMessageId,
});
const prefix = [{ ...user("1", "hello", null, 1), selectedChildId: "2" }, reply("2", "hi", "1", 2)];
const incoming = session(
  [
    prefix[0],
    { ...prefix[1], selectedChildId: "3" },
    { ...user("3", "official follow-up", "2", 3), selectedChildId: "4" },
    reply("4", "official reply", "3", 4),
  ],
  "1",
);

test("appends missing messages to the selected path and skips a repeated import", () => {
  const merged = mergeImportedSession(session(prefix, "1"), incoming)!;
  expect(getVisibleMessages(merged).map((message) => message.id)).toEqual(["1", "2", "3", "4"]);
  expect(mergeImportedSession(merged, incoming)).toBeNull();
});

test("keeps a divergent local branch when message IDs collide", () => {
  const local = session(
    [prefix[0], { ...prefix[1], selectedChildId: "3" }, user("3", "local follow-up", "2", 3)],
    "1",
  );
  const merged = mergeImportedSession(local, incoming)!;
  expect(getVisibleMessages(merged).at(-1)?.id).toBe("3");
  const other = merged.messages.find((message) => message.parentId === "2" && message.id !== "3")!;
  expect(other).toMatchObject({ content: "official follow-up" });
  expect(merged.messages.find((message) => message.id === other.selectedChildId)?.parentId).toBe(
    other.id,
  );
  expect(mergeImportedSession(merged, incoming)).toBeNull();
});

test("matches equivalent history when archive conversion renumbered the messages", () => {
  const local = session(
    [
      { ...user("local-user", "hello", null, 1), selectedChildId: "local-reply" },
      reply("local-reply", "hi", "local-user", 2),
    ],
    "local-user",
  );
  const merged = mergeImportedSession(local, incoming)!;
  expect(getVisibleMessages(merged).map((message) => message.id)).toEqual([
    "local-user",
    "local-reply",
    "3",
    "4",
  ]);
});

import { normalizeSession } from "../branches.js";
import type { Message, Session } from "../types.js";

function messageKey(message: Message, parent: string | null) {
  const body =
    message.role === "user"
      ? [message.content, message.files.map(({ id, name }) => [id, name])]
      : message.blocks.map((block) => {
          if (block.type === "text") return [block.type, block.text];
          if (block.type === "thinking") return [block.type, block.thinking];
          if (block.type === "server_tool_use") return [block.type, block.name, block.input];
          return [block.type, block.kind, block.content];
        });
  return JSON.stringify([parent, message.role, message.createdAt, body]);
}

/** Reuse matching messages under the same parent and preserve both sides of any divergence. */
export function mergeImportedSession(local: Session, incoming: Session): Session | null {
  const base = normalizeSession(local);
  const ids = new Set(base.messages.map((message) => message.id));
  const byContent = new Map<string, Message[]>();
  for (const message of base.messages) {
    const key = messageKey(message, message.parentId ?? null);
    const matches = byContent.get(key);
    if (matches) matches.push(message);
    else byContent.set(key, [message]);
  }

  const mapping = new Map<string, string>();
  const reused = new Set<string>();
  const added = new Map<string, Message>();
  // Archive conversion yields parent-before-child order.
  for (const message of incoming.messages) {
    const parent = message.parentId == null ? null : mapping.get(message.parentId);
    if (parent === undefined) throw new Error("Invalid imported message parent");
    const matches = byContent.get(messageKey(message, parent));
    const match =
      matches?.find((candidate) => candidate.id === message.id && !reused.has(candidate.id)) ??
      matches?.find((candidate) => !reused.has(candidate.id));
    if (match) {
      mapping.set(message.id, match.id);
      reused.add(match.id);
      continue;
    }
    const id = ids.has(message.id) ? crypto.randomUUID() : message.id;
    ids.add(id);
    mapping.set(message.id, id);
    added.set(id, { ...message, id, parentId: parent, selectedChildId: undefined });
  }
  if (added.size === 0) return null;

  const nextChildren = new Map<string, string>();
  for (const message of incoming.messages) {
    if (!message.selectedChildId) continue;
    const id = mapping.get(message.id);
    const child = mapping.get(message.selectedChildId);
    if (!id || !child) continue;
    const newMessage = added.get(id);
    if (newMessage) newMessage.selectedChildId = child;
    else if (added.has(child)) nextChildren.set(id, child);
  }
  const messages = base.messages.map((message) => {
    const child = nextChildren.get(message.id);
    return child && !message.selectedChildId ? { ...message, selectedChildId: child } : message;
  });
  return {
    ...base,
    rootMessageId: base.rootMessageId ?? mapping.get(incoming.rootMessageId ?? "") ?? null,
    updatedAt: Math.max(base.updatedAt, incoming.updatedAt),
    messages: messages.concat([...added.values()]),
  };
}

import type { MessageUsage } from "../api/types.js";
import { applyCompaction, findCompaction, getContextRounds, getReplyText } from "./reply.js";
import type { AssistantMessage, Message, UserMessage } from "./types.js";

/**
 * 超长对话的自动压缩（只支持官方 DeepSeek）。思路参考 pi 的 compaction（MIT）和 DeepSeek Harness 的
 * compaction-basic：接近窗口时把最旧的几轮压成摘要，最近的轮次原样保留。与它们的差别：
 * - 摘要作为消息上的属性（Message.compaction），不是树里的新节点，所以随分支走，导出时不带；
 * - 用户无感：界面和消息树不变，只改发给模型的历史；
 * - 用接口返回的真实用量判断大小，估算只在没有用量时用。
 */

/** 官方 deepseek-flash 与 deepseek-v4-pro 的上下文窗口（官方 /models 列表所声明）。 */
export const DEFAULT_CONTEXT_WINDOW = 1_048_576;
/** 预估的下一次请求超过窗口的这个比例就压缩。 */
export const TRIGGER_RATIO = 0.9;
/** 压缩后原样保留的最近内容，占窗口的比例。 */
export const KEEP_RATIO = 0.5;
/** 溢出后的补救压缩保留得更少，腾出更多空间再重试。 */
export const OVERFLOW_KEEP_RATIO = 0.25;
/** 给下一轮的思考、回复和工具往返预留的空间，占窗口的比例。 */
export const RESERVE_RATIO = 0.03;
/** 单次摘要请求最多读多少，占窗口的比例；更多的旧内容分块迭代摘要。 */
const CHUNK_RATIO = 0.25;
const MAX_CHUNK_TOKENS = 250_000;
/** 声明的工具定义等固定开销，粗略估计。 */
const FIXED_OVERHEAD_TOKENS = 1_500;
/** 单条消息进摘要请求时的字符上限，防止一条超长粘贴撑爆摘要请求。 */
const MAX_SERIALIZED_CHARS = 60_000;

/**
 * 上下文窗口。设置里没有这个选项；本地存储里的 chat-demo:context-window 只用于测试和排查，
 * 让几千 token 的小窗口也能走到压缩。
 */
export const getContextWindow = (): number => {
  try {
    const raw = Number(localStorage.getItem("chat-demo:context-window"));
    if (Number.isFinite(raw) && raw >= 1000) {
      return raw;
    }
  } catch {
    // 存储不可用时用官方窗口
  }
  return DEFAULT_CONTEXT_WINDOW;
};

/**
 * 粗略估算 token：ASCII 约 4 个字符一个；中日韩等非 ASCII 字符按 0.75 个，偏保守（真实值通常更低）。
 * 没有 DeepSeek 分词器可用，这个比例没有经过实测，只在没有真实用量时使用。
 */
export const estimateTokens = (text: string): number => {
  let ascii = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) {
      ascii++;
    } else {
      other++;
    }
  }
  return Math.ceil(ascii / 4 + other * 0.75);
};

const estimateFiles = (files: UserMessage["files"]) =>
  files.reduce((sum, file) => sum + Math.ceil(file.size / 3), 0);

const estimateQuestion = (question: UserMessage) =>
  estimateTokens(question.content) + estimateFiles(question.files);

export const estimateRound = ([user, reply]: [UserMessage, AssistantMessage]) =>
  estimateTokens(user.content) + estimateFiles(user.files) + estimateTokens(getReplyText(reply));

/** 一次请求实际占用的输入 token：未命中缓存的、命中缓存的、写入缓存的（实测 input_tokens 不含缓存命中）。 */
export const promptTokensOf = (usage: MessageUsage) =>
  usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;

export type CompactionPlan = {
  /** 压缩要写在哪条消息上：提问之前的最后一条 */
  ownerId: string;
  /** 保留部分的第一条提问 */
  firstKeptMessageId: string;
  /** 要并入摘要的最旧的轮次，按时间顺序 */
  toSummarize: [UserMessage, AssistantMessage][];
  /** 这些轮次之前已有的摘要，迭代摘要时一并交给模型 */
  previousSummary?: string;
  tokensBefore: number;
};

/**
 * 判断是否要压缩，并选出切点。返回 undefined 表示不需要，或者没有可压的内容（保留部分已经占满）。
 * - 大小：最近一次回复的真实用量加上它的输出，再加新提问的估算和预留；该回复是在上一次压缩之后生成的
 *   才有效，否则（刚压缩过、或导入的历史没有用量）整段按估算；
 * - 切点：从最新的轮次往旧累加，超过保留额度的最小集合保留，只在提问处切，不拆开一轮。
 */
export const planCompaction = (
  history: Message[],
  question: UserMessage,
  options: { window: number; systemPromptTokens?: number; force?: boolean },
): CompactionPlan | undefined => {
  const { window, force } = options;
  const owner = history.at(-1);
  if (!owner) {
    return undefined;
  }
  const found = findCompaction(history);
  const rounds = applyCompaction(getContextRounds(history), history, found);
  if (rounds.length < 2) {
    return undefined;
  }

  const estimated =
    rounds.reduce((sum, round) => sum + estimateRound(round), 0) +
    (found ? estimateTokens(found.compaction.summary) : 0) +
    (options.systemPromptTokens ?? 0) +
    FIXED_OVERHEAD_TOKENS;
  let base = estimated;
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i];
    if (found && i <= found.index) {
      break; // 这之前的用量是压缩之前的请求，已经过时
    }
    if (message.role === "assistant" && message.status === "done" && message.usage) {
      base = promptTokensOf(message.usage) + message.usage.output_tokens;
      break;
    }
  }
  const projected = base + estimateQuestion(question) + RESERVE_RATIO * window;
  if (!force && projected <= TRIGGER_RATIO * window) {
    return undefined;
  }

  const keepBudget = (force ? OVERFLOW_KEEP_RATIO : KEEP_RATIO) * window;
  let kept = 0;
  let firstKept = -1;
  for (let i = rounds.length - 1; i >= 0; i--) {
    kept += estimateRound(rounds[i]);
    if (kept >= keepBudget) {
      firstKept = i;
      break;
    }
  }
  // 全部轮次加起来都不到保留额度：没有可以并入摘要的旧内容。
  if (firstKept <= 0) {
    return undefined;
  }
  return {
    ownerId: owner.id,
    firstKeptMessageId: rounds[firstKept][0].id,
    toSummarize: rounds.slice(0, firstKept),
    previousSummary: found?.compaction.summary,
    tokensBefore: Math.round(projected),
  };
};

/** 把轮次转成给摘要用的纯文本：不带思考和工具往返，附件只留文件名。 */
const serializeRound = ([user, reply]: [UserMessage, AssistantMessage]) => {
  const clip = (text: string) =>
    text.length > MAX_SERIALIZED_CHARS
      ? `${text.slice(0, MAX_SERIALIZED_CHARS)}\n[... ${text.length - MAX_SERIALIZED_CHARS} more characters cut ...]`
      : text;
  const attachments = user.files.map((file) => ` [attached: ${file.name}]`).join("");
  return `[User]: ${clip(user.content)}${attachments}\n[Assistant]: ${clip(getReplyText(reply))}`;
};

/** 要摘要的轮次按大小切成几块，每块一次摘要请求；旧内容比窗口还大（如导入的超长历史）也能处理。 */
export const chunkRounds = (rounds: [UserMessage, AssistantMessage][], window: number) => {
  const limit = Math.min(MAX_CHUNK_TOKENS, window * CHUNK_RATIO);
  const chunks: [UserMessage, AssistantMessage][][] = [];
  let current: [UserMessage, AssistantMessage][] = [];
  let size = 0;
  for (const round of rounds) {
    const tokens = estimateRound(round);
    if (current.length > 0 && size + tokens > limit) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(round);
    size += tokens;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
};

export const SUMMARY_SYSTEM_PROMPT =
  "You maintain the long-term memory of an ongoing conversation, which is often a collaborative story or role-play. " +
  "You are given earlier notes (if any) and a stretch of the conversation. Write updated notes that let the conversation continue seamlessly. " +
  "Never continue the conversation yourself, never address the user, and output only the notes.";

export const summaryUserPrompt = (
  rounds: [UserMessage, AssistantMessage][],
  previousSummary?: string,
) =>
  `${previousSummary ? `<previous-notes>\n${previousSummary}\n</previous-notes>\n\n` : ""}` +
  `<conversation>\n${rounds.map(serializeRound).join("\n\n")}\n</conversation>\n\n` +
  "Update the notes so that they cover both the previous notes (if any) and the conversation above. Use these sections, leaving out a section only if it is truly empty:\n" +
  "## Story and topics so far\n" +
  "## Characters and relationships\n" +
  "## World, places and facts established\n" +
  "## Current situation\n" +
  "## Open threads and promises\n" +
  "## Tone, style and point of view\n" +
  "## User's preferences and instructions\n\n" +
  "Be specific: keep names, numbers, decisions, in-world facts, and anything the user explicitly asked for. Do not invent anything. " +
  "Write in the language the conversation uses. Keep the notes under about 4,000 words, dropping the least important detail first.";

/**
 * DeepSeek 上下文溢出的错误特征。官方接口的具体文案没有验证过（要验证得真发一个超过窗口的请求，
 * 费用不低），这里只用通用关键词做兜底，匹配不到就按普通错误处理。
 */
export const isContextOverflowError = (status: number | undefined, message: string) =>
  (status === 400 || status === 413 || status === undefined) &&
  /context[_ ]length[_ ]exceeded|maximum context length|exceeds? (?:the )?(?:model'?s )?(?:maximum )?context|prompt is too long|input is too long|too many tokens|token limit|request_too_large/i.test(
    message,
  );

import { afterAll, beforeAll, expect } from "bun:test";
import { feature, scenario } from "./support/bdd.js";
import { isSummaryRequest } from "./support/mockDeepseek.js";
import { actions, hasText, mock, openApp, see, start, stop } from "./support/world.js";

beforeAll(start);
afterAll(stop);

// 小窗口（1 万 token）让几个回合就走到压缩；真实窗口是 1,048,576。
const WINDOW = 10_000;
const filler = (label: string) => `${label} ` + "word ".repeat(480); // 约 2,400 个字符，约 600 token

const mains = () => mock.requests.filter((request) => !isSummaryRequest(request.body));
const summaries = () => mock.requests.filter((request) => isSummaryRequest(request.body));
/** 与假服务端报告用量时用的同一个估法：约 4 个字符一个 token，加固定开销。 */
const sizeOf = (body: any) => Math.ceil(JSON.stringify(body.messages).length / 4) + 1500;
/** 应用在请求里插入的 latest_reminder（日期、语言等快照）不属于对话，判断内容时先去掉。 */
const conversation = (body: any): any[] =>
  body.messages.filter((message: any) => message.role !== "latest_reminder");
const text = (message: any): string =>
  typeof message.content === "string" ? message.content : JSON.stringify(message.content);

const talk = async (ui: ReturnType<typeof actions>, turn: number) => {
  mock.reply({ chunks: [filler(`REPLY-${turn}`)] });
  await ui.send(filler(`QUESTION-${turn}`));
  await ui.waitForReplyDone();
};

// 压缩对用户无感：界面和消息树不变，只改发给模型的历史。
feature("Compaction", () => {
  scenario.fixtureOnly(
    "A long conversation is compacted without the user noticing",
    async ({ given, thenStep }) => {
      const app = await openApp({ thinking: false, contextWindow: WINDOW });
      try {
        const ui = actions(app.page);
        await given("a conversation that keeps growing past the context window", async () => {
          for (let turn = 1; turn <= 10; turn++) await talk(ui, turn);
        });
        await thenStep(
          "the first notes were requested once the context got close to the limit",
          async () => {
            expect(summaries().length).toBeGreaterThanOrEqual(1);
            const request = summaries()[0].body;
            expect(request.tools).toBeUndefined();
            expect(request.title).toBeUndefined();
            expect(request.thinking.type).toBe("disabled");
            const prompt = text(request.messages[0]);
            expect(prompt).toContain("<conversation>");
            expect(prompt).toContain("QUESTION-1");
          },
        );
        await thenStep("no request to the model ever exceeded the window", async () => {
          for (const request of mains()) expect(sizeOf(request.body)).toBeLessThanOrEqual(WINDOW);
        });
        await thenStep(
          "after the first compaction the oldest rounds are replaced by the notes",
          async () => {
            const index = mock.requests.findIndex((request) => isSummaryRequest(request.body));
            const next = mock.requests
              .slice(index + 1)
              .find((request) => !isSummaryRequest(request.body))!;
            const messages = conversation(next.body);
            expect(messages[0].role).toBe("user");
            expect(text(messages[0])).toContain("<conversation-notes>");
            expect(text(messages[0])).toContain("SCRIPTED-SUMMARY");
            expect(JSON.stringify(messages)).not.toContain("QUESTION-1");
            // 用户与助手仍然严格交替
            messages.forEach((message: any, i: number) =>
              expect(message.role).toBe(i % 2 === 0 ? "user" : "assistant"),
            );
          },
        );
        await thenStep(
          "the user still sees the whole conversation and nothing about it",
          async () => {
            await see(app.page.getByText("QUESTION-1", { exact: false }).first());
            await see(app.page.getByText("REPLY-10", { exact: false }).first());
            const shown = await app.page.locator("body").innerText();
            expect(shown).not.toMatch(/conversation-notes|SCRIPTED-SUMMARY|compact|condens/i);
          },
        );
      } finally {
        await app.close();
      }
    },
  );

  scenario.fixtureOnly(
    "Regenerating a reply reuses the notes instead of summarizing again",
    async ({ given, when, thenStep }) => {
      const app = await openApp({ thinking: false, contextWindow: WINDOW });
      try {
        const ui = actions(app.page);
        let before = 0;
        await given(
          "a conversation whose latest turn is the one that was just compacted",
          async () => {
            for (let turn = 1; summaries().length === 0 && turn <= 15; turn++) await talk(ui, turn);
            expect(summaries().length).toBeGreaterThanOrEqual(1);
            before = summaries().length;
          },
        );
        await when("I regenerate the last reply", async () => {
          mock.reply({ chunks: ["REGENERATED"] });
          await ui.regenerate();
          await ui.waitForReplyDone();
          await hasText(ui.versionCount(), "2 / 2");
        });
        await thenStep(
          "no new summary was needed and the request still carries the notes",
          async () => {
            expect(summaries().length).toBe(before);
            const last = conversation(mains().at(-1)!.body);
            expect(text(last[0])).toContain("<conversation-notes>");
          },
        );
      } finally {
        await app.close();
      }
    },
  );

  scenario.fixtureOnly(
    "A branch that forks before the compaction point sees the full early history",
    async ({ given, when, thenStep }) => {
      const app = await openApp({ thinking: false, contextWindow: WINDOW });
      try {
        const ui = actions(app.page);
        await given("a conversation that has been compacted", async () => {
          for (let turn = 1; turn <= 9; turn++) await talk(ui, turn);
          expect(summaries().length).toBeGreaterThanOrEqual(1);
        });
        await when("I regenerate an early reply and continue on that new branch", async () => {
          mock.reply({ chunks: ["EARLY-REPLY-V2"] });
          await app.page.getByRole("button", { name: "Regenerate" }).nth(1).click({ force: true });
          await see(app.page.getByText("EARLY-REPLY-V2"));
          await ui.waitForReplyDone();
          mock.reply({ chunks: ["ON-THE-NEW-BRANCH"] });
          await ui.send("Continue from here");
          await ui.waitForReplyDone();
        });
        await thenStep(
          "that branch is not compacted: it still has the first question, and no notes",
          async () => {
            const last = mains().at(-1)!.body.messages;
            expect(JSON.stringify(last)).toContain("QUESTION-1");
            expect(JSON.stringify(last)).not.toContain("<conversation-notes>");
          },
        );
      } finally {
        await app.close();
      }
    },
  );

  scenario.fixtureOnly(
    "A failed summary does not block the chat; the next one covers more, in chunks",
    async ({ given, thenStep }) => {
      const app = await openApp({ thinking: false, contextWindow: WINDOW });
      try {
        const ui = actions(app.page);
        await given("the first three summary attempts fail", async () => {
          mock.failSummaries(3);
          for (let turn = 1; turn <= 11; turn++) await talk(ui, turn);
        });
        await thenStep("every reply still arrived", async () => {
          await see(app.page.getByText("REPLY-11", { exact: false }).first());
          expect(await app.page.getByText("mock: summary failed").count()).toBe(0);
        });
        await thenStep(
          "the first success summarized a long span in consecutive chunks, each building on the last",
          async () => {
            const failedCount = 3;
            const firstSuccess = mock.requests.filter((request) => isSummaryRequest(request.body))[
              failedCount
            ];
            const at = mock.requests.indexOf(firstSuccess);
            const second = mock.requests[at + 1];
            // 同一次压缩里紧接着又是一个摘要请求（中间没有普通请求），并且带着前一块得到的笔记
            expect(isSummaryRequest(second.body)).toBe(true);
            expect(text(second.body.messages[0])).toContain("<previous-notes>");
            expect(text(second.body.messages[0])).toContain("SCRIPTED-SUMMARY");
            expect(text(firstSuccess.body.messages[0])).not.toContain("<previous-notes>");
          },
        );
      } finally {
        await app.close();
      }
    },
  );

  scenario.fixtureOnly(
    "A context-overflow error compacts harder and retries once",
    async ({ given, when, thenStep }) => {
      const app = await openApp({ thinking: false, contextWindow: WINDOW });
      try {
        const ui = actions(app.page);
        await given(
          "a short conversation that the API nevertheless rejects as too long",
          async () => {
            for (let turn = 1; turn <= 4; turn++) await talk(ui, turn);
            expect(summaries().length).toBe(0);
          },
        );
        await when("the next message is rejected with a context-length error", async () => {
          mock.overflowOnce();
          mock.reply({ chunks: ["RECOVERED"] });
          await ui.send(filler("QUESTION-5"));
          await ui.waitForReplyDone();
        });
        await thenStep("it was compacted, retried, and the reply arrived", async () => {
          await see(app.page.getByText("RECOVERED"));
          expect(summaries().length).toBe(1);
          const last = conversation(mains().at(-1)!.body);
          expect(text(last[0])).toContain("<conversation-notes>");
          expect(JSON.stringify(last)).toContain("QUESTION-5");
        });
      } finally {
        await app.close();
      }
    },
  );
});

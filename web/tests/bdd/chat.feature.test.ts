import { afterAll, beforeAll, expect } from "bun:test";
import { feature, scenario } from "./support/bdd.js";
import { actions, hasText, mock, openApp, see, start, stop, strict } from "./support/world.js";

beforeAll(start);
afterAll(stop);

// 同一份场景在两种后端上跑：fixture（假服务端，断言精确）与 real（真实接口，只断言结构）。
feature("Chat", () => {
  if (strict) {
    scenario(
      "Open the SeekAgain repository from the desktop and mobile logos",
      async ({ when }) => {
        const app = await openApp();
        try {
          const project = "https://github.com/wangzexi/seek-again";
          await app.context.route(project, (route) =>
            route.fulfill({ body: "SeekAgain repository" }),
          );
          for (const width of [1100, 390]) {
            await app.page.setViewportSize({ width, height: 800 });
            await when(`I click the logo at width ${width}`, async () => {
              const logo = app.page.getByRole("link", { name: "SeekAgain", exact: true });
              const [tab] = await Promise.all([
                app.page.waitForEvent("popup"),
                logo.locator("img").click(),
              ]);
              await tab.waitForURL(project);
              await tab.close();
            });
          }
        } finally {
          await app.close();
        }
      },
    );
  }

  scenario(
    "Send a message and receive a streamed reply",
    async ({ given, when, thenStep, and }) => {
      const app = await openApp();
      try {
        const ui = actions(app.page);
        await given("a reply is scripted in two chunks", async () => {
          mock.reply({ chunks: ["PO", "NG"], gapMs: 400 });
        });
        await when("I send a message", () =>
          ui.send(strict ? "Say pong" : "Reply with exactly one word: PONG"),
        );
        await thenStep("my message is shown", () =>
          see(app.page.getByText(strict ? "Say pong" : "Reply with exactly one word: PONG")),
        );
        if (strict) {
          await and("the first chunk appears while the reply is still streaming", async () => {
            await app.page.getByText("PO", { exact: true }).waitFor();
            await app.page.getByRole("button", { name: "Stop" }).waitFor();
          });
        }
        await and("the reply finishes", () => ui.waitForReplyDone());
        await and("the reply contains PONG", () =>
          // 限定在助手消息的 Markdown 区域，且整段只有 PONG（允许大小写和结尾标点），
          // 这样既不会匹配到用户自己发的那句话，也不会匹配到侧边栏里的会话标题。
          see(app.page.locator(".ds-markdown", { hasText: /^\s*pong[.!]?\s*$/i }).last()),
        );
        if (strict) {
          await and("the request carried the user message", async () => {
            expect(mock.requests).toHaveLength(1);
            expect(JSON.stringify(mock.requests[0].body.messages)).toContain("Say pong");
          });
        }
      } finally {
        await app.close();
      }
    },
  );

  scenario(
    "Regenerating keeps the previous reply as another version",
    async ({ given, when, thenStep, and }) => {
      const app = await openApp();
      try {
        const ui = actions(app.page);
        await given("a conversation with one reply", async () => {
          mock.reply({ chunks: ["ALPHA"] });
          mock.reply({ chunks: ["BETA"] });
          await ui.send("Reply with a single word");
          await ui.waitForReplyDone();
        });
        await when("I regenerate the reply", async () => {
          await ui.regenerate();
          await ui.waitForReplyDone();
        });
        await thenStep("there are two versions and the new one is selected", async () => {
          await hasText(ui.versionCount(), "2 / 2");
          if (strict) await see(app.page.getByText("BETA"));
        });
        await and("the new request did not include the old reply as history", async () => {
          if (!strict) return;
          expect(mock.requests).toHaveLength(2);
          expect(JSON.stringify(mock.requests[1].body.messages)).not.toContain("ALPHA");
        });
        await when("I switch back to the previous version", () => ui.previousVersion());
        await thenStep("the first version is shown again", async () => {
          await hasText(ui.versionCount(), "1 / 2");
          if (strict) await see(app.page.getByText("ALPHA"));
        });
      } finally {
        await app.close();
      }
    },
  );

  scenario("A conversation survives a page reload", async ({ given, when, thenStep }) => {
    const app = await openApp();
    try {
      const ui = actions(app.page);
      await given("a conversation with one reply", async () => {
        mock.reply({ chunks: ["REMEMBER-ME"] });
        await ui.send("Remember this: pineapple");
        await ui.waitForReplyDone();
      });
      await when("I reload the page", async () => {
        await app.page.reload();
        await app.page.getByPlaceholder("Enter a message").waitFor();
      });
      await thenStep("the conversation is listed in the sidebar", () => see(ui.firstSession()));
      await when("I open it from the list", () => ui.firstSession().click());
      await thenStep("my message and the reply are shown again", async () => {
        await see(app.page.getByText("Remember this: pineapple"));
        if (strict) await see(app.page.getByText("REMEMBER-ME"));
        else await see(app.page.getByRole("button", { name: "Regenerate" }).last());
      });
    } finally {
      await app.close();
    }
  });
});

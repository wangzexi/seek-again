import { afterAll, beforeAll, expect } from "bun:test";
import { lastToolResults, messagesOf, toolResults, toolRow } from "./support/agentSteps.js";
import { feature, scenario } from "./support/bdd.js";
import { actions, hasText, mock, openApp, see, start, stop, strict } from "./support/world.js";

beforeAll(start);
afterAll(stop);

const bashCall = (id: string, command: string) => ({ id, name: "bash", input: { command } });

// bash 依赖深度思考（接口限制），所以这里的场景都开启深度思考。
feature("Agent", () => {
  scenario(
    "The agent writes a file with bash and reads it back",
    async ({ given, when, thenStep, and }) => {
      const app = await openApp({ thinking: true });
      try {
        const ui = actions(app.page);
        await given("the model will write a file, read it back and answer", async () => {
          mock.reply({
            chunks: ["I'll save it."],
            toolCalls: [bashCall("call_a", "printf 'HELLO-AGENT' > hello.txt")],
          });
          mock.reply({ chunks: [], toolCalls: [bashCall("call_b", "cat hello.txt")] });
          mock.reply({ chunks: ["The file contains HELLO-AGENT."] });
        });
        await when("I ask it to remember something", () =>
          ui.send(
            strict
              ? "Remember: HELLO-AGENT"
              : "Use the bash tool to create hello.txt containing exactly HELLO-AGENT, then use the bash tool again to read the file back, then tell me what the file contains.",
          ),
        );
        await thenStep("the timeline shows a command being run", () =>
          see(toolRow(app.page, "bash").first(), 60_000),
        );
        await and("the reply finishes", () => ui.waitForReplyDone());
        await and("the answer mentions the content", () =>
          see(app.page.locator(".ds-markdown", { hasText: /HELLO-AGENT/ }).last()),
        );
        if (strict) {
          await and("three requests were made", async () => {
            expect(mock.requests).toHaveLength(3);
          });
          await and(
            "the only client tool offered is bash, together with deep thinking",
            async () => {
              const body = mock.requests[0].body;
              expect(body.thinking.type).toBe("enabled");
              expect(body.tools.map((tool: any) => tool.name)).toEqual([
                "deepseek_read_url",
                "bash",
              ]);
            },
          );
          await and(
            "the tool round-trip is sent back exactly as the model produced it",
            async () => {
              const second = messagesOf(1).slice(-2);
              expect(second[0].role).toBe("assistant");
              expect(second[0].content.map((b: any) => b.type)).toEqual([
                "thinking",
                "text",
                "tool_use",
              ]);
              expect(second[0].content[0].signature).toBe("mock-1");
              expect(second[0].content[2]).toEqual({
                type: "tool_use",
                id: "call_a",
                name: "bash",
                input: { command: "printf 'HELLO-AGENT' > hello.txt" },
              });
              expect(second[1].role).toBe("user");
              expect(second[1].content).toEqual([
                {
                  type: "tool_result",
                  tool_use_id: "call_a",
                  content: "(no output)\n[files: created hello.txt]",
                },
              ]);
            },
          );
          await and("the second command read back what the first one wrote", async () => {
            expect(toolResults(2)[0]).toMatchObject({
              tool_use_id: "call_b",
              content: "HELLO-AGENT",
            });
          });
          await and("earlier rounds stay in the history of the last request", async () => {
            expect(
              messagesOf(2)
                .map((m) => m.role)
                .slice(-4),
            ).toEqual(["assistant", "user", "assistant", "user"]);
          });
        }
      } finally {
        await app.close();
      }
    },
  );

  scenario.fixtureOnly(
    "Each branch of the story has its own files",
    async ({ given, when, thenStep }) => {
      const app = await openApp({ thinking: true });
      try {
        const ui = actions(app.page);
        await given("the first reply writes a.txt", async () => {
          mock.reply({ chunks: [], toolCalls: [bashCall("w1", "echo 'from branch one' > a.txt")] });
          mock.reply({ chunks: ["Saved."] });
          await ui.send("Save a note");
          await ui.waitForReplyDone();
        });
        await when("I regenerate and the new version lists the files", async () => {
          mock.reply({ chunks: [], toolCalls: [bashCall("l1", "ls")] });
          mock.reply({ chunks: ["Nothing here."] });
          await ui.regenerate();
          await ui.waitForReplyDone();
          await hasText(ui.versionCount(), "2 / 2");
        });
        await thenStep("the new version sees an empty folder", async () => {
          expect(lastToolResults()[0]).toMatchObject({ tool_use_id: "l1", content: "(no output)" });
        });
        await when("I switch back to the first version and ask again", async () => {
          await ui.previousVersion();
          await hasText(ui.versionCount(), "1 / 2");
          mock.reply({ chunks: [], toolCalls: [bashCall("l2", "ls")] });
          mock.reply({ chunks: ["One file."] });
          await ui.send("What files do I have?");
          await ui.waitForReplyDone();
        });
        await thenStep("the first branch still has a.txt", async () => {
          expect(lastToolResults()[0]).toMatchObject({ tool_use_id: "l2", content: "a.txt\n" });
        });
      } finally {
        await app.close();
      }
    },
  );

  scenario.fixtureOnly("Files survive a page reload", async ({ given, when, thenStep }) => {
    const app = await openApp({ thinking: true });
    try {
      const ui = actions(app.page);
      await given("a reply wrote notes/world.md", async () => {
        mock.reply({
          chunks: [],
          toolCalls: [bashCall("w1", "mkdir -p notes && printf '# World' > notes/world.md")],
        });
        mock.reply({ chunks: ["Saved."] });
        await ui.send("Save the world notes");
        await ui.waitForReplyDone();
      });
      await when("I reload and open the conversation", async () => {
        await app.page.reload();
        await app.page.getByPlaceholder("Enter a message").waitFor();
        await see(ui.firstSession());
        await ui.firstSession().click();
        await see(app.page.getByText("Save the world notes"));
      });
      await thenStep("the command step is still shown in the timeline", () =>
        see(toolRow(app.page, "bash")),
      );
      await when("I ask it to read the file back", async () => {
        mock.reply({ chunks: [], toolCalls: [bashCall("r1", "cat notes/world.md")] });
        mock.reply({ chunks: ["Found it."] });
        await ui.send("Read my world notes");
        await ui.waitForReplyDone();
      });
      await thenStep("the file and its content are still there", async () => {
        expect(lastToolResults()[0]).toMatchObject({ content: "# World" });
      });
    } finally {
      await app.close();
    }
  });

  scenario.fixtureOnly(
    "A bad tool call is reported to the model, not fatal",
    async ({ given, when, thenStep }) => {
      const app = await openApp({ thinking: true });
      try {
        const ui = actions(app.page);
        await given(
          "the model sends invalid arguments and calls a tool that does not exist",
          async () => {
            mock.reply({
              chunks: [],
              toolCalls: [
                { id: "bad1", name: "bash", input: {} },
                { id: "bad2", name: "write_file", input: { path: "x.txt", content: "x" } },
              ],
            });
            mock.reply({ chunks: ["Understood."] });
          },
        );
        await when("I send a message", async () => {
          await ui.send("Try something wrong");
          await ui.waitForReplyDone();
        });
        await thenStep("both results are errors and the turn still finishes normally", async () => {
          const results = toolResults(1) as any[];
          expect(results.map((r) => r.tool_use_id)).toEqual(["bad1", "bad2"]);
          expect(results.every((r) => r.is_error === true)).toBe(true);
          expect(results[0].content).toContain("Invalid arguments");
          expect(results[1].content).toContain("Unknown tool: write_file");
          await see(toolRow(app.page, "bash", "error"));
          await see(app.page.getByText("Understood."));
        });
      } finally {
        await app.close();
      }
    },
  );

  scenario.fixtureOnly(
    "Stopping during a later round keeps what already happened",
    async ({ given, when, thenStep }) => {
      const app = await openApp({ thinking: true });
      try {
        const ui = actions(app.page);
        await given("the model runs a command and then streams a slow answer", async () => {
          mock.reply({ chunks: [], toolCalls: [bashCall("l1", "ls")] });
          mock.reply({ chunks: ["PART-ONE ", "PART-TWO"], gapMs: 3000 });
        });
        await when("I stop while the answer is streaming", async () => {
          await ui.send("Slow please");
          await see(app.page.getByText("PART-ONE"));
          await app.page.getByRole("button", { name: "Stop" }).click();
        });
        await thenStep(
          "the turn ends as stopped, with the command step kept and no error",
          async () => {
            await ui.waitForReplyDone();
            await see(toolRow(app.page, "bash"));
            await app.page.waitForTimeout(3500); // 本应出现第二段的时间
            expect(await app.page.getByText("PART-TWO").count()).toBe(0);
            expect(await app.page.getByText(/error|failed/i).count()).toBe(0);
          },
        );
      } finally {
        await app.close();
      }
    },
  );

  scenario.fixtureOnly("A runaway tool loop is stopped", async ({ given, when, thenStep }) => {
    const app = await openApp({ thinking: true });
    try {
      const ui = actions(app.page);
      await given("the model keeps calling tools forever", async () => {
        for (let i = 0; i < 12; i++) {
          mock.reply({ chunks: [], toolCalls: [bashCall(`l${i}`, "echo x")] });
        }
      });
      await when("I send a message", () => ui.send("Loop"));
      await thenStep(
        "the turn stops with a clear message after a bounded number of rounds",
        async () => {
          await see(app.page.getByText("Too many tool calls; this turn was stopped."), 30_000);
          // 第一次请求加 8 轮往返
          expect(mock.requests.length).toBe(9);
        },
      );
    } finally {
      await app.close();
    }
  });

  scenario.fixtureOnly(
    "Without deep thinking no client tools are offered",
    async ({ given, when, thenStep }) => {
      const app = await openApp({ thinking: false });
      try {
        const ui = actions(app.page);
        await given("a plain reply is scripted", async () => {
          mock.reply({ chunks: ["Plain."] });
        });
        await when("I send a message", async () => {
          await ui.send("Hello");
          await ui.waitForReplyDone();
        });
        await thenStep("the request has no client tools and the chat works", async () => {
          const body = mock.requests[0].body;
          expect(body.thinking.type).toBe("disabled");
          expect(body.tools.map((tool: any) => tool.name)).toEqual(["deepseek_read_url"]);
          await see(app.page.getByText("Plain."));
        });
      } finally {
        await app.close();
      }
    },
  );
});

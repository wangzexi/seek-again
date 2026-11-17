import { afterAll, beforeAll, expect } from "bun:test";
import { lastToolResults, messagesOf, toolRow } from "./support/agentSteps.js";
import { feature, scenario } from "./support/bdd.js";
import { actions, hasText, mock, openApp, see, start, stop, strict } from "./support/world.js";

beforeAll(start);
afterAll(stop);

const bashCall = (id: string, command: string) => ({ id, name: "bash", input: { command } });

// 命令在真实 Chrome 的 Worker 里由 just-bash 真正执行；假服务端只负责让“模型”发出这些命令。
feature("Bash", () => {
  scenario(
    "The agent finds things in its notes with grep",
    async ({ given, when, thenStep, and }) => {
      const app = await openApp({ thinking: true });
      try {
        const ui = actions(app.page);
        await given("the model writes two notes, greps them and answers", async () => {
          mock.reply({
            chunks: [],
            toolCalls: [
              bashCall(
                "w1",
                "mkdir -p notes && printf 'The dragon sleeps under the mountain' > notes/a.md && printf 'The knight rides at dawn' > notes/b.md",
              ),
            ],
          });
          mock.reply({ chunks: [], toolCalls: [bashCall("s1", "grep -rn dragon notes")] });
          mock.reply({ chunks: ["The dragon is mentioned in notes/a.md."] });
        });
        await when("I ask where the dragon is mentioned", () =>
          ui.send(
            strict
              ? "Where is the dragon mentioned?"
              : "Use the bash tool to create notes/a.md containing 'The dragon sleeps under the mountain' and notes/b.md containing 'The knight rides at dawn'. Then use the bash tool with grep to find which file mentions the dragon, and tell me the file name.",
          ),
        );
        await thenStep("the timeline shows the commands that were run", () =>
          see(toolRow(app.page, "bash").first(), 90_000),
        );
        await and("the reply finishes and names the right file", async () => {
          await ui.waitForReplyDone();
          await see(app.page.locator(".ds-markdown", { hasText: /a\.md/ }).last());
        });
        if (strict) {
          await and("grep really ran against the saved files", async () => {
            expect(lastToolResults()[0]).toMatchObject({
              tool_use_id: "s1",
              content: "notes/a.md:1:The dragon sleeps under the mountain\n",
            });
          });
        }
      } finally {
        await app.close();
      }
    },
  );

  scenario.fixtureOnly(
    "Files created, changed and deleted by a command are saved",
    async ({ given, when, thenStep }) => {
      const app = await openApp({ thinking: true });
      try {
        const ui = actions(app.page);
        await given("two files exist and one command creates, edits and deletes", async () => {
          mock.reply({
            chunks: [],
            toolCalls: [bashCall("w1", "printf 'obsolete' > old.txt && printf 'abc' > keep.txt")],
          });
          mock.reply({
            chunks: [],
            toolCalls: [
              bashCall(
                "s1",
                "printf 'hello\\n' > out.txt && sed -i 's/hello/world/' out.txt && sed -i 's/abc/xyz/' keep.txt && rm old.txt && mkdir -p deep/dir && echo x > deep/dir/f.md",
              ),
            ],
          });
          mock.reply({ chunks: ["Done."] });
          await ui.send("Make some files");
          await ui.waitForReplyDone();
        });
        await thenStep("the result lists exactly what changed", async () => {
          const result = lastToolResults()[0];
          expect(result.is_error).toBeUndefined();
          expect(result.content).toContain("[files: ");
          // keep.txt 本来就在目录里：靠“被写过”识别，而不是靠它是新文件
          for (const expected of [
            "created out.txt",
            "modified keep.txt",
            "deleted old.txt",
            "created deep/dir/f.md",
          ]) {
            expect(result.content).toContain(expected);
          }
        });
        await when("a later turn lists and reads the folder", async () => {
          mock.reply({
            chunks: [],
            toolCalls: [
              bashCall("l1", "find . -type f | sort"),
              bashCall("r1", "cat out.txt"),
              bashCall("r2", "cat keep.txt"),
            ],
          });
          mock.reply({ chunks: ["Listed."] });
          await ui.send("What is there now?");
          await ui.waitForReplyDone();
        });
        await thenStep(
          "the files are in the conversation folder with the edited content",
          async () => {
            const [listing, out, keep] = lastToolResults();
            expect(listing.content.trim().split("\n")).toEqual([
              "./deep/dir/f.md",
              "./keep.txt",
              "./out.txt",
            ]);
            expect(out).toMatchObject({ tool_use_id: "r1", content: "world\n" });
            expect(keep).toMatchObject({ tool_use_id: "r2", content: "xyz" });
          },
        );
      } finally {
        await app.close();
      }
    },
  );

  scenario.fixtureOnly(
    "A command that changes many files reports only the first few",
    async ({ given, when, thenStep }) => {
      const app = await openApp({ thinking: true });
      try {
        const ui = actions(app.page);
        await given("the model creates 60 files with one command", async () => {
          mock.reply({
            chunks: [],
            toolCalls: [bashCall("many", "for i in $(seq 1 60); do echo $i > n$i.txt; done")],
          });
          mock.reply({ chunks: ["Done."] });
        });
        await when("I send a message", async () => {
          await ui.send("Make many files");
          await ui.waitForReplyDone();
        });
        await thenStep("the result lists 20 files and counts the rest", async () => {
          const text: string = lastToolResults()[0].content;
          expect(text.match(/created n\d+\.txt/g)).toHaveLength(20);
          expect(text).toContain("and 40 more");
        });
      } finally {
        await app.close();
      }
    },
  );

  scenario.fixtureOnly(
    "The shell is a sandbox: no network, no host files, no Python",
    async ({ given, when, thenStep }) => {
      const app = await openApp({ thinking: true });
      try {
        const ui = actions(app.page);
        await given("the model tries to reach outside the sandbox", async () => {
          mock.reply({
            chunks: [],
            toolCalls: [
              bashCall("c1", "curl -s https://example.com"),
              bashCall("c2", "cat /etc/passwd"),
              bashCall("c3", 'python3 -c "print(1)"'),
              bashCall("c4", "echo secret > /tmp/outside.txt; ls /tmp"),
            ],
          });
          mock.reply({ chunks: ["I could not."] });
        });
        await when("I send a message", async () => {
          await ui.send("Try to escape");
          await ui.waitForReplyDone();
        });
        await thenStep("none of it works and nothing leaks into the folder", async () => {
          const [curl, passwd, python, tmp] = lastToolResults();
          expect(curl.content).toMatch(/not found/i);
          expect(passwd.content).toMatch(/no such file/i);
          // 浏览器版 just-bash 明确拒绝 python3，而不是悄悄失败
          expect(python.content).toMatch(/not available in browser/i);
          // 写到 /tmp 的文件在命令里可见，但不属于对话目录，之后会被丢弃
          expect(tmp.content).toContain("outside.txt");
          expect(tmp.content).not.toContain("[files:");
          // 退出码非 0 不是工具错误，时间线上不显示“失败”
          await see(toolRow(app.page, "bash", "done").first());
          expect(await toolRow(app.page, "bash", "error").count()).toBe(0);
        });
      } finally {
        await app.close();
      }
    },
  );

  scenario.fixtureOnly(
    "A runaway command is stopped and the shell keeps working",
    async ({ given, when, thenStep }) => {
      const app = await openApp({ thinking: true });
      try {
        const ui = actions(app.page);
        await given("the model starts an endless loop, then runs a normal command", async () => {
          mock.reply({ chunks: [], toolCalls: [bashCall("loop", "while true; do :; done")] });
          mock.reply({ chunks: [], toolCalls: [bashCall("ok", "echo still-alive")] });
          mock.reply({ chunks: ["Recovered."] });
        });
        await when("I send a message", async () => {
          await ui.send("Loop forever");
          await see(app.page.getByText("Recovered."), 60_000);
          await ui.waitForReplyDone();
        });
        await thenStep(
          "the loop was reported as a limit and the next command still ran",
          async () => {
            const second = messagesOf(1).at(-1)?.content[0];
            expect(second.tool_use_id).toBe("loop");
            expect(second.content).toMatch(/limit|exceeded|timeout|too many|stopped/i);
            expect(lastToolResults()[0]).toMatchObject({ tool_use_id: "ok" });
            expect(lastToolResults()[0].content).toContain("still-alive");
          },
        );
      } finally {
        await app.close();
      }
    },
  );

  scenario.fixtureOnly(
    "Stopping while a command runs ends it right away and the shell recovers",
    async ({ given, when, thenStep }) => {
      const app = await openApp({ thinking: true });
      try {
        const ui = actions(app.page);
        await given("the model starts a command that takes 30 seconds", async () => {
          mock.reply({ chunks: [], toolCalls: [bashCall("slow", "sleep 30; echo late")] });
        });
        await when("I stop while it is running", async () => {
          await ui.send("Wait a long time");
          await see(toolRow(app.page, "bash", "running"));
          await app.page.getByRole("button", { name: "Stop" }).click();
        });
        await thenStep(
          "the turn ends quickly as stopped, with the step marked stopped",
          async () => {
            const started = Date.now();
            await ui.waitForReplyDone();
            expect(Date.now() - started).toBeLessThan(5000);
            await see(toolRow(app.page, "bash", "stopped"));
          },
        );
        await when("I send another message that runs a normal command", async () => {
          mock.reply({ chunks: [], toolCalls: [bashCall("ok", "echo recovered")] });
          mock.reply({ chunks: ["Fine."] });
          await ui.send("Try again");
          await ui.waitForReplyDone();
        });
        await thenStep("the shell works again", async () => {
          expect(lastToolResults()[0].content).toContain("recovered");
        });
      } finally {
        await app.close();
      }
    },
  );

  scenario.fixtureOnly(
    "The current directory and variables persist between commands and turns",
    async ({ given, when, thenStep }) => {
      const app = await openApp({ thinking: true });
      try {
        const ui = actions(app.page);
        await given("one command changes directory and sets a variable", async () => {
          mock.reply({
            chunks: [],
            toolCalls: [bashCall("s1", "mkdir -p notes && cd notes && X=42 && echo start > a.md")],
          });
          mock.reply({ chunks: [], toolCalls: [bashCall("s2", 'pwd; echo "X=$X"; ls')] });
          mock.reply({ chunks: ["Set."] });
          await ui.send("Set things up");
          await ui.waitForReplyDone();
        });
        await thenStep(
          "the next command in the same turn starts where the last one ended",
          async () => {
            expect(messagesOf(2).at(-1)?.content[0]).toMatchObject({
              tool_use_id: "s2",
              content: "/work/notes\nX=42\na.md\n",
            });
          },
        );
        await when("I send another message in the same conversation", async () => {
          mock.reply({ chunks: [], toolCalls: [bashCall("s3", 'pwd; echo "X=$X"')] });
          mock.reply({ chunks: ["Still there."] });
          await ui.send("Where am I?");
          await ui.waitForReplyDone();
        });
        await thenStep("the directory and the variable are still set", async () => {
          expect(lastToolResults()[0]).toMatchObject({
            tool_use_id: "s3",
            content: "/work/notes\nX=42\n",
          });
        });
      } finally {
        await app.close();
      }
    },
  );

  scenario.fixtureOnly(
    "A directory made with mkdir is still there for the next command",
    async ({ given, thenStep }) => {
      const app = await openApp({ thinking: true });
      try {
        const ui = actions(app.page);
        await given(
          "one command makes an empty directory, the next goes into it and writes a file",
          async () => {
            mock.reply({ chunks: [], toolCalls: [bashCall("m1", "mkdir project")] });
            mock.reply({
              chunks: [],
              toolCalls: [bashCall("m2", "cd project && echo hi > a.txt && pwd")],
            });
            // m2 left the shell inside project/, so go up a level before listing
            mock.reply({
              chunks: [],
              toolCalls: [bashCall("m3", "cd .. && ls project && ls && find . -type f")],
            });
            mock.reply({ chunks: ["Done."] });
            await ui.send("Make a project folder");
            await ui.waitForReplyDone();
          },
        );
        await thenStep("mkdir reports the new directory", async () => {
          expect(messagesOf(1).at(-1)?.content[0].content).toBe(
            "(no output)\n[files: created project/]",
          );
        });
        await thenStep("the next command could cd into it and write there", async () => {
          const second = messagesOf(2).at(-1)?.content[0].content;
          expect(second).toContain("/work/project");
          expect(second).toContain("created project/a.txt");
        });
        await thenStep(
          "the directory now holds the file, and the placeholder never shows up as a file",
          async () => {
            expect(lastToolResults()[0].content).toBe("a.txt\nproject\n./project/a.txt\n");
          },
        );
      } finally {
        await app.close();
      }
    },
  );

  scenario.fixtureOnly(
    "Shell state follows the branch and survives a reload",
    async ({ given, when, thenStep }) => {
      const app = await openApp({ thinking: true });
      try {
        const ui = actions(app.page);
        await given("the first reply moves into a folder", async () => {
          mock.reply({
            chunks: [],
            toolCalls: [bashCall("c1", "mkdir -p notes && cd notes && echo x > f")],
          });
          mock.reply({ chunks: ["Moved."] });
          await ui.send("Go to notes");
          await ui.waitForReplyDone();
        });
        await when("I regenerate the reply and ask where I am", async () => {
          mock.reply({ chunks: [], toolCalls: [bashCall("p1", "pwd")] });
          mock.reply({ chunks: ["Here."] });
          await ui.regenerate();
          await ui.waitForReplyDone();
        });
        await thenStep(
          "the new version starts at the root: the other branch does not leak its directory",
          async () => {
            expect(lastToolResults()[0]).toMatchObject({ tool_use_id: "p1", content: "/work\n" });
          },
        );
        await when("I go back to the first version, reload, and ask again", async () => {
          await ui.previousVersion();
          await hasText(ui.versionCount(), "1 / 2");
          // 选中的版本是异步保存的；刚点完就重载会赶不上，给它一点时间。
          await app.page.waitForTimeout(800);
          await app.page.reload();
          await app.page.getByPlaceholder("Enter a message").waitFor();
          await see(ui.firstSession());
          await ui.firstSession().click();
          await see(app.page.getByText("Go to notes"));
          await hasText(ui.versionCount(), "1 / 2");
          mock.reply({ chunks: [], toolCalls: [bashCall("p2", "pwd")] });
          mock.reply({ chunks: ["There."] });
          await ui.send("Where am I now?");
          await ui.waitForReplyDone();
        });
        await thenStep("the first branch is still in notes, even after the reload", async () => {
          expect(lastToolResults()[0]).toMatchObject({
            tool_use_id: "p2",
            content: "/work/notes\n",
          });
        });
      } finally {
        await app.close();
      }
    },
  );

  scenario.fixtureOnly(
    "Output is clipped at 16,000 characters like the official bash",
    async ({ given, when, thenStep }) => {
      const app = await openApp({ thinking: true });
      try {
        const ui = actions(app.page);
        await given("the model prints far more than that", async () => {
          mock.reply({ chunks: [], toolCalls: [bashCall("big", "seq 1 5000")] });
          mock.reply({ chunks: ["Too much."] });
        });
        await when("I send a message", async () => {
          await ui.send("Print a lot");
          await ui.waitForReplyDone();
        });
        await thenStep("only the first 16,000 characters are sent back, with a hint", async () => {
          const text: string = lastToolResults()[0].content;
          expect(text).toContain("[output truncated at 16000 characters");
          expect(text.startsWith("1\n2\n3\n")).toBe(true);
          expect(text.length).toBeLessThan(16_300);
        });
      } finally {
        await app.close();
      }
    },
  );

  scenario.fixtureOnly(
    "The bash tool is declared the way the official one is",
    async ({ given, when, thenStep }) => {
      const app = await openApp({ thinking: true });
      try {
        const ui = actions(app.page);
        await given("a plain reply is scripted", async () => {
          mock.reply({ chunks: ["Hi."] });
        });
        await when("I send a message", async () => {
          await ui.send("Hello");
          await ui.waitForReplyDone();
        });
        await thenStep(
          "the tool is named bash with a single required command parameter",
          async () => {
            const tool = mock.requests[0].body.tools.find((item: any) => item.name === "bash");
            expect(Object.keys(tool.input_schema.properties)).toEqual(["command"]);
            expect(tool.input_schema.required).toEqual(["command"]);
            expect(tool.input_schema.properties.command.description).toBe(
              "The bash command to run. Relative path is preferred in the command.",
            );
            for (const line of [
              "State is persistent across command calls and discussions with the user",
              "sed -n 10,25p /path/to/the/file",
              "Please avoid commands that may produce a very large amount of output.",
            ]) {
              expect(tool.description).toContain(line);
            }
          },
        );
      } finally {
        await app.close();
      }
    },
  );
});

import { describe, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(120_000);

type Step = <T = void>(text: string, run: () => Promise<T> | T) => Promise<T>;

const step =
  (keyword: "Given" | "When" | "Then" | "And"): Step =>
  async (text, run) => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof Error) {
        error.message = `${keyword} ${text}\n${error.message}`;
      }
      throw error;
    }
  };

export const steps = {
  given: step("Given"),
  when: step("When"),
  thenStep: step("Then"),
  and: step("And"),
};

export const feature = (name: string, body: () => void) => describe(`Feature: ${name}`, body);

type Body = (steps: typeof import("./bdd.js").steps) => Promise<void>;

export const scenario = Object.assign(
  (name: string, body: Body) => test(`Scenario: ${name}`, () => body(steps)),
  {
    /** 只在假服务端上跑：依赖脚本化的工具调用或精确的请求内容，真实模型的输出不能保证。 */
    fixtureOnly: (name: string, body: Body) =>
      test.skipIf(process.env.BDD_MODE === "real")(`Scenario: ${name} [fixture only]`, () =>
        body(steps),
      ),
  },
);

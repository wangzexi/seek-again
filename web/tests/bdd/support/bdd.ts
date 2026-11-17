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

export const scenario = (
  name: string,
  body: (steps: typeof import("./bdd.js").steps) => Promise<void>,
) => test(`Scenario: ${name}`, () => body(steps));

import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import type { Language } from "../src/types.ts";

export interface CliQuestioner {
  question(prompt: string): Promise<string>;
  close(): void;
}

export interface CliIO {
  setLanguage(language: Language): void;
  ask(prompt: string): Promise<string>;
  choose(prompt: string, options: readonly string[], zeroLabel?: string): Promise<number>;
  confirm(prompt: string): Promise<boolean>;
  writeLine(message?: string): void;
  close(): void;
}

export class UserCancelledError extends Error {
  constructor() {
    super("user-cancelled");
  }
}

export class BackRequestedError extends Error {
  constructor() {
    super("back-requested");
  }
}

async function askQuestion(questioner: CliQuestioner, prompt: string): Promise<string> {
  try {
    const answer = await questioner.question(prompt);
    if (answer.trim() === "0") throw new BackRequestedError();
    return answer;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new UserCancelledError();
    throw error;
  }
}

export function createCliIO(questioner: CliQuestioner, output: (line: string) => void): CliIO {
  let language: Language | null = null;
  const localized = (chinese: string, english: string): string => language === "zh"
    ? chinese
    : language === "en" ? english : `${chinese} / ${english}`;

  return {
    setLanguage(nextLanguage) {
      language = nextLanguage;
    },
    ask(prompt) {
      return askQuestion(questioner, `${prompt}${localized("（输入 0 返回）", " (enter 0 to go back)")}`);
    },
    async choose(prompt, options, zeroLabel) {
      if (options.length === 0) throw new Error("cli-choice-options-empty");
      while (true) {
        output("");
        output(`──────── ${prompt} ────────`);
        options.forEach((option, index) => output(`${index + 1}. ${option}`));
        output(`0. ${zeroLabel ?? localized("返回上一步", "Back")}`);
        const answer = (await askQuestion(questioner, "> ")).trim();
        if (/^\d+$/.test(answer)) {
          const selected = Number(answer) - 1;
          if (selected >= 0 && selected < options.length) return selected;
        }
        output(localized(
          `请输入 1 到 ${options.length} 之间的数字。`,
          `Please enter a number from 1 to ${options.length}.`,
        ));
      }
    },
    async confirm(prompt) {
      while (true) {
        const answer = (await askQuestion(questioner, `${prompt} [y/n/0] `)).trim().toLowerCase();
        if (["y", "yes", "是"].includes(answer)) return true;
        if (["n", "no", "否"].includes(answer)) return false;
        output(localized("请输入 y/yes/是 或 n/no/否。", "Enter y/yes or n/no."));
      }
    },
    writeLine(message = "") {
      output(message);
    },
    close() {
      questioner.close();
    },
  };
}

export function createReadlineCliIO(
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): CliIO {
  const readline = createInterface({ input, output });
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  const questioner: CliQuestioner = {
    question(prompt) {
      return readline.question(prompt, { signal: controller.signal });
    },
    close() {
      process.removeListener("SIGINT", cancel);
      readline.close();
    },
  };
  return createCliIO(questioner, (line) => output.write(`${line}\n`));
}

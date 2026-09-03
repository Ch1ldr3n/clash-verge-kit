import { describe, expect, it } from "vitest";
import { BackRequestedError, createCliIO, UserCancelledError, type CliQuestioner } from "../scripts/cli-io";
import { getCliMessages } from "../scripts/cli-messages";

function scriptedQuestioner(answers: string[]): CliQuestioner {
  return {
    async question() {
      const answer = answers.shift();
      if (answer === undefined) throw new Error("test-input-exhausted");
      return answer;
    },
    close() {},
  };
}

describe("CLI input and messages", () => {
  it("retries an invalid numbered choice and returns a zero-based index", async () => {
    const lines: string[] = [];
    const io = createCliIO(scriptedQuestioner(["9", "2"]), (line) => lines.push(line));

    const selected = await io.choose("请选择语言 / Choose language", ["中文", "English"]);

    expect(selected).toBe(1);
    expect(lines.join("\n")).toContain("Please enter a number from 1 to 2");
  });

  it("accepts Chinese and English confirmation answers", async () => {
    const english = createCliIO(scriptedQuestioner(["yes"]), () => {});
    const chinese = createCliIO(scriptedQuestioner(["是"]), () => {});

    await expect(english.confirm("Continue?")).resolves.toBe(true);
    await expect(chinese.confirm("继续吗？")).resolves.toBe(true);
  });

  it("uses zero as the same back command for menus, text input, and confirmation", async () => {
    const menuLines: string[] = [];
    const menu = createCliIO(scriptedQuestioner(["0"]), (line) => menuLines.push(line));
    const text = createCliIO(scriptedQuestioner(["0"]), () => {});
    const confirmation = createCliIO(scriptedQuestioner(["0"]), () => {});

    await expect(menu.choose("Choose", ["One"])).rejects.toBeInstanceOf(BackRequestedError);
    await expect(text.ask("Name: ")).rejects.toBeInstanceOf(BackRequestedError);
    await expect(confirmation.confirm("Continue?")).rejects.toBeInstanceOf(BackRequestedError);
    expect(menuLines).toEqual([
      "",
      "──────── Choose ────────",
      "1. One",
      "0. 返回上一步 / Back",
    ]);
  });

  it("uses only the selected language after language selection", async () => {
    const lines: string[] = [];
    const io = createCliIO(scriptedQuestioner(["9", "0"]), (line) => lines.push(line));
    io.setLanguage("zh");

    await expect(io.choose("选择", ["继续"])).rejects.toBeInstanceOf(BackRequestedError);

    expect(lines).toEqual([
      "",
      "──────── 选择 ────────",
      "1. 继续",
      "0. 返回上一步",
      "请输入 1 到 1 之间的数字。",
      "",
      "──────── 选择 ────────",
      "1. 继续",
      "0. 返回上一步",
    ]);
    expect(lines.join("\n")).not.toContain("Back");
  });

  it("provides distinct Chinese and English product copy", () => {
    const children = [{ subscriptionName: "Child", groupName: "Nested child" }];
    expect(getCliMessages("zh").deliveryReview("Main", "PROXY", children)).toContain("Child → Nested child");
    expect(getCliMessages("zh").directionCopyCorrect).toContain("复制完整脚本");
    expect(getCliMessages("en").deliveryReview("Main", "PROXY", children)).toContain("Child → Nested child");
    expect(getCliMessages("en").directionCopyCorrect).toContain("Copy the full script");
  });

  it("turns an aborted terminal question into normal user cancellation", async () => {
    const aborted: CliQuestioner = {
      async question() {
        const error = new Error("The operation was aborted");
        error.name = "AbortError";
        throw error;
      },
      close() {},
    };
    const io = createCliIO(aborted, () => {});

    await expect(io.ask("prompt")).rejects.toBeInstanceOf(UserCancelledError);
  });
});

import { spawn } from "node:child_process";

export interface ClipboardCommand {
  file: string;
  args: string[];
}

export async function copyTextToClipboard(
  text: string,
  command: ClipboardCommand = { file: "clip.exe", args: [] },
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const child = spawn(command.file, command.args, {
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
    });
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
    child.stdin.once("error", () => finish(false));
    child.stdin.end(Buffer.from(text, "utf16le"));
  });
}

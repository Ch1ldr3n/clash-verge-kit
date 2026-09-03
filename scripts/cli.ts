#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { createReadlineCliIO, UserCancelledError, type CliIO } from "./cli-io.ts";
import { copyTextToClipboard } from "./cli-clipboard.ts";
import { getCliMessages } from "./cli-messages.ts";
import { runCliWorkflow } from "./cli-workflow.ts";
import { createLocalProfileRepository } from "./local-profile-repository.ts";
import { readRemoteProfile } from "./remote-profile-reader.ts";
import { generateClashVergeScript } from "../src/generator.ts";
import type { Language } from "../src/types.ts";

const terminalIo = createReadlineCliIO();
let selectedLanguage: Language | null = null;
const io: CliIO = {
  ...terminalIo,
  setLanguage(language) {
    selectedLanguage = language;
    terminalIo.setLanguage(language);
  },
};

try {
  await runCliWorkflow({
    io,
    profiles: createLocalProfileRepository(),
    inspectRemote: readRemoteProfile,
    generate: generateClashVergeScript,
    copyScript: copyTextToClipboard,
    createChildId: randomUUID,
  });
} catch (error) {
  if (!(error instanceof UserCancelledError)) {
    io.writeLine(selectedLanguage
      ? getCliMessages(selectedLanguage).internalError
      : "发生内部错误。 / An internal error occurred.");
    process.exitCode = 1;
  }
} finally {
  io.close();
}

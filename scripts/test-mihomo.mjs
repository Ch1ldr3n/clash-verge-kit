import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import vm from "node:vm";
import { stringify } from "yaml";
import { createRemovedChildSubscription, generateClashVergeScript } from "../src/generator.ts";

const isWindows = process.platform === "win32";
const defaultBinary = isWindows ? "D:\\Clash Verge\\verge-mihomo.exe" : "mihomo";
const binary = process.env.MIHOMO_BIN || defaultBinary;
const expectedVersion = process.env.MIHOMO_EXPECTED_VERSION || "v1.19.29";
const temporaryRoot = await mkdtemp(join(tmpdir(), "clash-verge-kit-"));

function executeGeneratedScript(script, config) {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${script}\nthis.__main = main;`, sandbox);
  return sandbox.__main(config, "Mihomo fixture");
}

async function validateMihomoConfig(config, label) {
  const configPath = join(temporaryRoot, `${label}.yaml`);
  await writeFile(configPath, stringify(config), "utf8");
  const result = spawnSync(resolve(binary), ["-d", temporaryRoot, "-t", "-f", configPath], {
    cwd: temporaryRoot,
    encoding: "utf8",
    timeout: 30000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label}: ${result.stdout}\n${result.stderr}`.trim());
  }
}

try {
  const version = spawnSync(binary, ["-v"], { encoding: "utf8" });
  if (version.error) throw version.error;
  const versionText = `${version.stdout}\n${version.stderr}`;
  if (!versionText.includes(expectedVersion)) {
    throw new Error(`Expected Mihomo ${expectedVersion}, received: ${versionText.trim()}`);
  }

  const children = [
    { id: "fixture", groupName: "Nested", mode: "file", source: "./profiles/secondary.yaml" },
    { id: "fixture-two", groupName: "Nested Two", mode: "file", source: "./profiles/secondary-two.yaml" },
  ];
  const spec = {
    targetProfile: {
      name: "Mihomo fixture",
      source: "https://main.example.test/subscription",
    },
    parentGroupMode: "manual",
    parentGroupName: "PROXY",
    children,
    ai: { enabled: true, mode: "create", groupName: "AI", customDomains: ["openai.com"] },
  };
  const generated = generateClashVergeScript(spec);
  if (!generated.valid) throw new Error("Fixture generation failed.");

  const config = executeGeneratedScript(generated.fullScript, {
    "mixed-port": 7890,
    "allow-lan": false,
    mode: "rule",
    proxies: [
      {
        name: "Primary",
        type: "ss",
        server: "127.0.0.1",
        port: 8388,
        cipher: "aes-128-gcm",
        password: "fixture-only",
      },
    ],
    "proxy-groups": [{ name: "PROXY", type: "select", proxies: ["Primary"] }],
    rules: ["MATCH,PROXY"],
  });
  const nestedProvider = Object.values(config["proxy-providers"] || {})[0];
  if (nestedProvider?.override?.["additional-prefix"]) {
    throw new Error("Explicit parent groups must preserve the original nested node names.");
  }

  await mkdir(join(temporaryRoot, "profiles"), { recursive: true });
  await writeFile(
    join(temporaryRoot, "profiles", "secondary.yaml"),
    stringify({
      proxies: [
        {
          name: "Secondary",
          type: "ss",
          server: "127.0.0.2",
          port: 8388,
          cipher: "aes-128-gcm",
          password: "fixture-only",
        },
      ],
    }),
    "utf8",
  );
  await writeFile(
    join(temporaryRoot, "profiles", "secondary-two.yaml"),
    stringify({
      proxies: [
        {
          name: "Secondary Two",
          type: "ss",
          server: "127.0.0.3",
          port: 8388,
          cipher: "aes-128-gcm",
          password: "fixture-only",
        },
      ],
    }),
    "utf8",
  );

  await validateMihomoConfig(config, "applied");

  const removedSecond = createRemovedChildSubscription(children[1]);
  const update = generateClashVergeScript({
    ...spec,
    children: [children[0]],
    removedChildren: [removedSecond],
  });
  if (!update.valid) throw new Error("Update fixture generation failed.");
  const updatedConfig = executeGeneratedScript(update.fullScript, config);
  await validateMihomoConfig(updatedConfig, "updated");

  const restore = generateClashVergeScript({
    ...spec,
    children: [],
    removedChildren: [removedSecond, createRemovedChildSubscription(children[0])],
  });
  if (!restore.valid) throw new Error("Restore fixture generation failed.");
  const restoredConfig = executeGeneratedScript(restore.fullScript, updatedConfig);
  await validateMihomoConfig(restoredConfig, "restored");

  process.stdout.write(`Mihomo ${expectedVersion} apply, update, and restore tests passed.\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

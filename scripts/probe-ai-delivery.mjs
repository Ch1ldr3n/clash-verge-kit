// Isolated acceptance probe. Never opens the user's profiles or active controller.
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import vm from "node:vm";
import { stringify } from "yaml";
import { generateClashVergeScript } from "../src/generator.ts";

const binary = process.env.MIHOMO_BIN || "D:\\Clash Verge\\verge-mihomo.exe";
const version = spawnSync(binary, ["-v"], { encoding: "utf8", windowsHide: true });
assert.equal(version.status, 0, "installed test kernel unavailable");
console.log(version.stdout.trim());
const root = await mkdtemp(join(tmpdir(), "kit-ai-delivery-"));
const servers = [], sockets = new Set();
let kernel, logs = "", remoteText = "+.ai.fixture.test\n", remoteStatus = 200, hits = 0;
async function server(handler) {
  const instance = http.createServer(handler);
  instance.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  instance.listen(0, "127.0.0.1");
  servers.push(instance);
  await once(instance, "listening");
  return instance;
}
async function freePort() {
  const instance = await server();
  const port = instance.address().port;
  await new Promise(done => instance.close(done));
  return port;
}
async function fakeProxy(label) {
  const instance = await server((_req, res) => res.end(label));
  instance.on("connect", (_req, socket) => {
    socket.on("error", () => {});
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    socket.once("data", () => socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${label.length}\r\nConnection: close\r\n\r\n${label}`));
  });
  return { name: label, type: "http", server: "127.0.0.1", port: instance.address().port };
}
function apply(script, input) {
  return structuredClone(vm.runInNewContext(`${script}\nmain(input, "Synthetic target")`, { input }, { timeout: 2000 }));
}
try {
  const nodes = await Promise.all([fakeProxy("AI-EXIT"), fakeProxy("ORIGINAL-A"), fakeProxy("ORIGINAL-B")]);
  const remote = await server((req, res) => {
    hits++;
    res.statusCode = remoteStatus;
    res.end(remoteStatus === 200 ? (req.url === "/openai" ? remoteText : "+.unused.fixture.test\n") : "synthetic failure");
  });
  const proxyPort = await freePort(), controllerPort = await freePort();
  const baseline = (exit) => ({
    port: proxyPort, "bind-address": "127.0.0.1", "allow-lan": false,
    "external-controller": `127.0.0.1:${controllerPort}`, secret: "isolated-test-only",
    mode: "rule", "log-level": "warning", ipv6: false,
    dns: { enable: false }, tun: { enable: false }, profile: { "store-selected": false },
    proxies: nodes, "proxy-groups": [{ name: "AI outlet", type: "select", proxies: ["AI-EXIT"] }],
    rules: [`DOMAIN-SUFFIX,ai.fixture.test,${exit}`, `MATCH,${exit}`],
  });
  const generated = generateClashVergeScript({
    targetProfile: { name: "Synthetic target", source: "https://synthetic.example.test/sub" },
    parentGroupMode: "auto", parentGroupName: "", children: [],
    ai: { enabled: true, mode: "existing", groupName: "AI outlet", customDomains: [], ruleSource: "services-v1" },
  });
  assert.ok(generated.valid);
  // Restore a previous script in this temporary directory, never the live file.
  const previousScript = "function main(config) { return config; }";
  const scriptPath = join(root, "synthetic-script.js");
  await writeFile(scriptPath, previousScript);
  const scriptBackup = await readFile(scriptPath, "utf8");
  await writeFile(scriptPath, generated.fullScript);
  const originalPath = join(root, "synthetic-subscription.yaml");
  const originalText = stringify(baseline("ORIGINAL-A"));
  await writeFile(originalPath, originalText);
  const configPath = join(root, "runtime.yaml");
  function localize(config) {
    // Keep emitted rule format and routing; replace only remote URLs/cache for isolation.
    for (const [key, provider] of Object.entries(config["rule-providers"] ?? {})) {
      assert.ok(key.startsWith("clash_verge_kit_ai_"));
      const name = key.slice("clash_verge_kit_ai_".length);
      provider.url = `http://127.0.0.1:${remote.address().port}/${name}`;
      provider.path = `./${name}.list`;
      provider.proxy = "DIRECT"; // Loopback test download only; not a product default.
    }
    return config;
  }
  const firstInput = baseline("ORIGINAL-A"), untouched = structuredClone(firstInput);
  const first = apply(generated.fullScript, firstInput);
  assert.deepEqual(firstInput, untouched);
  assert.deepEqual(first.rules.slice(3), untouched.rules);
  assert.deepEqual(first["proxy-groups"], untouched["proxy-groups"]);
  assert.deepEqual(apply(generated.fullScript, first), first);
  assert.equal(await readFile(originalPath, "utf8"), originalText);
  await writeFile(configPath, stringify(localize(first)));
  kernel = spawn(binary, ["-d", root, "-f", configPath], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  kernel.stdout.on("data", chunk => { logs += chunk; });
  kernel.stderr.on("data", chunk => { logs += chunk; });
  kernel.on("error", error => { logs += error.message; });
  async function api(route, method = "GET", body) {
    const response = await fetch(`http://127.0.0.1:${controllerPort}${route}`, {
      method, headers: { Authorization: "Bearer isolated-test-only", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(4000),
    });
    return response;
  }
  async function until(check) {
    for (let attempt = 0; attempt < 60; attempt++) {
      try { return await check(); } catch (error) { if (attempt === 59) throw error; }
      await delay(100);
    }
  }
  async function request(domain) {
    return new Promise((done, reject) => {
      const req = http.get({ hostname: "127.0.0.1", port: proxyPort, path: `http://${domain}/probe`, headers: { Host: domain }, agent: false }, res => {
        let body = ""; res.on("data", data => { body += data; }); res.on("end", () => done(body));
      });
      req.setTimeout(3000, () => req.destroy(Error("request timeout")));
      req.on("error", reject);
    });
  }
  await until(async () => assert.ok((await api("/version")).ok));
  await until(async () => assert.equal(await request("ai.fixture.test"), "AI-EXIT"));
  assert.equal(await request("ordinary.fixture.test"), "ORIGINAL-A");
  assert.equal(await request("new.fixture.test"), "ORIGINAL-A");
  console.log("PASS AI takes priority; ordinary traffic keeps original outlet; source file unchanged");
  remoteText += "+.new.fixture.test\n";
  assert.ok((await api("/providers/rules/clash_verge_kit_ai_openai", "PUT")).ok);
  await until(async () => assert.equal(await request("new.fixture.test"), "AI-EXIT"));
  console.log("PASS remote rule refresh changes routing without regenerating the script");
  const hitsBeforeFailure = hits;
  remoteStatus = 503;
  assert.equal((await api("/providers/rules/clash_verge_kit_ai_openai", "PUT")).ok, false);
  assert.ok(hits > hitsBeforeFailure);
  assert.equal(await request("new.fixture.test"), "AI-EXIT");
  console.log("PASS failed rule refresh retains the last loaded rules");
  remoteStatus = 200;
  const refreshed = baseline("ORIGINAL-B");
  await writeFile(originalPath, stringify(refreshed)); // Simulated subscription refresh.
  await writeFile(configPath, stringify(localize(apply(await readFile(scriptPath, "utf8"), refreshed))));
  assert.ok((await api("/configs?force=true", "PUT", { path: configPath })).ok);
  await until(async () => assert.equal(await request("ordinary.fixture.test"), "ORIGINAL-B"));
  assert.equal(await request("ai.fixture.test"), "AI-EXIT");
  console.log("PASS refreshed subscription rules take effect while AI routing remains active");
  await writeFile(scriptPath, scriptBackup);
  const restored = apply(await readFile(scriptPath, "utf8"), baseline("ORIGINAL-B"));
  assert.deepEqual(restored, baseline("ORIGINAL-B"));
  await writeFile(configPath, stringify(restored));
  assert.ok((await api("/configs?force=true", "PUT", { path: configPath })).ok);
  await until(async () => assert.equal(await request("ai.fixture.test"), "ORIGINAL-B"));
  assert.equal(await request("ordinary.fixture.test"), "ORIGINAL-B");
  assert.equal(await readFile(scriptPath, "utf8"), previousScript);
  console.log("PASS restoring the previous script restores current subscription routing, not an old snapshot");
} catch (error) {
  console.error(logs.slice(-2000));
  throw error;
} finally {
  if (kernel && kernel.exitCode === null) {
    const exited = once(kernel, "exit"); kernel.kill(); await exited;
  }
  for (const socket of sockets) socket.destroy();
  await Promise.all(servers.filter(instance => instance.listening).map(instance => new Promise(done => instance.close(done))));
  const absolute = resolve(root);
  assert.ok(absolute.startsWith(resolve(tmpdir()) + sep) && absolute.includes("kit-ai-delivery-"));
  await rm(absolute, { recursive: true, force: true });
}

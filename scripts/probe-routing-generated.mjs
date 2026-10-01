import { createProbeRuntime } from "./probe-runtime.mjs";
// Real TCP acceptance for production-generated routing. All traffic is loopback.
import assert from "node:assert/strict";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import vm from "node:vm";
import { stringify } from "yaml";
import { generateClashVergeScript } from "../src/generator.ts";
import { supportsSelectedRouting } from "./mihomo-capability.ts";

const binary = process.env.MIHOMO_BIN || "D:\\Clash Verge\\verge-mihomo.exe";
const version = spawnSync(binary, ["-v"], { encoding: "utf8", windowsHide: true });
assert.equal(version.status, 0);
const release = version.stdout.match(/v(\d+\.\d+\.\d+)/)?.[1];
assert.ok(supportsSelectedRouting(release ?? null));
console.log(version.stdout.trim());
const probe = await createProbeRuntime("kit-generated-routing-");
const { root, listen, freePort: port } = probe;
let directHits = 0, unselectedHits = 0;
async function upstream(label, count = () => {}) {
  const server = await listen((_req, response) => { count(); response.end(label); });
  server.on("connect", (_request, socket) => {
    count(); socket.on("error", () => {}); socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    socket.once("data", () => socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${label.length}\r\nConnection: close\r\n\r\n${label}`));
  });
  return { name: label, type: "http", server: "127.0.0.1", port: server.address().port };
}
try {
  const trap = await listen((_req, res) => { directHits++; res.end("DIRECT-TRAP"); });
  const [a, b, unselected] = await Promise.all([upstream("SELECTED-A"), upstream("SELECTED-B"), upstream("UNSELECTED", () => unselectedHits++)]);
  a.name = "same[1]"; b.name = "[Existing] chosen+B"; unselected.name = "other";
  let ruleUnavailable = false;
  const ruleSource = await listen((_req, res) => { if (ruleUnavailable) res.statusCode = 503; res.end(ruleUnavailable ? "unavailable" : "+.ai.fixture.test\n"); });
  const proxyPort = await port(), controllerPort = await port();
  const configPath = join(root, "runtime.yaml");
  await mkdir(join(root, "profiles"));
  const childPath = join(root, "profiles", "child.yaml");
  await writeFile(childPath, stringify({ proxies: [b, { ...unselected, name: "same[1]" }] }));
  const spec = {
    targetProfile: { name: "Main", source: "https://main.example.test/synthetic" },
    parentGroupMode: "manual", parentGroupName: "Original", children: [{ id: "nested", groupName: "Nested", mode: "file", source: "./profiles/child.yaml" }],
    removedChildren: [], ai: { enabled: false, mode: "existing", groupName: "AI", customDomains: [] },
    routing: { sources: [{ id: "target", kind: "target" }, { id: "child", kind: "subscription", name: "Child", mode: "file", source: "./profiles/child.yaml" }],
      outlets: [{ id: "outlet", kind: "selected", groupName: "Chosen", nodes: [
        { sourceId: "target", provider: null, name: a.name }, { sourceId: "child", provider: null, name: b.name },
      ] }], modules: [{ id: "ai", kind: "ai", enabled: true, outletId: "outlet", ruleSource: "category-ai-v1", customDomains: [] }] },
  };
  function baseline(proxies = [a, unselected]) {
    return { port: proxyPort, "bind-address": "127.0.0.1", "allow-lan": false,
      "external-controller": `127.0.0.1:${controllerPort}`, secret: "synthetic-only", mode: "rule", "log-level": "warning",
      ipv6: false, dns: { enable: false }, tun: { enable: false }, profile: { "store-selected": false }, proxies,
      "proxy-groups": [{ name: "Original", type: "select", proxies: ["other"] }, { name: "Auto", type: "select", "include-all": true, "exclude-filter": "" }],
      rules: ["DOMAIN-SUFFIX,fixture.test,Original", "MATCH,Original"] };
  }
  function generated(plan, input) {
    const result = generateClashVergeScript(plan);
    assert.ok(result.valid, JSON.stringify(result.diagnostics));
    const output = structuredClone(vm.runInNewContext(`${result.fullScript}\nmain(input, "Main")`, { input }, { timeout: 2000 }));
    for (const provider of Object.values(output["rule-providers"] ?? {})) {
      provider.url = `http://127.0.0.1:${ruleSource.address().port}/rules`; provider.proxy = "DIRECT";
    }
    return output;
  }
  let output = generated(spec, baseline());
  await writeFile(configPath, stringify(output));
  probe.startKernel(binary, configPath);
  async function api(endpoint, method = "GET", value) {
    const response = await fetch(`http://127.0.0.1:${controllerPort}${endpoint}`, { method,
      headers: { Authorization: "Bearer synthetic-only", "Content-Type": "application/json" },
      body: value === undefined ? undefined : JSON.stringify(value), signal: AbortSignal.timeout(3000) });
    assert.ok(response.ok, `${endpoint}: ${response.status}`); return response.status === 204 ? null : response.json();
  }
  async function until(check) { for (let attempt = 0; attempt < 60; attempt++) { try { return await check(); } catch (error) { if (attempt === 59) throw error; } await delay(100); } }
  async function members(expectedCount) { return until(async () => { const group = await api("/proxies/Chosen"); assert.equal(group.all.length, expectedCount); return group.all; }); }
  async function request(host = "ai.fixture.test") {
    return new Promise(done => {
      const req = http.get({ hostname: "127.0.0.1", port: proxyPort, path: `http://${host}:${trap.address().port}/probe`, headers: { Host: host }, agent: false }, res => {
        let body = ""; res.on("data", chunk => { body += chunk; }); res.on("end", () => done(body));
      });
      req.setTimeout(2000, () => req.destroy(Error("timeout"))); req.on("error", () => done("BLOCKED"));
    });
  }
  async function blocked(label) {
    const before = [directHits, unselectedHits]; const response = await request();
    assert.ok(response === "" || response === "BLOCKED"); assert.deepEqual([directHits, unselectedHits], before); console.log(`PASS ${label}`);
  }
  await until(() => api("/version"));
  const initial = await members(2);
  assert.ok(initial.includes("same[1]")); assert.ok(initial.some(name => name.endsWith(b.name)));
  assert.ok(!initial.includes("REJECT"));
  assert.ok((await api("/proxies/Auto")).all.every(name => !name.startsWith("[Kit:")));
  assert.ok((await api("/proxies/Auto")).all.includes("other"));
  await api("/proxies/Chosen", "PUT", { name: "same[1]" });
  assert.equal(await request(), "SELECTED-A");
  assert.equal(await request("ordinary.fixture.test"), "UNSELECTED");
  console.log("PASS generated exact static selection, AI priority and ordinary routing");
  output = generated(spec, baseline([unselected]));
  await writeFile(configPath, stringify(output)); await api("/configs?force=true", "PUT", { path: configPath });
  await until(async () => assert.equal(await request(), "SELECTED-B"));
  console.log("PASS one source missing retains the other selected source; original prefixes preserved");
  const privateProvider = Object.keys(output["proxy-providers"]).find(key => key.startsWith("clash_verge_kit_nodes_"));
  await writeFile(childPath, stringify({ proxies: [{ ...unselected, name: "same[1]" }] }));
  await api(`/providers/proxies/${privateProvider}`, "PUT");
  await until(async () => assert.deepEqual(await members(1), ["REJECT"]));
  await blocked("generated all-sources-missing blocks without selecting same-name unselected nodes");
  await writeFile(childPath, stringify({ proxies: [b] })); await api(`/providers/proxies/${privateProvider}`, "PUT");
  await until(async () => assert.equal(await request(), "SELECTED-B"));
  await writeFile(childPath, "proxies: []\n");
  const failed = await fetch(`http://127.0.0.1:${controllerPort}/providers/proxies/${privateProvider}`, { method: "PUT", headers: { Authorization: "Bearer synthetic-only" } });
  assert.equal(failed.status, 503); assert.equal(await request(), "SELECTED-B");
  console.log("PASS generated provider failure retains last valid selected candidate");
  await writeFile(childPath, stringify({ proxies: [b] }));
  const disabled = structuredClone(spec); disabled.routing.modules[0].enabled = false;
  const restored = generated(disabled, baseline([unselected]));
  assert.ok(restored["proxy-groups"].some(group => group.name === "Nested"));
  assert.ok(!restored["proxy-groups"].some(group => group.name === "Chosen"));
  await writeFile(configPath, stringify(restored)); await api("/configs?force=true", "PUT", { path: configPath });
  assert.equal(await request(), "UNSELECTED");
  console.log("PASS disabled module restores current airport rules and preserves nested provider");
  let remoteNodes = [a, unselected];
  const remote = await listen((_req, res) => res.end(stringify({ proxies: remoteNodes })));
  const dynamic = structuredClone(spec);
  dynamic.routing.sources = [{ id: "target", kind: "target" }];
  dynamic.routing.outlets[0].nodes = [{ sourceId: "target", provider: "p", name: a.name }];
  const dynamicInput = baseline([unselected]);
  dynamicInput["proxy-providers"] = { p: { type: "http", url: `http://127.0.0.1:${remote.address().port}/nodes`,
    path: "original-target-provider.yaml", proxy: "DIRECT", interval: 3600, override: { "additional-prefix": "Original ", udp: true }, "health-check": { enable: false } } };
  const dynamicOutput = generated(dynamic, dynamicInput);
  assert.deepEqual(dynamicOutput["proxy-providers"].p, dynamicInput["proxy-providers"].p);
  await writeFile(configPath, stringify(dynamicOutput)); await api("/configs?force=true", "PUT", { path: configPath });
  const dynamicMembers = await members(1);
  assert.ok(dynamicMembers[0].startsWith("[Kit:") && dynamicMembers[0].endsWith(a.name));
  assert.equal(await request(), "SELECTED-A");
  assert.ok((await api("/proxies/Auto")).all.every(name => !name.startsWith("[Kit:")));
  console.log("PASS generated target HTTP provider exact identity and original include-all isolation");
  remoteNodes = [unselected];
  const dynamicKey = Object.keys(dynamicOutput["proxy-providers"]).find(key => key.startsWith("clash_verge_kit_nodes_"));
  await api(`/providers/proxies/${dynamicKey}`, "PUT"); await members(1);
  assert.deepEqual((await api("/proxies/Chosen")).all, ["REJECT"]);
  await blocked("generated target HTTP selected node renamed or removed");
  const disconnected = structuredClone(spec);
  disconnected.routing.outlets[0].nodes = [{ sourceId: "target", provider: null, name: a.name }];
  await writeFile(configPath, stringify(generated(disconnected, baseline([{ ...a, port: await port() }, unselected]))));
  await api("/configs?force=true", "PUT", { path: configPath });
  assert.deepEqual(await members(1), [a.name]);
  await blocked("existing selected candidate with connection failure remains a candidate and does not use another outlet");
  const cold = structuredClone(spec); cold.routing.modules[0].id = "cold";
  ruleUnavailable = true;
  await writeFile(configPath, stringify(generated(cold, baseline())));
  const coldResponse = await fetch(`http://127.0.0.1:${controllerPort}/configs?force=true`, { method: "PUT",
    headers: { Authorization: "Bearer synthetic-only", "Content-Type": "application/json" },
    body: JSON.stringify({ path: configPath }), signal: AbortSignal.timeout(15000) });
  const afterCold = await request();
  assert.equal(coldResponse.status, 204);
  const coldProviders = await api("/providers/rules");
  const coldProvider = Object.values(coldProviders.providers).find(provider => provider.name.includes("_cold_"));
  assert.equal(coldProvider.ruleCount, 0);
  assert.equal(afterCold, "UNSELECTED");
  console.log("PASS first rule download failure: configuration accepted (204), rules empty (0), ordinary routing remains active");
} catch (error) { console.error(probe.logs); throw error; }
finally {
  await probe.close();
}

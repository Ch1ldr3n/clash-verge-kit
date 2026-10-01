import { createProbeRuntime } from "./probe-runtime.mjs";
// Synthetic regression probe: two targets with equally named providers/nodes
// must not reuse each other's private provider cache. No active client is used.
import assert from "node:assert/strict";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
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
const probe = await createProbeRuntime("kit-review-cache-");
const { root, listen, freePort } = probe;

async function upstream(label) {
  const server = await listen((_request, response) => response.end(label));
  server.on("connect", (_request, socket) => {
    socket.on("error", () => {});
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    socket.once("data", () => socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${label.length}\r\nConnection: close\r\n\r\n${label}`));
  });
  return { name: "chosen", type: "http", server: "127.0.0.1", port: server.address().port };
}

try {
  const a = await upstream("SOURCE-A"), b = await upstream("SOURCE-B");
  const feed = await listen((request, response) => {
    if (request.url === "/a") response.end(stringify({ proxies: [a] }));
    else if (request.url === "/rules") response.end("+.ai.fixture.test\n");
    else { response.statusCode = 503; response.end("unavailable"); }
  });
  const controllerPort = await freePort(), proxyPort = await freePort();
  const configPath = join(root, "runtime.yaml");
  // Both target subscriptions already have their own valid native cache.
  await writeFile(join(root, "a.yaml"), stringify({ proxies: [a] }));
  await writeFile(join(root, "b.yaml"), stringify({ proxies: [b] }));

  function generated(label) {
    const spec = {
      targetProfile: { name: label, source: `https://${label.toLowerCase()}.example.test/synthetic` },
      parentGroupMode: "auto", parentGroupName: "", children: [], removedChildren: [],
      ai: { enabled: false, mode: "existing", groupName: "AI", customDomains: [] },
      routing: {
        sources: [{ id: "target", kind: "target" }],
        outlets: [{ id: "outlet", kind: "selected", groupName: "Chosen", nodes: [{ sourceId: "target", provider: "pool", name: "chosen" }] }],
        modules: [{ id: "ai", kind: "ai", enabled: true, outletId: "outlet", ruleSource: "category-ai-v1", customDomains: ["ai.fixture.test"] }],
      },
    };
    const result = generateClashVergeScript(spec);
    assert.ok(result.valid, JSON.stringify(result.diagnostics));
    const input = {
      port: proxyPort, "bind-address": "127.0.0.1", "allow-lan": false,
      "external-controller": `127.0.0.1:${controllerPort}`, secret: "synthetic-review",
      mode: "rule", "log-level": "warning", dns: { enable: false }, tun: { enable: false },
      profile: { "store-selected": false },
      "proxy-providers": { pool: {
        type: "http", url: `http://127.0.0.1:${feed.address().port}/${label.toLowerCase()}`,
        path: `./${label.toLowerCase()}.yaml`, interval: 3600, proxy: "DIRECT",
      } },
      "proxy-groups": [
        { name: "Original", type: "select", proxies: ["REJECT"] },
        { name: "Native", type: "select", use: ["pool"] },
      ],
      rules: ["DOMAIN,native.fixture.test,Native", "MATCH,Original"],
    };
    const output = structuredClone(vm.runInNewContext(`${result.fullScript}\nmain(input, ${JSON.stringify(label)})`, { input }, { timeout: 2000 }));
    // Keep rule downloads inside this probe; private node providers are unchanged.
    for (const provider of Object.values(output["rule-providers"])) {
      provider.url = `http://127.0.0.1:${feed.address().port}/rules`;
      provider.proxy = "DIRECT";
    }
    return output;
  }

  const first = generated("A"), second = generated("B");
  const privateKey = output => Object.keys(output["proxy-providers"]).find(key => key.startsWith("clash_verge_kit_nodes_"));
  const firstKey = privateKey(first), secondKey = privateKey(second);
  assert.ok(firstKey && secondKey);
  assert.notEqual(first["proxy-providers"][firstKey].path, second["proxy-providers"][secondKey].path,
    "Different target subscriptions must not share a private provider cache path");
  async function api(endpoint, method = "GET", value) {
    const response = await fetch(`http://127.0.0.1:${controllerPort}${endpoint}`, {
      method, headers: { Authorization: "Bearer synthetic-review", "Content-Type": "application/json" },
      body: value === undefined ? undefined : JSON.stringify(value), signal: AbortSignal.timeout(2500),
    });
    assert.ok(response.ok, `${endpoint}: ${response.status}`);
    return response.status === 204 ? null : response.json();
  }
  async function until(check) {
    let last;
    for (let attempt = 0; attempt < 50; attempt++) {
      try { return await check(); } catch (error) { last = error; }
      await delay(100);
    }
    throw last;
  }
  async function request(host = "ai.fixture.test") {
    return new Promise(resolve => {
      const req = http.get({ hostname: "127.0.0.1", port: proxyPort,
        path: `http://${host}/probe`, headers: { Host: host }, agent: false }, response => {
        let body = "";
        response.on("data", chunk => { body += chunk; });
        response.on("end", () => resolve(body));
      });
      req.setTimeout(2000, () => req.destroy(new Error("timeout")));
      req.on("error", () => resolve("BLOCKED"));
    });
  }

  await writeFile(configPath, stringify(first));
  probe.startKernel(binary, configPath);
  await until(() => api("/version"));
  await until(async () => assert.equal(await request(), "SOURCE-A"));

  await writeFile(configPath, stringify(second));
  await api("/configs?force=true", "PUT", { path: configPath });
  await delay(500);
  const nativeObserved = await request("native.fixture.test");
  assert.equal(nativeObserved, "SOURCE-B", "Reload must actually activate B's native provider");
  const observed = await request();
  const native = await api("/providers/proxies/pool");
  const privateProvider = await api(`/providers/proxies/${secondKey}`);
  assert.equal(privateProvider.proxies.length, 0,
    "B's failed first load must not borrow A's cached selected node");
  console.log(JSON.stringify({ kernel: release,
    pathsCollide: first["proxy-providers"][firstKey].path === second["proxy-providers"][secondKey].path,
    urlsDiffer: first["proxy-providers"][firstKey].url !== second["proxy-providers"][secondKey].url,
    reloadAccepted: true, secondTarget: "B", nativeObservedBody: nativeObserved, nativePoolNames: native.proxies.map(node => node.name),
    privatePoolNames: privateProvider.proxies.map(node => node.name), observedBody: observed,
    expectedOrigin: "SOURCE-B or rejection; never SOURCE-A",
  }, null, 2));
  assert.notEqual(observed, "SOURCE-A", "Target B must never route through target A's cached selected node");
  assert.ok(["SOURCE-B", "", "BLOCKED"].includes(observed));
} catch (error) {
  console.error(error.message);
  // All providers and traffic are synthetic; never print generated configuration.
  console.error(probe.logs.slice(-2000));
  process.exitCode = 1;
} finally {
  await probe.close();
}

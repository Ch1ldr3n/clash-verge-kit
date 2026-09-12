// Isolated research probe, not a product generator or a client controller.
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { stringify } from "yaml";

const binary = process.env.MIHOMO_BIN || "D:\\Clash Verge\\verge-mihomo.exe";
const version = spawnSync(binary, ["-v"], { encoding: "utf8", windowsHide: true });
if (version.error || version.status !== 0) throw version.error || Error(version.stderr);
console.log(version.stdout.trim());
const root = await mkdtemp(join(tmpdir(), "kit-routing-probe-"));
const servers = [];
const sockets = new Set();
let child;
let logs = "";
let directHits = 0;
async function listen(handler) {
  const server = http.createServer(handler);
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server;
}
async function freePort() {
  const server = await listen();
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
const proxy = (name, port) => ({ name, type: "http", server: "127.0.0.1", port });
try {
  const origin = await listen((_req, res) => { directHits++; res.end("DIRECT-TRAP"); });
  const upstreamA = await listen((_req, res) => res.end("SOURCE-A"));
  const upstreamB = await listen((_req, res) => res.end("SOURCE-B"));
  for (const [server, body] of [[upstreamA, "SOURCE-A"], [upstreamB, "SOURCE-B"]]) {
    server.on("connect", (_req, socket) => {
      socket.on("error", () => {});
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      socket.once("data", () => socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`));
    });
  }
  const mixed = await freePort();
  const controller = await freePort();
  const nodesA = [proxy("same[1]", upstreamA.address().port), proxy("other", upstreamA.address().port)];
  const nodesB = [proxy("same[1]", upstreamB.address().port), proxy("chosen+B", upstreamB.address().port)];
  let remoteStatus = 200;
  let remoteInvalid = false;
  let remoteTimeout = false;
  let remoteNodes = nodesA;
  let remoteHits = 0;
  let unavailableHits = 0;
  const remote = await listen((req, res) => {
    if (req.url === "/unavailable") unavailableHits++;
    else remoteHits++;
    if (remoteTimeout && req.url !== "/unavailable") return;
    res.statusCode = req.url === "/unavailable" ? 503 : remoteStatus;
    res.end(res.statusCode === 200 ? (remoteInvalid ? "proxies: [invalid" : stringify({ proxies: remoteNodes })) : "synthetic unavailable");
  });
  const remoteUrl = `http://127.0.0.1:${remote.address().port}`;
  async function provider(name, proxies) { await writeFile(join(root, `${name}.yaml`), stringify({ proxies })); }
  await provider("a", nodesA);
  await provider("b", nodesB);
  await provider("filtered", nodesA);
  const config = {
    port: mixed, "bind-address": "127.0.0.1", "allow-lan": false,
    "external-controller": `127.0.0.1:${controller}`, secret: "synthetic-probe-only",
    mode: "rule", "log-level": "warning", ipv6: false,
    dns: { enable: false }, tun: { enable: false }, profile: { "store-selected": false },
    proxies: [proxy("static+A", upstreamA.address().port)],
    "proxy-providers": {
      a: { type: "file", path: "a.yaml", override: { "additional-prefix": "A::" }, "health-check": { enable: false } },
      b: { type: "file", path: "b.yaml", override: { "additional-prefix": "B::" }, "health-check": { enable: false } },
      filtered: { type: "file", path: "filtered.yaml", filter: "^same\\[1\\]$", "health-check": { enable: false } },
      remote: { type: "http", url: `${remoteUrl}/nodes`, path: "remote.yaml", proxy: "DIRECT", interval: 1, "health-check": { enable: false } },
      unavailable: { type: "http", url: `${remoteUrl}/unavailable`, path: "unavailable.yaml", proxy: "DIRECT", interval: 3600, "health-check": { enable: false } },
    },
    "proxy-groups": [
      { name: "dynamic", type: "select", use: ["a", "b"], filter: "^(A::same\\[1\\]|B::chosen\\+B)$", "empty-fallback": "REJECT" },
      { name: "static", type: "select", "include-all-proxies": true, filter: "^static\\+A$", "empty-fallback": "REJECT" },
      { name: "static-empty", type: "select", "include-all-proxies": true, filter: "^missing$", "empty-fallback": "REJECT" },
      { name: "control-empty", type: "select", "include-all-proxies": true, filter: "^missing$" },
      { name: "provider-filter-control", type: "select", use: ["filtered"], "empty-fallback": "REJECT" },
      { name: "remote-selected", type: "select", use: ["remote"], filter: "^same\\[1\\]$", "empty-fallback": "REJECT" },
      { name: "remote-unavailable", type: "select", use: ["unavailable"], filter: "^same\\[1\\]$", "empty-fallback": "REJECT" },
      { name: "entry", type: "select", proxies: ["dynamic", "static", "static-empty", "control-empty", "remote-selected", "remote-unavailable"] },
    ],
    rules: ["MATCH,entry"],
  };
  const configPath = join(root, "config.yaml");
  await writeFile(configPath, stringify(config));
  child = spawn(binary, ["-d", root, "-f", configPath], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", chunk => { logs += chunk; });
  child.stderr.on("data", chunk => { logs += chunk; });
  child.on("error", error => { logs += error.message; });
  async function api(path, method = "GET", body) {
    const response = await fetch(`http://127.0.0.1:${controller}${path}`, {
      method, headers: { Authorization: "Bearer synthetic-probe-only", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(2000),
    });
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${await response.clone().text()}`);
    return response.status === 204 ? undefined : response.json();
  }
  async function until(check) {
    for (let i = 0; i < 50; i++) {
      try { return await check(); } catch (error) { if (i === 49) throw error; }
      await delay(100);
    }
  }
  await until(() => api("/version"));
  async function members(name, expected) {
    await until(async () => assert.deepEqual((await api(`/proxies/${name}`)).all, expected));
  }
  async function select(name) { await api("/proxies/entry", "PUT", { name }); }
  async function request() {
    return new Promise(resolve => {
      const req = http.get({ hostname: "127.0.0.1", port: mixed,
        headers: { Host: `127.0.0.1:${origin.address().port}` },
        path: `http://127.0.0.1:${origin.address().port}/probe`, agent: false,
      }, res => { let body = ""; res.on("data", c => { body += c; }); res.on("end", () => resolve(body)); });
      req.setTimeout(1500, () => req.destroy(Error("timeout")));
      req.on("error", () => resolve("BLOCKED"));
    });
  }
  async function blocked(label) {
    const before = directHits;
    const result = await request();
    assert.notEqual(result, "SOURCE-A"); assert.notEqual(result, "SOURCE-B");
    assert.notEqual(result, "DIRECT-TRAP"); assert.equal(directHits, before);
    console.log(`PASS ${label}: ${JSON.stringify(result)}`);
  }
  await members("dynamic", ["A::same[1]", "B::chosen+B"]);
  assert.equal(await request(), "SOURCE-A");
  console.log("PASS source-scoped exact filters and initial dynamic connection");
  await provider("a", [nodesA[1]]);
  await api("/providers/proxies/a", "PUT");
  await members("dynamic", ["B::chosen+B"]);
  assert.equal(await request(), "SOURCE-B");
  console.log("PASS one source empty leaves other selected source usable; same-name unselected B excluded");
  await provider("b", [nodesB[0]]);
  await api("/providers/proxies/b", "PUT");
  await members("dynamic", ["REJECT"]);
  await blocked("dynamic all selected nodes absent");
  await select("static");
  await members("static", ["static+A"]);
  assert.equal(await request(), "SOURCE-A");
  console.log("PASS static selected candidate connection");
  await select("static-empty");
  await members("static-empty", ["REJECT"]);
  await blocked("static no matching selected node");
  await select("control-empty");
  await members("control-empty", ["COMPATIBLE"]);
  assert.equal(await request(), "DIRECT-TRAP");
  assert.equal(directHits, 1);
  console.log("PASS negative control: omitted empty-fallback reaches direct trap");
  await provider("b", nodesB);
  await api("/providers/proxies/b", "PUT");
  await members("dynamic", ["B::chosen+B"]);
  await provider("b", []);
  const emptyUpdate = await fetch(`http://127.0.0.1:${controller}/providers/proxies/b`, {
    method: "PUT", headers: { Authorization: "Bearer synthetic-probe-only" }, signal: AbortSignal.timeout(2000),
  });
  assert.equal(emptyUpdate.status, 503);
  console.log(`OBSERVED empty raw provider rejected: ${await emptyUpdate.text()}`);
  await members("dynamic", ["B::chosen+B"]);
  await select("dynamic");
  assert.equal(await request(), "SOURCE-B");
  console.log("OBSERVED rejected empty provider update retains previous selected candidate; not an empty-group event");
  await provider("filtered", [nodesA[1]]);
  const filteredUpdate = await fetch(`http://127.0.0.1:${controller}/providers/proxies/filtered`, {
    method: "PUT", headers: { Authorization: "Bearer synthetic-probe-only" }, signal: AbortSignal.timeout(2000),
  });
  assert.equal(filteredUpdate.status, 503);
  console.log(`OBSERVED provider-level zero-match update rejected: ${await filteredUpdate.text()}`);
  await members("provider-filter-control", ["same[1]"]);
  console.log("OBSERVED provider-level filter retains stale selected node despite empty-fallback REJECT");
  await members("remote-selected", ["same[1]"]);
  await select("remote-selected");
  assert.equal(await request(), "SOURCE-A");
  const hitsBeforeFailure = remoteHits;
  remoteStatus = 503;
  const remoteFailure = await fetch(`http://127.0.0.1:${controller}/providers/proxies/remote`, {
    method: "PUT", headers: { Authorization: "Bearer synthetic-probe-only" }, signal: AbortSignal.timeout(5000),
  });
  assert.equal(remoteFailure.status, 503);
  assert.ok(remoteHits > hitsBeforeFailure, "HTTP update must reach the synthetic source");
  await members("remote-selected", ["same[1]"]);
  assert.equal(await request(), "SOURCE-A");
  console.log("PASS HTTP update failure retains usable last selected candidate");
  remoteStatus = 200;
  remoteNodes = [nodesA[1]];
  await api("/providers/proxies/remote", "PUT");
  await members("remote-selected", ["REJECT"]);
  await blocked("HTTP successful update removes all selected candidates");
  await until(() => assert.ok(unavailableHits > 0, "First-load failure must reach the unavailable HTTP source"));
  await members("remote-unavailable", ["REJECT"]);
  await select("remote-unavailable");
  await blocked("HTTP first load failure without cached selected candidates");
  remoteNodes = nodesA;
  await members("remote-selected", ["same[1]"]);
  await select("remote-selected");
  assert.equal(await request(), "SOURCE-A");
  remoteNodes = [nodesA[1]];
  await members("remote-selected", ["REJECT"]);
  await blocked("scheduled HTTP refresh removes selected candidates");
  remoteNodes = nodesA;
  await api("/providers/proxies/remote", "PUT");
  await members("remote-selected", ["same[1]"]);
  remoteInvalid = true;
  const invalidUpdate = await fetch(`http://127.0.0.1:${controller}/providers/proxies/remote`, {
    method: "PUT", headers: { Authorization: "Bearer synthetic-probe-only" }, signal: AbortSignal.timeout(5000),
  });
  assert.equal(invalidUpdate.status, 503);
  await members("remote-selected", ["same[1]"]);
  assert.equal(await request(), "SOURCE-A");
  console.log("PASS invalid HTTP 200 data retains last selected candidates");
  remoteInvalid = false;
  remoteTimeout = true;
  await delay(1500);
  await members("remote-selected", ["same[1]"]);
  assert.equal(await request(), "SOURCE-A");
  console.log("PASS pending HTTP refresh does not invent an empty group");
  const timedOutUpdate = await fetch(`http://127.0.0.1:${controller}/providers/proxies/remote`, {
    method: "PUT", headers: { Authorization: "Bearer synthetic-probe-only" }, signal: AbortSignal.timeout(45000),
  });
  assert.equal(timedOutUpdate.status, 503);
  await members("remote-selected", ["same[1]"]);
  assert.equal(await request(), "SOURCE-A");
  console.log("PASS completed HTTP timeout retains last selected candidates");
  remoteTimeout = false;
  remoteStatus = 503;
  const exited = once(child, "exit");
  child.kill();
  await exited;
  child = spawn(binary, ["-d", root, "-f", configPath], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", chunk => { logs += chunk; });
  child.stderr.on("data", chunk => { logs += chunk; });
  child.on("error", error => { logs += error.message; });
  await until(() => api("/version"));
  await members("remote-selected", ["same[1]"]);
  await select("remote-selected");
  assert.equal(await request(), "SOURCE-A");
  console.log("PASS restart with failed source retains disk-cached selected candidates");
  const failedReload = await fetch(`http://127.0.0.1:${controller}/configs?force=true`, {
    method: "PUT", headers: { Authorization: "Bearer synthetic-probe-only", "Content-Type": "application/json" },
    body: JSON.stringify({ payload: stringify({ ...config, "proxy-groups": [{ name: "bad", type: "select", proxies: ["missing-node"] }] }) }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(failedReload.status, 400);
  assert.equal(await request(), "SOURCE-A");
  console.log("PASS failed config application retains previous running configuration (not proof of blocking)");
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  async function bounded(promise) {
    let timer;
    try {
      await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error("Probe cleanup exceeded 5 seconds; temporary files retained")), 5000);
      })]);
    } finally { clearTimeout(timer); }
  }
  for (const socket of sockets) socket.destroy();
  try {
    await bounded(Promise.all(servers.map(server => new Promise(resolve => server.close(resolve)))));
  } finally {
    // Always stop our kernel, even if closing a test server timed out.
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await bounded(exited);
    }
  }
  const absolute = resolve(root);
  assert.ok(absolute.startsWith(resolve(tmpdir()) + sep) && absolute.includes("kit-routing-probe-"));
  await bounded(rm(absolute, { recursive: true, force: true }));
}

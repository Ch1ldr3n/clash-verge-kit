// Shared lifecycle for synthetic, loopback-only probes. Never discovers live profiles.
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error("Probe cleanup timed out; temporary files retained")), 5000);
    })]);
  } finally { clearTimeout(timer); }
}

export async function createProbeRuntime(prefix) {
  assert.match(prefix, /^kit-[a-z-]+-$/);
  const root = await mkdtemp(join(tmpdir(), prefix));
  const servers = [], kernels = [], sockets = new Set();
  let logs = "";
  async function listen(handler) {
    const server = http.createServer(handler);
    servers.push(server);
    server.on("connection", socket => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return server;
  }
  return {
    root, listen,
    get logs() { return logs; },
    async freePort() {
      const server = await listen();
      const port = server.address().port;
      await new Promise(done => server.close(done));
      return port;
    },
    startKernel(binary, configPath, cwd = process.cwd()) {
      assert.equal(dirname(resolve(configPath)), resolve(root));
      const kernel = spawn(binary, ["-d", root, "-f", configPath], {
        cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      });
      kernels.push(kernel);
      const capture = chunk => { logs = (logs + chunk).slice(-16000); };
      kernel.stdout.on("data", capture);
      kernel.stderr.on("data", capture);
      kernel.on("error", error => capture(error.message));
      return kernel;
    },
    async close() {
      // Try every cleanup even if another fails; never remove a live kernel's files.
      const cleanup = await Promise.allSettled([
        ...kernels.map(async kernel => {
          if (kernel.pid && kernel.exitCode === null && kernel.signalCode === null) {
            const exited = once(kernel, "exit");
            kernel.kill();
            await bounded(exited);
          }
        }),
        ...servers.map(async server => {
          for (const socket of sockets) socket.destroy();
          if (server.listening) await bounded(new Promise(done => server.close(done)));
        }),
      ]);
      const failed = cleanup.find(result => result.status === "rejected");
      if (failed) throw failed.reason;
      const absolute = resolve(root);
      assert.equal(dirname(absolute), resolve(tmpdir()));
      assert.ok(basename(absolute).startsWith(prefix));
      await bounded(rm(absolute, { recursive: true, force: true }));
    },
  };
}

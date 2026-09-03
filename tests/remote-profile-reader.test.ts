import { createServer } from "node:http";
import { PassThrough } from "node:stream";
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import {
  downloadProfileThroughHttpProxy,
  extractRemoteProfileMetadata,
  finishProfileResponse,
  getRemoteInspectionErrorCode,
  parseClashProxyConfig,
  readRemoteProfile,
  selectClashFakeIp,
  isPublicNetworkAddress,
  selectPublicNetworkAddress,
  shouldRetryThroughClashProxy,
} from "../scripts/remote-profile-reader";

describe("remote subscription inspection", () => {
  const mainProfile = `
proxy-groups:
  - name: 机场主组
    type: select
  - name: AI平台
    type: select
rules:
  - MATCH,机场主组
`;

  it("uses profile-title and extracts selectable proxy groups", () => {
    expect(extractRemoteProfileMetadata(mainProfile, {
      "profile-title": encodeURIComponent("赔钱机场"),
    })).toEqual({
      name: "赔钱机场",
      nameSource: "profile-title",
      selectGroups: ["机场主组", "AI平台"],
      suggestedGroup: null,
    });
  });

  it("uses the YAML profile name from the shared inspection", () => {
    expect(extractRemoteProfileMetadata(`
name: Example.yaml
proxy-groups:
  - name: MAIN
    type: select
`)).toEqual({
      name: "Example",
      nameSource: "yaml",
      selectGroups: ["MAIN"],
      suggestedGroup: "MAIN",
    });
  });

  it("rejects terminal control sequences from remote profile titles", () => {
    expect(extractRemoteProfileMetadata(mainProfile, {
      "profile-title": encodeURIComponent("unsafe\u001b]52;c;ZmFrZQ==\u0007"),
    })).toEqual({
      name: "机场主组",
      nameSource: "group",
      selectGroups: ["机场主组", "AI平台"],
      suggestedGroup: null,
    });
  });

  it("falls back to the terminal proxy group when no profile name is supplied", () => {
    expect(extractRemoteProfileMetadata(mainProfile).name).toBe("机场主组");
    expect(extractRemoteProfileMetadata(mainProfile).nameSource).toBe("group");
  });

  it("keeps the terminal group name fallback when the displayed group list is truncated", () => {
    const groupCount = 257;
    const terminalGroup = `Group ${groupCount}`;
    const proxyGroups = Array.from({ length: groupCount }, (_, index) => [
      `  - name: Group ${index + 1}`,
      "    type: select",
    ]).flat();
    const metadata = extractRemoteProfileMetadata([
      "proxy-groups:",
      ...proxyGroups,
      "rules:",
      `  - MATCH,${terminalGroup}`,
    ].join("\n"));

    expect(metadata.selectGroups).toHaveLength(256);
    expect(metadata.name).toBe(terminalGroup);
    expect(metadata.nameSource).toBe("group");
  });

  it("blocks loopback, private, documentation, and IPv4-mapped addresses", () => {
    expect(isPublicNetworkAddress("127.0.0.1")).toBe(false);
    expect(isPublicNetworkAddress("10.0.0.8")).toBe(false);
    expect(isPublicNetworkAddress("203.0.113.7")).toBe(false);
    expect(isPublicNetworkAddress("::1")).toBe(false);
    expect(isPublicNetworkAddress("::ffff:127.0.0.1")).toBe(false);
  });

  it("allows ordinary public IPv4 and IPv6 addresses", () => {
    expect(isPublicNetworkAddress("1.1.1.1")).toBe(true);
    expect(isPublicNetworkAddress("2606:4700:4700::1111")).toBe(true);
  });

  it("ignores Clash Fake-IP answers and pins the request to a public result", () => {
    expect(selectPublicNetworkAddress([
      { address: "198.18.0.241", family: 4 },
      { address: "2606:50c0:8001::154", family: 6 },
    ])).toEqual({ address: "2606:50c0:8001::154", family: 6 });
    expect(selectPublicNetworkAddress([{ address: "192.168.1.2", family: 4 }])).toBeNull();
  });

  it("accepts only an all-Fake-IP system answer for Clash compatibility", () => {
    const fakeAnswer = [{ address: "198.18.0.241", family: 4 }];
    expect(selectClashFakeIp(fakeAnswer)).toEqual({ address: "198.18.0.241", family: 4 });
    expect(selectClashFakeIp([...fakeAnswer, { address: "192.168.1.5", family: 4 }])).toBeNull();
  });

  it("exposes only a safe Fake-IP reachability error to the local API", () => {
    expect(getRemoteInspectionErrorCode(new Error("clash-fake-ip-unreachable")))
      .toBe("clash-fake-ip-unreachable");
    expect(getRemoteInspectionErrorCode(new Error("connect EACCES 198.18.0.1:443")))
      .toBe("subscription-unavailable");
  });

  it("reads the Clash mixed port from a local config without accepting a remote proxy", () => {
    expect(parseClashProxyConfig("mixed-port: 7897\nallow-lan: false\n")).toEqual({
      host: "127.0.0.1",
      port: 7897,
    });
    expect(parseClashProxyConfig("mixed-port: 7897\n")).toEqual({ host: "127.0.0.1", port: 7897 });
    expect(parseClashProxyConfig("mixed-port: 7897\nproxy-server: https://proxy.example.test:443\n"))
      .toEqual({ host: "127.0.0.1", port: 7897 });
    expect(parseClashProxyConfig("mixed-port: 0\n")).toBeNull();
  });

  it("falls back through the local Clash proxy after a direct Fake-IP failure", async () => {
    const requests: Array<number | null> = [];
    const body = `
proxies:
  - name: Example
    type: ss
    server: example.test
    port: 443
    cipher: aes-128-gcm
    password: redacted
proxy-groups:
  - name: MAIN
    type: select
    proxies: [Example]
rules:
  - MATCH,MAIN
`;

    const inspection = await readRemoteProfile("https://subscription.example.test/online", {
      resolveLocalProxy: async () => ({ host: "127.0.0.1", port: 7897 }),
      download: async (_target, _redirectCount, proxy) => {
        requests.push(proxy?.port ?? null);
        if (!proxy) throw new Error("clash-fake-ip-unreachable");
        return { body, headers: { "profile-title": "Remote subscription" } };
      },
    });

    expect(requests).toEqual([null, 7897]);
    expect(inspection.name).toBe("Remote subscription");
    expect(inspection.selectGroups).toEqual(["MAIN"]);
    expect(inspection.nodeCount).toBe(1);
  });

  it("falls back through the local Clash proxy after a Windows EACCES direct failure", async () => {
    const requests: Array<number | null> = [];
    const body = `
proxies:
  - name: Example
    type: ss
    server: example.test
    port: 443
    cipher: aes-128-gcm
    password: redacted
proxy-groups:
  - name: MAIN
    type: select
    proxies: [Example]
rules:
  - MATCH,MAIN
`;

    const inspection = await readRemoteProfile("https://subscription.example.test/online", {
      resolveLocalProxy: async () => ({ host: "127.0.0.1", port: 7897 }),
      download: async (_target, _redirectCount, proxy) => {
        requests.push(proxy?.port ?? null);
        if (!proxy) throw Object.assign(new Error("connect denied"), { code: "EACCES" });
        return { body, headers: { "profile-title": "Remote subscription" } };
      },
    });

    expect(requests).toEqual([null, 7897]);
    expect(inspection.nodeCount).toBe(1);
  });

  it("applies one ten-second deadline while DNS resolution is still pending", async () => {
    vi.useFakeTimers();
    try {
      const inspection = readRemoteProfile("https://subscription.example.test/online", {
        resolvePublicAddress: async () => new Promise(() => undefined),
      }).then(
        () => "resolved",
        (error: unknown) => error instanceof Error ? error.message : "unknown-error",
      );
      const outcome = Promise.race([
        inspection,
        new Promise<string>((resolve) => setTimeout(() => resolve("still-pending"), 10_001)),
      ]);

      await vi.advanceTimersByTimeAsync(10_001);

      expect(await outcome).toBe("remote-timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reset the ten-second deadline for proxy fallback", async () => {
    vi.useFakeTimers();
    try {
      const requests: Array<number | null> = [];
      const inspection = readRemoteProfile("https://subscription.example.test/online", {
        resolveLocalProxy: async () => ({ host: "127.0.0.1", port: 7897 }),
        download: async (_target, _redirectCount, proxy) => {
          requests.push(proxy?.port ?? null);
          if (!proxy) {
            return new Promise((_, reject) => setTimeout(
              () => reject(Object.assign(new Error("connect denied"), { code: "EACCES" })),
              6_000,
            ));
          }
          return new Promise(() => undefined);
        },
      }).then(
        () => "resolved",
        (error: unknown) => error instanceof Error ? error.message : "unknown-error",
      );
      const outcome = Promise.race([
        inspection,
        new Promise<string>((resolve) => setTimeout(() => resolve("still-pending"), 10_001)),
      ]);

      await vi.advanceTimersByTimeAsync(6_000);
      expect(requests).toEqual([null, 7897]);
      await vi.advanceTimersByTimeAsync(4_001);

      expect(await outcome).toBe("remote-timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("binds an actual CONNECT request to the audited address while retaining the hostname for Host", async () => {
    const connectRequests: Array<{ authority: string; host: string }> = [];
    const proxyServer = createServer();
    proxyServer.on("connect", (request, socket) => {
      connectRequests.push({
        authority: request.url ?? "",
        host: String(request.headers.host ?? ""),
      });
      socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    });
    await new Promise<void>((resolve) => proxyServer.listen(0, "127.0.0.1", resolve));
    const address = proxyServer.address();
    if (!address || typeof address === "string") throw new Error("proxy-test-server-not-listening");

    try {
      await expect(downloadProfileThroughHttpProxy(
        new URL("https://subscription.example.test/path"),
        0,
        { host: "127.0.0.1", port: address.port },
        { address: "198.18.3.157", family: 4 },
        async () => { throw new Error("unexpected-redirect"); },
      )).rejects.toThrow("proxy-connect-failed");
    } finally {
      await new Promise<void>((resolve, reject) => proxyServer.close((error) => error ? reject(error) : resolve()));
    }

    expect(connectRequests).toEqual([{
      authority: "198.18.3.157:443",
      host: "subscription.example.test",
    }]);
  });

  it("passes every validated redirect to a fresh pinned proxy CONNECT hop", async () => {
    const connectAuthorities: string[] = [];
    const proxyServer = createServer();
    proxyServer.on("connect", (request, socket) => {
      connectAuthorities.push(request.url ?? "");
      socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    });
    await new Promise<void>((resolve) => proxyServer.listen(0, "127.0.0.1", resolve));
    const address = proxyServer.address();
    if (!address || typeof address === "string") throw new Error("proxy-test-server-not-listening");

    const destroyRedirectResponse = vi.fn();
    const redirectResponse = {
      statusCode: 302,
      headers: { location: "https://redirect.example.test/new-path" },
      resume: () => undefined,
      destroy: destroyRedirectResponse,
    } as never;
    const seenRedirects: Array<{ target: string; count: number }> = [];
    const proxy = { host: "127.0.0.1" as const, port: address.port };
    try {
      const redirectAttempt = new Promise<void>((resolve, reject) => {
        finishProfileResponse(
          new URL("https://first.example.test/start"),
          0,
          proxy,
          redirectResponse,
          async (target, redirectCount, nextProxy) => {
            seenRedirects.push({ target: target.toString(), count: redirectCount });
            return downloadProfileThroughHttpProxy(
              target,
              redirectCount,
              nextProxy!,
              { address: "198.18.3.158", family: 4 },
              async () => { throw new Error("unexpected-redirect"); },
            );
          },
          () => resolve(),
          reject,
        );
      });
      await expect(redirectAttempt).rejects.toThrow("proxy-connect-failed");
    } finally {
      await new Promise<void>((resolve, reject) => proxyServer.close((error) => error ? reject(error) : resolve()));
    }

    expect(seenRedirects).toEqual([{
      target: "https://redirect.example.test/new-path",
      count: 1,
    }]);
    expect(destroyRedirectResponse).toHaveBeenCalledOnce();
    expect(connectAuthorities).toEqual(["198.18.3.158:443"]);
  });

  it("destroys a rejected HTTP response instead of draining its body", async () => {
    const destroyResponse = vi.fn();
    const response = {
      statusCode: 500,
      headers: {},
      destroy: destroyResponse,
      resume: vi.fn(),
    } as never;
    const rejection = new Promise<void>((resolve, reject) => {
      finishProfileResponse(
        new URL("https://subscription.example.test/path"),
        0,
        undefined,
        response,
        async () => { throw new Error("unexpected-redirect"); },
        () => resolve(),
        reject,
      );
    });

    await expect(rejection).rejects.toThrow("remote-http-error");
    expect(destroyResponse).toHaveBeenCalledOnce();
  });

  it("destroys the source response when decompressed content exceeds the limit", async () => {
    const response = new PassThrough() as PassThrough & {
      statusCode: number;
      headers: Record<string, string>;
    };
    response.statusCode = 200;
    response.headers = { "content-encoding": "gzip" };
    const destroyResponse = vi.spyOn(response, "destroy");
    const rejection = new Promise<void>((resolve, reject) => {
      finishProfileResponse(
        new URL("https://subscription.example.test/path"),
        0,
        undefined,
        response as never,
        async () => { throw new Error("unexpected-redirect"); },
        () => resolve(),
        reject,
      );
    });

    try {
      response.write(gzipSync(Buffer.alloc(5 * 1024 * 1024 + 1, "a")));
      await expect(rejection).rejects.toThrow("remote-profile-too-large");
      expect(destroyResponse).toHaveBeenCalledOnce();
    } finally {
      response.destroy();
    }
  });

  it("fails safely when the local proxy is unavailable or not loopback", async () => {
    const requests: Array<number | null> = [];
    await expect(readRemoteProfile("https://subscription.example.test/online", {
      resolveLocalProxy: async () => ({ host: "proxy.example.test", port: 7897 } as never),
      download: async (_target, _redirectCount, proxy) => {
        requests.push(proxy?.port ?? null);
        throw Object.assign(new Error("connect denied"), { code: "EACCES" });
      },
    })).rejects.toMatchObject({ code: "EACCES" });
    expect(requests).toEqual([null]);
  });

  it("parses a Clash profile when the upstream labels the response as HTML", async () => {
    const inspection = await readRemoteProfile("https://subscription.example.test/online", {
      download: async () => ({
        body: `
proxies:
  - name: Example
    type: ss
    server: example.test
    port: 443
    cipher: aes-128-gcm
    password: redacted
proxy-groups:
  - name: MAIN
    type: select
    proxies: [Example]
rules:
  - MATCH,MAIN
`,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    });

    expect(inspection.format).toBe("clash-yaml");
    expect(inspection.nodeCount).toBe(1);
  });

  it("does not parse a login or error HTML page as a subscription", async () => {
    await expect(readRemoteProfile("https://subscription.example.test/online", {
      resolveLocalProxy: async () => null,
      download: async () => ({
        body: "<!doctype html><html><body>login required</body></html>",
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    })).rejects.toThrow("html-response");
  });

  it("only retries errors that can be caused by the direct network path", () => {
    expect(shouldRetryThroughClashProxy(new Error("clash-fake-ip-unreachable"))).toBe(true);
    expect(shouldRetryThroughClashProxy(Object.assign(new Error("connect denied"), { code: "EACCES" }))).toBe(true);
    expect(shouldRetryThroughClashProxy(new Error("remote-timeout"))).toBe(true);
    expect(shouldRetryThroughClashProxy(new Error("remote-http-error"))).toBe(true);
    expect(shouldRetryThroughClashProxy(new Error("private-address"))).toBe(false);
    expect(shouldRetryThroughClashProxy(new Error("remote-profile-too-large"))).toBe(false);
    expect(shouldRetryThroughClashProxy(new Error("html-response"))).toBe(true);
  });
});

import { lookup as dnsLookup } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { Agent as HttpAgent, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import type { Readable } from "node:stream";
import { connect as tlsConnect } from "node:tls";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { parse } from "yaml";
import {
  createSubscriptionInspectionSummary,
  type SubscriptionInspectionSummary,
} from "../src/subscription-inspection.ts";
import { cleanSubscriptionName, inspectProfileYaml, type ProfileYamlInspection } from "./profile-yaml.ts";

const MAX_REMOTE_PROFILE_BYTES = 5 * 1024 * 1024;
const REMOTE_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

const blockedNetworks = new BlockList();
const blockedIpv4Networks: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
];
blockedIpv4Networks.forEach(([address, prefix]) => blockedNetworks.addSubnet(address, prefix, "ipv4"));
const blockedIpv6Networks: Array<[string, number]> = [
  ["::", 128],
  ["::1", 128],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
];
blockedIpv6Networks.forEach(([address, prefix]) => blockedNetworks.addSubnet(address, prefix, "ipv6"));

export type RemoteProfileNameSource = "profile-title" | "yaml" | "filename" | "group" | null;

export interface RemoteProfileMetadata {
  name: string | null;
  nameSource: RemoteProfileNameSource;
  selectGroups: string[];
  suggestedGroup: string | null;
}

export type RemoteProfileInspection = SubscriptionInspectionSummary;
export type RemoteInspectionErrorCode = "clash-fake-ip-unreachable" | "subscription-unavailable";

export interface HttpProxyEndpoint {
  host: "127.0.0.1";
  port: number;
}

export interface ResolvedRemoteAddress {
  address: string;
  family: 4 | 6;
}

export type PublicAddressResolver = (
  hostname: string,
  allowClashFakeIp: boolean,
  signal?: AbortSignal,
) => Promise<ResolvedRemoteAddress>;

type ProfileDownload = (
  target: URL,
  redirectCount: number,
  proxy?: HttpProxyEndpoint,
  signal?: AbortSignal,
) => Promise<{ body: string; headers: IncomingHttpHeaders }>;

export interface RemoteProfileReaderOptions {
  resolveLocalProxy?: () => Promise<HttpProxyEndpoint | null>;
  resolvePublicAddress?: PublicAddressResolver;
  download?: ProfileDownload;
}

export function getRemoteInspectionErrorCode(error: unknown): RemoteInspectionErrorCode {
  return error instanceof Error && error.message === "clash-fake-ip-unreachable"
    ? "clash-fake-ip-unreachable"
    : "subscription-unavailable";
}

function remoteTimeoutError(): Error {
  return new Error("remote-timeout");
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : remoteTimeoutError();
}

function waitForAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function firstHeader(headers: IncomingHttpHeaders, name: string): string | null {
  const value = headers[name];
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function decodeHeaderName(value: string | null): string | null {
  if (!value) return null;
  try {
    return cleanSubscriptionName(decodeURIComponent(value));
  } catch {
    return cleanSubscriptionName(value);
  }
}

function dispositionName(value: string | null): string | null {
  if (!value) return null;
  const encoded = value.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1];
  if (encoded) return decodeHeaderName(encoded);
  const plain = value.match(/filename\s*=\s*(?:"([^"]+)"|([^;]+))/i);
  return cleanSubscriptionName(plain?.[1] ?? plain?.[2]);
}

export function extractRemoteProfileMetadata(
  yamlSource: string,
  headers: IncomingHttpHeaders = {},
  yamlInspection: ProfileYamlInspection = inspectProfileYaml(yamlSource),
): RemoteProfileMetadata {
  const groups = {
    selectGroups: yamlInspection.selectGroups,
    suggestedGroup: yamlInspection.suggestedGroup,
  };
  const headerName = decodeHeaderName(firstHeader(headers, "profile-title"));
  if (headerName) return { name: headerName, nameSource: "profile-title", ...groups };

  const yamlName = yamlInspection.profileName;
  if (yamlName) return { name: yamlName, nameSource: "yaml", ...groups };

  const fileName = dispositionName(firstHeader(headers, "content-disposition"));
  if (fileName) return { name: fileName, nameSource: "filename", ...groups };
  const groupName = yamlInspection.terminalGroup ?? groups.suggestedGroup;
  return { name: groupName, nameSource: groupName ? "group" : null, ...groups };
}

export function isPublicNetworkAddress(address: string): boolean {
  if (/^::ffff:/i.test(address)) return false;
  const family = isIP(address);
  if (family === 4) return !blockedNetworks.check(address, "ipv4");
  if (family === 6) return !blockedNetworks.check(address, "ipv6");
  return false;
}

export function isClashFakeIpAddress(address: string): boolean {
  const parts = address.split(".").map(Number);
  return parts.length === 4
    && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    && parts[0] === 198
    && (parts[1] === 18 || parts[1] === 19);
}

export function selectPublicNetworkAddress(
  addresses: Array<{ address: string; family: number }>,
): { address: string; family: 4 | 6 } | null {
  const selected = addresses.find(({ address }) => isPublicNetworkAddress(address));
  return selected ? { address: selected.address, family: selected.family as 4 | 6 } : null;
}

export function selectClashFakeIp(
  systemAddresses: Array<{ address: string; family: number }>,
): { address: string; family: 4 } | null {
  if (!systemAddresses.length || systemAddresses.some(({ address }) => !isClashFakeIpAddress(address))) return null;
  const fakeIp = systemAddresses[0]!;
  return { address: fakeIp.address, family: 4 };
}

function validateRemoteUrl(source: string): URL {
  const target = new URL(source.trim());
  if (target.protocol !== "https:") throw new Error("https-required");
  if (target.username || target.password) throw new Error("credentials-in-url");
  target.hash = "";
  return target;
}

function parsePort(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value >= 1 && value <= 65_535 ? value : null;
  }
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return null;
  const port = Number(value.trim());
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null;
}

export function parseClashProxyConfig(source: string): HttpProxyEndpoint | null {
  try {
    const root = parse(source) as Record<string, unknown> | null;
    if (!root || typeof root !== "object" || Array.isArray(root)) return null;
    const port = parsePort(root["mixed-port"] ?? root.port ?? root.verge_mixed_port);
    return port ? { host: "127.0.0.1", port } : null;
  } catch {
    return null;
  }
}

function clashConfigCandidates(): string[] {
  const appData = process.env.APPDATA;
  const home = os.homedir();
  const roots = [
    appData ? path.join(appData, "io.github.clash-verge-rev.clash-verge-rev") : "",
    process.platform === "darwin"
      ? path.join(home, "Library", "Application Support", "io.github.clash-verge-rev.clash-verge-rev")
      : "",
    process.platform === "linux"
      ? path.join(home, ".local", "share", "io.github.clash-verge-rev.clash-verge-rev")
      : "",
  ].filter(Boolean);
  return roots.flatMap((root) => [path.join(root, "config.yaml"), path.join(root, "verge.yaml")]);
}

function validateLocalClashProxy(value: unknown): HttpProxyEndpoint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as { host?: unknown; port?: unknown };
  const port = parsePort(candidate.port);
  return candidate.host === "127.0.0.1" && port !== null && port === candidate.port
    ? { host: "127.0.0.1", port }
    : null;
}

async function findLocalClashProxy(): Promise<HttpProxyEndpoint | null> {
  for (const filePath of clashConfigCandidates()) {
    try {
      const proxy = parseClashProxyConfig(await readFile(filePath, "utf8"));
      if (proxy) return proxy;
    } catch {
      // Try the next fixed Clash Verge Rev config path.
    }
  }
  return null;
}

export function shouldRetryThroughClashProxy(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if ([
    "private-address",
    "https-required",
    "credentials-in-url",
    "too-many-redirects",
    "redirect-without-location",
    "remote-profile-too-large",
    "unsupported-content-encoding",
  ].includes(error.message)) return false;
  if ([
    "clash-fake-ip-unreachable",
    "remote-timeout",
    "remote-http-error",
    "html-response",
  ].includes(error.message)) return true;
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" && [
    "EACCES",
    "ECONNABORTED",
    "ECONNREFUSED",
    "ECONNRESET",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ENETDOWN",
    "ENOTFOUND",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "EPIPE",
    "EPERM",
  ].includes(code);
}

async function resolvePublicAddress(
  hostname: string,
  allowClashFakeIp: boolean,
  signal?: AbortSignal,
): Promise<ResolvedRemoteAddress> {
  const literalFamily = isIP(hostname);
  if (literalFamily) {
    if (!isPublicNetworkAddress(hostname)) throw new Error("private-address");
    return { address: hostname, family: literalFamily as 4 | 6 };
  }

  const addresses = await waitForAbort(dnsLookup(hostname, { all: true, verbatim: true }), signal);
  const selected = selectPublicNetworkAddress(addresses);
  if (selected) return selected;
  if (allowClashFakeIp) {
    const fakeIp = selectClashFakeIp(addresses);
    if (fakeIp) return fakeIp;
  }
  throw new Error("private-address");
}

function decodedStream(response: Readable, encoding: string | undefined): Readable {
  switch ((encoding ?? "identity").toLowerCase()) {
    case "identity": return response;
    case "gzip": return response.pipe(createGunzip());
    case "deflate": return response.pipe(createInflate());
    case "br": return response.pipe(createBrotliDecompress());
    default: throw new Error("unsupported-content-encoding");
  }
}

async function readLimitedBody(stream: Readable, signal?: AbortSignal): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  const onAbort = signal ? () => stream.destroy(abortReason(signal)) : null;
  if (signal?.aborted) stream.destroy(abortReason(signal));
  else if (onAbort) signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_REMOTE_PROFILE_BYTES) {
        stream.destroy();
        throw new Error("remote-profile-too-large");
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

const remoteRequestHeaders = {
  Accept: "application/yaml, text/yaml, text/plain, application/octet-stream;q=0.8",
  "Accept-Encoding": "gzip, deflate, br",
  "User-Agent": "clash-verge",
};

export function finishProfileResponse(
  target: URL,
  redirectCount: number,
  proxy: HttpProxyEndpoint | undefined,
  response: IncomingMessage,
  download: ProfileDownload,
  resolve: (value: { body: string; headers: IncomingHttpHeaders }) => void,
  reject: (reason?: unknown) => void,
  signal?: AbortSignal,
): void {
  const status = response.statusCode ?? 0;
  if (status >= 300 && status < 400) {
    const location = response.headers.location;
    response.destroy();
    if (!location) {
      reject(new Error("redirect-without-location"));
      return;
    }
    let redirected: URL;
    try {
      redirected = validateRemoteUrl(new URL(location, target).toString());
    } catch (error) {
      reject(error);
      return;
    }
    void download(redirected, redirectCount + 1, proxy, signal).then(resolve, reject);
    return;
  }
  if (status < 200 || status >= 300) {
    response.destroy();
    reject(new Error("remote-http-error"));
    return;
  }
  const declaredSize = Number(response.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredSize) && declaredSize > MAX_REMOTE_PROFILE_BYTES) {
    response.destroy();
    reject(new Error("remote-profile-too-large"));
    return;
  }
  let stream: Readable;
  try {
    stream = decodedStream(response, response.headers["content-encoding"]);
  } catch (error) {
    response.destroy();
    reject(error);
    return;
  }
  void readLimitedBody(stream, signal).then(
    (body) => resolve({ body, headers: response.headers }),
    (error) => {
      if (!response.destroyed) response.destroy();
      reject(error);
    },
  );
}

function formatAddressForAuthority(address: string): string {
  return address.includes(":") && !address.startsWith("[") ? `[${address}]` : address;
}

function targetHostHeader(target: URL): string {
  const hostname = formatAddressForAuthority(target.hostname);
  const defaultPort = target.protocol === "https:" ? "443" : "";
  return target.port && target.port !== defaultPort ? `${hostname}:${target.port}` : hostname;
}

function proxyAuthority(address: string, target: URL): string {
  return `${formatAddressForAuthority(address)}:${target.port || "443"}`;
}

export function downloadProfileThroughHttpProxy(
  target: URL,
  redirectCount: number,
  proxy: HttpProxyEndpoint,
  resolved: ResolvedRemoteAddress,
  download: ProfileDownload,
  signal?: AbortSignal,
): Promise<{ body: string; headers: IncomingHttpHeaders }> {
  const validatedProxy = validateLocalClashProxy(proxy);
  if (!validatedProxy) return Promise.reject(new Error("invalid-local-proxy"));
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const authority = proxyAuthority(resolved.address, target);
    const hostHeader = targetHostHeader(target);
    let requestAgent: HttpAgent | null = null;
    const proxyRequest = httpRequest({
      host: validatedProxy.host,
      port: validatedProxy.port,
      method: "CONNECT",
      path: authority,
      headers: { Host: hostHeader },
      signal,
    });
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      requestAgent?.destroy();
      reject(signal?.aborted ? abortReason(signal) : error);
    };
    proxyRequest.setTimeout(REMOTE_TIMEOUT_MS, () => proxyRequest.destroy(new Error("remote-timeout")));
    proxyRequest.once("error", fail);
    proxyRequest.once("connect", (response, socket, head) => {
      if ((response.statusCode ?? 0) !== 200) {
        socket.destroy();
        fail(new Error("proxy-connect-failed"));
        return;
      }
      if (head.length) socket.unshift(head);
      const tlsSocket = tlsConnect({
        socket,
        servername: target.hostname,
      });
      if (signal) {
        const abortTls = () => tlsSocket.destroy(abortReason(signal));
        if (signal.aborted) abortTls();
        else signal.addEventListener("abort", abortTls, { once: true });
        tlsSocket.once("close", () => signal.removeEventListener("abort", abortTls));
      }
      tlsSocket.once("error", fail);
      requestAgent = new HttpAgent({ keepAlive: false });
      requestAgent.createConnection = () => tlsSocket;
      const requestOptions = {
        // The resolver has already rejected private destinations. Keep the
        // audited address for both CONNECT and the tunneled request so neither
        // Clash nor Node can perform a second, unpinned DNS lookup.
        hostname: resolved.address,
        port: target.port || 443,
        path: `${target.pathname}${target.search}`,
        method: "GET",
        agent: requestAgent,
        headers: { ...remoteRequestHeaders, Host: hostHeader },
        signal,
      };
      const requestThroughProxy = httpRequest(requestOptions, (profileResponse) => {
        finishProfileResponse(target, redirectCount, proxy, profileResponse, download, (value) => {
          settled = true;
          resolve(value);
        }, fail, signal);
      });
      requestThroughProxy.setTimeout(REMOTE_TIMEOUT_MS, () => requestThroughProxy.destroy(new Error("remote-timeout")));
      requestThroughProxy.once("error", fail);
      requestThroughProxy.end();
    });
    proxyRequest.end();
  });
}

async function downloadProfile(
  target: URL,
  redirectCount = 0,
  proxy?: HttpProxyEndpoint,
  resolveAddress: PublicAddressResolver = resolvePublicAddress,
  signal?: AbortSignal,
): Promise<{ body: string; headers: IncomingHttpHeaders }> {
  if (redirectCount > MAX_REDIRECTS) throw new Error("too-many-redirects");
  const resolved = await waitForAbort(resolveAddress(target.hostname, true, signal), signal);
  const download = (nextTarget: URL, nextRedirectCount: number, nextProxy?: HttpProxyEndpoint) => (
    downloadProfile(nextTarget, nextRedirectCount, nextProxy, resolveAddress, signal)
  );
  if (proxy) return downloadProfileThroughHttpProxy(target, redirectCount, proxy, resolved, download, signal);

  return new Promise((resolve, reject) => {
    const req = httpsRequest(target, {
      method: "GET",
      agent: false,
      headers: remoteRequestHeaders,
      signal,
      lookup: (_hostname, options, callback) => {
        if (typeof options === "object" && options.all) {
          callback(null, [{ address: resolved.address, family: resolved.family }]);
          return;
        }
        callback(null, resolved.address, resolved.family);
      },
    }, (response) => finishProfileResponse(
      target,
      redirectCount,
      undefined,
      response,
      download,
      resolve,
      reject,
      signal,
    ));
    req.setTimeout(REMOTE_TIMEOUT_MS, () => req.destroy(new Error("remote-timeout")));
    req.once("error", (error) => {
      reject(signal?.aborted
        ? abortReason(signal)
        : isClashFakeIpAddress(resolved.address) ? new Error("clash-fake-ip-unreachable") : error);
    });
    req.end();
  });
}

export async function readRemoteProfile(
  source: string,
  options: RemoteProfileReaderOptions = {},
): Promise<RemoteProfileInspection> {
  const target = validateRemoteUrl(source);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(remoteTimeoutError()), REMOTE_TIMEOUT_MS);
  const { signal } = controller;
  const resolveAddress = options.resolvePublicAddress ?? resolvePublicAddress;
  const download: ProfileDownload = options.download ?? ((nextTarget, redirectCount, proxy, nextSignal) => (
    downloadProfile(nextTarget, redirectCount, proxy, resolveAddress, nextSignal)
  ));
  const inspectDownloaded = (downloaded: { body: string; headers: IncomingHttpHeaders }): RemoteProfileInspection => {
    const { body, headers } = downloaded;
    const normalizedBody = body.replace(/^\uFEFF/, "").trim();
    if (!normalizedBody) throw new Error("invalid-response");
    if (/^(?:<!doctype\s+html\b|<html\b|<head\b|<body\b)/i.test(normalizedBody)) {
      throw new Error("html-response");
    }
    const yamlInspection = inspectProfileYaml(normalizedBody);
    const contentType = (firstHeader(headers, "content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
    if ((contentType === "text/html" || contentType === "application/xhtml+xml")
      && yamlInspection.format !== "clash-yaml") {
      throw new Error("html-response");
    }
    const metadata = extractRemoteProfileMetadata(normalizedBody, headers, yamlInspection);
    if (!metadata.name && metadata.selectGroups.length === 0) throw new Error("unsupported-subscription");
    return createSubscriptionInspectionSummary({
      origin: "remote",
      ...metadata,
      format: yamlInspection.format,
      nodeCount: yamlInspection.nodeCount,
      warnings: yamlInspection.warnings,
    });
  };

  try {
    return inspectDownloaded(await waitForAbort(download(target, 0, undefined, signal), signal));
  } catch (directError) {
    if (signal.aborted) throw abortReason(signal);
    if (!shouldRetryThroughClashProxy(directError)) throw directError;
    const proxy = validateLocalClashProxy(await waitForAbort(
      (options.resolveLocalProxy ?? findLocalClashProxy)(),
      signal,
    ));
    if (!proxy) throw directError;
    return inspectDownloaded(await waitForAbort(download(target, 0, proxy, signal), signal));
  } finally {
    clearTimeout(timeout);
  }
}

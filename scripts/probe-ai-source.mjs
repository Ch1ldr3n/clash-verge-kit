// Issue #1: immutable public-source evidence; no private configuration or file writes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const commit = "c9f1fd664797ccdc85783c5746827a3f22ce6068";
const file = "geo/geosite/category-ai-!cn.list";
const expected = "2f01a4ba73661bce315958aae3e81871bdae826a4494dd93311655c8849bb89e";
const response = await fetch(`https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/${commit}/${file}`, {
  signal: AbortSignal.timeout(20000),
});
assert.ok(response.ok, `public source returned ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
assert.equal(createHash("sha256").update(bytes).digest("hex"), expected);
const rules = bytes.toString("utf8").trim().split(/\r?\n/);
const matches = (domain) => rules.some((rule) => rule.startsWith("+.")
  ? domain === rule.slice(2) || domain.endsWith(`.${rule.slice(2)}`)
  : domain === rule);
for (const domain of ["chatgpt.com", "claude.ai", "gemini.google.com", "cursor.com", "grok.com", "perplexity.ai", "githubcopilot.com", "notebooklm.google.com"]) {
  assert.ok(matches(domain), `missing service: ${domain}`);
}
for (const domain of ["linux.do", "nodeseek.com", "stripe.com", "cloudflare.com"]) {
  assert.equal(matches(domain), false, `unexpected broad domain: ${domain}`);
}
// These are intentional evidence of the upstream scope, not claims of AI-only traffic.
for (const domain of ["envato.com", "themeforest.net", "host.livekit.cloud"]) assert.ok(matches(domain));
console.log(JSON.stringify({ commit, file, sha256: expected, entries: rules.length, assertions: 16 }));

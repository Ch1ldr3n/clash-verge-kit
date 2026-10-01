// Issue #1 research only: data relationships, not a production parser or generator.
// No local profile access, network, script execution, or installed-file writes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

const revision = "research-model-1";
const checksum = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const nodeKey = (node) => JSON.stringify([node.sourceId, node.provider ?? null, node.name]);

function validateRelationships(plan) {
  assert.ok(plan.target.name && plan.target.source);
  const sourceIds = plan.sources.map((source) => source.id);
  const outletIds = plan.outlets.map((outlet) => outlet.id);
  assert.equal(new Set(sourceIds).size, sourceIds.length, "duplicate source ID");
  assert.equal(new Set(outletIds).size, outletIds.length, "duplicate outlet ID");
  for (const source of plan.sources) {
    assert.ok(["target", "subscription"].includes(source.kind));
    if (source.kind === "subscription") assert.ok(source.locator);
  }
  assert.equal(plan.sources.filter((source) => source.kind === "target").length, 1);
  for (const outlet of plan.outlets) {
    if (outlet.kind === "existing") {
      assert.ok(outlet.groupName);
      assert.equal(outlet.nodes, undefined, "existing group must not acquire selected nodes");
    } else {
      assert.equal(outlet.kind, "selected");
      assert.ok(outlet.groupName && outlet.nodes.length);
      assert.equal(new Set(outlet.nodes.map(nodeKey)).size, outlet.nodes.length, "duplicate node reference");
      for (const node of outlet.nodes) {
        assert.ok(sourceIds.includes(node.sourceId), "missing source");
        assert.ok(typeof node.name === "string" && node.name.length);
        assert.ok(node.provider === null || typeof node.provider === "string");
      }
    }
  }
  const moduleIds = plan.modules.map((module) => module.id);
  assert.equal(new Set(moduleIds).size, moduleIds.length);
  for (const module of plan.modules) {
    assert.equal(typeof module.enabled, "boolean");
    assert.ok(outletIds.includes(module.outletId), "missing outlet");
    assert.ok(module.ruleSource.id && module.ruleSource.revision);
  }
  if (plan.nesting !== null) {
    assert.ok(plan.nesting.parentGroupName);
    for (const id of plan.nesting.sourceIds) {
      assert.equal(plan.sources.find((source) => source.id === id)?.kind, "subscription");
    }
  }
  return plan;
}

function saveModel(plan) {
  validateRelationships(plan);
  const payload = { schema: "kit-routing-research-only", version: 2, revision, plan };
  return JSON.stringify({ payload, checksum: checksum(payload) });
}

function readModel(serialized, target) {
  const envelope = JSON.parse(serialized);
  assert.equal(envelope.payload.schema, "kit-routing-research-only");
  assert.equal(envelope.payload.version, 2, "unsupported version");
  assert.equal(envelope.payload.revision, revision, "unsupported revision");
  assert.equal(envelope.checksum, checksum(envelope.payload), "changed metadata");
  assert.deepEqual(envelope.payload.plan.target, target, "target mismatch");
  return validateRelationships(envelope.payload.plan);
}

// Abstract reference graph: roots include nesting and every external reference.
// Ownership has to be proven separately against the current runtime object.
function removableObjects(objects, roots) {
  const byId = new Map(objects.map((object) => [object.id, object]));
  assert.equal(byId.size, objects.length);
  const live = new Set();
  const visit = (id) => {
    if (live.has(id)) return;
    const object = byId.get(id);
    assert.ok(object, "dangling dependency");
    live.add(id);
    object.dependencies.forEach(visit);
  };
  objects.filter((object) => !object.owned).forEach((object) => visit(object.id));
  roots.forEach(visit);
  return objects.filter((object) => object.owned && !live.has(object.id)).map((object) => object.id);
}

function fixture() {
  return {
    target: { name: "Synthetic main", source: "https://main.example.test/synthetic" },
    nesting: null,
    sources: [{ id: "main", kind: "target" }],
    outlets: [{ id: "exit-1", kind: "existing", groupName: "Original group" }],
    modules: [{ id: "ai", enabled: true, outletId: "exit-1", ruleSource: { id: "ai-reference", revision: "catalog-1" } }],
  };
}

test("standalone routing round-trips with no nesting or child subscription", () => {
  const plan = fixture();
  assert.deepEqual(readModel(saveModel(plan), plan.target), plan);
});

test("nesting and routing share one subscription source without duplicating it", () => {
  const plan = fixture();
  plan.sources.push({ id: "child", kind: "subscription", locator: "https://child.example.test/synthetic" });
  plan.nesting = { parentGroupName: "Original group", sourceIds: ["child"] };
  plan.outlets = [{ id: "exit-1", kind: "selected", groupName: "Selected", nodes: [
    { sourceId: "main", provider: null, name: "Same [A]+" },
    { sourceId: "child", provider: "provider-1", name: "Same [A]+" },
    { sourceId: "child", provider: "provider-2", name: "Same [A]+" },
  ] }];
  const restored = readModel(saveModel(plan), plan.target);
  assert.deepEqual(restored, plan);
  assert.equal(new Set(restored.outlets[0].nodes.map(nodeKey)).size, 3);
});

test("source deletion cannot silently leave a selected node dangling", () => {
  const plan = fixture();
  plan.outlets = [{ id: "exit-1", kind: "selected", groupName: "Selected", nodes: [
    { sourceId: "deleted-source", provider: null, name: "Selected" },
  ] }];
  assert.throws(() => saveModel(plan), /missing source/);
});

test("missing outlets and mixed existing/selected semantics are rejected", () => {
  const plan = fixture();
  plan.modules[0].outletId = "missing";
  assert.throws(() => saveModel(plan), /missing outlet/);
  plan.modules[0].outletId = "exit-1";
  plan.outlets[0].nodes = [];
  assert.throws(() => saveModel(plan), /existing group/);
});

test("unknown format and revision are rejected even with a recalculated checksum", () => {
  for (const key of ["version", "revision"]) {
    const plan = fixture();
    const envelope = JSON.parse(saveModel(plan));
    envelope.payload[key] = "unknown";
    envelope.checksum = checksum(envelope.payload);
    assert.throws(() => readModel(JSON.stringify(envelope), plan.target), /unsupported/);
  }
});

test("changed metadata and mismatched selected target are rejected", () => {
  const plan = fixture();
  const saved = saveModel(plan);
  const envelope = JSON.parse(saved);
  envelope.payload.plan.modules[0].enabled = false;
  assert.throws(() => readModel(JSON.stringify(envelope), plan.target), /changed metadata/);
  assert.throws(() => readModel(saved, { ...plan.target, source: "https://other.example.test/synthetic" }), /target mismatch/);
});

test("editing and cancelling an in-memory draft cannot change saved data", () => {
  const plan = fixture();
  const saved = saveModel(plan);
  const draft = readModel(saved, plan.target);
  draft.modules[0].enabled = false;
  assert.equal(readModel(saved, plan.target).modules[0].enabled, true);
  assert.equal(readModel(saveModel(draft), plan.target).modules[0].enabled, false);
});

test("closing AI retains shared nesting dependencies and unrelated airport objects", () => {
  const objects = [
    { id: "airport", owned: false, dependencies: [] },
    { id: "nested", owned: true, dependencies: ["shared-provider"] },
    { id: "ai-exit", owned: true, dependencies: ["shared-provider"] },
    { id: "shared-provider", owned: true, dependencies: [] },
    { id: "ai-rules", owned: true, dependencies: ["ai-exit"] },
  ];
  assert.deepEqual(removableObjects(objects, ["nested"]), ["ai-exit", "ai-rules"]);
  objects[0].dependencies.push("ai-exit");
  assert.deepEqual(removableObjects(objects, ["nested"]), ["ai-rules"]);
});

test("same-prefix airport objects never become owned by a name heuristic", () => {
  assert.deepEqual(removableObjects([
    { id: "kit-looking-airport-object", owned: false, dependencies: [] },
    { id: "recorded-kit-object", owned: true, dependencies: [] },
  ], []), ["recorded-kit-object"]);
});

import test from "node:test";
import assert from "node:assert/strict";
import { checkUpdates, type Registry } from "../src/check-updates.js";

const current = { provider: "opencode", id: "gemini-3.8-flash", contextWindow: 100, reasoning: true };
const registry = (available: any[], fail = false): Registry & { calls: string[][] } => ({
  calls: [],
  async refresh({ providers }) { this.calls.push(providers); if (fail) throw new Error("offline"); },
  getAvailable() { return available; },
});

test("empty scope does not refresh unrestricted catalog", async () => {
  const reg = registry([]);
  const result = await checkUpdates([], reg);
  assert.match(result.message, /No shortlist configured/);
  assert.equal(reg.calls.length, 0);
});

test("refreshes only scoped providers and reports candidates and missing models", async () => {
  const reg = registry([current, { provider: "opencode", id: "gemini-3.9-flash", contextWindow: 200, reasoning: false }]);
  const result = await checkUpdates([{ model: current, thinkingLevel: "high" }, { model: { provider: "x", id: "gone" } }], reg);
  assert.deepEqual(reg.calls, [["opencode", "x"]]);
  assert.equal(result.candidates[0].candidate.id, "gemini-3.9-flash");
  assert.ok(result.candidates[0].warnings.includes("context window differs"));
  assert.deepEqual(result.missing.map((m) => m.id), ["gone"]);
});

test("failed refresh is distinct from no updates and retains available cached catalog", async () => {
  const reg = registry([current], true);
  const result = await checkUpdates([{ model: current }], reg);
  assert.equal(result.refreshFailures.length, 1);
  assert.match(result.message, /Catalog refresh failed/);
  assert.doesNotMatch(result.message, /No higher-version candidates/);
});

test("cancellation bounds a refresh that ignores its signal", async () => {
  const controller = new AbortController();
  const reg: Registry = {
    async refresh() { await new Promise(() => {}); },
    getAvailable() { return [current]; },
  };
  const pending = checkUpdates([{ model: current }], reg, controller.signal);
  controller.abort(new Error("shutdown"));
  const result = await pending;
  assert.equal(result.refreshFailures.length, 1);
  assert.match(result.refreshFailures[0].error, /shutdown/);
});

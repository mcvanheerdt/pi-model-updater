import test from "node:test";
import assert from "node:assert/strict";
import { compareVersions, findHigherCandidates, type ModelLike } from "../src/families.js";

const m = (provider: string, id: string): ModelLike => ({ provider, id });

test("observed families match only higher versions on the same provider and variant", () => {
  const current = m("openai-codex", "gpt-6-sol");
  const catalog = [m("openai-codex", "gpt-5.6-sol"), m("openai-codex", "gpt-6.1-sol"), m("openai-codex", "gpt-6.1-luna"), m("opencode", "gpt-7-sol")];
  assert.deepEqual(findHigherCandidates(current, catalog).map((x) => x.model.id), ["gpt-6.1-sol"]);
});

test("numeric version ordering and equality treat missing zero components equally", () => {
  assert.ok(compareVersions([6, 10], [6, 9]) > 0);
  assert.equal(compareVersions([6], [6, 0]), 0);
  assert.deepEqual(findHigherCandidates(m("opencode", "deepseek-v4-flash"), [m("opencode", "deepseek-v4.10-flash"), m("opencode", "deepseek-v4.9-flash")]).map((x) => x.model.id), ["deepseek-v4.10-flash"]);
});

test("deepseek flash is supported; Gemini, unknown and experimental names are ignored", () => {
  assert.equal(findHigherCandidates(m("opencode", "deepseek-v4-flash"), [m("opencode", "deepseek-v4.1-flash")]).length, 1);
  assert.equal(findHigherCandidates(m("opencode", "gemini-3.5-flash"), [m("opencode", "gemini-4-flash")]).length, 0);
  assert.equal(findHigherCandidates(m("opencode", "deepseek-v4-flash-exp"), [m("opencode", "deepseek-v5-flash")]).length, 0);
  assert.equal(findHigherCandidates(m("elsewhere", "unknown-1"), [m("elsewhere", "unknown-2")]).length, 0);
});

test("reports a single highest version and deduplicates duplicate catalog entries", () => {
  const current = m("opencode", "deepseek-v4-flash");
  const results = findHigherCandidates(current, [m("opencode", "deepseek-v4.1-flash"), m("opencode", "deepseek-v4.2-flash"), m("opencode", "deepseek-v4.2-flash")]);
  assert.deepEqual(results.map((x) => x.model.id), ["deepseek-v4.2-flash"]);
});

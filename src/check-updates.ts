import { findHigherCandidates, metadataWarnings, type FamilyRule, type ModelLike } from "./families.js";

export interface ScopedModel { model: ModelLike; thinkingLevel?: string }
export interface Registry {
  refresh(options: { providers: string[]; force: boolean; signal: AbortSignal }): Promise<unknown>;
  getAvailable(): ModelLike[];
}
export interface CheckResult {
  checked: number;
  candidates: Array<{ current: ModelLike; candidate: ModelLike; thinkingLevel?: string; warnings: string[] }>;
  missing: ModelLike[];
  refreshFailures: Array<{ provider: string; error: string }>;
  message: string;
}

const TIMEOUT_MS = 15_000;
const inFlight = new Map<string, Promise<CheckResult>>();

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export function checkUpdates(scope: ScopedModel[], registry: Registry, parentSignal?: AbortSignal, rules: FamilyRule[] = []): Promise<CheckResult> {
  const key = scope.map(({ model }) => `${model.provider}/${model.id}`).sort().join("|");
  const existing = inFlight.get(key);
  if (existing) return existing;
  const pending = performCheck(scope, registry, parentSignal, rules).finally(() => { inFlight.delete(key); });
  inFlight.set(key, pending);
  return pending;
}

async function performCheck(scope: ScopedModel[], registry: Registry, parentSignal?: AbortSignal, rules: FamilyRule[] = []): Promise<CheckResult> {
  if (!scope.length) return { checked: 0, candidates: [], missing: [], refreshFailures: [], message: "No shortlist configured (model selection is unrestricted)." };
  const providers = [...new Set(scope.map(({ model }) => model.provider))];
  const controller = new AbortController();
  const abort = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) abort();
  else parentSignal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Catalog refresh timed out")), TIMEOUT_MS);
  const refreshFailures: CheckResult["refreshFailures"] = [];
  try {
    const refreshes = (async () => {
      try { await registry.refresh({ providers, force: true, signal: controller.signal }); }
      catch (error) {
        for (const provider of providers) refreshFailures.push({ provider, error: errorText(error) });
      }
    })();
    const aborted = new Promise<void>((resolve) => {
      if (controller.signal.aborted) resolve();
      else controller.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    await Promise.race([refreshes, aborted]);
    if (controller.signal.aborted) {
      const reason = errorText(controller.signal.reason ?? "refresh cancelled");
      for (const provider of providers) {
        if (!refreshFailures.some((failure) => failure.provider === provider)) refreshFailures.push({ provider, error: reason });
      }
    }
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", abort);
  }
  const available = registry.getAvailable();
  const missing: ModelLike[] = [];
  const candidates: CheckResult["candidates"] = [];
  for (const scoped of scope) {
    const current = available.find((model) => model.provider === scoped.model.provider && model.id === scoped.model.id);
    if (!current) { missing.push(scoped.model); continue; }
    for (const { model: candidate } of findHigherCandidates(current, available, rules)) {
      candidates.push({ current, candidate, thinkingLevel: scoped.thinkingLevel, warnings: metadataWarnings(current, candidate, scoped.thinkingLevel) });
    }
  }
  const lines = candidates.flatMap(({ current, candidate, warnings }) => {
    const pricingDiffers = warnings.some((warning) => warning.startsWith("pricing differs:"));
    const otherWarnings = warnings.filter((warning) => !warning.startsWith("pricing differs:"));
    const labels = [...(pricingDiffers ? ["pricing differs"] : []), ...otherWarnings];
    const header = `${current.provider}/${current.id} → ${candidate.provider}/${candidate.id}${labels.length ? ` (${pricingDiffers && !otherWarnings.length ? labels.join(", ") : `warning: ${labels.join(", ")}`})` : ""}`;
    return [
      header,
      ...(pricingDiffers ? [
        `    old: ${JSON.stringify(current.cost ?? {})}`,
        `    new: ${JSON.stringify(candidate.cost ?? {})}`,
      ] : []),
    ];
  });
  const message = [
    `${scope.length} shortlisted model${scope.length === 1 ? "" : "s"} checked; higher-version candidates are not guaranteed improvements.`,
    ...lines,
    ...(missing.length ? [`Not found in the available catalog: ${missing.map((m) => `${m.provider}/${m.id}`).join(", ")}.`] : []),
    ...refreshFailures.map(({ provider, error }) => [`Catalog refresh failed for ${provider}: ${error}. Cached catalog data was used where available.`][0]),
    ...(!lines.length && !missing.length && !refreshFailures.length ? ["No higher-version candidates found in the supported model families."] : []),
  ].join("\n");
  return { checked: scope.length, candidates, missing, refreshFailures, message };
}

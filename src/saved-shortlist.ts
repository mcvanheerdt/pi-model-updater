import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ScopedModel, CheckResult } from "./check-updates.js";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export interface SavedUpdateResult {
  updated: boolean;
  replacements: Array<{ from: string; to: string }>;
  reason?: string;
}

/**
 * Update only an exact, explicit global enabledModels list. Never expand globs,
 * touch project settings, or guess that a CLI-only scope is persisted.
 */
export async function updateSavedShortlist(
  cwd: string,
  scope: ScopedModel[],
  result: CheckResult,
  dryRun: boolean,
): Promise<SavedUpdateResult> {
  if (result.refreshFailures.length) return { updated: false, replacements: [], reason: "Catalog refresh failed; saved settings were left unchanged." };
  if (result.missing.length) return { updated: false, replacements: [], reason: "One or more scoped models are missing; saved settings were left unchanged." };

  const settings = SettingsManager.create(cwd);
  try {
    const projectSettings = settings.getProjectSettings() as { enabledModels?: unknown };
    if (projectSettings.enabledModels !== undefined) {
      return { updated: false, replacements: [], reason: "Project settings override the shortlist; project settings were left unchanged." };
    }
    const patterns = (settings.getGlobalSettings() as { enabledModels?: unknown }).enabledModels;
    if (!Array.isArray(patterns) || patterns.length !== scope.length || !patterns.every((item) => typeof item === "string")) {
      return { updated: false, replacements: [], reason: "No matching explicit global shortlist was found (scope may be CLI-only or pattern-based)." };
    }

    const entries = patterns as string[];
    const modelsByPattern = new Map<string, ScopedModel>();
    for (const scoped of scope) {
      const canonical = `${scoped.model.provider}/${scoped.model.id}`;
      const matching = entries.filter((entry) => entry === canonical || (
        entry.startsWith(`${canonical}:`) && THINKING_LEVELS.has(entry.slice(canonical.length + 1))
      ));
      if (matching.length !== 1 || modelsByPattern.has(matching[0])) {
        return { updated: false, replacements: [], reason: "Saved shortlist entries are ambiguous or not exact model references; settings were left unchanged." };
      }
      modelsByPattern.set(matching[0], scoped);
    }
    if (modelsByPattern.size !== entries.length) {
      return { updated: false, replacements: [], reason: "Saved entries do not exactly match this session's scope; settings were left unchanged." };
    }

    const candidates = new Map<string, string[]>();
    for (const item of result.candidates) {
      const key = `${item.current.provider}/${item.current.id}`;
      const value = `${item.candidate.provider}/${item.candidate.id}`;
      candidates.set(key, [...(candidates.get(key) ?? []), value]);
    }
    const replacements: SavedUpdateResult["replacements"] = [];
    const updatedEntries = entries.map((entry) => {
      const scoped = modelsByPattern.get(entry)!;
      const key = `${scoped.model.provider}/${scoped.model.id}`;
      const options = candidates.get(key) ?? [];
      if (!options.length) return entry;
      if (new Set(options).size !== 1) return entry;
      const suffix = entry.slice(key.length);
      const replacement = `${options[0]}${suffix}`;
      if (replacement !== entry) replacements.push({ from: entry, to: replacement });
      return replacement;
    });
    if (result.candidates.some((item) => new Set(candidates.get(`${item.current.provider}/${item.current.id}`)).size > 1)) {
      return { updated: false, replacements: [], reason: "Multiple equally ranked candidates exist; settings were left unchanged." };
    }
    if (!replacements.length) return { updated: false, replacements: [], reason: "No unambiguous higher-version candidates to save." };
    if (dryRun) return { updated: false, replacements, reason: "Dry run: saved settings were not changed." };

    settings.setEnabledModels(updatedEntries);
    await settings.flush();
    const errors = settings.drainErrors();
    if (errors.length) return { updated: false, replacements: [], reason: `Could not save settings: ${errors.map((error) => error.error.message).join("; ")}` };
    return { updated: true, replacements, reason: "Saved shortlist updated for future sessions. The current session's scope is unchanged." };
  } finally {
    await settings.flush();
  }
}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { checkUpdates, type ScopedModel } from "./check-updates.js";
import type { FamilyRule } from "./families.js";
import { updateSavedShortlist } from "./saved-shortlist.js";

const STARTUP_COOLDOWN_MS = 24 * 60 * 60 * 1000;
let lastStartupCheck = 0;
let shutdownController: AbortController | undefined;

function configuredRules(): FamilyRule[] {
  const raw = process.env.PI_MODEL_UPDATE_RULES;
  if (!raw) return [];
  try {
    const entries = JSON.parse(raw) as Array<{ id?: string; provider: string; pattern: string }>;
    return entries.map((entry, index) => ({ id: entry.id ?? `custom-${index}`, provider: entry.provider, pattern: new RegExp(entry.pattern) }));
  } catch (error) {
    console.error("[model-updates] ignoring invalid PI_MODEL_UPDATE_RULES:", error);
    return [];
  }
}

function readScope(ctx: any): ScopedModel[] {
  const raw = ctx.scopedModels as Array<any> | undefined;
  if (!raw?.length) return [];
  return raw.map((entry) => {
    if (entry?.model) return { model: entry.model, thinkingLevel: entry.thinkingLevel };
    return { model: entry, thinkingLevel: entry.thinkingLevel };
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("model-updates", {
    description: "Check higher-version candidates for the current model shortlist",
    handler: async (args, ctx) => {
      const scope = readScope(ctx);
      const result = await checkUpdates(scope, ctx.modelRegistry as any, shutdownController?.signal, configuredRules());
      const dryRun = args.trim() === "dry-run";
      const saveResult = scope.length
        ? await updateSavedShortlist(ctx.cwd, scope, result, dryRun)
        : { updated: false, replacements: [], reason: "No configured shortlist to update." };
      const report = {
        ...result,
        update: { mode: dryRun ? "dry-run" : "automatic", ...saveResult },
        message: `${result.message}\n${saveResult.reason ?? "done"}`, 
      };
      if (ctx.hasUI) ctx.ui.notify(report.message, saveResult.updated ? "warning" : "info");
      else console.log(JSON.stringify(report, null, 2));
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    shutdownController = new AbortController();
    if (process.env.PI_MODEL_UPDATES_STARTUP === "0") return;
    if (Date.now() - lastStartupCheck < STARTUP_COOLDOWN_MS) return;
    lastStartupCheck = Date.now();
    const controller = shutdownController;
    void checkUpdates(readScope(ctx), ctx.modelRegistry as any, controller.signal, configuredRules()).then((result) => {
      if (!result.candidates.length || controller.signal.aborted) return;
      const notice = `Higher-version model candidates found. Run /model-updates for details.`;
      if (ctx.hasUI) ctx.ui.notify(notice, "warning");
      else console.log(JSON.stringify({ type: "model-updates", ...result }, null, 2));
    }).catch((error) => {
      if (!controller.signal.aborted) console.error("[model-updates] startup check failed:", error);
    });
  });

  pi.on("session_shutdown", async () => {
    shutdownController?.abort(new Error("Pi session shutting down"));
    shutdownController = undefined;
  });
}

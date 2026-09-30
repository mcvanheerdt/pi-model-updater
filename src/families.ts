export interface ModelLike {
  id: string;
  provider: string;
  name?: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

export interface FamilyRule {
  id: string;
  provider: string;
  /** Applied to the model ID. Capture group 1 must contain a numeric version. */
  pattern: RegExp;
  /** Optional exact-case-insensitive filter for the captured family identity. */
  identity?: (id: string, match: RegExpExecArray) => string | undefined;
}

interface Identity { family: string; version: number[] }

function versionTuple(text: string): number[] | undefined {
  if (!/^\d+(?:\.\d+)*$/.test(text)) return undefined;
  return text.split(".").map(Number);
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left - right;
  }
  return 0;
}

function identity(model: ModelLike): Identity | undefined {
  const id = model.id.toLowerCase();
  const provider = model.provider.toLowerCase();
  let match: RegExpExecArray | null;
  if (provider === "openai-codex" && (match = /^gpt-(\d+(?:\.\d+)*?)-(sol|luna)$/.exec(id))) {
    return { family: `gpt-${match[2]}`, version: versionTuple(match[1])! };
  }
  if (provider === "opencode" && (match = /^gemini-(\d+(?:\.\d+)*?)-flash$/.exec(id))) {
    return { family: "gemini-flash", version: versionTuple(match[1])! };
  }
  if (provider === "opencode" && (match = /^deepseek-v(\d+(?:\.\d+)*?)-flash$/.exec(id))) {
    return { family: "deepseek-flash", version: versionTuple(match[1])! };
  }
  return undefined;
}

export interface CandidateMatch { model: ModelLike; reason: "higher-version" | "unsupported" }

/** Match only known provider/product/variant families; never infer from model names. */
export function findHigherCandidates(current: ModelLike, available: ModelLike[], rules: FamilyRule[] = []): CandidateMatch[] {
  const base = identity(current);
  if (base) {
    const candidates = available.filter((candidate) => {
      if (candidate.provider !== current.provider || candidate.id === current.id) return false;
      const next = identity(candidate);
      return !!next && next.family === base.family && compareVersions(next.version, base.version) > 0;
    });
    return highestPerVersion(candidates, (m) => identity(m)!.version);
  }

  const rule = rules.find((item) => item.provider === current.provider && item.pattern.test(current.id));
  if (!rule) return [];
  rule.pattern.lastIndex = 0;
  const match = rule.pattern.exec(current.id);
  const currentVersion = match?.[1] && versionTuple(match[1]);
  const family = match && (rule.identity?.(current.id, match) ?? current.id.replace(match[1], "{version}"));
  if (!currentVersion || !family) return [];
  const candidates = available.filter((candidate) => {
    if (candidate.provider !== current.provider || candidate.id === current.id) return false;
    rule.pattern.lastIndex = 0;
    const candidateMatch = rule.pattern.exec(candidate.id);
    const candidateVersion = candidateMatch?.[1] && versionTuple(candidateMatch[1]);
    return !!candidateVersion && (rule.identity?.(candidate.id, candidateMatch!) ?? candidate.id.replace(candidateMatch![1], "{version}")) === family && compareVersions(candidateVersion, currentVersion) > 0;
  });
  return highestPerVersion(candidates, (candidate) => {
    rule.pattern.lastIndex = 0;
    return versionTuple(rule.pattern.exec(candidate.id)![1])!;
  });
}

function highestPerVersion(models: ModelLike[], getVersion: (m: ModelLike) => number[]): CandidateMatch[] {
  if (!models.length) return [];
  let highest = getVersion(models[0]);
  for (const model of models.slice(1)) if (compareVersions(getVersion(model), highest) > 0) highest = getVersion(model);
  const best = models.filter((model) => compareVersions(getVersion(model), highest) === 0);
  const unique = new Map(best.map((model) => [`${model.provider}/${model.id}`, model]));
  return [...unique.values()].map((model) => ({ model, reason: "higher-version" }));
}

export function metadataWarnings(current: ModelLike, candidate: ModelLike, thinkingLevel?: string): string[] {
  const warnings: string[] = [];
  if (current.reasoning !== candidate.reasoning) warnings.push("reasoning capability differs");
  if (JSON.stringify(current.input ?? []) !== JSON.stringify(candidate.input ?? [])) warnings.push("input capabilities differ");
  if (current.contextWindow !== candidate.contextWindow) warnings.push("context window differs");
  if (current.maxTokens !== candidate.maxTokens) warnings.push("max output differs");
  if (JSON.stringify(current.cost ?? {}) !== JSON.stringify(candidate.cost ?? {})) {
    warnings.push(`pricing differs: old ${JSON.stringify(current.cost ?? {})}, new ${JSON.stringify(candidate.cost ?? {})}`);
  }
  if (thinkingLevel && candidate.reasoning === false) warnings.push(`thinking level ${thinkingLevel} may not be supported`);
  return warnings;
}

export { compareVersions };

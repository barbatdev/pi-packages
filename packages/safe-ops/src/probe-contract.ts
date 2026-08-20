import type { StaticDecision } from "./manager-classifier.ts";

export type ProbeValueKind =
  | "version"
  | "boolean"
  | "unsigned_integer"
  | "registry"
  | "optional_scoped_registry"
  | "csv_package_names"
  | "json_string_list"
  | "json_boolean_map";

export type EvidenceTarget = Readonly<{
  field: "version" | "saveExact" | "minimumReleaseAge" | "releaseAgeExclusions" | "ignoreScripts" | "allowScripts" | "minimumReleaseAgeStrict" | "minimumReleaseAgeIgnoreMissingTime" | "blockExoticSubdeps" | "strictDepBuilds" | "dangerouslyAllowAllBuilds" | "allowBuilds" | "registry" | "scopeRegistries";
  scope?: string;
}>;

export type ProbeRequest = Readonly<{
  id: string;
  ordinal: number;
  argv: readonly string[];
  context: "normal" | "global";
  target: EvidenceTarget;
  valueKind: ProbeValueKind;
}>;

export type ProbePlan = Readonly<{
  executable: "npm" | "pnpm";
  requests: readonly ProbeRequest[];
  shell: false;
  timeoutMs: number;
  outputByteLimit: number;
  cache: "none";
}>;

export type ProbePlanResult =
  | Readonly<{ ok: true; value: ProbePlan }>
  | Readonly<{ ok: false; code: "static_decision_not_eligible" }>;

type ControlledDecision = Extract<StaticDecision, { kind: "needs_controls" }>;
type ProbeContext = ProbeRequest["context"];
type RequestTemplate = Readonly<{ key: string; target: EvidenceTarget; valueKind: ProbeValueKind; context: ProbeContext }>;
type ConfigRequestTemplate = Readonly<{ executable: ProbePlan["executable"]; key: string; target: EvidenceTarget; valueKind: ProbeValueKind; context: ProbeContext }>;

const NPM_CONTROLS: readonly RequestTemplate[] = [
  { key: "save-exact", target: { field: "saveExact" }, valueKind: "boolean", context: "normal" },
  { key: "min-release-age", target: { field: "minimumReleaseAge" }, valueKind: "unsigned_integer", context: "normal" },
  { key: "ignore-scripts", target: { field: "ignoreScripts" }, valueKind: "boolean", context: "normal" },
];
const PNPM_CONTROLS: readonly RequestTemplate[] = [
  { key: "saveExact", target: { field: "saveExact" }, valueKind: "boolean", context: "normal" },
  { key: "minimumReleaseAge", target: { field: "minimumReleaseAge" }, valueKind: "unsigned_integer", context: "normal" },
  { key: "minimumReleaseAgeStrict", target: { field: "minimumReleaseAgeStrict" }, valueKind: "boolean", context: "normal" },
  { key: "minimumReleaseAgeIgnoreMissingTime", target: { field: "minimumReleaseAgeIgnoreMissingTime" }, valueKind: "boolean", context: "normal" },
  { key: "minimumReleaseAgeExclude", target: { field: "releaseAgeExclusions" }, valueKind: "json_string_list", context: "normal" },
  { key: "ignoreScripts", target: { field: "ignoreScripts" }, valueKind: "boolean", context: "normal" },
  { key: "blockExoticSubdeps", target: { field: "blockExoticSubdeps" }, valueKind: "boolean", context: "normal" },
  { key: "strictDepBuilds", target: { field: "strictDepBuilds" }, valueKind: "boolean", context: "normal" },
  { key: "dangerouslyAllowAllBuilds", target: { field: "dangerouslyAllowAllBuilds" }, valueKind: "boolean", context: "normal" },
  { key: "allowBuilds", target: { field: "allowBuilds" }, valueKind: "json_boolean_map", context: "normal" },
];

function directScopes(decision: ControlledDecision): readonly string[] {
  return [...new Set(decision.packages.flatMap((item) => item.name.startsWith("@") ? [item.name.slice(0, item.name.indexOf("/"))] : []))];
}

function contextFor(decision: ControlledDecision, template: RequestTemplate): ProbeContext {
  return decision.global || decision.manager === "npm" && decision.operation === "exec_helper" && template.target.field === "allowScripts" ? "global" : template.context;
}

function appendConfigRequest(requests: ProbeRequest[], template: ConfigRequestTemplate): void {
  const ordinal = requests.length;
  const argv = template.context === "global" ? ["--global", "config", "get", template.key] : ["config", "get", template.key];
  requests.push(Object.freeze({
    id: `${template.executable}-${ordinal}`,
    ordinal,
    argv: Object.freeze(argv),
    context: template.context,
    target: Object.freeze({ ...template.target }),
    valueKind: template.valueKind,
  }));
}

function fixedRequests(decision: ControlledDecision): readonly ProbeRequest[] {
  const requests: ProbeRequest[] = [];
  requests.push(Object.freeze({
    id: `${decision.manager}-0`, ordinal: 0, argv: Object.freeze(["--version"]), context: "normal",
    target: Object.freeze({ field: "version" }), valueKind: "version",
  }));
  const templates = decision.manager === "npm" ? NPM_CONTROLS : PNPM_CONTROLS;
  for (const template of templates) {
    appendConfigRequest(requests, { ...template, executable: decision.manager, context: contextFor(decision, template) });
  }
  if (decision.manager === "npm" && (decision.operation === "exec_helper" || decision.global)) {
    appendConfigRequest(requests, { executable: decision.manager, key: "allow-scripts", target: { field: "allowScripts" }, valueKind: "csv_package_names", context: "global" });
  }
  const registryContext: ProbeContext = decision.global ? "global" : "normal";
  appendConfigRequest(requests, { executable: decision.manager, key: "registry", target: { field: "registry" }, valueKind: "registry", context: registryContext });
  for (const scope of directScopes(decision)) {
    appendConfigRequest(requests, { executable: decision.manager, key: `${scope}:registry`, target: { field: "scopeRegistries", scope }, valueKind: "optional_scoped_registry", context: registryContext });
  }
  return Object.freeze(requests);
}

/** Builds immutable, fixed, direct read-only manager requests with no shell or cache semantics. */
export function createProbePlan(decision: StaticDecision): ProbePlanResult {
  if (decision.kind !== "needs_controls") return { ok: false, code: "static_decision_not_eligible" };
  return { ok: true, value: Object.freeze({ executable: decision.manager, requests: fixedRequests(decision), shell: false, timeoutMs: 1_500, outputByteLimit: 8_192, cache: "none" }) };
}

import type { StaticDecision } from "./manager-classifier.ts";
import { isPublicPackageName } from "./package-spec.ts";

export type ControlEvidence = Readonly<{
  manager: "npm" | "pnpm";
  version: string;
  probeFailure?: "cancelled" | "malformed" | "nonzero" | "oversized" | "timeout" | "unexpected_key" | "unsupported";
  saveExact?: boolean;
  minimumReleaseAge?: number;
  releaseAgeExclusions?: readonly string[];
  ignoreScripts?: boolean;
  allowScripts?: readonly string[];
  minimumReleaseAgeStrict?: boolean;
  minimumReleaseAgeIgnoreMissingTime?: boolean;
  blockExoticSubdeps?: boolean;
  strictDepBuilds?: boolean;
  dangerouslyAllowAllBuilds?: boolean;
  allowBuilds?: Readonly<Record<string, boolean>>;
  registry?: string;
  scopeRegistries?: Readonly<Record<string, string>>;
}>;

export type EvidenceDecision =
  | Readonly<{ kind: "allow" }>
  | Readonly<{ kind: "block"; code: string; remediation: string }>;

type ControlledDecision = Extract<StaticDecision, { kind: "needs_controls" }>;
type EvidenceFailureCode =
  | "static_decision_not_eligible"
  | "probe_failure_cancelled"
  | "probe_failure_malformed"
  | "probe_failure_nonzero"
  | "probe_failure_oversized"
  | "probe_failure_timeout"
  | "probe_failure_unexpected_key"
  | "probe_failure_unsupported"
  | "manager_mismatch"
  | "unsupported_manager_version"
  | "save_exact_disabled_or_missing"
  | "release_age_too_low_or_malformed"
  | "release_age_exclusions_nonempty_or_malformed"
  | "untrusted_default_registry"
  | "untrusted_direct_scope_registry"
  | "npm_lifecycle_scripts_unproven"
  | "pnpm_minimum_age_strictness_missing"
  | "pnpm_missing_time_bypass"
  | "pnpm_exotic_subdeps_not_blocked"
  | "pnpm_helper_scripts_not_disabled"
  | "pnpm_lifecycle_build_policy_unsafe";

const PUBLIC_REGISTRY = "https://registry.npmjs.org/";
const PROBE_FAILURE_CODES: Readonly<Record<NonNullable<ControlEvidence["probeFailure"]>, EvidenceFailureCode>> = {
  cancelled: "probe_failure_cancelled",
  malformed: "probe_failure_malformed",
  nonzero: "probe_failure_nonzero",
  oversized: "probe_failure_oversized",
  timeout: "probe_failure_timeout",
  unexpected_key: "probe_failure_unexpected_key",
  unsupported: "probe_failure_unsupported",
};
const REMEDIATIONS: Readonly<Record<EvidenceFailureCode, string>> = {
  static_decision_not_eligible: "Use a supported static package-manager acquisition or execution-helper command first.",
  probe_failure_cancelled: "Wait for a non-cancelled bounded manager probe before retrying the supported command.",
  probe_failure_malformed: "Re-run the bounded manager probe and provide normalized supported evidence.",
  probe_failure_nonzero: "Re-run the bounded manager probe and provide normalized supported evidence.",
  probe_failure_oversized: "Re-run the bounded manager probe and provide normalized supported evidence.",
  probe_failure_timeout: "Re-run the bounded manager probe and provide normalized supported evidence.",
  probe_failure_unexpected_key: "Re-run the bounded manager probe and provide normalized supported evidence.",
  probe_failure_unsupported: "Use a manager version supported by the V1 conformance adapter.",
  manager_mismatch: "Probe the same package manager selected by the static command.",
  unsupported_manager_version: "Use the exact manager version supported by the V1 conformance adapter.",
  save_exact_disabled_or_missing: "Enable and prove the manager exact-save control.",
  release_age_too_low_or_malformed: "Set and prove the required minimum release age.",
  release_age_exclusions_nonempty_or_malformed: "Remove release-age exclusions and prove an empty exclusion list.",
  untrusted_default_registry: "Use and prove the public default registry.",
  untrusted_direct_scope_registry: "Use and prove the public registry for every direct package scope.",
  npm_lifecycle_scripts_unproven: "Disable npm lifecycle scripts or allowlist every direct package for the supported helper/global form.",
  pnpm_minimum_age_strictness_missing: "Enable and prove strict pnpm minimum release age enforcement.",
  pnpm_missing_time_bypass: "Disable and prove the pnpm missing-release-time bypass is off.",
  pnpm_exotic_subdeps_not_blocked: "Enable and prove pnpm exotic subdependency blocking.",
  pnpm_helper_scripts_not_disabled: "For pnpm dlx/pnx, prove ignoreScripts=true; strict build policy evidence is insufficient for temporary installation.",
  pnpm_lifecycle_build_policy_unsafe: "Disable pnpm scripts or prove the supported strict build allowlist policy.",
};

function block(code: EvidenceFailureCode): EvidenceDecision {
  return { kind: "block", code, remediation: REMEDIATIONS[code] };
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function requestedScopes(decision: ControlledDecision): readonly string[] {
  return [...new Set(decision.packages.flatMap((item) => item.name.startsWith("@") ? [item.name.slice(0, item.name.indexOf("/"))] : []))];
}

function hasTrustedRegistries(evidence: ControlEvidence, requiredScopes: readonly string[]): EvidenceFailureCode | undefined {
  if (evidence.registry !== PUBLIC_REGISTRY) return "untrusted_default_registry";
  if (evidence.scopeRegistries === undefined) return "untrusted_direct_scope_registry";
  if (!Object.entries(evidence.scopeRegistries).every(([scope, registry]) => isPublicPackageName(scope.slice(1)) && scope.startsWith("@") && registry === PUBLIC_REGISTRY)) {
    return "untrusted_direct_scope_registry";
  }
  return requiredScopes.every((scope) => evidence.scopeRegistries?.[scope] === PUBLIC_REGISTRY) ? undefined : "untrusted_direct_scope_registry";
}

function requestedNamesCovered(decision: ControlledDecision, allowScripts: unknown): boolean {
  if (!isStringArray(allowScripts) || !allowScripts.every(isPublicPackageName)) return false;
  const allowed = new Set(allowScripts);
  return decision.packages.every((item) => allowed.has(item.name));
}

function meetsMinimum(value: unknown, minimum: number): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function hasSafePnpmAllowBuilds(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(([name, enabled]) => !name.startsWith("@") && isPublicPackageName(name) && typeof enabled === "boolean");
}

function commonEvidenceFailure(decision: ControlledDecision, evidence: ControlEvidence, version: string, minimumAge: number): EvidenceFailureCode | undefined {
  if (evidence.version !== version) return "unsupported_manager_version";
  if (evidence.saveExact !== true) return "save_exact_disabled_or_missing";
  if (!meetsMinimum(evidence.minimumReleaseAge, minimumAge)) return "release_age_too_low_or_malformed";
  if (!isStringArray(evidence.releaseAgeExclusions) || evidence.releaseAgeExclusions.length !== 0) return "release_age_exclusions_nonempty_or_malformed";
  return hasTrustedRegistries(evidence, requestedScopes(decision));
}

function npmEvidenceFailure(decision: ControlledDecision, evidence: ControlEvidence): EvidenceFailureCode | undefined {
  const commonFailure = commonEvidenceFailure(decision, evidence, "11.16.0", 7);
  if (commonFailure !== undefined) return commonFailure;

  const executionHelperOrGlobal = decision.operation === "exec_helper" || decision.global;
  const scriptsSafe = evidence.ignoreScripts === true || executionHelperOrGlobal && requestedNamesCovered(decision, evidence.allowScripts);
  return scriptsSafe ? undefined : "npm_lifecycle_scripts_unproven";
}

function pnpmEvidenceFailure(decision: ControlledDecision, evidence: ControlEvidence): EvidenceFailureCode | undefined {
  const commonFailure = commonEvidenceFailure(decision, evidence, "11.21.0", 10080);
  if (commonFailure !== undefined) return commonFailure;
  if (evidence.minimumReleaseAgeStrict !== true) return "pnpm_minimum_age_strictness_missing";
  if (evidence.minimumReleaseAgeIgnoreMissingTime !== false) return "pnpm_missing_time_bypass";
  if (evidence.blockExoticSubdeps !== true) return "pnpm_exotic_subdeps_not_blocked";
  if (evidence.ignoreScripts === true) return undefined;
  if (decision.operation === "exec_helper") return "pnpm_helper_scripts_not_disabled";

  const buildsSafe = evidence.dangerouslyAllowAllBuilds === false && evidence.strictDepBuilds === true && hasSafePnpmAllowBuilds(evidence.allowBuilds);
  return buildsSafe ? undefined : "pnpm_lifecycle_build_policy_unsafe";
}

/** Evaluates bounded, normalized probe evidence; it never receives raw process output. */
export function evaluateControlEvidence(decision: StaticDecision, evidence: ControlEvidence): EvidenceDecision {
  if (decision.kind !== "needs_controls") return block("static_decision_not_eligible");
  if (evidence.probeFailure !== undefined) return block(PROBE_FAILURE_CODES[evidence.probeFailure]);
  if (evidence.manager !== decision.manager) return block("manager_mismatch");

  const failure = decision.manager === "npm" ? npmEvidenceFailure(decision, evidence) : pnpmEvidenceFailure(decision, evidence);
  return failure === undefined ? { kind: "allow" } : block(failure);
}

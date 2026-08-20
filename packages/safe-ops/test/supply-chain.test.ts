import assert from "node:assert/strict";
import test from "node:test";

import { evaluateControlEvidence, type ControlEvidence } from "../src/control-evidence.ts";
import { classifyManagerSegment, classifyManagerSegments } from "../src/manager-classifier.ts";
import { isPublicPackageName, validatePackageSpec } from "../src/package-spec.ts";
import { createProbePlan } from "../src/probe-contract.ts";

type Segment = { precedingOperator: null | ";" | "newline" | "&&" | "||" | "|"; tokens: readonly string[] };

function staticDecision(tokens: readonly string[]) {
  return classifyManagerSegment({ precedingOperator: null, tokens });
}

function needsControls(tokens: readonly string[]) {
  const decision = staticDecision(tokens);
  assert.equal(decision.kind, "needs_controls", `expected controls for ${tokens.join(" ")}`);
  return decision;
}

function npmEvidence(overrides: Partial<ControlEvidence> = {}): ControlEvidence {
  return {
    manager: "npm",
    version: "11.16.0",
    saveExact: true,
    minimumReleaseAge: 7,
    releaseAgeExclusions: [],
    ignoreScripts: true,
    allowScripts: [],
    registry: "https://registry.npmjs.org/",
    scopeRegistries: {},
    ...overrides,
  };
}

function pnpmEvidence(overrides: Partial<ControlEvidence> = {}): ControlEvidence {
  return {
    manager: "pnpm",
    version: "11.21.0",
    saveExact: true,
    minimumReleaseAge: 10080,
    minimumReleaseAgeStrict: true,
    minimumReleaseAgeIgnoreMissingTime: false,
    releaseAgeExclusions: [],
    ignoreScripts: true,
    blockExoticSubdeps: true,
    strictDepBuilds: true,
    dangerouslyAllowAllBuilds: false,
    allowBuilds: {},
    registry: "https://registry.npmjs.org/",
    scopeRegistries: {},
    ...overrides,
  };
}

test("package specs accept only stable exact public-registry versions", () => {
  for (const raw of ["foo@1.2.3", "@scope/pkg@0.0.1", "foo-bar_2@99.10.0"]) {
    const result = validatePackageSpec(raw);
    assert.deepEqual(result.ok ? result.value : result, result.ok ? { name: raw.slice(0, raw.lastIndexOf("@")), version: raw.slice(raw.lastIndexOf("@") + 1) } : result, raw);
  }

  for (const raw of [
    "foo", "foo@v1.2.3", "foo@1.2", "foo@1.2.3-beta", "foo@1.2.3+build", "foo@latest", "foo@^1.2.3",
    "foo@*", "foo@>=1.2.3", "foo@npm:bar@1.2.3", "git+https://example.test/a", "file:../a", "link:../a",
    "workspace:*", "catalog:foo", "https://example.test/a.tgz", "@scope/@1.2.3", "bad name@1.2.3", "", "foo@1.2.3@registry",
  ]) {
    assert.equal(validatePackageSpec(raw).ok, false, raw);
  }
});

test("package names use bounded public-registry syntax", () => {
  for (const name of ["a", "foo", "foo-bar_2", "@s/p", "@scope/pkg-name_2"]) {
    assert.equal(isPublicPackageName(name), true, name);
  }

  for (const name of ["", "-foo", "foo-", ".foo", "foo.", "@scope-/pkg", "@scope/pkg_", "@Scope/pkg", "foo/bar", "a".repeat(215), "@scope/" + "a".repeat(210)]) {
    assert.equal(isPublicPackageName(name), false, name);
  }
});

test("static classification allows only bounded exact acquisition grammars", () => {
  const allowed = [
    ["npm", "install", "foo@1.2.3", "@scope/pkg@2.3.4"],
    ["npm", "--workspace=web", "--global", "i", "foo@1.2.3"],
    ["npm", "install", "--global", "--workspace", "web", "foo@1.2.3"],
    ["npx", "foo@1.2.3"],
    ["npx", "--yes", "foo@1.2.3", "payload", "--not-a-spec"],
    ["npm", "--workspace=web", "exec", "--package", "foo@1.2.3", "--", "payload"],
    ["npm", "exec", "--package", "foo@1.2.3", "--", "payload", "--not-a-spec"],
    ["npm", "install", "-D", "foo@1.2.3", "--save-peer"],
    ["npm", "install", "foo@1.2.3", "--save-dev", "-O"],
    ["pnpm", "--filter", "web", "--global", "add", "foo@1.2.3", "@scope/pkg@2.3.4"],
    ["pnpm", "add", "--global", "--filter=web", "foo@1.2.3"],
    ["pnpm", "add", "--save-dev", "foo@1.2.3", "--save-peer"],
    ["pnpm", "add", "foo@1.2.3", "-D", "--save-optional"],
    ["pnpm", "dlx", "foo@1.2.3"],
    ["pnx", "foo@1.2.3"],
    ["pnpm", "dlx", "foo@1.2.3", "--", "payload", "--registry=https://attacker.example/"],
    ["pnx", "foo@1.2.3", "--", "payload", "--ignore-scripts=false"],
  ];

  for (const tokens of allowed) {
    const decision = needsControls(tokens);
    assert.ok(decision.packages.length > 0, tokens.join(" "));
  }
  const pnx = needsControls(["pnx", "foo@1.2.3", "--", "payload"]);
  assert.deepEqual(pnx, { kind: "needs_controls", manager: "pnpm", operation: "exec_helper", packages: [{ name: "foo", version: "1.2.3" }], global: false });

  for (const tokens of [
    ["npm", "install"], ["npm", "ci"], ["npm", "update", "foo@1.2.3"], ["npm", "x", "foo@1.2.3"], ["npm", "init", "foo@1.2.3"], ["npm", "create", "foo@1.2.3"], ["pnpm", "install"], ["pnpm", "--frozen-lockfile", "add", "foo@1.2.3"], ["pnpm", "up", "foo@1.2.3"], ["pnpm", "create", "foo@1.2.3"],
    ["npm", "install", "foo@^1.2.3"], ["npm", "install", "foo@latest"], ["npm", "install", "foo@1.2.3-beta"], ["npm", "install", "foo@1.2.3+build"], ["npm", "install", "foo@npm:bar@1.2.3"], ["npm", "install", "file:../foo"],
    ["npm", "--registry=https://evil.test", "install", "foo@1.2.3"], ["npm", "install", "foo@1.2.3", "--force"], ["npm", "install", "--", "foo@1.2.3"], ["npm", "exec", "foo@1.2.3"], ["npm", "exec", "--package", "foo@1.2.3", "--"], ["npx", "--package", "foo@1.2.3"], ["npx", "foo"], ["pnpm", "dlx", "foo"], ["pnpm", "dlx", "foo@1.2.3", "payload"], ["pnpm", "dlx", "foo@1.2.3", "--registry=https://attacker.example/"], ["pnpm", "dlx", "foo@1.2.3", "payload", "--registry=https://attacker.example/"], ["pnx", "foo@1.2.3", "--ignore-scripts=false"], ["pnx", "foo@1.2.3", "payload", "--ignore-scripts=false"],
    ["NODE_ENV=test", "npm", "install", "foo@1.2.3"], ["sudo", "npm", "install", "foo@1.2.3"], ["corepack", "pnpm", "add", "foo@1.2.3"], ["env", "npm", "install", "foo@1.2.3"], ["sh", "-c", "npm install foo@1.2.3"], ["eval", "npm", "install", "foo@1.2.3"],
  ]) {
    assert.equal(staticDecision(tokens).kind, "block", tokens.join(" "));
  }

  const composed: Segment = { precedingOperator: "&&", tokens: ["npm", "install", "foo@1.2.3"] };
  assert.equal(classifyManagerSegment(composed).kind, "block");
  assert.equal(classifyManagerSegments([
    { precedingOperator: null, tokens: ["npm", "install", "foo@1.2.3"] },
    { precedingOperator: "&&", tokens: ["echo", "done"] },
  ]).kind, "block");
  assert.equal(staticDecision(["echo", "safe"]).kind, "not_applicable");
  assert.equal(staticDecision(["echo", "npm install foo@1.2.3"]).kind, "not_applicable");
  for (const tokens of [
    ["npm", "run", "build"], ["npm", "test"], ["npm", "view", "foo"], ["npm", "config", "get", "registry"],
    ["pnpm", "run", "build"], ["pnpm", "test"], ["pnpm", "view", "foo"], ["pnpm", "config", "get", "registry"],
  ]) {
    assert.equal(staticDecision(tokens).kind, "not_applicable", tokens.join(" "));
  }
});

test("npx treats post-package argv as executable payload while unsupported pre-package options block", () => {
  const packageOnly = needsControls(["npx", "foo@1.2.3"]);
  assert.deepEqual(needsControls(["npx", "-y", "foo@1.2.3"]), packageOnly);
  assert.deepEqual(needsControls(["npx", "--yes", "foo@1.2.3"]), packageOnly);
  const payload = needsControls(["npx", "foo@1.2.3", "--registry=https://attacker.example/", "--ignore-scripts=false"]);
  assert.deepEqual(payload, packageOnly);
  assert.equal(staticDecision(["npx", "--registry=https://attacker.example/", "foo@1.2.3"]).kind, "block");
  assert.equal(staticDecision(["npx", "--ignore-scripts=false", "foo@1.2.3"]).kind, "block");
});

test("wrapper and executable-path acquisitions block without matching arbitrary literal arguments", () => {
  for (const tokens of [
    ["command", "npm", "install", "foo@1.2.3"],
    ["exec", "pnpm", "add", "foo@1.2.3"],
    ["command", "npx", "foo@1.2.3"],
    ["exec", "pnx", "foo@1.2.3"],
    ["env", "NAME=value", "npm", "install", "foo@1.2.3"],
    ["/usr/bin/npm", "install", "foo@1.2.3"],
    ["./node_modules/.bin/pnpm", "add", "foo@1.2.3"],
    ["/usr/bin/npx", "foo@1.2.3"],
    ["./node_modules/.bin/pnx", "foo@1.2.3"],
  ]) {
    const decision = staticDecision(tokens);
    assert.equal(decision.kind, "block", tokens.join(" "));
    if (decision.kind === "block") assert.equal(decision.code, "unsupported_wrapper_or_path");
  }

  for (const tokens of [
    ["env", "echo", "npm install foo@1.2.3"],
    ["echo", "npm install foo@1.2.3"],
    ["command", "-v", "npm"],
    ["command", "-V", "npm"],
    ["npm", "--silent", "--version"],
    ["pnpm", "--reporter=silent", "list"],
  ]) {
    assert.equal(staticDecision(tokens).kind, "not_applicable", tokens.join(" "));
  }

  for (const tokens of [
    ["npm", "--silent", "install", "foo@1.2.3"],
    ["pnpm", "--reporter=silent", "add", "foo@1.2.3"],
  ]) {
    assert.equal(staticDecision(tokens).kind, "block", tokens.join(" "));
  }
});

test("evidence allows exact supported npm and pnpm controls", () => {
  assert.equal(evaluateControlEvidence(needsControls(["npm", "install", "foo@1.2.3"]), npmEvidence()).kind, "allow");
  assert.equal(evaluateControlEvidence(needsControls(["npm", "--global", "install", "foo@1.2.3"]), npmEvidence({ ignoreScripts: false, allowScripts: ["foo"] })).kind, "allow");
  assert.equal(evaluateControlEvidence(needsControls(["pnpm", "add", "@scope/pkg@1.2.3"]), pnpmEvidence({ scopeRegistries: { "@scope": "https://registry.npmjs.org/" } })).kind, "allow");
  assert.equal(evaluateControlEvidence(needsControls(["pnpm", "add", "foo@1.2.3"]), pnpmEvidence({ ignoreScripts: false, allowBuilds: { foo: true } })).kind, "allow");
});

test("pnpm dlx and pnx require scripts disabled for temporary installation", () => {
  const helperBuildPolicy = {
    ignoreScripts: false,
    strictDepBuilds: true,
    dangerouslyAllowAllBuilds: false,
    allowBuilds: {},
  };
  for (const tokens of [["pnpm", "dlx", "foo@1.2.3"], ["pnx", "foo@1.2.3"]]) {
    const result = evaluateControlEvidence(needsControls(tokens), pnpmEvidence(helperBuildPolicy));
    assert.deepEqual(result, {
      kind: "block",
      code: "pnpm_helper_scripts_not_disabled",
      remediation: "For pnpm dlx/pnx, prove ignoreScripts=true; strict build policy evidence is insufficient for temporary installation.",
    });
    assert.equal(evaluateControlEvidence(needsControls(tokens), pnpmEvidence({ ...helperBuildPolicy, ignoreScripts: true })).kind, "allow");
  }
  assert.equal(evaluateControlEvidence(needsControls(["pnpm", "add", "foo@1.2.3"]), pnpmEvidence(helperBuildPolicy)).kind, "allow");
});

test("evidence reports specific bounded remediation codes", () => {
  const npmDecision = needsControls(["npm", "--global", "install", "foo@1.2.3"]);
  const pnpmDecision = needsControls(["pnpm", "add", "foo@1.2.3"]);
  const cases: ReadonlyArray<readonly [ControlEvidence, string]> = [
    [npmEvidence({ probeFailure: "cancelled" }), "probe_failure_cancelled"],
    [npmEvidence({ probeFailure: "timeout" }), "probe_failure_timeout"],
    [npmEvidence({ manager: "pnpm" }), "manager_mismatch"],
    [npmEvidence({ version: "11.15.0" }), "unsupported_manager_version"],
    [npmEvidence({ saveExact: false }), "save_exact_disabled_or_missing"],
    [npmEvidence({ minimumReleaseAge: 6 }), "release_age_too_low_or_malformed"],
    [npmEvidence({ releaseAgeExclusions: ["foo"] }), "release_age_exclusions_nonempty_or_malformed"],
    [npmEvidence({ registry: "https://evil.test/" }), "untrusted_default_registry"],
    [npmEvidence({ ignoreScripts: false, allowScripts: [] }), "npm_lifecycle_scripts_unproven"],
    [pnpmEvidence({ minimumReleaseAgeIgnoreMissingTime: true }), "pnpm_missing_time_bypass"],
    [pnpmEvidence({ blockExoticSubdeps: false }), "pnpm_exotic_subdeps_not_blocked"],
    [pnpmEvidence({ minimumReleaseAgeStrict: false }), "pnpm_minimum_age_strictness_missing"],
    [pnpmEvidence({ ignoreScripts: false, dangerouslyAllowAllBuilds: true }), "pnpm_lifecycle_build_policy_unsafe"],
  ];
  for (const [evidence, code] of cases) {
    const decision = code === "manager_mismatch" || evidence.manager === "npm" ? npmDecision : pnpmDecision;
    const result = evaluateControlEvidence(decision, evidence);
    assert.equal(result.kind, "block");
    if (result.kind === "block") assert.equal(result.code, code);
  }
});

test("evidence remediation is concrete without reflecting probe values", () => {
  const npmDecision = needsControls(["npm", "install", "@scope/foo@1.2.3"]);
  const probeFailure = evaluateControlEvidence(npmDecision, npmEvidence({ probeFailure: "timeout" }));
  assert.deepEqual(probeFailure, {
    kind: "block",
    code: "probe_failure_timeout",
    remediation: "Re-run the bounded manager probe and provide normalized supported evidence.",
  });
  const scopeRegistry = evaluateControlEvidence(npmDecision, npmEvidence({ scopeRegistries: {} }));
  assert.deepEqual(scopeRegistry, {
    kind: "block",
    code: "untrusted_direct_scope_registry",
    remediation: "Use and prove the public registry for every direct package scope.",
  });
});

test("evidence fails closed for weak, missing, malformed, and unsupported values", () => {
  const npmDecision = needsControls(["npm", "--global", "install", "foo@1.2.3"]);
  const pnpmDecision = needsControls(["pnpm", "add", "foo@1.2.3"]);
  for (const evidence of [
    npmEvidence({ version: "11.15.0" }), npmEvidence({ saveExact: false }), npmEvidence({ minimumReleaseAge: 6 }), npmEvidence({ releaseAgeExclusions: ["foo"] }), npmEvidence({ ignoreScripts: false, allowScripts: [] }), npmEvidence({ registry: "https://evil.test/" }), npmEvidence({ scopeRegistries: { "@scope": "https://evil.test/" } }), npmEvidence({ probeFailure: "timeout" }),
  ]) {
    assert.equal(evaluateControlEvidence(npmDecision, evidence).kind, "block");
  }
  for (const evidence of [
    pnpmEvidence({ version: "11.20.0" }), pnpmEvidence({ minimumReleaseAge: 10079 }), pnpmEvidence({ minimumReleaseAgeStrict: false }), pnpmEvidence({ minimumReleaseAgeIgnoreMissingTime: true }), pnpmEvidence({ releaseAgeExclusions: ["foo"] }), pnpmEvidence({ blockExoticSubdeps: false }), pnpmEvidence({ ignoreScripts: false, dangerouslyAllowAllBuilds: true }), pnpmEvidence({ ignoreScripts: false, strictDepBuilds: false }), pnpmEvidence({ ignoreScripts: false, allowBuilds: { foo: "yes" as never } }), pnpmEvidence({ probeFailure: "malformed" }),
  ]) {
    assert.equal(evaluateControlEvidence(pnpmDecision, evidence).kind, "block");
  }
});

test("probe plans use fixed direct argv and deduplicated direct scopes without execution", () => {
  const npm = createProbePlan(needsControls(["npm", "install", "@scope/a@1.2.3", "@scope/b@2.3.4", "foo@1.0.0"]));
  assert.equal(npm.ok, true);
  if (npm.ok) {
    assert.equal(npm.value.executable, "npm");
    assert.deepEqual(npm.value.requests[0]?.argv, ["--version"]);
    assert.equal(npm.value.requests[0]?.context, "normal");
    assert.ok(npm.value.requests.some((request) => request.argv.join(" ") === "config get @scope:registry"));
    assert.equal(npm.value.requests.filter((request) => request.argv.join(" ") === "config get @scope:registry").length, 1);
    assert.ok(npm.value.requests.every((request) => !request.argv.some((token) => ["install", "exec", "list", "--shell"].includes(token))));
  }

  const pnpm = createProbePlan(needsControls(["pnpm", "add", "@scope/a@1.2.3"]));
  assert.equal(pnpm.ok, true);
  if (pnpm.ok) {
    assert.equal(pnpm.value.executable, "pnpm");
    assert.ok(pnpm.value.requests.some((request) => request.argv.join(" ") === "config get minimumReleaseAgeStrict"));
    assert.ok(pnpm.value.requests.every((request) => request.argv[0] === "--version" || request.argv.slice(0, 2).join(" ") === "config get"));
  }
});

test("probe plans bind immutable structured requests to exact argv, context, target, and value kind", () => {
  const npm = createProbePlan(needsControls(["npm", "install", "@scope/a@1.2.3"]));
  const pnpm = createProbePlan(needsControls(["pnpm", "add", "@scope/a@1.2.3"]));
  assert.equal(npm.ok, true);
  assert.equal(pnpm.ok, true);
  if (!npm.ok || !pnpm.ok) return;

  assert.deepEqual(npm.value.requests[0], {
    id: "npm-0", ordinal: 0, argv: ["--version"], context: "normal",
    target: { field: "version" }, valueKind: "version",
  });
  assert.equal(npm.value.requests.some((request) => request.target.field === "releaseAgeExclusions"), false);
  assert.ok(pnpm.value.requests.some((request) => request.target.field === "releaseAgeExclusions" && request.valueKind === "json_string_list"));
  assert.ok(pnpm.value.requests.some((request) => request.target.field === "allowBuilds" && request.valueKind === "json_boolean_map"));
  const scope = npm.value.requests.find((request) => request.target.field === "scopeRegistries");
  assert.deepEqual(scope?.target, { field: "scopeRegistries", scope: "@scope" });
  assert.equal(scope?.valueKind, "optional_scoped_registry");
  assert.ok(npm.value.requests.every((request) => Object.isFrozen(request)));
});

test("probe plans bind global config requests to explicit argv and context", () => {
  const globalNpm = createProbePlan(needsControls(["npm", "--global", "install", "foo@1.2.3"]));
  const npmExec = createProbePlan(needsControls(["npm", "exec", "--package", "foo@1.2.3", "--", "payload"]));
  const globalPnpm = createProbePlan(needsControls(["pnpm", "--global", "add", "foo@1.2.3"]));
  assert.equal(globalNpm.ok, true);
  assert.equal(npmExec.ok, true);
  assert.equal(globalPnpm.ok, true);
  if (!globalNpm.ok || !npmExec.ok || !globalPnpm.ok) return;

  assert.deepEqual(globalNpm.value.requests[0]?.argv, ["--version"]);
  assert.equal(globalNpm.value.requests[0]?.context, "normal");
  assert.ok(globalNpm.value.requests.every((request) => request.argv[0] === "--version" || request.context === "global" && request.argv[0] === "--global"));
  const globalSaveExact = globalNpm.value.requests.find((request) => request.argv.at(-1) === "save-exact");
  const normalSaveExact = npmExec.value.requests.find((request) => request.argv.at(-1) === "save-exact");
  assert.deepEqual(globalSaveExact?.argv, ["--global", "config", "get", "save-exact"]);
  assert.equal(globalSaveExact?.context, "global");
  assert.deepEqual(normalSaveExact?.argv, ["config", "get", "save-exact"]);
  assert.equal(normalSaveExact?.context, "normal");
  assert.notDeepEqual(globalSaveExact, normalSaveExact);
  assert.ok(npmExec.value.requests.some((request) => request.context === "global" && request.argv.join(" ") === "--global config get allow-scripts"));
  assert.ok(npmExec.value.requests.some((request) => request.context === "normal" && request.argv.join(" ") === "config get save-exact"));
  assert.ok(globalPnpm.value.requests.every((request) => request.argv[0] === "--version" || request.context === "global" && request.argv[0] === "--global"));
});

test("supply-chain contracts do not mutate caller-owned segments, evidence, or requests", () => {
  const segment: Segment = { precedingOperator: null, tokens: ["npm", "install", "@scope/pkg@1.2.3"] };
  const segmentBefore = structuredClone(segment);
  const decision = classifyManagerSegment(segment);
  assert.deepEqual(segment, segmentBefore);
  assert.equal(decision.kind, "needs_controls");
  if (decision.kind !== "needs_controls") return;

  const evidence = npmEvidence({ scopeRegistries: { "@scope": "https://registry.npmjs.org/" } });
  const evidenceBefore = structuredClone(evidence);
  evaluateControlEvidence(decision, evidence);
  assert.deepEqual(evidence, evidenceBefore);

  const plan = createProbePlan(decision);
  assert.equal(plan.ok, true);
  assert.deepEqual(segment, segmentBefore);
});

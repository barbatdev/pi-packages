import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import extension from "../src/index.ts";
import { createProbeRunner, normalizeProbeOutputs, type SpawnChild, type SpawnDependency } from "../src/probe-runner.ts";
import { createRuntimeHandler } from "../src/runtime.ts";
import type { ProbePlan } from "../src/probe-contract.ts";
import type { ControlEvidence } from "../src/control-evidence.ts";

const npmEvidence: ControlEvidence = {
  manager: "npm", version: "11.16.0", saveExact: true, minimumReleaseAge: 7,
  releaseAgeExclusions: [], ignoreScripts: true, allowScripts: [],
  registry: "https://registry.npmjs.org/", scopeRegistries: {},
};

function event(command: string, toolName = "bash") {
  return { toolName, input: { command } };
}

function plan(): ProbePlan {
  return {
    executable: "npm", shell: false, timeoutMs: 20, outputByteLimit: 32, cache: "none",
    requests: [
      { id: "npm-0", ordinal: 0, argv: ["--version"], context: "normal", target: { field: "version" }, valueKind: "version" },
      { id: "npm-1", ordinal: 1, argv: ["config", "get", "save-exact"], context: "normal", target: { field: "saveExact" }, valueKind: "boolean" },
      { id: "npm-2", ordinal: 2, argv: ["config", "get", "registry"], context: "normal", target: { field: "registry" }, valueKind: "registry" },
    ],
  };
}

test("default extension factory registers exactly one tool_call handler", () => {
  const registrations: Array<{ name: string; handler: unknown }> = [];
  (extension as unknown as (pi: { on(name: string, handler: unknown): void }) => void)({
    on(name, handler) { registrations.push({ name, handler }); },
  });
  assert.deepEqual(registrations.map((entry) => entry.name), ["tool_call"]);
});

test("runtime registers and handles only Bash without input mutation or UI", async () => {
  let runs = 0;
  const handler = createRuntimeHandler({
    isBashEvent: (value): value is { input: { command: string } } => (value as { toolName?: string }).toolName === "bash",
    runProbePlan: async () => { runs += 1; return npmEvidence; },
  });
  const input = event("npm install foo@1.2.3");
  const before = structuredClone(input);
  assert.equal(await handler(event("echo safe", "read"), { cwd: "/repo", hasUI: false, signal: new AbortController().signal }), undefined);
  assert.equal(await handler(event("echo safe"), { cwd: "/repo", hasUI: false, signal: new AbortController().signal }), undefined);
  assert.equal(await handler(input, { cwd: "/repo", hasUI: false, signal: new AbortController().signal }), undefined);
  assert.equal(runs, 1);
  assert.deepEqual(input, before);
});

test("runtime fail-closes lexed candidates and leaves malformed unrelated shell alone", async () => {
  const handler = createRuntimeHandler({
    isBashEvent: (value): value is { input: { command: string } } => (value as { toolName?: string }).toolName === "bash",
    runProbePlan: async () => npmEvidence,
  });
  const context = { cwd: "/repo", hasUI: false, signal: new AbortController().signal };
  const manager = await handler(event("npm install 'unterminated"), context);
  const sql = await handler(event("psql -c 'DROP TABLE x' $bad"), context);
  assert.equal(manager?.block, true);
  assert.equal(sql?.block, true);
  assert.equal(await handler(event("echo 'unterminated"), context), undefined);
  assert.ok(!manager?.reason.includes("unterminated"));
});

test("runtime conservatively blocks malformed shell candidates without executing probes", async () => {
  const handler = createRuntimeHandler({
    runProbePlan: async () => assert.fail("malformed-shell candidate detection must not probe"),
  });
  const context = { cwd: "/repo", hasUI: false, signal: new AbortController().signal };
  const candidates = [
    "p\\sql -c 'DROP TABLE accounts' $x",
    "p\\" + "\n" + "sql -c 'DROP TABLE accounts' $x",
    "n\\pm install foo@1.2.3 $x",
    "p's'ql -c 'DROP TABLE accounts' $x",
    "'n''pm' install foo@1.2.3 $x",
    "/usr/bin/p's'ql -c 'DROP TABLE accounts' $x",
    "/usr/bin/'n''pm' install foo@1.2.3 $x",
    "p${EMPTY}sql -c 'DROP TABLE accounts' $x",
    "n$(printf p)m install foo@1.2.3 $x",
    "$COMMAND --version",
    "command p\\sql -c 'DROP TABLE accounts' $x",
    "exec n\\pm install foo@1.2.3 $x",
    "env CI=1 p\\sql -c 'DROP TABLE accounts' $x",
    ">audit p\\sql -c 'DROP TABLE accounts' $x",
    "echo ok; n\\pm install foo@1.2.3 $x",
    "(p\\sql -c 'DROP TABLE accounts' $x)",
    "sudo p\\sql -c 'DROP TABLE accounts' $x",
    "corepack n\\pm install foo@1.2.3 $x",
    "sudo --user root p\\sql -c 'DROP TABLE accounts' $x",
    "corepack --install-directory bin n\\pm install foo@1.2.3 $x",
    "sudo corepack --install-directory bin n\\pm install foo@1.2.3 $x",
  ];

  for (const command of candidates) {
    const input = event(command);
    const before = structuredClone(input);
    const result = await handler(input, context);
    assert.equal(result?.block, true, command);
    assert.match(result?.reason ?? "", /^pi-safe-ops\/unverifiable_shell_candidate:/);
    assert.ok(!result?.reason.includes(command));
    assert.deepEqual(input, before);
  }

  for (const command of ["echo $x", "printf '%s' \"$x\"", "echo \"p's'ql\" $x"]) {
    assert.equal(await handler(event(command), context), undefined, command);
  }

  const oversized = `echo ${"x".repeat(8_193)} $x`;
  const result = await handler(event(oversized), context);
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /^pi-safe-ops\/unverifiable_shell_candidate:/);
  assert.ok(!result?.reason.includes(oversized));
});

test("runtime blocks escaped candidates inside direct interpreter and eval payloads without probes", async () => {
  const handler = createRuntimeHandler({
    runProbePlan: async () => assert.fail("nested payload candidate detection must not probe"),
  });
  const context = { cwd: "/repo", hasUI: false, signal: new AbortController().signal };
  const candidates = [
    "bash -c 'n\\pm install foo@1.2.3'",
    "sh -c 'p\\npm add foo@1.2.3'",
    "eval 'n\\pm install foo@1.2.3'",
    "bash -c \"'n''pm' install foo@1.2.3\"",
    "eval \"p\\npm add foo@1.2.3\"",
    "bash -c \"psql -c 'DROP TABLE accounts'\"",
  ];

  for (const command of candidates) {
    const input = event(command);
    const before = structuredClone(input);
    const result = await handler(input, context);
    assert.equal(result?.block, true, command);
    assert.match(result?.reason ?? "", /^pi-safe-ops\/unverifiable_shell_candidate:/);
    assert.ok(!result?.reason.includes(command));
    assert.deepEqual(input, before);
  }

  assert.equal(await handler(event("bash -c 'echo ok'"), context), undefined);
});

test("runtime blocks escaped candidates in wrapper-hidden interpreter payloads without probes", async () => {
  const handler = createRuntimeHandler({
    runProbePlan: async () => assert.fail("wrapper-hidden payload candidate detection must not probe"),
  });
  const context = { cwd: "/repo", hasUI: false, signal: new AbortController().signal };
  const candidates = [
    "env bash -c 'n\\pm install foo@1.2.3'",
    "sudo bash -c 'n\\pm install foo@1.2.3'",
    "command bash -c 'n\\pm install foo@1.2.3'",
    "exec -a shell bash -c 'n\\pm install foo@1.2.3'",
    "corepack --install-directory bin bash -c 'n\\pm install foo@1.2.3'",
    "env --unrecognized bash -c 'n\\pm install foo@1.2.3'",
    "sudo env --unrecognized bash -c 'n\\pm install foo@1.2.3'",
    "env -C /tmp sudo --user root command -p /bin/bash -c 'p\\sql -c \\\"DROP TABLE x\\\" $x'",
  ];

  for (const command of candidates) {
    const result = await handler(event(command), context);
    assert.equal(result?.block, true, command);
    assert.match(result?.reason ?? "", /^pi-safe-ops\/unverifiable_shell_candidate:/);
    assert.ok(!result?.reason.includes(command));
  }

  for (const command of [
    "env bash -c 'echo ok'",
    "sudo bash -c 'echo ok'",
    "command bash -c 'echo ok'",
    "env sudo command bash -c 'echo ok'",
    "env --unrecognized echo ok",
    "echo $x",
  ]) assert.equal(await handler(event(command), context), undefined, command);
});

test("runtime blocks successful-lex nested wrapper candidates without probes", async () => {
  const handler = createRuntimeHandler({
    runProbePlan: async () => assert.fail("successful-lex nested wrapper candidates must not probe"),
  });
  const context = { cwd: "/repo", hasUI: false, signal: new AbortController().signal };
  const candidates = [
    "command env npm install foo@1.2.3",
    "command env sudo npm install foo@1.2.3",
    "command env sudo psql -c 'SELECT 1'",
    "command env sudo exec bash -c 'n\\pm install foo@1.2.3'",
    "command env sudo exec corepack npm install foo@1.2.3",
    "command env sudo exec corepack bash -c 'p\\sql -c \\\"DROP TABLE accounts\\\"'",
  ];

  for (const command of candidates) {
    const input = event(command);
    const before = structuredClone(input);
    const result = await handler(input, context);
    assert.equal(result?.block, true, command);
    assert.match(result?.reason ?? "", /^pi-safe-ops\/unverifiable_shell_candidate:/);
    assert.ok(!result?.reason.includes(command));
    assert.deepEqual(input, before);
  }

  for (const command of ["command env sudo echo ok", "command env sudo bash -c 'echo ok'"]) {
    assert.equal(await handler(event(command), context), undefined, command);
  }
});

test("runtime resumes malformed candidate scanning after comments end at a newline", async () => {
  const handler = createRuntimeHandler({
    runProbePlan: async () => assert.fail("comment-following candidate detection must not probe"),
  });
  const context = { cwd: "/repo", hasUI: false, signal: new AbortController().signal };
  const candidates = [
    "echo ok # comment\nn\\pm install foo@1.2.3 $x",
    "echo ok # comment\np\\sql -c 'DROP TABLE x' $x",
    "# comment\nn\\pm install foo@1.2.3 $x",
  ];

  for (const command of candidates) {
    const result = await handler(event(command), context);
    assert.equal(result?.block, true, command);
    assert.match(result?.reason ?? "", /^pi-safe-ops\/unverifiable_shell_candidate:/);
    assert.ok(!result?.reason.includes(command));
  }

  for (const command of [
    "echo ok # npm text only",
    "# psql -c 'DROP TABLE x'",
    "echo \\# n\\pm install foo@1.2.3",
    "echo '# n\\pm install foo@1.2.3'",
  ]) assert.equal(await handler(event(command), context), undefined, command);
});

test("runtime preserves supply-before-SQL precedence and blocks probe failures without values", async () => {
  let calls = 0;
  const handler = createRuntimeHandler({
    isBashEvent: (value): value is { input: { command: string } } => (value as { toolName?: string }).toolName === "bash",
    runProbePlan: async () => { calls += 1; return { manager: "npm", version: "", probeFailure: "cancelled" }; },
  });
  const result = await handler(event("npm install foo@1.2.3; psql -c 'DROP TABLE secret'"), { cwd: "/repo", hasUI: false, signal: new AbortController().signal });
  assert.equal(calls, 0, "static composition blocks before any probe");
  assert.equal(result?.block, true);
  assert.ok(result?.reason.includes("shell_composition"));
  assert.ok(!result?.reason.includes("secret"));
});

test("runtime blocks protected or unverifiable SQL and passes direct safe SQL", async () => {
  const handler = createRuntimeHandler({ runProbePlan: async () => npmEvidence });
  const context = { cwd: "/repo", hasUI: false, signal: new AbortController().signal };
  assert.equal((await handler(event("psql -c 'DROP TABLE users'"), context))?.block, true);
  assert.equal((await handler(event("psql -c 'select 1'"), context)), undefined);
  assert.equal((await handler(event("mysql"), context))?.block, true);
});

test("normalization binds request identity, fixtures, and rejects malformed values", () => {
  const evidence = normalizeProbeOutputs(plan(), [
    { executable: "npm", id: "npm-0", ordinal: 0, argv: ["--version"], context: "normal", output: "11.16.0\n" },
    { executable: "npm", id: "npm-1", ordinal: 1, argv: ["config", "get", "save-exact"], context: "normal", output: "true\n" },
    { executable: "npm", id: "npm-2", ordinal: 2, argv: ["config", "get", "registry"], context: "normal", output: "https://registry.npmjs.org/\n" },
  ]);
  assert.equal(evidence.probeFailure, undefined);
  assert.equal(evidence.version, "11.16.0");
  assert.equal(evidence.saveExact, true);
  assert.equal(evidence.registry, "https://registry.npmjs.org/");
  assert.deepEqual(evidence.releaseAgeExclusions, []);
  const unsupportedVersion = normalizeProbeOutputs(plan(), [
    { executable: "npm", id: "npm-0", ordinal: 0, argv: ["--version"], context: "normal", output: "11.15.0\n" },
    { executable: "npm", id: "npm-1", ordinal: 1, argv: ["config", "get", "save-exact"], context: "normal", output: "true\n" },
    { executable: "npm", id: "npm-2", ordinal: 2, argv: ["config", "get", "registry"], context: "normal", output: "https://registry.npmjs.org/\n" },
  ]);
  assert.equal(unsupportedVersion.releaseAgeExclusions, undefined);
  assert.equal(normalizeProbeOutputs(plan(), [{ executable: "npm", id: "wrong", ordinal: 0, argv: ["--version"], context: "normal", output: "11.16.0" }]).probeFailure, "unexpected_key");
  const malformed = [
    { executable: "npm" as const, id: "npm-0", ordinal: 0, argv: ["--version"], context: "normal" as const, output: "11.16.0\nextra" },
    { executable: "npm" as const, id: "npm-1", ordinal: 1, argv: ["config", "get", "save-exact"], context: "normal" as const, output: "true" },
    { executable: "npm" as const, id: "npm-2", ordinal: 2, argv: ["config", "get", "registry"], context: "normal" as const, output: "https://registry.npmjs.org/" },
  ];
  assert.equal(normalizeProbeOutputs(plan(), malformed).probeFailure, "malformed");
});

class FakeChild extends EventEmitter implements SpawnChild {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  kills = 0;
  readonly killSignals: Array<NodeJS.Signals | undefined> = [];
  kill(signal?: NodeJS.Signals): boolean { this.kills += 1; this.killSignals.push(signal); return true; }
}

function runnerFor(child: FakeChild, capture: Array<{ command: string; args: readonly string[]; options: object }>) {
  const spawn: SpawnDependency = (command, args, options) => { capture.push({ command, args, options }); return child; };
  return createProbeRunner({ spawn, getAgentDir: () => "/agent", env: { Path: "/bin", KEEP: "yes" }, platform: "win32" });
}

test("normalization accepts pretty JSON boolean maps without accepting scalar newlines", () => {
  const pnpmPlan: ProbePlan = {
    executable: "pnpm", shell: false, timeoutMs: 20, outputByteLimit: 32, cache: "none",
    requests: [
      { id: "pnpm-0", ordinal: 0, argv: ["config", "get", "registry"], context: "normal", target: { field: "registry" }, valueKind: "registry" },
      { id: "pnpm-1", ordinal: 1, argv: ["config", "get", "allowBuilds"], context: "normal", target: { field: "allowBuilds" }, valueKind: "json_boolean_map" },
    ],
  };
  const evidence = normalizeProbeOutputs(pnpmPlan, [
    { executable: "pnpm", id: "pnpm-0", ordinal: 0, argv: ["config", "get", "registry"], context: "normal", output: "https://registry.npmjs.org/\n" },
    { executable: "pnpm", id: "pnpm-1", ordinal: 1, argv: ["config", "get", "allowBuilds"], context: "normal", output: "{\n  \"foo\": true\n}\n" },
  ]);
  assert.deepEqual(evidence.allowBuilds, { foo: true });
});

test("probe runner uses direct bounded spawn and PATH prepend exactly once", async () => {
  const child = new FakeChild();
  const captured: Array<{ command: string; args: readonly string[]; options: object }> = [];
  const basePlan = plan();
  const oneRequestPlan = { ...basePlan, requests: basePlan.requests.slice(0, 1) };
  const pending = runnerFor(child, captured)(oneRequestPlan, { cwd: "/repo", signal: new AbortController().signal });
  child.stdout.emit("data", Buffer.from("11.16.0\n"));
  child.emit("close", 0);
  // Remaining requests stop because this synthetic child is already terminal; this verifies direct spawn shape only.
  const result = await pending;
  assert.equal(result.probeFailure, "malformed");
  assert.equal(captured[0]?.command, "npm");
  assert.deepEqual(captured[0]?.args, ["--version"]);
  const options = captured[0]?.options as { shell: boolean; env: Record<string, string> };
  assert.equal(options.shell, false);
  assert.equal(options.env.PATH, "/agent/bin;/bin");
  assert.equal(options.env.KEEP, "yes");
  assert.equal(child.listenerCount("close"), 0);
  assert.equal(child.listenerCount("error"), 0);
  assert.equal(child.stdout.listenerCount("data"), 0);
  assert.equal(child.stderr.listenerCount("data"), 0);
});

test("probe runner canonicalizes duplicate Windows PATH keys and agent-bin entries", async () => {
  const child = new FakeChild();
  const captured: Array<{ command: string; args: readonly string[]; options: object }> = [];
  const spawn: SpawnDependency = (command, args, options) => { captured.push({ command, args, options }); return child; };
  const oneRequestPlan = { ...plan(), requests: plan().requests.slice(0, 1) };
  const pending = createProbeRunner({
    spawn,
    getAgentDir: () => "/agent",
    env: { Path: "/variant;/AGENT/BIN;/other", PATH: "/exact;/Agent/Bin;/tail", KEEP: "sentinel" },
    platform: "win32",
  })(oneRequestPlan, { cwd: "/repo", signal: new AbortController().signal });
  child.stdout.emit("data", Buffer.from("11.16.0\n"));
  child.emit("close", 0);
  await pending;

  const env = (captured[0]?.options as { env: Record<string, string> }).env;
  const pathKeys = Object.keys(env).filter((key) => key.toLowerCase() === "path");
  assert.deepEqual(pathKeys, ["PATH"]);
  assert.equal(env.PATH, "/agent/bin;/exact;/tail");
  assert.equal(env.KEEP, "sentinel");
});

test("probe runner isolates stderr while counting it against the shared byte limit", async () => {
  const children = [new FakeChild(), new FakeChild(), new FakeChild()];
  const responses: Array<readonly [string, string]> = [
    ["11.21.0\n", "warning\n"],
    ["true\n", ""],
    ["https://registry.npmjs.org/\n", ""],
  ];
  const spawn: SpawnDependency = (_command, _args, _options) => {
    const child = children.shift();
    const response = responses.shift();
    assert.ok(child);
    assert.ok(response);
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(response[0]));
      if (response[1] !== "") child.stderr.emit("data", Buffer.from(response[1]));
      child.emit("close", 0);
    });
    return child;
  };
  const result = await createProbeRunner({ spawn, getAgentDir: () => "/agent", env: {}, platform: "linux" })(plan(), { cwd: "/repo", signal: new AbortController().signal });
  assert.equal(result.probeFailure, undefined);
  assert.equal(result.version, "11.21.0");

  const cappedChild = new FakeChild();
  const cappedPlan = { ...plan(), outputByteLimit: 12 };
  const capped = runnerFor(cappedChild, [])(cappedPlan, { cwd: "/repo", signal: new AbortController().signal });
  cappedChild.stdout.emit("data", Buffer.from("11.21.0\n"));
  cappedChild.stderr.emit("data", Buffer.from("warning\n"));
  cappedChild.emit("close", 0);
  assert.equal((await capped).probeFailure, "oversized");
  assert.equal(cappedChild.kills, 1);
});

test("probe runner settles a terminal timeout when a killed child never closes", async () => {
  const child = new FakeChild();
  const shortPlan = { ...plan(), timeoutMs: 5 };
  const pending = runnerFor(child, [])(shortPlan, { cwd: "/repo", signal: new AbortController().signal });
  const outcome = await Promise.race([
    pending,
    new Promise<"test-budget-exceeded">((resolve) => setTimeout(() => resolve("test-budget-exceeded"), 80)),
  ]);
  if (outcome === "test-budget-exceeded") assert.fail("probe runner exceeded the terminal timeout test budget");
  assert.equal(outcome.probeFailure, "timeout");
  assert.equal(child.kills, 1);
  assert.deepEqual(child.killSignals, ["SIGKILL"]);
  assert.equal(child.listenerCount("close"), 0);
  assert.equal(child.listenerCount("error"), 0);
});

test("probe runner reports abort, timeout, overflow, ENOENT, and nonzero without raw output", async () => {
  for (const kind of ["abort", "timeout", "overflow", "enoent", "nonzero"] as const) {
    const child = new FakeChild();
    const controller = new AbortController();
    const pending = runnerFor(child, [])(plan(), { cwd: "/repo", signal: controller.signal });
    if (kind === "abort") controller.abort();
    if (kind === "timeout") await new Promise((resolve) => setTimeout(resolve, 25));
    if (kind === "overflow") child.stdout.emit("data", Buffer.alloc(33));
    if (kind === "enoent") child.emit("error", Object.assign(new Error("missing"), { code: "ENOENT" }));
    if (kind === "nonzero") child.emit("close", 1);
    child.emit("close", 1);
    const result = await pending;
    assert.ok(["cancelled", "timeout", "oversized", "unsupported", "nonzero"].includes(result.probeFailure ?? ""));
    if (kind === "abort" || kind === "timeout" || kind === "overflow") assert.equal(child.kills, 1);
    assert.equal(child.listenerCount("close"), 0);
    assert.equal(child.listenerCount("error"), 0);
  }
});

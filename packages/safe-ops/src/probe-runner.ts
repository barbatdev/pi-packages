import { spawn as nodeSpawn } from "node:child_process";
import { delimiter, join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import type { ControlEvidence } from "./control-evidence.ts";
import { isPublicPackageName } from "./package-spec.ts";
import type { ProbePlan, ProbeRequest } from "./probe-contract.ts";

export type SpawnChild = Readonly<{
  stdout?: Readonly<{ on(event: "data", listener: (chunk: Uint8Array | string) => void): unknown; off(event: "data", listener: (chunk: Uint8Array | string) => void): unknown }> | null;
  stderr?: Readonly<{ on(event: "data", listener: (chunk: Uint8Array | string) => void): unknown; off(event: "data", listener: (chunk: Uint8Array | string) => void): unknown }> | null;
  on(event: "close" | "error", listener: (value: number | Error | null) => void): unknown;
  off(event: "close" | "error", listener: (value: number | Error | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}>;

export type SpawnDependency = (command: string, args: readonly string[], options: {
  shell: false;
  stdio: ["ignore", "pipe", "pipe"];
  cwd: string;
  env: NodeJS.ProcessEnv;
  windowsHide: true;
  detached: false;
}) => SpawnChild;

export type ProbeOutput = Readonly<{
  executable: ProbePlan["executable"];
  id: string;
  ordinal: number;
  argv: readonly string[];
  context: ProbeRequest["context"];
  output: string;
}>;

export type ProbeRunnerDependencies = Readonly<{
  spawn?: SpawnDependency;
  getAgentDir?: () => string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}>;

type ProbeFailure = NonNullable<ControlEvidence["probeFailure"]>;
type RequestResult = Readonly<{ ok: true; output: ProbeOutput }> | Readonly<{ ok: false; failure: ProbeFailure }>;
type NormalizationResult = Readonly<{ ok: true; value: unknown }> | Readonly<{ ok: false }>;
type ResolvedDependencies = Required<Pick<ProbeRunnerDependencies, "spawn" | "getAgentDir" | "env" | "platform">>;
type RequestExecutionOptions = Readonly<{ plan: ProbePlan; request: ProbeRequest; cwd: string; signal: AbortSignal; dependencies: ResolvedDependencies }>;
type RequestState = {
  child: SpawnChild;
  plan: ProbePlan;
  request: ProbeRequest;
  signal: AbortSignal;
  resolve: (result: RequestResult) => void;
  settled: boolean;
  killed: boolean;
  terminalFailure: ProbeFailure | undefined;
  aggregateBytes: number;
  stdoutBytes: number;
  stdoutChunks: Buffer[];
  timeout: ReturnType<typeof setTimeout> | undefined;
  fallback: ReturnType<typeof setTimeout> | undefined;
};
type RequestListeners = Readonly<{
  onStdout: (chunk: Uint8Array | string) => void;
  onStderr: (chunk: Uint8Array | string) => void;
  onAbort: () => void;
  onClose: (code: number | Error | null) => void;
  onError: (error: number | Error | null) => void;
}>;
type ScalarKind = Exclude<ProbeRequest["valueKind"], "json_string_list" | "json_boolean_map">;
type ScalarNormalizer = (value: string) => NormalizationResult;
type EvidenceAccumulator = { evidence: Record<string, unknown>; scopes: Record<string, string | undefined> };

const TERMINATION_GRACE_MS = 20;

function failure(plan: ProbePlan, probeFailure: ProbeFailure): ControlEvidence {
  return { manager: plan.executable, version: "", probeFailure };
}

function pathEnvironment(env: NodeJS.ProcessEnv, agentDirectory: string, currentPlatform: NodeJS.Platform): NodeJS.ProcessEnv {
  const pathKeys = Object.keys(env).filter((key) => key.toLowerCase() === "path");
  const sourcePathKey = pathKeys.includes("PATH") ? "PATH" : pathKeys[0] ?? "PATH";
  const agentBin = join(agentDirectory, "bin");
  const pathDelimiter = currentPlatform === "win32" ? ";" : delimiter;
  const existing = env[sourcePathKey] ?? "";
  const equivalentPathEntry = currentPlatform === "win32"
    ? (entry: string) => entry.toLowerCase() === agentBin.toLowerCase()
    : (entry: string) => entry === agentBin;
  const values = existing.split(pathDelimiter).filter((entry) => entry.length > 0 && !equivalentPathEntry(entry));
  const inherited = Object.fromEntries(Object.entries(env).filter(([key]) => key.toLowerCase() !== "path"));
  return { ...inherited, PATH: [agentBin, ...values].join(pathDelimiter) };
}

function asBuffer(chunk: Uint8Array | string): Buffer {
  return typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
}

function createRequestState(child: SpawnChild, options: RequestExecutionOptions, resolve: (result: RequestResult) => void): RequestState {
  return {
    child,
    plan: options.plan,
    request: options.request,
    signal: options.signal,
    resolve,
    settled: false,
    killed: false,
    terminalFailure: undefined,
    aggregateBytes: 0,
    stdoutBytes: 0,
    stdoutChunks: [],
    timeout: undefined,
    fallback: undefined,
  };
}

function outputFor(request: ProbeRequest, plan: ProbePlan, chunks: readonly Buffer[], size: number): RequestResult {
  try {
    const output = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size));
    return { ok: true, output: { executable: plan.executable, id: request.id, ordinal: request.ordinal, argv: request.argv, context: request.context, output } };
  } catch {
    return { ok: false, failure: "malformed" };
  }
}

function errorFailure(error: number | Error | null): ProbeFailure {
  const code = typeof error === "object" && error !== null && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
  return code === "ENOENT" ? "unsupported" : "unexpected_key";
}

function spawnRequest(options: RequestExecutionOptions): SpawnChild | undefined {
  const { plan, request, cwd, dependencies } = options;
  try {
    return dependencies.spawn(plan.executable, request.argv, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      cwd,
      env: pathEnvironment(dependencies.env, dependencies.getAgentDir(), dependencies.platform),
      windowsHide: true,
      detached: false,
    });
  } catch {
    return undefined;
  }
}

function cleanup(state: RequestState, listeners: RequestListeners): void {
  if (state.timeout !== undefined) clearTimeout(state.timeout);
  if (state.fallback !== undefined) clearTimeout(state.fallback);
  state.signal.removeEventListener("abort", listeners.onAbort);
  state.child.stdout?.off("data", listeners.onStdout);
  state.child.stderr?.off("data", listeners.onStderr);
  state.child.off("close", listeners.onClose);
  state.child.off("error", listeners.onError);
}

function finish(state: RequestState, listeners: RequestListeners, result: RequestResult): void {
  if (state.settled) return;
  state.settled = true;
  cleanup(state, listeners);
  state.resolve(result);
}

function finishTerminalFailure(state: RequestState, listeners: RequestListeners): void {
  const probeFailure = state.terminalFailure;
  if (probeFailure !== undefined) finish(state, listeners, { ok: false, failure: probeFailure });
}

function killOnce(state: RequestState): void {
  if (state.killed) return;
  state.killed = true;
  try {
    state.child.kill("SIGKILL");
  } catch {
    // The direct child is already unavailable.
  }
}

function scheduleTerminalFallback(state: RequestState, listeners: RequestListeners): void {
  state.fallback = setTimeout(() => finishTerminalFailure(state, listeners), TERMINATION_GRACE_MS);
}

function terminate(state: RequestState, listeners: RequestListeners, probeFailure: ProbeFailure): void {
  if (state.settled || state.terminalFailure !== undefined) return;
  state.terminalFailure = probeFailure;
  killOnce(state);
  scheduleTerminalFallback(state, listeners);
}

function acceptChunk(state: RequestState, listeners: RequestListeners, chunk: Uint8Array | string, retain: boolean): void {
  if (state.settled || state.terminalFailure !== undefined) return;
  const value = asBuffer(chunk);
  state.aggregateBytes += value.byteLength;
  if (state.aggregateBytes > state.plan.outputByteLimit) {
    terminate(state, listeners, "oversized");
    return;
  }
  if (!retain) return;
  state.stdoutBytes += value.byteLength;
  state.stdoutChunks.push(value);
}

function handleClose(state: RequestState, listeners: RequestListeners, code: number | Error | null): void {
  if (state.settled) return;
  if (state.terminalFailure !== undefined) {
    finishTerminalFailure(state, listeners);
    return;
  }
  if (typeof code !== "number" || code !== 0) {
    finish(state, listeners, { ok: false, failure: "nonzero" });
    return;
  }
  finish(state, listeners, outputFor(state.request, state.plan, state.stdoutChunks, state.stdoutBytes));
}

function handleError(state: RequestState, listeners: RequestListeners, error: number | Error | null): void {
  if (state.settled) return;
  if (state.terminalFailure !== undefined) {
    finishTerminalFailure(state, listeners);
    return;
  }
  finish(state, listeners, { ok: false, failure: errorFailure(error) });
}

function createListeners(state: RequestState): RequestListeners {
  const listeners: RequestListeners = {
    onStdout: (chunk) => acceptChunk(state, listeners, chunk, true),
    onStderr: (chunk) => acceptChunk(state, listeners, chunk, false),
    onAbort: () => terminate(state, listeners, "cancelled"),
    onClose: (code) => handleClose(state, listeners, code),
    onError: (error) => handleError(state, listeners, error),
  };
  return listeners;
}

function attachListeners(state: RequestState, listeners: RequestListeners): void {
  state.child.stdout?.on("data", listeners.onStdout);
  state.child.stderr?.on("data", listeners.onStderr);
  state.child.on("close", listeners.onClose);
  state.child.on("error", listeners.onError);
  state.signal.addEventListener("abort", listeners.onAbort, { once: true });
}

function startTimeout(state: RequestState, listeners: RequestListeners): void {
  state.timeout = setTimeout(() => terminate(state, listeners, "timeout"), state.plan.timeoutMs);
}

function executeRequest(options: RequestExecutionOptions): Promise<RequestResult> {
  if (options.signal.aborted) return Promise.resolve({ ok: false, failure: "cancelled" });
  const child = spawnRequest(options);
  if (child === undefined) return Promise.resolve({ ok: false, failure: "unsupported" });
  return new Promise((resolve) => {
    const state = createRequestState(child, options, resolve);
    const listeners = createListeners(state);
    attachListeners(state, listeners);
    startTimeout(state, listeners);
    if (state.signal.aborted) listeners.onAbort();
  });
}

function removeOneFinalLine(value: string): string {
  if (value.endsWith("\r\n")) return value.slice(0, -2);
  if (value.endsWith("\n")) return value.slice(0, -1);
  return value;
}

function scalarValue(output: string): string | undefined {
  const value = removeOneFinalLine(output);
  return /[\r\n]/.test(value) ? undefined : value;
}

function normalized(value: unknown): NormalizationResult {
  return { ok: true, value };
}

function malformed(): NormalizationResult {
  return { ok: false };
}

function normalizeVersion(value: string): NormalizationResult {
  return /^\d+\.\d+\.\d+$/.test(value) ? normalized(value) : malformed();
}

function normalizeBoolean(value: string): NormalizationResult {
  if (value === "true") return normalized(true);
  if (value === "false") return normalized(false);
  return malformed();
}

function normalizeUnsignedInteger(value: string): NormalizationResult {
  return /^(?:0|[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value)) ? normalized(Number(value)) : malformed();
}

function normalizeRegistry(value: string): NormalizationResult {
  return value.length > 0 ? normalized(value) : malformed();
}

function normalizeOptionalScopedRegistry(value: string): NormalizationResult {
  if (value === "undefined" || value === "null") return normalized(undefined);
  return normalizeRegistry(value);
}

function normalizeCsvPackageNames(value: string): NormalizationResult {
  const packages = value === "" ? [] : value.split(",").map((entry) => entry.trim());
  return packages.every(isPublicPackageName) ? normalized(packages) : malformed();
}

const scalarNormalizers: Readonly<Record<ScalarKind, ScalarNormalizer>> = {
  version: normalizeVersion,
  boolean: normalizeBoolean,
  unsigned_integer: normalizeUnsignedInteger,
  registry: normalizeRegistry,
  optional_scoped_registry: normalizeOptionalScopedRegistry,
  csv_package_names: normalizeCsvPackageNames,
};

function normalizeScalar(kind: ScalarKind, output: string): NormalizationResult {
  const value = scalarValue(output);
  return value === undefined ? malformed() : scalarNormalizers[kind](value);
}

function parseJson(output: string): unknown | undefined {
  try {
    return JSON.parse(removeOneFinalLine(output));
  } catch {
    return undefined;
  }
}

function normalizeStringList(output: string): NormalizationResult {
  const parsed = parseJson(output);
  return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string") ? normalized(parsed) : malformed();
}

function normalizeBooleanMap(output: string): NormalizationResult {
  const parsed = parseJson(output);
  if (parsed === undefined || parsed === null || Array.isArray(parsed) || Object.getPrototypeOf(parsed) !== Object.prototype) return malformed();
  const map = parsed as Record<string, unknown>;
  const valid = Object.entries(map).every(([name, enabled]) => !name.startsWith("@") && isPublicPackageName(name) && typeof enabled === "boolean");
  return valid ? normalized(map as Record<string, boolean>) : malformed();
}

function normalizeValue(request: ProbeRequest, output: string): NormalizationResult {
  if (request.valueKind === "json_string_list") return normalizeStringList(output);
  if (request.valueKind === "json_boolean_map") return normalizeBooleanMap(output);
  return normalizeScalar(request.valueKind, output);
}

function matchesRequest(plan: ProbePlan, request: ProbeRequest, output: ProbeOutput): boolean {
  if (output.executable !== plan.executable || output.id !== request.id || output.ordinal !== request.ordinal || output.context !== request.context) return false;
  if (output.argv.length !== request.argv.length) return false;
  return output.argv.every((item, ordinal) => item === request.argv[ordinal]);
}

function createEvidenceAccumulator(plan: ProbePlan): EvidenceAccumulator {
  return { evidence: { manager: plan.executable }, scopes: {} };
}

function appendEvidence(accumulator: EvidenceAccumulator, request: ProbeRequest, value: unknown): boolean {
  if (request.target.field === "scopeRegistries") {
    if (request.target.scope === undefined) return false;
    accumulator.scopes[request.target.scope] = value as string | undefined;
    return true;
  }
  accumulator.evidence[request.target.field] = value;
  return true;
}

function finalizeEvidence(plan: ProbePlan, accumulator: EvidenceAccumulator): ControlEvidence {
  const registry = accumulator.evidence.registry;
  if (typeof registry !== "string") return failure(plan, "malformed");
  if (plan.executable === "npm" && accumulator.evidence.version === "11.16.0") accumulator.evidence.releaseAgeExclusions = [];
  for (const [scope, value] of Object.entries(accumulator.scopes)) accumulator.scopes[scope] = value ?? registry;
  accumulator.evidence.scopeRegistries = accumulator.scopes;
  return accumulator.evidence as ControlEvidence;
}

/** Normalizes bound probe records only; it never returns stdout/stderr or accepts key-only substitution. */
export function normalizeProbeOutputs(plan: ProbePlan, outputs: readonly ProbeOutput[]): ControlEvidence {
  if (outputs.length !== plan.requests.length) return failure(plan, "unexpected_key");
  const accumulator = createEvidenceAccumulator(plan);
  for (const [index, request] of plan.requests.entries()) {
    const output = outputs[index];
    if (output === undefined || !matchesRequest(plan, request, output)) return failure(plan, "unexpected_key");
    const value = normalizeValue(request, output.output);
    if (!value.ok || !appendEvidence(accumulator, request, value.value)) return failure(plan, "malformed");
  }
  return finalizeEvidence(plan, accumulator);
}

async function executePlan(plan: ProbePlan, context: Readonly<{ cwd: string; signal: AbortSignal }>, dependencies: ResolvedDependencies): Promise<ControlEvidence> {
  const outputs: ProbeOutput[] = [];
  for (const request of plan.requests) {
    const result = await executeRequest({ plan, request, cwd: context.cwd, signal: context.signal, dependencies });
    if (!result.ok) return failure(plan, result.failure);
    outputs.push(result.output);
  }
  return normalizeProbeOutputs(plan, outputs);
}

/** Production direct-spawn adapter. Custom SDK spawnHook PATH mutation is outside V1 proof. */
export function createProbeRunner(options: ProbeRunnerDependencies = {}): (plan: ProbePlan, context: Readonly<{ cwd: string; signal: AbortSignal }>) => Promise<ControlEvidence> {
  const dependencies: ResolvedDependencies = {
    spawn: options.spawn ?? ((command, args, spawnOptions) => nodeSpawn(command, args, spawnOptions) as unknown as SpawnChild),
    getAgentDir: options.getAgentDir ?? getAgentDir,
    env: options.env ?? process.env,
    platform: options.platform ?? process.platform,
  };
  return (plan, context) => executePlan(plan, context, dependencies);
}

export const runProbePlan = createProbeRunner();

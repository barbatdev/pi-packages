import type { ShellSegment } from "./argv.ts";
import { type ExactPackageSpec, validatePackageSpec } from "./package-spec.ts";

export type SupplyChainManager = "npm" | "pnpm";
export type SupplyChainOperation = "acquire" | "exec_helper";

export type StaticDecision =
  | Readonly<{ kind: "not_applicable" }>
  | Readonly<{ kind: "block"; code: string; remediation: string }>
  | Readonly<{
      kind: "needs_controls";
      manager: SupplyChainManager;
      operation: SupplyChainOperation;
      packages: readonly ExactPackageSpec[];
      global: boolean;
    }>;

type ParsedOptions = Readonly<{ actionIndex: number; global: boolean }>;
type ManagerCommand = "npm" | "pnpm" | "npx" | "pnx";
type BlockedDecision = Extract<StaticDecision, { kind: "block" }>;
type OptionResult =
  | Readonly<{ kind: "not_an_option" }>
  | Readonly<{ kind: "continue"; nextIndex: number; global: boolean }>
  | BlockedDecision;

const MANAGER_COMMANDS = new Set<ManagerCommand>(["npm", "pnpm", "npx", "pnx"]);
const INTERPRETERS = new Set(["sh", "bash", "dash", "zsh", "ksh", "node", "nodejs", "python", "python3", "ruby", "perl"]);
const NPM_ACTIONS = new Set(["install", "i", "add", "exec"]);
const PNPM_ACTIONS = new Set(["add"]);
const NPM_BLOCKED_ACTIONS = new Set(["update", "up", "ci", "x", "init", "create"]);
const PNPM_BLOCKED_ACTIONS = new Set(["update", "up", "install", "i", "create"]);
const NON_ACQUISITION_ACTIONS = new Set(["run", "test", "view", "config", "help", "version", "--version", "doctor", "cache", "whoami", "ping", "outdated", "list", "ls", "audit", "explain", "why", "root", "prefix", "bin"]);
const SAVE_TARGET_FLAGS = new Set(["-D", "--save-dev", "-P", "--save-prod", "-O", "--save-optional", "--save-peer"]);
const MANAGER_OPERATION_TEXT = /(?:^|[;&|()\s])(?:npm|pnpm|npx|pnx)(?:\s|$)/;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const REPORTING_FLAGS = new Set(["--silent", "--json", "--parseable", "--color"]);

type WrappedManager = Readonly<{ tokens: readonly string[]; viaWrapperOrPath: boolean }>;

function blocked(code: string): BlockedDecision {
  return { kind: "block", code, remediation: "Use one direct supported package-manager operation with exact public registry versions." };
}

function isManagerCommand(value: string | undefined): value is ManagerCommand {
  return value !== undefined && MANAGER_COMMANDS.has(value as ManagerCommand);
}

function managerFromExecutable(value: string | undefined): ManagerCommand | undefined {
  if (value === undefined) return undefined;
  const basename = value.slice(value.lastIndexOf("/") + 1);
  return isManagerCommand(basename) ? basename : undefined;
}

function managerTokens(tokens: readonly string[], index: number, viaWrapperOrPath: boolean): WrappedManager | undefined {
  const manager = managerFromExecutable(tokens[index]);
  return manager === undefined ? undefined : { tokens: [manager, ...tokens.slice(index + 1)], viaWrapperOrPath };
}

function unwrapCommand(tokens: readonly string[]): WrappedManager | undefined {
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--") return managerTokens(tokens, index + 1, true);
    if (token === "-v" || token === "-V" || token?.startsWith("-") && (token.includes("v") || token.includes("V"))) return undefined;
    if (token === "-p" || token === "--default-path") continue;
    return managerTokens(tokens, index, true);
  }
  return undefined;
}

function unwrapExec(tokens: readonly string[]): WrappedManager | undefined {
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--") return managerTokens(tokens, index + 1, true);
    if (token === "-a") {
      index += 1;
      continue;
    }
    if (token === "-c" || token === "-l") continue;
    return managerTokens(tokens, index, true);
  }
  return undefined;
}

function unwrapEnv(tokens: readonly string[]): WrappedManager | undefined {
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--") return managerTokens(tokens, index + 1, true);
    if (token === "-i" || token === "--ignore-environment" || ENV_ASSIGNMENT.test(token ?? "")) continue;
    if (token === "-u" || token === "--unset" || token === "-C" || token === "--chdir") {
      index += 1;
      continue;
    }
    if (token?.startsWith("--unset=") || token?.startsWith("--chdir=")) continue;
    return managerTokens(tokens, index, true);
  }
  return undefined;
}

function unwrapSudo(tokens: readonly string[]): WrappedManager | undefined {
  const optionsWithValue = new Set(["-u", "-g", "-h", "-C", "-r", "-t", "-T", "-R", "-D", "--user", "--group", "--host", "--close-from", "--role", "--type", "--command-timeout", "--chdir"]);
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--") return managerTokens(tokens, index + 1, true);
    if (optionsWithValue.has(token ?? "")) {
      index += 1;
      continue;
    }
    if (token?.startsWith("--user=") || token?.startsWith("--group=") || token?.startsWith("--host=") || token?.startsWith("--chdir=")) continue;
    if (token?.startsWith("-")) continue;
    return managerTokens(tokens, index, true);
  }
  return undefined;
}

function unwrapCorepack(tokens: readonly string[]): WrappedManager | undefined {
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--") return managerTokens(tokens, index + 1, true);
    if (token === "--install-directory") {
      index += 1;
      continue;
    }
    if (token === "--cache-only" || token === "--verbose" || token?.startsWith("--install-directory=")) continue;
    return managerTokens(tokens, index, true);
  }
  return undefined;
}

function unwrapManager(tokens: readonly string[]): WrappedManager | undefined {
  const command = tokens[0];
  if (ENV_ASSIGNMENT.test(command ?? "")) {
    let index = 0;
    while (ENV_ASSIGNMENT.test(tokens[index] ?? "")) index += 1;
    return managerTokens(tokens, index, true);
  }
  if (command === "command") return unwrapCommand(tokens);
  if (command === "exec") return unwrapExec(tokens);
  if (command === "env") return unwrapEnv(tokens);
  if (command === "sudo") return unwrapSudo(tokens);
  if (command === "corepack") return unwrapCorepack(tokens);
  return managerTokens(tokens, 0, command !== managerFromExecutable(command));
}

function hasExecutedManagerPayload(tokens: readonly string[]): boolean {
  const command = tokens[0];
  if (command === "eval") return MANAGER_OPERATION_TEXT.test(tokens.slice(1).join(" "));
  if (command === undefined || !INTERPRETERS.has(command)) return false;
  const commandFlag = tokens.indexOf("-c");
  const payload = commandFlag === -1 ? undefined : tokens[commandFlag + 1];
  return payload !== undefined && MANAGER_OPERATION_TEXT.test(payload);
}

function requireSelectorValue(tokens: readonly string[], index: number): number | undefined {
  const value = tokens[index + 1];
  return value === undefined || value === "--" || value.startsWith("-") ? undefined : index + 1;
}

function supportsInlineSelector(manager: SupplyChainManager, token: string): boolean {
  return (manager === "npm" && token.startsWith("--workspace=")) || (manager === "pnpm" && token.startsWith("--filter="));
}

function isSelectorWithValue(manager: SupplyChainManager, token: string): boolean {
  return (manager === "npm" && token === "--workspace") || (manager === "pnpm" && token === "--filter");
}

function isSupportedFlag(manager: SupplyChainManager, token: string): boolean {
  return token === "--global" || token === "-g"
    || (manager === "npm" && (token === "--workspaces" || token === "--include-workspace-root"))
    || (manager === "pnpm" && (token === "--workspace-root" || token === "-w"));
}

function consumeSupportedOption(tokens: readonly string[], index: number, manager: SupplyChainManager): OptionResult {
  const token = tokens[index];
  if (token === undefined || token === "--") return blocked(token === "--" ? "delimiter_before_operation" : "missing_operation");
  if (isSupportedFlag(manager, token)) return { kind: "continue", nextIndex: index, global: token === "--global" || token === "-g" };
  if (supportsInlineSelector(manager, token)) return token.endsWith("=") ? blocked("invalid_option_value") : { kind: "continue", nextIndex: index, global: false };
  if (!isSelectorWithValue(manager, token)) return { kind: "not_an_option" };

  const nextIndex = requireSelectorValue(tokens, index);
  return nextIndex === undefined ? blocked("invalid_option_value") : { kind: "continue", nextIndex, global: false };
}

function isAcquisitionAction(manager: SupplyChainManager, token: string): boolean {
  return manager === "npm" ? NPM_ACTIONS.has(token) : PNPM_ACTIONS.has(token);
}

function isBlockedAction(manager: SupplyChainManager, token: string): boolean {
  return manager === "npm" ? NPM_BLOCKED_ACTIONS.has(token) : PNPM_BLOCKED_ACTIONS.has(token);
}

function parseAcquisitionOptions(tokens: readonly string[], start: number, manager: SupplyChainManager): ParsedOptions | StaticDecision {
  let global = false;
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) break;
    if (isAcquisitionAction(manager, token)) return { actionIndex: index, global };
    if (isBlockedAction(manager, token)) return blocked("unsupported_operation");

    const option = consumeSupportedOption(tokens, index, manager);
    if (option.kind === "block") return option;
    if (option.kind === "not_an_option") return blocked("unsupported_option_or_operation");
    global ||= option.global;
    index = option.nextIndex;
  }
  return blocked("missing_operation");
}

function parseExactSpecs(
  tokens: readonly string[],
  start: number,
  manager: SupplyChainManager,
  initialGlobal: boolean,
): Readonly<{ packages: readonly ExactPackageSpec[]; global: boolean }> | StaticDecision {
  const packages: ExactPackageSpec[] = [];
  let global = initialGlobal;
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) break;
    if (token === "--") return blocked("invalid_package_arguments");
    if (SAVE_TARGET_FLAGS.has(token)) continue;

    const option = consumeSupportedOption(tokens, index, manager);
    if (option.kind === "block") return option;
    if (option.kind === "continue") {
      global ||= option.global;
      index = option.nextIndex;
      continue;
    }
    if (token.startsWith("-")) return blocked("invalid_package_arguments");

    const result = validatePackageSpec(token);
    if (!result.ok) return blocked(result.code);
    packages.push(result.value);
  }
  return packages.length === 0 ? blocked("missing_exact_package") : { packages, global };
}

function consumeReportingOption(tokens: readonly string[], index: number, manager: SupplyChainManager): number | undefined {
  const token = tokens[index];
  if (REPORTING_FLAGS.has(token ?? "") || token?.startsWith("--loglevel=") || token?.startsWith("--reporter=")) return index;
  if (token === "--loglevel" || manager === "pnpm" && token === "--reporter") return requireSelectorValue(tokens, index);
  return undefined;
}

function directAction(tokens: readonly string[], manager: SupplyChainManager): string | undefined {
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) return undefined;
    const option = consumeSupportedOption(tokens, index, manager);
    if (option.kind === "not_an_option") {
      const reportingOption = consumeReportingOption(tokens, index, manager);
      if (reportingOption !== undefined) {
        index = reportingOption;
        continue;
      }
      return token;
    }
    if (option.kind === "block") return undefined;
    index = option.nextIndex;
  }
  return undefined;
}

function startsDirectNonAcquisition(tokens: readonly string[], manager: SupplyChainManager): boolean {
  return NON_ACQUISITION_ACTIONS.has(directAction(tokens, manager) ?? "");
}

function classifyNpm(tokens: readonly string[]): StaticDecision {
  if (startsDirectNonAcquisition(tokens, "npm")) return { kind: "not_applicable" };
  const parsed = parseAcquisitionOptions(tokens, 1, "npm");
  if ("kind" in parsed) return parsed;

  if (tokens[parsed.actionIndex] === "exec") return classifyNpmExec(tokens, parsed.actionIndex + 1, parsed.global);
  const parsedSpecs = parseExactSpecs(tokens, parsed.actionIndex + 1, "npm", parsed.global);
  if ("kind" in parsedSpecs) return parsedSpecs;
  return { kind: "needs_controls", manager: "npm", operation: "acquire", packages: parsedSpecs.packages, global: parsedSpecs.global };
}

function classifyNpmExec(tokens: readonly string[], start: number, global: boolean): StaticDecision {
  if (global) return blocked("unsupported_exec_option");
  const packages: ExactPackageSpec[] = [];
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--") return index === tokens.length - 1 || packages.length === 0 ? blocked("missing_exec_package") : { kind: "needs_controls", manager: "npm", operation: "exec_helper", packages, global: false };
    if (token === "--package") {
      const result = validatePackageSpec(tokens[index + 1] ?? "");
      if (!result.ok) return blocked(result.code);
      packages.push(result.value);
      index += 1;
      continue;
    }
    if (token?.startsWith("--package=")) {
      const result = validatePackageSpec(token.slice("--package=".length));
      if (!result.ok) return blocked(result.code);
      packages.push(result.value);
      continue;
    }
    return blocked("exec_inference_or_unsupported_option");
  }
  return blocked("missing_exec_package");
}

function classifyNpx(tokens: readonly string[]): StaticDecision {
  const packageIndex = tokens[1] === "-y" || tokens[1] === "--yes" ? 2 : 1;
  const packageToken = tokens[packageIndex] ?? "";
  if (tokens[1]?.startsWith("-") && packageIndex === 1) return blocked("unsupported_npx_option");
  const packageResult = validatePackageSpec(packageToken);
  return packageResult.ok
    ? { kind: "needs_controls", manager: "npm", operation: "exec_helper", packages: [packageResult.value], global: false }
    : blocked(packageResult.code);
}

function classifyPnpmHelper(tokens: readonly string[]): StaticDecision {
  const packageResult = validatePackageSpec(tokens[0] ?? "");
  if (!packageResult.ok) return blocked(packageResult.code);
  if (tokens.length > 1 && tokens[1] !== "--") return blocked("invalid_package_arguments");
  return { kind: "needs_controls", manager: "pnpm", operation: "exec_helper", packages: [packageResult.value], global: false };
}

function classifyPnpm(tokens: readonly string[]): StaticDecision {
  if (startsDirectNonAcquisition(tokens, "pnpm")) return { kind: "not_applicable" };
  if (tokens[1] === "dlx") return classifyPnpmHelper(tokens.slice(2));

  const parsed = parseAcquisitionOptions(tokens, 1, "pnpm");
  if ("kind" in parsed) return parsed;
  const parsedSpecs = parseExactSpecs(tokens, parsed.actionIndex + 1, "pnpm", parsed.global);
  if ("kind" in parsedSpecs) return parsedSpecs;
  return { kind: "needs_controls", manager: "pnpm", operation: "acquire", packages: parsedSpecs.packages, global: parsedSpecs.global };
}

function classifyDirectManager(tokens: readonly string[]): StaticDecision {
  const command = tokens[0];
  if (command === "npm") return classifyNpm(tokens);
  if (command === "npx") return classifyNpx(tokens);
  if (command === "pnx") return classifyPnpmHelper(tokens.slice(1));
  return classifyPnpm(tokens);
}

function classifyPolicyCandidate(tokens: readonly string[]): StaticDecision {
  if (hasExecutedManagerPayload(tokens)) return blocked("unsupported_wrapper_or_path");
  const wrapped = unwrapManager(tokens);
  if (wrapped === undefined) return { kind: "not_applicable" };

  const decision = classifyDirectManager(wrapped.tokens);
  if (decision.kind === "not_applicable") return decision;
  return wrapped.viaWrapperOrPath ? blocked("unsupported_wrapper_or_path") : decision;
}

/** Classifies one already-lexed shell segment without executing a manager. */
export function classifyManagerSegment(segment: ShellSegment): StaticDecision {
  const decision = classifyPolicyCandidate(segment.tokens);
  return segment.precedingOperator !== null && decision.kind !== "not_applicable" ? blocked("shell_composition") : decision;
}

/** Requires a recognized manager operation to be the only shell segment. */
export function classifyManagerSegments(segments: readonly ShellSegment[]): StaticDecision {
  const policySegments = segments.filter((segment) => classifyPolicyCandidate(segment.tokens).kind !== "not_applicable");
  if (policySegments.length === 0) return { kind: "not_applicable" };
  if (segments.length !== 1 || policySegments.length !== 1) return blocked("shell_composition");
  const policySegment = policySegments[0];
  return policySegment === undefined ? blocked("shell_composition") : classifyManagerSegment(policySegment);
}

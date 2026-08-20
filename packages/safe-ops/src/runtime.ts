import { lexShell } from "./argv.ts";
import { evaluateControlEvidence, type ControlEvidence } from "./control-evidence.ts";
import { classifyManagerSegments } from "./manager-classifier.ts";
import { createProbePlan, type ProbePlan } from "./probe-contract.ts";
import { classifySqlSegments } from "./sql-policy.ts";

export type ToolCallBlock = Readonly<{ block: true; reason: string }>;
export type BashContext = Readonly<{ cwd: string; hasUI: boolean; signal: AbortSignal }>;
export type BashEvent = Readonly<{ input: Readonly<{ command: string }> }>;
export type RunProbePlan = (plan: ProbePlan, context: Pick<BashContext, "cwd" | "signal">) => Promise<ControlEvidence>;
export type RuntimeDependencies = Readonly<{
  runProbePlan: RunProbePlan;
  isBashEvent?: (event: unknown) => event is BashEvent;
}>;

const MAX_MALFORMED_SHELL_SCAN_LENGTH = 8_192;
const CANDIDATE_BASENAMES = new Set(["npm", "pnpm", "npx", "pnx", "psql", "mysql", "mariadb", "sqlite3"]);

type QuoteState = "unquoted" | "single" | "double";
type ShellWord = Readonly<{ literal: string; hasDynamicFragment: boolean }>;
type WrapperName = "command" | "corepack" | "env" | "exec" | "sudo";
type MalformedShellScan = {
  segments: ShellWord[][];
  current: { literal: string; hasDynamicFragment: boolean; started: boolean };
  quote: QuoteState;
};
type BalancedConsumeOptions = Readonly<{ open: string; close: string; depth: number }>;
type WrapperTarget = Readonly<{ kind: "safe" }> | Readonly<{ kind: "target"; index: number }> | Readonly<{ kind: "ambiguous" }>;

const MAX_WRAPPER_INSPECTION_DEPTH = 3;
const INTERPRETERS = new Set(["sh", "bash", "dash", "zsh", "ksh", "node", "nodejs", "python", "python3", "ruby", "perl"]);
const SUDO_VALUE_OPTIONS = new Set(["-u", "-g", "-h", "-C", "-r", "-t", "-T", "-R", "-D", "--user", "--group", "--host", "--close-from", "--role", "--type", "--command-timeout", "--chdir"]);
const ENV_VALUE_OPTIONS = new Set(["-u", "--unset", "-C", "--chdir"]);

function defaultBashEvent(event: unknown): event is BashEvent {
  const candidate = event as { toolName?: unknown; input?: { command?: unknown } };
  return candidate?.toolName === "bash" && typeof candidate.input?.command === "string";
}

function reason(code: string, remediation: string): ToolCallBlock {
  return { block: true, reason: `pi-safe-ops/${code}: ${remediation}` };
}

function malformedCandidateBlock(): ToolCallBlock {
  return reason("unverifiable_shell_candidate", "Use a direct supported package-manager or SQL-client argv form without unsupported shell syntax.");
}

function appendLiteral(scan: MalformedShellScan, value: string): void {
  scan.current.literal += value;
  scan.current.started = true;
}

function appendDynamicFragment(scan: MalformedShellScan): void {
  scan.current.hasDynamicFragment = true;
  scan.current.started = true;
}

function finishWord(scan: MalformedShellScan): void {
  if (!scan.current.started) return;
  const segment = scan.segments.at(-1);
  if (segment !== undefined) segment.push({ literal: scan.current.literal, hasDynamicFragment: scan.current.hasDynamicFragment });
  scan.current = { literal: "", hasDynamicFragment: false, started: false };
}

function finishSegment(scan: MalformedShellScan): void {
  finishWord(scan);
  if (scan.segments.at(-1)?.length !== 0) scan.segments.push([]);
}

function isWhitespace(character: string): boolean {
  return character === " " || character === "\t";
}

function isShellOperator(character: string): boolean {
  return character === ";" || character === "\n" || character === "|" || character === "&";
}

function isSegmentBoundary(character: string): boolean {
  return isShellOperator(character) || character === "(" || character === ")";
}

function segmentBoundaryWidth(input: string, offset: number): number {
  const character = input[offset] ?? "";
  return (character === "|" || character === "&") && input[offset + 1] === character ? 2 : 1;
}

function consumeQuoted(input: string, offset: number, quote: "'" | "\""): number {
  for (let index = offset + 1; index < input.length; index += 1) {
    if (input[index] === "\\") {
      index += 1;
      continue;
    }
    if (input[index] === quote) return index + 1;
  }
  return input.length;
}

function consumeBalanced(input: string, offset: number, options: BalancedConsumeOptions): number {
  let depth = options.depth;
  let quote: QuoteState = "unquoted";
  for (let index = offset; index < input.length; index += 1) {
    const character = input[index] ?? "";
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (quote !== "unquoted") {
      if (character === quote) quote = "unquoted";
      continue;
    }
    if (character === "'" || character === "\"") {
      quote = character === "'" ? "single" : "double";
      continue;
    }
    if (character === options.open) depth += 1;
    if (character === options.close && --depth === 0) return index + 1;
  }
  return input.length;
}

function isVariableCharacter(character: string): boolean {
  return character !== "" && "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_".includes(character);
}

function consumeDynamicExpansion(input: string, offset: number): number {
  const next = input[offset + 1] ?? "";
  if (next === "(") {
    const arithmetic = input[offset + 2] === "(";
    return consumeBalanced(input, offset + (arithmetic ? 3 : 2), { open: "(", close: ")", depth: arithmetic ? 2 : 1 });
  }
  if (next === "{") return consumeBalanced(input, offset + 2, { open: "{", close: "}", depth: 1 });
  if (next === "'" || next === "\"") return consumeQuoted(input, offset + 1, next);
  if ("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_#?*@!$-".includes(next)) {
    let end = offset + 2;
    for (; isVariableCharacter(input[end] ?? ""); end += 1) { /* consume the parameter name */ }
    return end;
  }
  return offset + 1;
}

function consumeBacktickExpansion(input: string, offset: number): number {
  for (let index = offset + 1; index < input.length; index += 1) {
    if (input[index] === "\\") {
      index += 1;
      continue;
    }
    if (input[index] === "`") return index + 1;
  }
  return input.length;
}

function executableCandidate(word: ShellWord | undefined): boolean {
  if (word === undefined) return false;
  if (word.hasDynamicFragment) return true;
  return CANDIDATE_BASENAMES.has(word.literal.slice(word.literal.lastIndexOf("/") + 1));
}

function isAssignment(word: ShellWord | undefined): boolean {
  return word !== undefined && !word.hasDynamicFragment && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word.literal);
}

function wrapperTarget(index: number): WrapperTarget {
  return { kind: "target", index };
}

function requiredWrapperOptionValue(words: readonly ShellWord[], index: number): WrapperTarget | number {
  const value = words[index + 1];
  return value === undefined || value.hasDynamicFragment ? { kind: "ambiguous" } : index + 1;
}

function resolveCommandTarget(words: readonly ShellWord[], start: number): WrapperTarget {
  for (let index = start; index < words.length; index += 1) {
    const word = words[index];
    if (word === undefined || word.hasDynamicFragment) return { kind: "ambiguous" };
    const value = word.literal;
    if (value === "--") return words[index + 1] === undefined ? { kind: "ambiguous" } : wrapperTarget(index + 1);
    if (value === "-v" || value === "-V" || value.startsWith("-") && (value.includes("v") || value.includes("V"))) return { kind: "safe" };
    if (value === "-p" || value === "--default-path") continue;
    return wrapperTarget(index);
  }
  return { kind: "safe" };
}

function resolveExecTarget(words: readonly ShellWord[], start: number): WrapperTarget {
  for (let index = start; index < words.length; index += 1) {
    const word = words[index];
    if (word === undefined || word.hasDynamicFragment) return { kind: "ambiguous" };
    if (word.literal === "--") return words[index + 1] === undefined ? { kind: "ambiguous" } : wrapperTarget(index + 1);
    if (word.literal === "-a") {
      const value = requiredWrapperOptionValue(words, index);
      if (typeof value !== "number") return value;
      index = value;
      continue;
    }
    if (word.literal === "-c" || word.literal === "-l") continue;
    return wrapperTarget(index);
  }
  return { kind: "safe" };
}

function resolveEnvTarget(words: readonly ShellWord[], start: number): WrapperTarget {
  for (let index = start; index < words.length; index += 1) {
    const word = words[index];
    if (word === undefined || word.hasDynamicFragment) return { kind: "ambiguous" };
    const value = word.literal;
    if (value === "--") return words[index + 1] === undefined ? { kind: "ambiguous" } : wrapperTarget(index + 1);
    if (value === "-i" || value === "--ignore-environment" || isAssignment(word) || value.startsWith("--unset=") || value.startsWith("--chdir=")) continue;
    if (ENV_VALUE_OPTIONS.has(value)) {
      const optionValue = requiredWrapperOptionValue(words, index);
      if (typeof optionValue !== "number") return optionValue;
      index = optionValue;
      continue;
    }
    return value.startsWith("-") ? { kind: "ambiguous" } : wrapperTarget(index);
  }
  return { kind: "safe" };
}

function resolveSudoTarget(words: readonly ShellWord[], start: number): WrapperTarget {
  for (let index = start; index < words.length; index += 1) {
    const word = words[index];
    if (word === undefined || word.hasDynamicFragment) return { kind: "ambiguous" };
    const value = word.literal;
    if (value === "--") return words[index + 1] === undefined ? { kind: "ambiguous" } : wrapperTarget(index + 1);
    if (SUDO_VALUE_OPTIONS.has(value)) {
      const optionValue = requiredWrapperOptionValue(words, index);
      if (typeof optionValue !== "number") return optionValue;
      index = optionValue;
      continue;
    }
    if (value.startsWith("--user=") || value.startsWith("--group=") || value.startsWith("--host=") || value.startsWith("--chdir=") || value.startsWith("-")) continue;
    return wrapperTarget(index);
  }
  return { kind: "safe" };
}

function resolveCorepackTarget(words: readonly ShellWord[], start: number): WrapperTarget {
  for (let index = start; index < words.length; index += 1) {
    const word = words[index];
    if (word === undefined || word.hasDynamicFragment) return { kind: "ambiguous" };
    const value = word.literal;
    if (value === "--") return words[index + 1] === undefined ? { kind: "ambiguous" } : wrapperTarget(index + 1);
    if (value === "--install-directory") {
      const optionValue = requiredWrapperOptionValue(words, index);
      if (typeof optionValue !== "number") return optionValue;
      index = optionValue;
      continue;
    }
    if (value === "--cache-only" || value === "--verbose" || value.startsWith("--install-directory=")) continue;
    return wrapperTarget(index);
  }
  return { kind: "safe" };
}

function resolveWrapperTarget(words: readonly ShellWord[], start: number, wrapper: WrapperName): WrapperTarget {
  if (wrapper === "command") return resolveCommandTarget(words, start);
  if (wrapper === "exec") return resolveExecTarget(words, start);
  if (wrapper === "env") return resolveEnvTarget(words, start);
  if (wrapper === "sudo") return resolveSudoTarget(words, start);
  return resolveCorepackTarget(words, start);
}

function isWrapper(value: string): value is WrapperName {
  return value === "command" || value === "corepack" || value === "env" || value === "exec" || value === "sudo";
}

function inspectExecutable(words: readonly ShellWord[], index: number, depth = 0): boolean {
  const executable = words[index];
  if (executable === undefined) return false;
  if (executable.hasDynamicFragment || executableCandidate(executable)) return true;
  if (!isWrapper(executable.literal)) return false;
  if (depth >= MAX_WRAPPER_INSPECTION_DEPTH) return true;
  const target = resolveWrapperTarget(words, index + 1, executable.literal);
  if (target.kind === "ambiguous") return true;
  return target.kind === "target" && inspectExecutable(words, target.index, depth + 1);
}

function redirectionEnd(words: readonly ShellWord[], index: number): number | undefined {
  const word = words[index];
  if (word === undefined || word.hasDynamicFragment) return undefined;
  const match = /^(?:\d+)?(?:>>?|<<|<>|>&|<&)(.*)$/.exec(word.literal);
  if (match === null) return undefined;
  return match[1] === "" ? index + 2 : index + 1;
}

function segmentHasCandidate(words: readonly ShellWord[]): boolean {
  let executableIndex = 0;
  for (;;) {
    if (isAssignment(words[executableIndex])) {
      executableIndex += 1;
      continue;
    }
    const next = redirectionEnd(words, executableIndex);
    if (next === undefined) break;
    executableIndex = next;
  }
  return inspectExecutable(words, executableIndex);
}

function consumeEscapedScanCharacter(scan: MalformedShellScan, input: string, offset: number, preserveBackslash: boolean): number {
  const escaped = input[offset + 1];
  if (escaped === undefined) appendDynamicFragment(scan);
  else if (escaped !== "\n") appendLiteral(scan, preserveBackslash && escaped !== "\"" && escaped !== "\\" && escaped !== "$" && escaped !== "`" ? `\\${escaped}` : escaped);
  return offset + (escaped === undefined ? 1 : 2);
}

function consumeSingleQuotedScanCharacter(scan: MalformedShellScan, character: string, offset: number): number {
  if (character === "'") scan.quote = "unquoted";
  else appendLiteral(scan, character);
  return offset + 1;
}

function consumeDoubleQuotedScanCharacter(scan: MalformedShellScan, input: string, offset: number): number {
  const character = input[offset] ?? "";
  if (character === "\"") {
    scan.quote = "unquoted";
    return offset + 1;
  }
  if (character === "\\") return consumeEscapedScanCharacter(scan, input, offset, true);
  if (character === "$" || character === "`") {
    appendDynamicFragment(scan);
    return character === "$" ? consumeDynamicExpansion(input, offset) : consumeBacktickExpansion(input, offset);
  }
  appendLiteral(scan, character);
  return offset + 1;
}

function isDynamicSyntax(character: string): boolean {
  return character === "{" || character === "}" || character === "*" || character === "[" || character === "]" || character === "?" || character === "~";
}

function consumeUnquotedScanCharacter(scan: MalformedShellScan, input: string, offset: number): number {
  const character = input[offset] ?? "";
  if (isWhitespace(character)) {
    finishWord(scan);
    return offset + 1;
  }
  if (isSegmentBoundary(character)) {
    finishSegment(scan);
    return offset + segmentBoundaryWidth(input, offset);
  }
  if (character === "#" && !scan.current.started) {
    const newline = input.indexOf("\n", offset + 1);
    return newline === -1 ? input.length : newline;
  }
  if (character === "'") {
    scan.quote = "single";
    scan.current.started = true;
    return offset + 1;
  }
  if (character === "\"") {
    scan.quote = "double";
    scan.current.started = true;
    return offset + 1;
  }
  if (character === "\\") return consumeEscapedScanCharacter(scan, input, offset, false);
  if (character === "$" || character === "`") {
    appendDynamicFragment(scan);
    return character === "$" ? consumeDynamicExpansion(input, offset) : consumeBacktickExpansion(input, offset);
  }
  if (isDynamicSyntax(character)) {
    appendDynamicFragment(scan);
    return offset + 1;
  }
  appendLiteral(scan, character);
  return offset + 1;
}

function consumeScanCharacter(scan: MalformedShellScan, input: string, offset: number): number {
  if (scan.quote === "single") return consumeSingleQuotedScanCharacter(scan, input[offset] ?? "", offset);
  if (scan.quote === "double") return consumeDoubleQuotedScanCharacter(scan, input, offset);
  return consumeUnquotedScanCharacter(scan, input, offset);
}

/** Bounded fallback for unsupported shell syntax; it recognizes executable words but never expands or executes them. */
function hasMalformedShellCandidate(input: string): boolean {
  if (input.length > MAX_MALFORMED_SHELL_SCAN_LENGTH) return true;
  const scan: MalformedShellScan = {
    segments: [[]], current: { literal: "", hasDynamicFragment: false, started: false }, quote: "unquoted",
  };
  for (let offset = 0; offset < input.length;) offset = consumeScanCharacter(scan, input, offset);
  finishWord(scan);
  return scan.segments.some(segmentHasCandidate);
}

function executableBasename(word: ShellWord | undefined): string | undefined {
  if (word === undefined || word.hasDynamicFragment) return undefined;
  return word.literal.slice(word.literal.lastIndexOf("/") + 1);
}

function interpreterPayload(words: readonly ShellWord[], index: number): string | undefined {
  const executable = executableBasename(words[index]);
  if (executable === "eval") return words.length > index + 1 ? words.slice(index + 1).map((word) => word.literal).join(" ") : undefined;
  if (executable === undefined || !INTERPRETERS.has(executable)) return undefined;
  const commandFlag = words.findIndex((word, wordIndex) => wordIndex > index && word.literal === "-c");
  return commandFlag === -1 ? undefined : words[commandFlag + 1]?.literal;
}

function ambiguousWrapperHasCandidatePayload(words: readonly ShellWord[], index: number): boolean {
  for (let candidateIndex = index + 1; candidateIndex < words.length; candidateIndex += 1) {
    const payload = interpreterPayload(words, candidateIndex);
    if (payload !== undefined && hasMalformedShellCandidate(payload)) return true;
  }
  return false;
}

function hasNestedPayloadCandidate(words: readonly ShellWord[], index = 0, depth = 0): boolean {
  const payload = interpreterPayload(words, index);
  if (payload !== undefined) return hasMalformedShellCandidate(payload);
  const wrapper = executableBasename(words[index]);
  if (wrapper === undefined || !isWrapper(wrapper) || depth >= MAX_WRAPPER_INSPECTION_DEPTH) return false;
  const target = resolveWrapperTarget(words, index + 1, wrapper);
  if (target.kind === "target") return hasNestedPayloadCandidate(words, target.index, depth + 1);
  return target.kind === "ambiguous" && ambiguousWrapperHasCandidatePayload(words, index);
}

function hasNestedPayloadCandidateInSegments(segments: readonly { tokens: readonly string[] }[]): boolean {
  return segments.some((segment) => hasNestedPayloadCandidate(segment.tokens.map((literal) => ({ literal, hasDynamicFragment: false }))));
}

function hasNestedWrapperCandidate(words: readonly ShellWord[]): boolean {
  const wrapper = executableBasename(words[0]);
  if (wrapper === undefined || !isWrapper(wrapper)) return false;
  const target = resolveWrapperTarget(words, 1, wrapper);
  if (target.kind !== "target") return false;
  const nestedWrapper = executableBasename(words[target.index]);
  return nestedWrapper !== undefined && isWrapper(nestedWrapper) && inspectExecutable(words, 0);
}

function hasNestedWrapperCandidateInSegments(segments: readonly { tokens: readonly string[] }[]): boolean {
  return segments.some((segment) => hasNestedWrapperCandidate(segment.tokens.map((literal) => ({ literal, hasDynamicFragment: false }))));
}

/** Creates the pure event pipeline; callers own Pi event registration and probe process wiring. */
export function createRuntimeHandler(dependencies: RuntimeDependencies): (event: unknown, context: BashContext) => Promise<ToolCallBlock | undefined> {
  const isBashEvent = dependencies.isBashEvent ?? defaultBashEvent;
  return async (event, context) => {
    if (!isBashEvent(event)) return undefined;
    const command = event.input.command;
    try {
      const lexed = lexShell(command);
      if (!lexed.ok) return hasMalformedShellCandidate(command) ? malformedCandidateBlock() : undefined;
      if (hasNestedPayloadCandidateInSegments(lexed.segments)) return malformedCandidateBlock();

      const supply = classifyManagerSegments(lexed.segments);
      if (supply.kind === "block") return reason(`supply_${supply.code}`, supply.remediation);
      if (supply.kind === "needs_controls") {
        const plan = createProbePlan(supply);
        if (!plan.ok) return reason("supply_static_decision_not_eligible", "Use a supported direct package-manager operation.");
        let evidence: ControlEvidence;
        try {
          evidence = await dependencies.runProbePlan(plan.value, { cwd: context.cwd, signal: context.signal });
        } catch {
          return reason("probe_failure_unexpected_key", "Re-run the bounded manager probe and provide normalized supported evidence.");
        }
        const controls = evaluateControlEvidence(supply, evidence);
        if (controls.kind === "block") return reason(controls.code, controls.remediation);
      }

      const sql = classifySqlSegments(lexed.segments);
      if (sql.kind === "block") return reason(sql.code, sql.remediation);
      return hasNestedWrapperCandidateInSegments(lexed.segments) ? malformedCandidateBlock() : undefined;
    } catch {
      return hasMalformedShellCandidate(command) ? malformedCandidateBlock() : undefined;
    }
  };
}

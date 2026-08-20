export type ShellOperator = ";" | "newline" | "&&" | "||" | "|";

export type ShellSegment = {
  precedingOperator: ShellOperator | null;
  tokens: readonly string[];
};

export type ShellLexFailureReason =
  | "arithmetic_substitution"
  | "background_operator"
  | "backtick_substitution"
  | "command_substitution"
  | "comment_syntax"
  | "control_character"
  | "dangling_escape"
  | "empty_segment"
  | "parameter_expansion"
  | "process_substitution"
  | "redirection"
  | "shell_grouping"
  | "tilde_expansion"
  | "unclosed_double_quote"
  | "unclosed_single_quote"
  | "unsupported_metacharacter";

export type ShellLexResult =
  | { ok: true; segments: readonly ShellSegment[] }
  | { ok: false; reason: ShellLexFailureReason; offset: number };

type QuoteState = "double" | "single" | "unquoted";

type LexerState = {
  currentTokens: string[];
  precedingOperator: ShellOperator | null;
  quoteState: QuoteState;
  segments: ShellSegment[];
  token: string;
  tokenStarted: boolean;
};

type CharacterStep =
  | { ok: true; nextOffset: number }
  | { failure: ShellLexResult; ok: false };

const DIRECT_UNQUOTED_FAILURES: Readonly<Partial<Record<string, ShellLexFailureReason>>> = {
  "!": "unsupported_metacharacter",
  "(": "shell_grouping",
  ")": "shell_grouping",
  "*": "unsupported_metacharacter",
  "[": "unsupported_metacharacter",
  "]": "unsupported_metacharacter",
  "`": "backtick_substitution",
  "{": "shell_grouping",
  "}": "shell_grouping",
  "~": "tilde_expansion",
};

function failure(reason: ShellLexFailureReason, offset: number): ShellLexResult {
  return { ok: false, reason, offset };
}

function successfulStep(nextOffset: number): CharacterStep {
  return { ok: true, nextOffset };
}

function failedStep(reason: ShellLexFailureReason, offset: number): CharacterStep {
  return { ok: false, failure: failure(reason, offset) };
}

function isDisallowedControlCharacter(character: string): boolean {
  return character !== "\n" && character !== "\t" && character.charCodeAt(0) < 0x20;
}

function isWhitespace(character: string): boolean {
  return character === " " || character === "\t";
}

function appendTokenCharacter(state: LexerState, character: string): void {
  state.token += character;
  state.tokenStarted = true;
}

function flushToken(state: LexerState): void {
  if (!state.tokenStarted) {
    return;
  }

  state.currentTokens.push(state.token);
  state.token = "";
  state.tokenStarted = false;
}

function closeSegment(state: LexerState, offset: number): ShellLexResult | undefined {
  flushToken(state);
  if (state.currentTokens.length === 0) {
    return failure("empty_segment", offset);
  }

  state.segments.push({
    precedingOperator: state.precedingOperator,
    tokens: state.currentTokens,
  });
  state.currentTokens = [];
  return undefined;
}

function applyOperator(state: LexerState, operator: ShellOperator, offset: number): ShellLexResult | undefined {
  const result = closeSegment(state, offset);
  if (result !== undefined) {
    return result;
  }

  state.precedingOperator = operator;
  return undefined;
}

function operatorAt(input: string, offset: number): { operator: ShellOperator; width: number } | undefined {
  const character = input.charAt(offset);
  if (character === ";" || character === "\n") {
    return { operator: character === "\n" ? "newline" : ";", width: 1 };
  }
  if (character === "&" && input.charAt(offset + 1) === "&") {
    return { operator: "&&", width: 2 };
  }
  if (character === "|") {
    return { operator: input.charAt(offset + 1) === "|" ? "||" : "|", width: input.charAt(offset + 1) === "|" ? 2 : 1 };
  }
  return undefined;
}

function substitutionFailureAt(input: string, offset: number): ShellLexFailureReason {
  if (input.charAt(offset + 1) !== "(") {
    return "parameter_expansion";
  }
  return input.charAt(offset + 2) === "(" ? "arithmetic_substitution" : "command_substitution";
}

function unquotedFailureAt(state: LexerState, input: string, offset: number): ShellLexFailureReason | undefined {
  const character = input.charAt(offset);
  const directFailure = DIRECT_UNQUOTED_FAILURES[character];
  if (directFailure !== undefined) {
    return directFailure;
  }

  if (character === "#" && !state.tokenStarted) {
    return "comment_syntax";
  }
  if (character === "<") {
    return input.charAt(offset + 1) === "(" ? "process_substitution" : "redirection";
  }
  if (character === ">") {
    return "redirection";
  }
  if (character === "$") {
    return substitutionFailureAt(input, offset);
  }
  if (character === "&") {
    return "background_operator";
  }
  return undefined;
}

function consumeEscapedCharacter(state: LexerState, input: string, offset: number, preserveBackslash: boolean): CharacterStep {
  const escaped = input.charAt(offset + 1);
  if (escaped === "") {
    return failedStep("dangling_escape", offset);
  }
  if (escaped === "\n") {
    return failedStep("unsupported_metacharacter", offset);
  }

  appendTokenCharacter(state, preserveBackslash ? `\\${escaped}` : escaped);
  return successfulStep(offset + 2);
}

function consumeSingleQuotedCharacter(state: LexerState, character: string, offset: number): CharacterStep {
  if (character === "'") {
    state.quoteState = "unquoted";
    return successfulStep(offset + 1);
  }

  appendTokenCharacter(state, character);
  return successfulStep(offset + 1);
}

function consumeDoubleQuotedCharacter(state: LexerState, input: string, offset: number): CharacterStep {
  const character = input.charAt(offset);
  if (character === "\"") {
    state.quoteState = "unquoted";
    return successfulStep(offset + 1);
  }
  if (character === "\\") {
    const escaped = input.charAt(offset + 1);
    const preservesBackslash = escaped !== "\"" && escaped !== "\\" && escaped !== "$" && escaped !== "`";
    return consumeEscapedCharacter(state, input, offset, preservesBackslash);
  }
  if (character === "$") {
    return failedStep("parameter_expansion", offset);
  }
  if (character === "`") {
    return failedStep("backtick_substitution", offset);
  }

  appendTokenCharacter(state, character);
  return successfulStep(offset + 1);
}

function consumeUnquotedCharacter(state: LexerState, input: string, offset: number): CharacterStep {
  const character = input.charAt(offset);
  if (isWhitespace(character)) {
    flushToken(state);
    return successfulStep(offset + 1);
  }
  if (character === "'") {
    state.quoteState = "single";
    state.tokenStarted = true;
    return successfulStep(offset + 1);
  }
  if (character === "\"") {
    state.quoteState = "double";
    state.tokenStarted = true;
    return successfulStep(offset + 1);
  }
  if (character === "\\") {
    return consumeEscapedCharacter(state, input, offset, false);
  }

  const operator = operatorAt(input, offset);
  if (operator !== undefined) {
    const result = applyOperator(state, operator.operator, offset);
    return result === undefined ? successfulStep(offset + operator.width) : { ok: false, failure: result };
  }

  const reason = unquotedFailureAt(state, input, offset);
  if (reason !== undefined) {
    return failedStep(reason, offset);
  }

  appendTokenCharacter(state, character);
  return successfulStep(offset + 1);
}

function consumeCharacter(state: LexerState, input: string, offset: number): CharacterStep {
  const character = input.charAt(offset);
  if (isDisallowedControlCharacter(character)) {
    return failedStep("control_character", offset);
  }
  if (state.quoteState === "single") {
    return consumeSingleQuotedCharacter(state, character, offset);
  }
  if (state.quoteState === "double") {
    return consumeDoubleQuotedCharacter(state, input, offset);
  }
  return consumeUnquotedCharacter(state, input, offset);
}

function finishLexing(state: LexerState, inputLength: number): ShellLexResult {
  if (state.quoteState === "single") {
    return failure("unclosed_single_quote", inputLength);
  }
  if (state.quoteState === "double") {
    return failure("unclosed_double_quote", inputLength);
  }

  flushToken(state);
  if (state.currentTokens.length === 0) {
    return state.segments.length === 0 ? { ok: true, segments: state.segments } : failure("empty_segment", inputLength);
  }

  state.segments.push({
    precedingOperator: state.precedingOperator,
    tokens: state.currentTokens,
  });
  return { ok: true, segments: state.segments };
}

/**
 * Lexes only static shell argv syntax. It intentionally rejects constructs that
 * need shell expansion, execution, or a full grammar to interpret safely.
 */
export function lexShell(input: string): ShellLexResult {
  const state: LexerState = {
    currentTokens: [],
    precedingOperator: null,
    quoteState: "unquoted",
    segments: [],
    token: "",
    tokenStarted: false,
  };

  for (let offset = 0; offset < input.length;) {
    const step = consumeCharacter(state, input, offset);
    if (!step.ok) {
      return step.failure;
    }
    offset = step.nextOffset;
  }

  return finishLexing(state, input.length);
}

export type SqlDialect = "postgres" | "mysql" | "sqlite";
export type SqlObjectType = "database" | "schema" | "table";
export type SqlUnverifiableReason =
  | "ambiguous_backslash_escape"
  | "control_character"
  | "executable_comment"
  | "input_too_large"
  | "mysql_source_command"
  | "psql_interpolation"
  | "psql_meta_command"
  | "unclosed_block_comment"
  | "unclosed_dollar_quote"
  | "unclosed_double_quote"
  | "unclosed_single_quote"
  | "unclosed_backtick_identifier";

export type SqlScanResult =
  | Readonly<{ kind: "safe" }>
  | Readonly<{ kind: "protected_drop"; objectType: SqlObjectType }>
  | Readonly<{ kind: "unverifiable"; reason: SqlUnverifiableReason }>;

type SqlStep =
  | Readonly<{ kind: "advance"; next: number }>
  | Readonly<{ kind: "semicolon"; next: number }>
  | Readonly<{ kind: "word"; next: number; word: string }>
  | Readonly<{ kind: "failure"; result: SqlScanResult }>;

type QuotedResult = Readonly<{ next: number }> | Readonly<{ failure: SqlScanResult }>;

/** Conservative V1 bound; callers must not use this scanner for unbounded SQL. */
export const MAX_SQL_INPUT_LENGTH = 65_536;

function safe(): SqlScanResult {
  return { kind: "safe" };
}

function unverifiable(reason: SqlUnverifiableReason): SqlScanResult {
  return { kind: "unverifiable", reason };
}

function isControl(character: string): boolean {
  const code = character.charCodeAt(0);
  return (code < 0x20 && character !== "\n" && character !== "\r" && character !== "\t") || code === 0x7f;
}

function isWordStart(character: string): boolean {
  return (character >= "A" && character <= "Z") || (character >= "a" && character <= "z") || character === "_";
}

function isWordCharacter(character: string): boolean {
  return isWordStart(character) || (character >= "0" && character <= "9");
}

function upperWord(input: string, start: number): Readonly<{ next: number; word: string }> {
  let next = start + 1;
  while (next < input.length && isWordCharacter(input.charAt(next))) next += 1;
  return { next, word: input.slice(start, next).toUpperCase() };
}

function protectedDrop(tokens: readonly string[]): SqlObjectType | undefined {
  const target = tokens.at(-1);
  if (target !== "TABLE" && target !== "DATABASE" && target !== "SCHEMA") return undefined;
  const beforeTarget = tokens.at(-2);
  const beforeModifier = tokens.at(-3);
  const beforeExists = tokens.at(-4);
  const beforeIf = tokens.at(-5);
  if (beforeTarget === "DROP" || beforeTarget === "TEMPORARY" && beforeModifier === "DROP") {
    return target.toLowerCase() as SqlObjectType;
  }
  if (beforeTarget === "EXISTS" && beforeModifier === "IF" && beforeExists === "DROP") {
    return target.toLowerCase() as SqlObjectType;
  }
  if (beforeTarget === "EXISTS" && beforeModifier === "IF" && beforeExists === "TEMPORARY" && beforeIf === "DROP") {
    return target.toLowerCase() as SqlObjectType;
  }
  return undefined;
}

function mysqlLineComment(input: string, offset: number): boolean {
  const next = input.charAt(offset + 2);
  return next === "" || next === " " || next === "\t" || next === "\r" || next === "\n" || next.charCodeAt(0) < 0x20;
}

function lineCommentWidth(input: string, offset: number, dialect: SqlDialect): number | undefined {
  const character = input.charAt(offset);
  if (dialect === "mysql" && character === "#") return 1;
  if (character !== "-" || input.charAt(offset + 1) !== "-") return undefined;
  return dialect !== "mysql" || mysqlLineComment(input, offset) ? 2 : undefined;
}

function skipLineComment(input: string, start: number, width: number): number {
  const newline = input.indexOf("\n", start + width);
  return newline === -1 ? input.length : newline + 1;
}

function skipBlockComment(input: string, start: number, dialect: SqlDialect): QuotedResult {
  if (dialect === "mysql" && (input.charAt(start + 2) === "!" || input.charAt(start + 2) === "M" && input.charAt(start + 3) === "!")) {
    return { failure: unverifiable("executable_comment") };
  }

  let depth = 1;
  for (let offset = start + 2; offset < input.length - 1; offset += 1) {
    if (input.charAt(offset) === "/" && input.charAt(offset + 1) === "*") {
      depth += 1;
      offset += 1;
      continue;
    }
    if (input.charAt(offset) === "*" && input.charAt(offset + 1) === "/") {
      depth -= 1;
      if (depth === 0) return { next: offset + 2 };
      offset += 1;
    }
  }
  return { failure: unverifiable("unclosed_block_comment") };
}

function skipQuoted(input: string, start: number, quote: string, failureReason: SqlUnverifiableReason): QuotedResult {
  for (let offset = start + 1; offset < input.length; offset += 1) {
    const character = input.charAt(offset);
    if (character === "\\") return { failure: unverifiable("ambiguous_backslash_escape") };
    if (character !== quote) continue;
    if (input.charAt(offset + 1) === quote) {
      offset += 1;
      continue;
    }
    return { next: offset + 1 };
  }
  return { failure: unverifiable(failureReason) };
}

function quoteFailureReason(character: string): SqlUnverifiableReason | undefined {
  if (character === "'") return "unclosed_single_quote";
  if (character === "\"") return "unclosed_double_quote";
  return character === "`" ? "unclosed_backtick_identifier" : undefined;
}

function dollarDelimiter(input: string, start: number): string | undefined {
  if (input.charAt(start) !== "$") return undefined;
  if (input.charAt(start + 1) === "$") return "$$";
  if (!isWordStart(input.charAt(start + 1))) return undefined;
  let offset = start + 2;
  while (offset < input.length && isWordCharacter(input.charAt(offset))) offset += 1;
  return input.charAt(offset) === "$" ? input.slice(start, offset + 1) : undefined;
}

function psqlInterpolationAt(input: string, offset: number): boolean {
  if (input.charAt(offset) !== ":") return false;
  const next = input.charAt(offset + 1);
  return input.charAt(offset - 1) !== ":" && next !== ":" && (next === "'" || next === "\"" || isWordStart(next));
}

function beginsClientCommand(tokens: readonly string[]): boolean {
  return tokens.length === 0 || tokens.at(-1) === ";";
}

function quotedStep(input: string, offset: number, reason: SqlUnverifiableReason): SqlStep {
  const quoted = skipQuoted(input, offset, input.charAt(offset), reason);
  return "failure" in quoted ? { kind: "failure", result: quoted.failure } : { kind: "advance", next: quoted.next };
}

function blockCommentStep(input: string, offset: number, dialect: SqlDialect): SqlStep {
  const comment = skipBlockComment(input, offset, dialect);
  return "failure" in comment ? { kind: "failure", result: comment.failure } : { kind: "advance", next: comment.next };
}

function dollarQuoteStep(input: string, offset: number): SqlStep | undefined {
  const delimiter = dollarDelimiter(input, offset);
  if (delimiter === undefined) return undefined;
  const close = input.indexOf(delimiter, offset + delimiter.length);
  return close === -1
    ? { kind: "failure", result: unverifiable("unclosed_dollar_quote") }
    : { kind: "advance", next: close + delimiter.length };
}

function postgresStep(input: string, offset: number, character: string): SqlStep | undefined {
  if (character === "$") {
    const dollarQuote = dollarQuoteStep(input, offset);
    if (dollarQuote !== undefined) return dollarQuote;
  }
  if (character === "\\") return { kind: "failure", result: unverifiable("psql_meta_command") };
  if (psqlInterpolationAt(input, offset)) return { kind: "failure", result: unverifiable("psql_interpolation") };
  return undefined;
}

function mysqlStep(input: string, offset: number, character: string): SqlStep | undefined {
  if (character === "\\" && input.charAt(offset + 1) === ".") {
    return { kind: "failure", result: unverifiable("mysql_source_command") };
  }
  return undefined;
}

function dialectStep(input: string, offset: number, dialect: SqlDialect, character: string): SqlStep | undefined {
  if (dialect === "postgres") return postgresStep(input, offset, character);
  if (dialect === "mysql") return mysqlStep(input, offset, character);
  return undefined;
}

function sqlStep(input: string, offset: number, dialect: SqlDialect): SqlStep {
  const character = input.charAt(offset);
  if (isControl(character)) return { kind: "failure", result: unverifiable("control_character") };
  const lineWidth = lineCommentWidth(input, offset, dialect);
  if (lineWidth !== undefined) return { kind: "advance", next: skipLineComment(input, offset, lineWidth) };
  if (character === "/" && input.charAt(offset + 1) === "*") return blockCommentStep(input, offset, dialect);
  const quoteReason = quoteFailureReason(character);
  if (quoteReason !== undefined) return quotedStep(input, offset, quoteReason);
  const dialectSpecific = dialectStep(input, offset, dialect, character);
  if (dialectSpecific !== undefined) return dialectSpecific;
  if (character === ";") return { kind: "semicolon", next: offset + 1 };
  if (isWordStart(character)) {
    const word = upperWord(input, offset);
    return { kind: "word", next: word.next, word: word.word };
  }
  return { kind: "advance", next: offset + 1 };
}

function wordDecision(tokens: string[], word: string, dialect: SqlDialect): SqlScanResult | undefined {
  if (dialect === "mysql" && word === "SOURCE" && beginsClientCommand(tokens)) return unverifiable("mysql_source_command");
  tokens.push(word);
  const objectType = protectedDrop(tokens);
  return objectType === undefined ? undefined : { kind: "protected_drop", objectType };
}

/**
 * Scans a bounded SQL string without constructing an AST or retaining raw SQL in its result.
 * It recognizes only protected DROP keywords and fails closed where client-specific execution
 * syntax or quote semantics would make a lexical answer unreliable.
 */
export function scanSql(input: string, dialect: SqlDialect): SqlScanResult {
  if (input.length > MAX_SQL_INPUT_LENGTH) return unverifiable("input_too_large");

  const tokens: string[] = [];
  for (let offset = 0; offset < input.length;) {
    const step = sqlStep(input, offset, dialect);
    if (step.kind === "failure") return step.result;
    if (step.kind === "semicolon") tokens.push(";");
    if (step.kind === "word") {
      const result = wordDecision(tokens, step.word, dialect);
      if (result !== undefined) return result;
    }
    offset = step.next;
  }
  return safe();
}

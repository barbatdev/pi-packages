import { lexShell, type ShellSegment } from "./argv.ts";
import { scanSql, type SqlDialect, type SqlScanResult } from "./sql-lexer.ts";

export type SqlDecision =
  | Readonly<{ kind: "not_applicable" }>
  | Readonly<{ kind: "block"; code: "protected_sql_drop" | "sql_shell_composition" | "sql_unverifiable_argv" | "sql_unverifiable_input" | "sql_unverifiable_wrapper"; remediation: string }>;

type SqlClient = "mariadb" | "mysql" | "psql" | "sqlite3";
type BlockCode = Extract<SqlDecision, { kind: "block" }>["code"];
type CommandConsumption =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "invalid" }>
  | Readonly<{ kind: "value"; next: number; value: string }>;
type ValueOptionConsumption =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "invalid" }>
  | Readonly<{ kind: "consumed"; next: number }>;
type SqliteArgumentConsumption =
  | Readonly<{ kind: "command"; next: number; value: string }>
  | Readonly<{ kind: "option"; next: number }>
  | Readonly<{ kind: "database"; next: number }>
  | Readonly<{ kind: "invalid_argv" }>
  | Readonly<{ kind: "invalid_input" }>;

type CommandClientConfig = Readonly<{
  commandOptions: ReadonlySet<string>;
  inlinePrefixes: readonly string[];
  valueOptions: ReadonlySet<string>;
  inputOptions: readonly string[];
  standaloneOptions: ReadonlySet<string>;
}>;

const CLIENTS = new Set<SqlClient>(["psql", "mysql", "mariadb", "sqlite3"]);
const INTERPRETERS = new Set(["sh", "bash", "dash", "zsh", "ksh", "node", "nodejs", "python", "python3", "ruby", "perl"]);
const MAX_WRAPPER_INSPECTION_DEPTH = 3;
const PSQL_VALUE_OPTIONS = new Set(["-d", "--dbname", "-h", "--host", "-p", "--port", "-U", "--username", "-o", "--output", "-v", "--set", "--variable"]);
const MYSQL_VALUE_OPTIONS = new Set(["-h", "--host", "-P", "--port", "-u", "--user", "-D", "--database", "--protocol", "--socket", "--default-character-set"]);
const SQLITE_FLAGS = new Set(["-batch", "-bail", "-readonly", "-noheader", "-header", "-column", "-list", "-csv", "-json", "-line", "-quote", "-ascii", "-tabs", "-table", "-html", "-markdown", "-box", "-qbox", "-nullvalue", "-separator", "-newline"]);
const PSQL_INFO_MODES = new Set(["--help", "--version", "-?", "-l", "--list"]);
const MYSQL_INFO_MODES = new Set(["--help", "--version", "-V"]);
const SQLITE_INFO_MODES = new Set(["--help", "-help", "--version", "-version"]);
const PSQL_CONFIG: CommandClientConfig = {
  commandOptions: new Set(["-c", "--command"]),
  inlinePrefixes: ["--command="],
  valueOptions: PSQL_VALUE_OPTIONS,
  inputOptions: ["-f", "--file"],
  standaloneOptions: new Set(["-q", "-A", "-t", "--tuples-only", "--no-align"]),
};
const MYSQL_CONFIG: CommandClientConfig = {
  commandOptions: new Set(["-e", "--execute", "--init-command", "--init-command-add"]),
  inlinePrefixes: ["--execute=", "--init-command=", "--init-command-add="],
  valueOptions: MYSQL_VALUE_OPTIONS,
  inputOptions: [],
  standaloneOptions: new Set(["-p", "--password", "-B", "--batch", "-N", "--skip-column-names"]),
};
const SUDO_VALUE_OPTIONS = new Set(["-u", "-g", "-h", "-C", "-r", "-t", "-T", "-R", "-D", "--user", "--group", "--host", "--close-from", "--role", "--type", "--command-timeout", "--chdir"]);
const ENV_VALUE_OPTIONS = new Set(["-u", "--unset", "-C", "--chdir"]);

function block(code: BlockCode): Extract<SqlDecision, { kind: "block" }> {
  const remediation = code === "protected_sql_drop"
    ? "Remove the protected direct DROP statement from the recognized SQL client invocation."
    : "Use a direct supported SQL client argv form with bounded inline SQL and no indirect input.";
  return { kind: "block", code, remediation };
}

function executableClient(value: string | undefined): SqlClient | undefined {
  if (value === undefined) return undefined;
  const basename = value.slice(value.lastIndexOf("/") + 1);
  return CLIENTS.has(basename as SqlClient) ? basename as SqlClient : undefined;
}

function scanResultDecision(result: SqlScanResult): SqlDecision {
  if (result.kind === "safe") return { kind: "not_applicable" };
  return result.kind === "protected_drop" ? block("protected_sql_drop") : block("sql_unverifiable_input");
}

function scanAll(values: readonly string[], dialect: SqlDialect): SqlDecision {
  for (const value of values) {
    const decision = scanResultDecision(scanSql(value, dialect));
    if (decision.kind === "block") return decision;
  }
  return { kind: "not_applicable" };
}

function hasOnlyInfoMode(tokens: readonly string[], modes: ReadonlySet<string>): boolean {
  return tokens.length > 1 && tokens.slice(1).every((token) => modes.has(token));
}

function valueAt(tokens: readonly string[], index: number): string | undefined {
  const value = tokens[index + 1];
  return value === undefined || value === "--" ? undefined : value;
}

function consumeCommandOption(tokens: readonly string[], index: number, config: CommandClientConfig): CommandConsumption {
  const token = tokens[index] ?? "";
  if (config.commandOptions.has(token)) {
    const value = valueAt(tokens, index);
    return value === undefined ? { kind: "invalid" } : { kind: "value", value, next: index + 2 };
  }
  const prefix = config.inlinePrefixes.find((candidate) => token.startsWith(candidate));
  if (prefix === undefined) return { kind: "none" };
  const value = token.slice(prefix.length);
  return value.length === 0 ? { kind: "invalid" } : { kind: "value", value, next: index + 1 };
}

function consumeValueOption(tokens: readonly string[], index: number, options: ReadonlySet<string>): ValueOptionConsumption {
  const token = tokens[index] ?? "";
  if (options.has(token)) return valueAt(tokens, index) === undefined ? { kind: "invalid" } : { kind: "consumed", next: index + 2 };
  const inline = [...options].find((option) => option.startsWith("--") && token.startsWith(`${option}=`));
  if (inline === undefined) return { kind: "none" };
  return token.length > inline.length + 1 ? { kind: "consumed", next: index + 1 } : { kind: "invalid" };
}

function inputOption(token: string, config: CommandClientConfig): boolean {
  return config.inputOptions.some((option) => token === option || token.startsWith(`${option}=`));
}

function mysqlStandaloneOption(token: string, config: CommandClientConfig): boolean {
  return config.standaloneOptions.has(token) || token.startsWith("-p") || token.startsWith("--password=");
}

function collectCommandClient(tokens: readonly string[], config: CommandClientConfig, dialect: SqlDialect): SqlDecision {
  const commands: string[] = [];
  for (let index = 1; index < tokens.length;) {
    const command = consumeCommandOption(tokens, index, config);
    if (command.kind === "invalid") return block("sql_unverifiable_argv");
    if (command.kind === "value") {
      commands.push(command.value);
      index = command.next;
      continue;
    }
    const option = consumeValueOption(tokens, index, config.valueOptions);
    if (option.kind === "invalid") return block("sql_unverifiable_argv");
    if (option.kind === "consumed") {
      index = option.next;
      continue;
    }
    const token = tokens[index] ?? "";
    if (inputOption(token, config)) return block("sql_unverifiable_input");
    if (!mysqlStandaloneOption(token, config)) return block("sql_unverifiable_argv");
    index += 1;
  }
  return commands.length === 0 ? block("sql_unverifiable_input") : scanAll(commands, dialect);
}

function classifyPsql(tokens: readonly string[]): SqlDecision {
  return hasOnlyInfoMode(tokens, PSQL_INFO_MODES) ? { kind: "not_applicable" } : collectCommandClient(tokens, PSQL_CONFIG, "postgres");
}

function classifyMysql(tokens: readonly string[]): SqlDecision {
  return hasOnlyInfoMode(tokens, MYSQL_INFO_MODES) ? { kind: "not_applicable" } : collectCommandClient(tokens, MYSQL_CONFIG, "mysql");
}

function sqliteOptionValue(tokens: readonly string[], index: number): CommandConsumption {
  const token = tokens[index] ?? "";
  if (token !== "-cmd") return { kind: "none" };
  const value = valueAt(tokens, index);
  return value === undefined ? { kind: "invalid" } : { kind: "value", value, next: index + 2 };
}

function sqliteFlagNext(tokens: readonly string[], index: number): number | undefined {
  const token = tokens[index] ?? "";
  if (!SQLITE_FLAGS.has(token)) return undefined;
  if (token !== "-nullvalue" && token !== "-separator" && token !== "-newline") return index + 1;
  return valueAt(tokens, index) === undefined ? undefined : index + 2;
}

function consumeSqlitePreDatabaseArgument(tokens: readonly string[], index: number): SqliteArgumentConsumption {
  const command = sqliteOptionValue(tokens, index);
  if (command.kind === "invalid") return { kind: "invalid_argv" };
  if (command.kind === "value") return { kind: "command", next: command.next, value: command.value };
  const token = tokens[index] ?? "";
  if (token === "-init" || token.startsWith("-init=")) return { kind: "invalid_input" };
  const next = sqliteFlagNext(tokens, index);
  if (token.startsWith("-") && next === undefined) return { kind: "invalid_argv" };
  return next === undefined ? { kind: "database", next: index + 1 } : { kind: "option", next };
}

function classifySqlite(tokens: readonly string[]): SqlDecision {
  if (hasOnlyInfoMode(tokens, SQLITE_INFO_MODES)) return { kind: "not_applicable" };
  const commands: string[] = [];
  let databaseIndex: number | undefined;
  for (let index = 1; index < tokens.length;) {
    const consumed = consumeSqlitePreDatabaseArgument(tokens, index);
    if (consumed.kind === "invalid_argv") return block("sql_unverifiable_argv");
    if (consumed.kind === "invalid_input") return block("sql_unverifiable_input");
    if (consumed.kind === "command") commands.push(consumed.value);
    if (consumed.kind === "database") {
      databaseIndex = consumed.next;
      break;
    }
    index = consumed.next;
  }
  if (databaseIndex === undefined) return block("sql_unverifiable_input");
  for (let index = databaseIndex; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token.startsWith(".")) return block("sql_unverifiable_input");
    commands.push(token);
  }
  return commands.length === 0 ? block("sql_unverifiable_input") : scanAll(commands, "sqlite");
}

function classifyDirectClient(client: SqlClient, tokens: readonly string[]): SqlDecision {
  if (client === "psql") return classifyPsql(tokens);
  if (client === "sqlite3") return classifySqlite(tokens);
  return classifyMysql(tokens);
}

function firstVisibleClient(tokens: readonly string[], start: number): SqlClient | undefined {
  return executableClient(tokens[start]);
}

function wrapperTarget(tokens: readonly string[], optionsWithValue: ReadonlySet<string>): SqlClient | undefined {
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token === "--") return firstVisibleClient(tokens, index + 1);
    if (optionsWithValue.has(token)) {
      index += 1;
      continue;
    }
    if (!token.startsWith("-")) return firstVisibleClient(tokens, index);
  }
  return undefined;
}

function envTarget(tokens: readonly string[]): SqlClient | undefined {
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token === "--") return firstVisibleClient(tokens, index + 1);
    if (ENV_VALUE_OPTIONS.has(token)) {
      index += 1;
      continue;
    }
    if (token === "-i" || token === "--ignore-environment" || token.startsWith("--unset=") || token.startsWith("--chdir=") || token.includes("=")) continue;
    if (!token.startsWith("-")) return firstVisibleClient(tokens, index);
  }
  return undefined;
}

function explicitWrapperPayload(tokens: readonly string[]): string | undefined {
  const command = tokens[0];
  if (command === "eval") return tokens.length > 1 ? tokens.slice(1).join(" ") : undefined;
  if (command === undefined || !INTERPRETERS.has(command)) return undefined;
  const flag = tokens.indexOf("-c");
  return flag === -1 ? undefined : tokens[flag + 1];
}

function wrapperTargetClient(tokens: readonly string[]): SqlClient | undefined {
  const command = tokens[0];
  if (command === "command") return tokens[1] === "-v" || tokens[1] === "-V" ? undefined : wrapperTarget(tokens, new Set());
  if (command === "exec") return wrapperTarget(tokens, new Set(["-a"]));
  if (command === "env") return envTarget(tokens);
  if (command === "sudo") return wrapperTarget(tokens, SUDO_VALUE_OPTIONS);
  if (command === "corepack") return wrapperTarget(tokens, new Set(["--install-directory"]));
  return undefined;
}

function visibleClientText(payload: string): boolean {
  return [...CLIENTS].some((client) => payload.includes(client));
}

function payloadHasClient(payload: string, depth: number): boolean {
  const lexed = lexShell(payload);
  if (!lexed.ok) return visibleClientText(payload);
  return lexed.segments.some((segment) => hasClientCandidate(segment.tokens, depth));
}

function hasClientCandidate(tokens: readonly string[], depth: number): boolean {
  if (executableClient(tokens[0]) !== undefined) return true;
  const payload = explicitWrapperPayload(tokens);
  if (payload !== undefined) {
    return depth >= MAX_WRAPPER_INSPECTION_DEPTH ? visibleClientText(payload) : payloadHasClient(payload, depth + 1);
  }
  return wrapperTargetClient(tokens) !== undefined;
}

function candidateDecision(tokens: readonly string[]): SqlDecision | undefined {
  const client = executableClient(tokens[0]);
  if (client !== undefined) return classifyDirectClient(client, tokens);
  return hasClientCandidate(tokens, 0) ? block("sql_unverifiable_wrapper") : undefined;
}

/** Classifies one pre-lexed shell segment without executing or mutating client argv. */
export function classifySqlSegment(segment: ShellSegment): SqlDecision {
  const candidate = candidateDecision(segment.tokens);
  if (candidate === undefined) return { kind: "not_applicable" };
  return segment.precedingOperator === null ? candidate : block("sql_shell_composition");
}

/** Requires a recognized SQL client candidate to be the only static shell segment. */
export function classifySqlSegments(segments: readonly ShellSegment[]): SqlDecision {
  const candidates = segments.filter((segment) => candidateDecision(segment.tokens) !== undefined);
  if (candidates.length === 0) return { kind: "not_applicable" };
  if (segments.length !== 1 || candidates.length !== 1) return block("sql_shell_composition");
  return classifySqlSegment(candidates[0] as ShellSegment);
}

import assert from "node:assert/strict";
import test from "node:test";

import type { ShellSegment } from "../src/argv.ts";
import { scanSql } from "../src/sql-lexer.ts";
import { classifySqlSegment, classifySqlSegments } from "../src/sql-policy.ts";

function segment(...tokens: string[]): ShellSegment {
  return { precedingOperator: null, tokens };
}

function protectedObject(sql: string, dialect: "postgres" | "mysql" | "sqlite"): string {
  const result = scanSql(sql, dialect);
  assert.equal(result.kind, "protected_drop", sql);
  return result.objectType;
}

function unverifiableReason(sql: string, dialect: "postgres" | "mysql" | "sqlite"): string {
  const result = scanSql(sql, dialect);
  assert.equal(result.kind, "unverifiable", sql);
  return result.reason;
}

function blockCode(tokens: string[]): string {
  const decision = classifySqlSegment(segment(...tokens));
  assert.equal(decision.kind, "block", tokens.join(" "));
  return decision.code;
}

test("scanSql finds protected direct DROP forms across SQL layout", () => {
  const cases: Array<{ sql: string; dialect: "postgres" | "mysql" | "sqlite"; objectType: string }> = [
    { sql: "DROP TABLE accounts", dialect: "postgres", objectType: "table" },
    { sql: "drop database app", dialect: "mysql", objectType: "database" },
    { sql: "DROP\nSCHEMA public", dialect: "sqlite", objectType: "schema" },
    { sql: "DROP /* gap */ TEMPORARY -- gap\n TABLE IF EXISTS session_data", dialect: "mysql", objectType: "table" },
    { sql: "SELECT 1; DROP /* gap */ TABLE IF EXISTS accounts", dialect: "postgres", objectType: "table" },
  ];

  for (const item of cases) {
    assert.equal(protectedObject(item.sql, item.dialect), item.objectType);
  }
});

test("scanSql ignores protected words in quoted content and ordinary comments", () => {
  const cases: Array<{ sql: string; dialect: "postgres" | "mysql" | "sqlite" }> = [
    { sql: "SELECT 'DROP TABLE accounts'", dialect: "postgres" },
    { sql: "SELECT \"DROP TABLE accounts\"", dialect: "sqlite" },
    { sql: "SELECT `DROP TABLE accounts`", dialect: "mysql" },
    { sql: "SELECT $tag$ DROP TABLE accounts $tag$", dialect: "postgres" },
    { sql: "-- DROP TABLE accounts\nSELECT 1", dialect: "postgres" },
    { sql: "/* outer /* DROP TABLE accounts */ still outer */ SELECT 1", dialect: "mysql" },
  ];

  for (const item of cases) {
    assert.deepEqual(scanSql(item.sql, item.dialect), { kind: "safe" }, item.sql);
  }
});

test("scanSql handles PostgreSQL casts and dialect-specific line comments", () => {
  assert.deepEqual(scanSql("SELECT 1::int", "postgres"), { kind: "safe" });
  assert.deepEqual(scanSql("SELECT value::schema.type", "postgres"), { kind: "safe" });
  assert.equal(unverifiableReason("SELECT :name", "postgres"), "psql_interpolation");
  assert.equal(unverifiableReason("SELECT :'name'", "postgres"), "psql_interpolation");
  assert.equal(unverifiableReason("SELECT :\"name\"", "postgres"), "psql_interpolation");
  assert.deepEqual(scanSql("# DROP TABLE accounts\nSELECT 1", "mysql"), { kind: "safe" });
  assert.equal(protectedObject("# DROP TABLE accounts\nSELECT 1", "postgres"), "table");
  assert.equal(protectedObject("# DROP TABLE accounts\nSELECT 1", "sqlite"), "table");
  assert.deepEqual(scanSql("-- DROP TABLE accounts\nSELECT 1", "mysql"), { kind: "safe" });
  assert.equal(protectedObject("SELECT 1 --x DROP TABLE accounts", "mysql"), "table");
});

test("scanSql fails closed for malformed and client-executed syntax", () => {
  assert.equal(unverifiableReason("SELECT 'unterminated", "postgres"), "unclosed_single_quote");
  assert.equal(unverifiableReason("SELECT /* unterminated", "mysql"), "unclosed_block_comment");
  assert.equal(unverifiableReason("SELECT $tag$ unterminated", "postgres"), "unclosed_dollar_quote");
  assert.equal(unverifiableReason("/*! DROP TABLE accounts */", "mysql"), "executable_comment");
  assert.equal(unverifiableReason("/*M! DROP TABLE accounts */", "mysql"), "executable_comment");
  assert.equal(unverifiableReason("SELECT :name", "postgres"), "psql_interpolation");
  assert.equal(unverifiableReason("\\i scripts.sql", "postgres"), "psql_meta_command");
  assert.equal(unverifiableReason("source scripts.sql", "mysql"), "mysql_source_command");
  assert.equal(unverifiableReason("\\. scripts.sql", "mysql"), "mysql_source_command");
  assert.equal(unverifiableReason("SELECT 'a\\b'", "mysql"), "ambiguous_backslash_escape");
  assert.equal(unverifiableReason("SELECT \u0000", "sqlite"), "control_character");
  assert.equal(unverifiableReason("x".repeat(65_537), "sqlite"), "input_too_large");
});

test("psql policy recognizes direct SQL and blocks unverifiable argv", () => {
  assert.deepEqual(classifySqlSegment(segment("psql", "-c", "select 1")), { kind: "not_applicable" });
  assert.deepEqual(classifySqlSegment(segment("psql", "--command=select 1", "--command", "select 2")), { kind: "not_applicable" });
  assert.equal(blockCode(["psql", "-c", "DROP TABLE accounts"]), "protected_sql_drop");
  assert.equal(blockCode(["psql", "-c", "select 1", "-f", "script.sql"]), "sql_unverifiable_input");
  assert.equal(blockCode(["psql"]), "sql_unverifiable_input");
  assert.equal(blockCode(["psql", "--unknown"]), "sql_unverifiable_argv");
  assert.equal(blockCode(["psql", "-cDROP TABLE accounts"]), "sql_unverifiable_argv");
  assert.deepEqual(classifySqlSegment(segment("psql", "--help")), { kind: "not_applicable" });
  assert.deepEqual(classifySqlSegment(segment("psql", "--version")), { kind: "not_applicable" });
  assert.deepEqual(classifySqlSegment(segment("psql", "-l")), { kind: "not_applicable" });
});

test("mysql and mariadb policy handles supported SQL flags", () => {
  for (const client of ["mysql", "mariadb"]) {
    assert.deepEqual(classifySqlSegment(segment(client, "-e", "select 1", "--init-command=select 2")), { kind: "not_applicable" }, client);
    assert.equal(blockCode([client, "--execute", "DROP DATABASE app"]), "protected_sql_drop", client);
    assert.equal(blockCode([client, "--init-command-add=DROP SCHEMA app"]), "protected_sql_drop", client);
    assert.equal(blockCode([client, "-e", "source script.sql"]), "sql_unverifiable_input", client);
    assert.equal(blockCode([client]), "sql_unverifiable_input", client);
    assert.equal(blockCode([client, "--unknown"]), "sql_unverifiable_argv", client);
    assert.equal(blockCode([client, "-eDROP TABLE accounts"]), "sql_unverifiable_argv", client);
    assert.deepEqual(classifySqlSegment(segment(client, "--help")), { kind: "not_applicable" }, client);
    assert.deepEqual(classifySqlSegment(segment(client, "--version")), { kind: "not_applicable" }, client);
  }
});

test("sqlite3 policy processes SQL after the database filename", () => {
  assert.deepEqual(classifySqlSegment(segment("sqlite3", "app.db", "select 1", "select 2")), { kind: "not_applicable" });
  assert.deepEqual(classifySqlSegment(segment("sqlite3", "-cmd", "select 1", "app.db", "select 2")), { kind: "not_applicable" });
  assert.equal(blockCode(["sqlite3", "app.db", "DROP TABLE accounts"]), "protected_sql_drop");
  assert.equal(blockCode(["sqlite3", "app.db", ".read script.sql"]), "sql_unverifiable_input");
  assert.equal(blockCode(["sqlite3", "-init", "setup.sql", "app.db", "select 1"]), "sql_unverifiable_input");
  assert.equal(blockCode(["sqlite3", "app.db"]), "sql_unverifiable_input");
  assert.equal(blockCode(["sqlite3", "--unknown", "app.db", "select 1"]), "sql_unverifiable_argv");
  assert.deepEqual(classifySqlSegment(segment("sqlite3", "--help")), { kind: "not_applicable" });
  assert.deepEqual(classifySqlSegment(segment("sqlite3", "--version")), { kind: "not_applicable" });
  assert.deepEqual(classifySqlSegment(segment("sqlite3", "-help")), { kind: "not_applicable" });
});

test("SQL policy recognizes paths, wrappers, composition, and preserves input", () => {
  assert.equal(blockCode(["/usr/bin/psql", "-c", "DROP TABLE accounts"]), "protected_sql_drop");
  assert.equal(blockCode(["sudo", "psql", "-c", "select 1"]), "sql_unverifiable_wrapper");
  assert.equal(blockCode(["sudo", "-u", "dbadmin", "psql", "-c", "select 1"]), "sql_unverifiable_wrapper");
  assert.equal(blockCode(["env", "MYSQL_PWD=x", "mysql", "-e", "select 1"]), "sql_unverifiable_wrapper");
  assert.equal(blockCode(["env", "-u", "OLDPWD", "mysql", "-e", "select 1"]), "sql_unverifiable_wrapper");
  assert.equal(blockCode(["corepack", "--install-directory", "bin", "sqlite3", "app.db", "select 1"]), "sql_unverifiable_wrapper");
  assert.equal(blockCode(["bash", "-c", "sqlite3 app.db 'select 1'"]), "sql_unverifiable_wrapper");
  assert.equal(blockCode(["bash", "-c", "echo ok; psql -c 'select 1'"]), "sql_unverifiable_wrapper");
  assert.equal(blockCode(["eval", "psql -c 'select 1'"]), "sql_unverifiable_wrapper");
  assert.equal(blockCode(["eval", "echo ok; mysql -e 'select 1'"]), "sql_unverifiable_wrapper");
  assert.equal(blockCode(["bash", "-c", "echo $(psql -c 'select 1')"]), "sql_unverifiable_wrapper");
  assert.deepEqual(classifySqlSegment(segment("bash", "-c", "echo 'psql -c select 1'")), { kind: "not_applicable" });
  assert.deepEqual(classifySqlSegment(segment("eval", "echo psql")), { kind: "not_applicable" });
  assert.deepEqual(classifySqlSegment(segment("command", "-v", "psql")), { kind: "not_applicable" });
  assert.deepEqual(classifySqlSegment(segment("echo", "DROP TABLE accounts")), { kind: "not_applicable" });
  assert.deepEqual(classifySqlSegment(segment("echo", "psql -c DROP TABLE accounts")), { kind: "not_applicable" });

  const original = segment("psql", "-c", "select 1");
  const before = structuredClone(original);
  const decision = classifySqlSegments([original]);
  assert.deepEqual(original, before);
  assert.deepEqual(decision, { kind: "not_applicable" });
  assert.equal(JSON.stringify(classifySqlSegment(segment("psql", "-c", "DROP TABLE private_data"))).includes("private_data"), false);

  const composed: readonly ShellSegment[] = [
    segment("echo", "ok"),
    { precedingOperator: ";", tokens: ["psql", "-c", "select 1"] },
  ];
  assert.equal(classifySqlSegments(composed).kind, "block");
  assert.equal((classifySqlSegments(composed) as { code: string }).code, "sql_shell_composition");
  assert.equal(
    (classifySqlSegment({ precedingOperator: ";", tokens: ["psql", "-c", "select 1"] }) as { code: string }).code,
    "sql_shell_composition",
  );
});

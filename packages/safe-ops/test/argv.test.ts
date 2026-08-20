import assert from "node:assert/strict";
import test from "node:test";

import { lexShell } from "../src/argv.ts";

type SegmentExpectation = {
  precedingOperator: null | ";" | "newline" | "&&" | "||" | "|";
  tokens: readonly string[];
};

function successfulSegments(input: string): readonly SegmentExpectation[] {
  const result = lexShell(input);
  if (!result.ok) {
    throw new Error(`expected success for ${JSON.stringify(input)}`);
  }
  return result.segments;
}

function failureReason(input: string): string {
  const result = lexShell(input);
  if (result.ok) {
    throw new Error(`expected failure for ${JSON.stringify(input)}`);
  }
  return result.reason;
}

test("lexShell accepts static argv forms", () => {
  const cases: Array<{ input: string; expected: SegmentExpectation[]; name: string }> = [
    {
      name: "exact npm package acquisition",
      input: "npm install foo@1.2.3",
      expected: [{ precedingOperator: null, tokens: ["npm", "install", "foo@1.2.3"] }],
    },
    {
      name: "single-quoted scoped package",
      input: "pnpm add '@scope/pkg@1.2.3'",
      expected: [{ precedingOperator: null, tokens: ["pnpm", "add", "@scope/pkg@1.2.3"] }],
    },
    {
      name: "reordered static tokens and double dash",
      input: "npm --loglevel=warn install foo@1.2.3 -- --literal",
      expected: [
        {
          precedingOperator: null,
          tokens: ["npm", "--loglevel=warn", "install", "foo@1.2.3", "--", "--literal"],
        },
      ],
    },
    {
      name: "environment assignment prefix",
      input: "NODE_ENV=production npm install foo@1.2.3",
      expected: [
        {
          precedingOperator: null,
          tokens: ["NODE_ENV=production", "npm", "install", "foo@1.2.3"],
        },
      ],
    },
    {
      name: "escaped whitespace",
      input: "npm install foo\\ bar",
      expected: [{ precedingOperator: null, tokens: ["npm", "install", "foo bar"] }],
    },
    {
      name: "semicolon separator",
      input: "one; two",
      expected: [
        { precedingOperator: null, tokens: ["one"] },
        { precedingOperator: ";", tokens: ["two"] },
      ],
    },
    {
      name: "newline separator",
      input: "one\ntwo",
      expected: [
        { precedingOperator: null, tokens: ["one"] },
        { precedingOperator: "newline", tokens: ["two"] },
      ],
    },
    {
      name: "and separator",
      input: "one && two",
      expected: [
        { precedingOperator: null, tokens: ["one"] },
        { precedingOperator: "&&", tokens: ["two"] },
      ],
    },
    {
      name: "or separator",
      input: "one || two",
      expected: [
        { precedingOperator: null, tokens: ["one"] },
        { precedingOperator: "||", tokens: ["two"] },
      ],
    },
    {
      name: "pipe separator",
      input: "one | two",
      expected: [
        { precedingOperator: null, tokens: ["one"] },
        { precedingOperator: "|", tokens: ["two"] },
      ],
    },
    {
      name: "quoted operator text stays literal",
      input: "echo ';|&&||' \";\" \"|\" \"&&\" \"||\"",
      expected: [
        { precedingOperator: null, tokens: ["echo", ";|&&||", ";", "|", "&&", "||"] },
      ],
    },
    {
      name: "single quotes preserve special characters",
      input: "echo '$VAR $(x) < > & { } * ~ # `x`'",
      expected: [
        { precedingOperator: null, tokens: ["echo", "$VAR $(x) < > & { } * ~ # `x`"] },
      ],
    },
    {
      name: "double quotes support static escaped quote and slash",
      input: "echo \"a\\\"b\\\\c\"",
      expected: [{ precedingOperator: null, tokens: ["echo", "a\"b\\c"] }],
    },
  ];

  for (const { input, expected, name } of cases) {
    assert.deepEqual(successfulSegments(input), expected, name);
  }
});

test("lexShell handles static quoting and horizontal whitespace safely", () => {
  const cases: Array<{ input: string; expected: SegmentExpectation[]; name: string }> = [
    {
      name: "single-quoted tilde stays literal",
      input: "echo '~'",
      expected: [{ precedingOperator: null, tokens: ["echo", "~"] }],
    },
    {
      name: "double-quoted non-special backslash is preserved",
      input: "echo \"a\\qb\"",
      expected: [{ precedingOperator: null, tokens: ["echo", "a\\qb"] }],
    },
    {
      name: "double-quoted escaped dollar and backtick stay literal",
      input: "echo \"\\$value \\`literal\"",
      expected: [{ precedingOperator: null, tokens: ["echo", "$value `literal"] }],
    },
    {
      name: "horizontal tabs separate tokens",
      input: "one\ttwo",
      expected: [{ precedingOperator: null, tokens: ["one", "two"] }],
    },
  ];

  for (const { input, expected, name } of cases) {
    assert.deepEqual(successfulSegments(input), expected, name);
  }
});

test("lexShell rejects unsupported or malformed shell syntax", () => {
  const cases: Array<{ input: string; reason: string; name: string }> = [
    { name: "unclosed single quote", input: "echo 'unterminated", reason: "unclosed_single_quote" },
    { name: "unclosed double quote", input: "echo \"unterminated", reason: "unclosed_double_quote" },
    { name: "dangling escape", input: "echo trailing\\", reason: "dangling_escape" },
    { name: "parameter expansion", input: "echo $VAR", reason: "parameter_expansion" },
    { name: "braced parameter expansion", input: "echo ${VAR}", reason: "parameter_expansion" },
    { name: "double-quoted parameter expansion", input: "echo \"$VAR\"", reason: "parameter_expansion" },
    { name: "command substitution", input: "echo $(command)", reason: "command_substitution" },
    { name: "arithmetic substitution", input: "echo $((1 + 1))", reason: "arithmetic_substitution" },
    { name: "double-quoted command substitution", input: "echo \"$(command)\"", reason: "parameter_expansion" },
    { name: "backtick substitution", input: "echo `command`", reason: "backtick_substitution" },
    { name: "double-quoted backtick substitution", input: "echo \"`command`\"", reason: "backtick_substitution" },
    { name: "process substitution", input: "echo <(command)", reason: "process_substitution" },
    { name: "heredoc", input: "cat <<EOF", reason: "redirection" },
    { name: "output redirection", input: "echo ok > out", reason: "redirection" },
    { name: "append redirection", input: "echo ok >> out", reason: "redirection" },
    { name: "input redirection", input: "cat < in", reason: "redirection" },
    { name: "background ampersand", input: "echo ok &", reason: "background_operator" },
    { name: "grouping", input: "echo (group)", reason: "shell_grouping" },
    { name: "braces", input: "echo {group}", reason: "shell_grouping" },
    { name: "glob", input: "echo *", reason: "unsupported_metacharacter" },
    { name: "tilde expansion", input: "echo ~/file", reason: "tilde_expansion" },
    { name: "tilde in assignment value", input: "HOME=~/tmp npm install foo", reason: "tilde_expansion" },
    { name: "unquoted tilde anywhere in token", input: "echo path~suffix", reason: "tilde_expansion" },
    { name: "comment", input: "echo # comment", reason: "comment_syntax" },
    { name: "control input", input: "echo \u0000", reason: "control_character" },
    { name: "unsupported bang", input: "echo !", reason: "unsupported_metacharacter" },
  ];

  for (const { input, reason, name } of cases) {
    assert.equal(failureReason(input), reason, name);
  }
});

test("lexShell rejects empty segments around operators", () => {
  const cases: Array<{ input: string; name: string }> = [
    { name: "leading separator", input: "; echo ok" },
    { name: "trailing separator", input: "echo ok;" },
    { name: "doubled separators", input: "echo ok && && other" },
    { name: "mixed doubled separators", input: "echo ok || | other" },
  ];

  for (const { input, name } of cases) {
    assert.equal(failureReason(input), "empty_segment", name);
  }
});

test("lexShell returns no segments for whitespace only input and does not mutate its input", () => {
  const input = "   ";
  const before = input;

  assert.deepEqual(successfulSegments(input), []);
  assert.equal(input, before);
});

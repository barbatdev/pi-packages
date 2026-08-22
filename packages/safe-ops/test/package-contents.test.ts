import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageDirectory = join(dirname(fileURLToPath(import.meta.url)), "..");
const expectedPaths = [
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "docs/policy-contract.md",
  "docs/threat-model.md",
  "package.json",
  "src/argv.ts",
  "src/control-evidence.ts",
  "src/index.ts",
  "src/manager-classifier.ts",
  "src/package-spec.ts",
  "src/probe-contract.ts",
  "src/probe-runner.ts",
  "src/runtime.ts",
  "src/sql-lexer.ts",
  "src/sql-policy.ts",
].sort();

type PackResult = {
  filename: string;
  files: Array<{ path: string }>;
};

function parsePackResult(output: string): PackResult {
  const parsed: unknown = JSON.parse(output);
  assert.ok(Array.isArray(parsed), "npm pack output must be a JSON array");
  assert.equal(parsed.length, 1, "npm pack output must contain exactly one package result");

  const [result] = parsed;
  assert.ok(result !== null && typeof result === "object", "npm pack result must be an object");
  assert.ok("filename" in result && typeof result.filename === "string", "npm pack result must include a filename");
  assert.ok("files" in result && Array.isArray(result.files), "npm pack result must include a files array");
  assert.ok(
    result.files.every((file: unknown) => file !== null && typeof file === "object" && "path" in file && typeof file.path === "string"),
    "npm pack files must each include a path",
  );

  return result as PackResult;
}

test("package dry-run exposes only the public package surface", () => {
  const archiveNamesBefore = new Set(
    readdirSync(packageDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".tgz"))
      .map((entry) => entry.name),
  );
  const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
    cwd: packageDirectory,
    encoding: "utf8",
    maxBuffer: 1_048_576,
    shell: false,
    timeout: 10_000,
    windowsHide: true,
  });

  assert.equal(result.error, undefined, "npm pack --dry-run could not be started or exceeded its timeout");
  assert.equal(result.status, 0, "npm pack --dry-run failed");

  const packResult = parsePackResult(result.stdout);
  assert.equal(archiveNamesBefore.has(packResult.filename), false, "npm pack --dry-run must not have created its archive before inspection");
  assert.equal(existsSync(join(packageDirectory, packResult.filename)), false, "npm pack --dry-run must not create an archive");
  assert.deepEqual(packResult.files.map((file) => file.path).sort(), expectedPaths);
});

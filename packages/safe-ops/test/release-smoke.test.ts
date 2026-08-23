import assert from "node:assert/strict";
import test from "node:test";

// The smoke helper is plain dependency-free ESM, intentionally without a TypeScript declaration file.
// @ts-ignore -- exercised directly by Node's ESM loader in this pure-unit test.
const smoke = await import("../../../scripts/release-smoke.mjs");
const { EXPECTED_PACKAGE_PATHS, MAX_DIAGNOSTIC_CHARS, classifyPiResult, comparePacks, formatCompleteEvidence, formatInstalledEvidence, formatPackEvidence, formatPiDiagnostic, formatTerminalEvidence, parsePackResult, sanitizeDiagnosticOutput, validateArchivePath, validateManifest } = smoke;

const expectedPaths = EXPECTED_PACKAGE_PATHS as string[];
const files = expectedPaths.map((path: string) => ({ path }));
const pack = { filename: "pi-safe-ops.tgz", files };

test("pack validation accepts one exact package result only", () => {
  assert.deepEqual((parsePackResult(JSON.stringify([pack])) as { files: Array<{ path: string }> }).files.map((file: { path: string }) => file.path), expectedPaths);
  for (const value of ["{}", "[]", JSON.stringify([pack, pack]), JSON.stringify([{ filename: "x", files: [] }])]) {
    assert.throws(() => parsePackResult(value));
  }
  assert.equal(validateArchivePath("/work/one", "pi-safe-ops.tgz"), "/work/one/pi-safe-ops.tgz");
  for (const name of ["../escape.tgz", "/absolute.tgz", "nested/file.tgz", ""]) assert.throws(() => validateArchivePath("/work/one", name));
});

test("pack comparison and bounded evidence reject unsafe surfaces", () => {
  const digest = { sha256: "a".repeat(64), sha1: "b".repeat(40), sha512: "c".repeat(128), sri: "sha512-c", size: 42, files: EXPECTED_PACKAGE_PATHS };
  assert.doesNotThrow(() => comparePacks(digest, { ...digest }));
  assert.throws(() => comparePacks(digest, { ...digest, size: 43 }));
  assert.throws(() => comparePacks(digest, { ...digest, sha512: "d".repeat(128) }));
  assert.throws(() => comparePacks(digest, { ...digest, files: [...EXPECTED_PACKAGE_PATHS, "extra.js"] }));
  assert.throws(() => comparePacks(digest, { ...digest, files: [...EXPECTED_PACKAGE_PATHS, EXPECTED_PACKAGE_PATHS[0]] }));
  assert.throws(() => comparePacks(digest, { ...digest, files: EXPECTED_PACKAGE_PATHS.slice(1) }));
  assert.throws(() => comparePacks(digest, { ...digest, files: [...EXPECTED_PACKAGE_PATHS].reverse() }));

  assert.equal(sanitizeDiagnosticOutput("\u001b[31mline\r\nnext\r\u0000\tend\u001b[0m"), "line\nnext\n�\tend");
  assert.equal(sanitizeDiagnosticOutput(null), "");
  assert.equal(sanitizeDiagnosticOutput(Buffer.from("raw-buffer")), "");
  const diagnostic = formatPiDiagnostic(null, "out\r\n\u0007", "\u001b[32merr\u001b[0m");
  assert.deepEqual(JSON.parse(diagnostic), { phase: "pi-terminal", status: null, stdout: "out\n�", stderr: "err" });
  assert.equal(diagnostic.includes("\n"), false);
  const bounded = formatPiDiagnostic(1, "x".repeat(10_000), "y".repeat(10_000));
  assert.ok(bounded.length <= MAX_DIAGNOSTIC_CHARS);
  assert.ok(JSON.parse(bounded).stdout.length < 10_000);
  assert.ok(JSON.parse(bounded).stderr.length < 10_000);

  const evidence = { sha256: "a".repeat(64), sha1: "b".repeat(40), sha512: "c".repeat(128), sri: "sha512-c", size: 42, files: ["unexpected"] };
  const packEvidence = formatPackEvidence("a".repeat(40), "0.1.0-beta.0", evidence);
  assert.deepEqual(JSON.parse(packEvidence), { phase: "pack", commit: "a".repeat(40), version: "0.1.0-beta.0", paths: expectedPaths, sha256: evidence.sha256, sha1: evidence.sha1, sha512: evidence.sha512, sri: evidence.sri, size: evidence.size });
  assert.equal(packEvidence.includes("\n"), false);
  assert.ok(packEvidence.length <= MAX_DIAGNOSTIC_CHARS);
  assert.deepEqual(JSON.parse(formatInstalledEvidence("a".repeat(40), "0.1.0-beta.0", "11.16.0", "0.82.1")), { phase: "installed", commit: "a".repeat(40), version: "0.1.0-beta.0", npmVersion: "11.16.0", piVersion: "0.82.1", packageListed: true, nestedPi: false });
  assert.deepEqual(JSON.parse(formatTerminalEvidence("expected-no-model")), { phase: "terminal", token: "expected-no-model" });
  assert.deepEqual(JSON.parse(formatTerminalEvidence("expected-no-key")), { phase: "terminal", token: "expected-no-key" });
  assert.throws(() => formatTerminalEvidence("unexpected"));
  assert.deepEqual(JSON.parse(formatCompleteEvidence("a".repeat(40), "0.1.0-beta.0", evidence)), { phase: "complete", commit: "a".repeat(40), version: "0.1.0-beta.0", paths: expectedPaths, sha256: evidence.sha256, sha1: evidence.sha1, sha512: evidence.sha512, sri: evidence.sri, size: evidence.size, removed: true });
});

test("manifest and Pi terminal policy fail closed", () => {
  const manifest = { name: "@barbatdev/pi-safe-ops", version: "0.1.0-beta.0", private: false, publishConfig: { access: "public" }, peerDependencies: { "@earendil-works/pi-coding-agent": "*" }, pi: { extensions: ["./src/index.ts"] } };
  assert.doesNotThrow(() => validateManifest(manifest));
  for (const invalid of [{ ...manifest, private: true }, { ...manifest, version: "1.0.0" }, { ...manifest, dependencies: { x: "1" } }, { ...manifest, peerDependencies: {} }, { ...manifest, scripts: { prepare: "x" } }]) assert.throws(() => validateManifest(invalid));

  const noModel = "No models available. Use /login to log into a provider via OAuth or API key. See:\n  /tools/node_modules/@earendil-works/pi-coding-agent/docs/providers.md\n  /tools/node_modules/@earendil-works/pi-coding-agent/docs/models.md";
  const noKey = "No API key found for the selected model.\n\nUse /login to log into a provider via OAuth or API key. See:\n  /tools/node_modules/@earendil-works/pi-coding-agent/docs/providers.md\n  /tools/node_modules/@earendil-works/pi-coding-agent/docs/models.md";
  assert.equal(classifyPiResult(1, "", `\u001b[31m${noModel.replace(/\n/g, "\r\n")}\u001b[0m\n`), "expected-no-model");
  assert.equal(classifyPiResult(1, "", `\u001b[31m${noKey.replace(/\n/g, "\r\n")}\u001b[0m\n`), "expected-no-key");
  for (const [status, stdout, stderr] of [
    [0, "", noModel], [null, "", noModel], [1, "output", noModel], [1, "", "No model available"],
    [1, "", `${noModel}\nnode: runtime diagnostic`], [1, "", `${noModel}\nfailed to load extension`],
    [1, "", `${noModel}\nError: Cannot find module 'extension'`],
    [1, "", noModel.replace("docs/models.md", "docs/other.md")],
    [0, "", noKey], [null, "", noKey], [1, "output", noKey], [1, "", "No API key found for a provider."],
    [1, "", noKey.replace("selected model", "another model")], [1, "", noKey.replace("selected model", "Anthropic model")], [1, "", noKey.replace("\n\n", "\n")], [1, "", noKey.replace("\n\n", "\n\n\n")], [1, "", `${noKey}\n\n`],
    [1, "", noKey.replace("docs/providers.md", "docs/provider.md")], [1, "", noKey.replace("docs/models.md", "docs/model.md")], [1, "", `${noKey}\nnode: runtime diagnostic`], [1, "", `node: runtime diagnostic\n${noKey}`],
    [1, "", "No API key found"], [1, "", "No models available"],
  ] as Array<[number | null, string, string]>) {
    assert.equal(classifyPiResult(status, stdout, stderr), "unexpected");
  }
});

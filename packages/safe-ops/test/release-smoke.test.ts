import assert from "node:assert/strict";
import test from "node:test";

// The smoke helper is plain dependency-free ESM, intentionally without a TypeScript declaration file.
// @ts-ignore -- exercised directly by Node's ESM loader in this pure-unit test.
const smoke = await import("../../../scripts/release-smoke.mjs");
const { EXPECTED_PACKAGE_PATHS, classifyPiResult, comparePacks, parsePackResult, validateArchivePath, validateManifest } = smoke;

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

test("pack comparison rejects changed hashes, sizes, and package surfaces", () => {
  const digest = { sha256: "a".repeat(64), sha1: "b".repeat(40), sha512: "c".repeat(128), sri: "sha512-c", size: 42, files: EXPECTED_PACKAGE_PATHS };
  assert.doesNotThrow(() => comparePacks(digest, { ...digest }));
  assert.throws(() => comparePacks(digest, { ...digest, size: 43 }));
  assert.throws(() => comparePacks(digest, { ...digest, sha512: "d".repeat(128) }));
  assert.throws(() => comparePacks(digest, { ...digest, files: [...EXPECTED_PACKAGE_PATHS, "extra.js"] }));
  assert.throws(() => comparePacks(digest, { ...digest, files: [...EXPECTED_PACKAGE_PATHS, EXPECTED_PACKAGE_PATHS[0]] }));
  assert.throws(() => comparePacks(digest, { ...digest, files: EXPECTED_PACKAGE_PATHS.slice(1) }));
  assert.throws(() => comparePacks(digest, { ...digest, files: [...EXPECTED_PACKAGE_PATHS].reverse() }));
});

test("manifest and Pi terminal policy fail closed", () => {
  const manifest = { name: "@barbatdev/pi-safe-ops", version: "0.1.0-beta.0", private: false, publishConfig: { access: "public" }, peerDependencies: { "@earendil-works/pi-coding-agent": "*" }, pi: { extensions: ["./src/index.ts"] } };
  assert.doesNotThrow(() => validateManifest(manifest));
  for (const invalid of [{ ...manifest, private: true }, { ...manifest, version: "1.0.0" }, { ...manifest, dependencies: { x: "1" } }, { ...manifest, peerDependencies: {} }, { ...manifest, scripts: { prepare: "x" } }]) assert.throws(() => validateManifest(invalid));

  const noModel = "No models available. Use /login to log into a provider via OAuth or API key. See:\n  /tools/node_modules/@earendil-works/pi-coding-agent/docs/providers.md\n  /tools/node_modules/@earendil-works/pi-coding-agent/docs/models.md";
  assert.equal(classifyPiResult(1, "", `\u001b[31m${noModel.replace(/\n/g, "\r\n")}\u001b[0m\n`), "expected-no-model");
  for (const [status, stdout, stderr] of [
    [0, "", noModel], [null, "", noModel], [1, "output", noModel], [1, "", "No model available"],
    [1, "", `${noModel}\nnode: runtime diagnostic`], [1, "", `${noModel}\nfailed to load extension`],
    [1, "", `${noModel}\nError: Cannot find module 'extension'`],
    [1, "", noModel.replace("docs/models.md", "docs/other.md")],
  ] as Array<[number | null, string, string]>) {
    assert.equal(classifyPiResult(status, stdout, stderr), "unexpected");
  }
});

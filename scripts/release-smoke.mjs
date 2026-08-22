import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

export const EXPECTED_PACKAGE_PATHS = ["CHANGELOG.md", "LICENSE", "README.md", "docs/policy-contract.md", "docs/threat-model.md", "package.json", "src/argv.ts", "src/control-evidence.ts", "src/index.ts", "src/manager-classifier.ts", "src/package-spec.ts", "src/probe-contract.ts", "src/probe-runner.ts", "src/runtime.ts", "src/sql-lexer.ts", "src/sql-policy.ts"];
const fail = (message) => { throw new Error(`release-smoke: ${message}`); };
const equal = (actual, expected, label) => { if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${label} differs`); };
const lifecycle = /^(?:pre|post)?(?:publish|pack|install|prepare)$/;

export function parsePackResult(output) {
  let value; try { value = JSON.parse(output); } catch { fail("pack JSON is invalid"); }
  if (!Array.isArray(value) || value.length !== 1 || !value[0] || typeof value[0] !== "object") fail("pack JSON must contain one result");
  const result = value[0];
  if (typeof result.filename !== "string" || !Array.isArray(result.files) || !result.files.every((file) => file && typeof file.path === "string")) fail("pack result is incomplete");
  equal(result.files.map((file) => file.path), EXPECTED_PACKAGE_PATHS, "package files"); return result;
}
export function validateArchivePath(directory, filename) {
  if (!filename || basename(filename) !== filename || !filename.endsWith(".tgz")) fail("archive filename is unsafe");
  const path = resolve(directory, filename); if (relative(resolve(directory), path).startsWith("..")) fail("archive escapes output directory"); return path;
}
export function comparePacks(left, right) {
  for (const pack of [left, right]) equal(pack.files, EXPECTED_PACKAGE_PATHS, "package files");
  for (const key of ["sha256", "sha1", "sha512", "sri", "size"])  if (left[key] !== right[key]) fail(`pack ${key} differs`);
}
export function validateManifest(manifest) {
  if (!manifest || manifest.name !== "@barbatdev/pi-safe-ops" || !/^\d+\.\d+\.\d+-beta\.\d+$/.test(manifest.version) || manifest.private !== false || manifest.publishConfig?.access !== "public" || manifest.peerDependencies?.["@earendil-works/pi-coding-agent"] !== "*" || Object.keys(manifest.dependencies ?? {}).length || Object.keys(manifest.scripts ?? {}).some((name) => lifecycle.test(name)) || !Array.isArray(manifest.pi?.extensions) || !manifest.pi.extensions.includes("./src/index.ts")) fail("manifest is not release-ready");
}
const PI_NO_MODEL_STDERR = [
  "No models available. Use /login to log into a provider via OAuth or API key. See:",
  "  /tools/node_modules/@earendil-works/pi-coding-agent/docs/providers.md",
  "  /tools/node_modules/@earendil-works/pi-coding-agent/docs/models.md",
].join("\n");
const normalizePiTerminal = (value) => value.replace(/\u001B\[[0-9;]*m/g, "").replace(/\r\n/g, "\n").replace(/\n$/, "");
export function classifyPiResult(status, stdout, stderr) {
  return status === 1 && stdout === "" && normalizePiTerminal(stderr) === PI_NO_MODEL_STDERR ? "expected-no-model" : "unexpected";
}
const run = (file, args, options = {}) => {
  const result = spawnSync(file, args, { encoding: "utf8", shell: false, timeout: 30_000, maxBuffer: 65_536, windowsHide: true, ...options });
  if (result.error || result.status !== 0) fail(`${file} failed`); return result.stdout;
};
const digest = (path, files) => { const size = statSync(path).size; if (size > 1_048_576) fail("archive is oversized"); const data = readFileSync(path), sha512 = createHash("sha512").update(data); return { sha256: createHash("sha256").update(data).digest("hex"), sha1: createHash("sha1").update(data).digest("hex"), sha512: sha512.digest("hex"), sri: `sha512-${createHash("sha512").update(data).digest("base64")}`, size, files }; };
const pack = (npm, directory, output) => { mkdirSync(output, { recursive: true }); const result = parsePackResult(run(npm, ["pack", "--ignore-scripts", "--json", "--pack-destination", output], { cwd: directory })); equal(result.files.map((file) => file.path), EXPECTED_PACKAGE_PATHS, "package files"); const archive = validateArchivePath(output, result.filename); if (!existsSync(archive)) fail("pack archive is missing"); return { archive, evidence: digest(archive, result.files.map((file) => file.path)) }; };

export function main(env = process.env) {
  const sha = env.RELEASE_SMOKE_SHA; if (!/^[a-f0-9]{40}$/.test(sha ?? "") || run("git", ["rev-parse", "HEAD"], { cwd: "/repo" }).trim() !== sha) fail("HEAD is not the bound commit");
  const npm = "/tools/node_modules/.bin/npm", pi = "/tools/node_modules/.bin/pi", pkg = "/repo/packages/safe-ops", work = "/work"; if (run(npm, ["--version"]).trim() !== "11.16.0") fail("npm is not pinned"); validateManifest(JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")));
  const dirs = [join(work, "one"), join(work, "two"), join(work, "consumer"), join(work, "home"), join(work, "pi"), join(work, "session")];
  try {
    const first = pack(npm, pkg, dirs[0]), second = pack(npm, pkg, dirs[1]); comparePacks(first.evidence, second.evidence);
    run(npm, ["install", "--prefix", dirs[2], "--ignore-scripts", "--legacy-peer-deps", "--offline", "--no-audit", "--no-fund", "--package-lock=false", first.archive]);
    const source = join(dirs[2], "node_modules/@barbatdev/pi-safe-ops"); if (existsSync(join(source, "node_modules/@earendil-works/pi-coding-agent"))) fail("consumer has nested Pi");
    mkdirSync(dirs[4], { recursive: true }); writeFileSync(join(dirs[4], "settings.json"), JSON.stringify({ npmCommand: [npm] })); const isolated = { ...env, HOME: dirs[3], PI_CODING_AGENT_DIR: dirs[4], PI_CODING_AGENT_SESSION_DIR: join(work, "session"), PI_OFFLINE: "1" };
    run(pi, ["install", source], { env: isolated }); if (!run(pi, ["list"], { env: isolated }).includes("@barbatdev/pi-safe-ops")) fail("Pi did not list package");
    const result = spawnSync(pi, ["--offline", "--no-session", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--print", "release smoke"], { encoding: "utf8", shell: false, timeout: 30_000, maxBuffer: 65_536, env: isolated });
    if (result.error || classifyPiResult(result.status, result.stdout ?? "", result.stderr ?? "") !== "expected-no-model") fail("Pi terminal is not expected offline no-model");
    run(pi, ["remove", source], { env: isolated }); if (run(pi, ["list"], { env: isolated }).includes("@barbatdev/pi-safe-ops")) fail("Pi did not remove package");
    console.log(JSON.stringify({ commit: sha, version: JSON.parse(readFileSync(join(pkg, "package.json"))).version, paths: EXPECTED_PACKAGE_PATHS, ...first.evidence }));
  } finally { for (const path of dirs) rmSync(path, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) main();

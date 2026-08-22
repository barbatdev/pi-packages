import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageDirectory = join(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryDirectory = join(packageDirectory, "..", "..");
const readRepositoryFile = (path: string) => readFileSync(join(repositoryDirectory, path), "utf8");
const readJson = (path: string): Record<string, unknown> => JSON.parse(readRepositoryFile(path)) as Record<string, unknown>;

test("release readiness prepares a public first beta through independent Changesets", () => {
  const rootManifest = readJson("package.json");
  const packageManifest = readJson("packages/safe-ops/package.json");
  const changesets = readJson(".changeset/config.json");
  const preState = readJson(".changeset/pre.json");
  const changelog = readRepositoryFile("packages/safe-ops/CHANGELOG.md");

  assert.equal((rootManifest.devDependencies as Record<string, string>)["@changesets/cli"], "3.0.0");
  assert.equal((rootManifest.scripts as Record<string, string>).changeset, "changeset");
  assert.equal((rootManifest.scripts as Record<string, string>)["version:packages"], "changeset version");
  assert.equal("publish" in (rootManifest.scripts as Record<string, string>), false);
  assert.deepEqual(changesets, {
    changelog: "@changesets/cli/changelog",
    commit: false,
    fixed: [],
    linked: [],
    access: "public",
    baseBranch: "main",
    updateInternalDependencies: "patch",
    ignore: [],
    privatePackages: { version: false, tag: false },
  });
  assert.equal(packageManifest.version, "0.1.0-beta.0");
  assert.equal(packageManifest.private, false);
  assert.equal(packageManifest.license, "MIT");
  assert.equal((packageManifest.peerDependencies as Record<string, string>)["@earendil-works/pi-coding-agent"], "*");
  assert.equal("dependencies" in packageManifest, false);
  assert.deepEqual(packageManifest.publishConfig, { access: "public" });
  assert.equal(existsSync(join(packageDirectory, "CHANGELOG.md")), true, "the beta CHANGELOG is part of the 16-file package surface");
  assert.match(changelog, /0\.1\.0-beta\.0/);
  assert.deepEqual(preState, { mode: "pre", tag: "beta" });
  assert.equal(existsSync(join(repositoryDirectory, ".changeset", "pre", "safe-ops-first-beta.md")), true, "Changesets 3.0.0 retains the prerelease ledger");
  assert.match(readRepositoryFile(".changeset/pre/safe-ops-first-beta.md"), /@barbatdev\/pi-safe-ops": minor/);
  assert.equal(existsSync(join(repositoryDirectory, ".changeset", "safe-ops-first-beta.md")), false, "the Changesets input must move into the prerelease ledger");
});

test("publish workflow is a protected, dispatch-only OIDC gate", () => {
  const workflow = readRepositoryFile(".github/workflows/publish.yml");
  const required = [
    "workflow_dispatch:",
    "inputs:",
    "tag:",
    "github.ref == 'refs/heads/main'",
    "environment: npm-publish",
    "contents: read",
    "id-token: write",
    "cancel-in-progress: false",
    "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
    "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
    "persist-credentials: false",
    "fetch-depth: 0",
    "node-version: 22.19.0",
    "corepack prepare pnpm@11.21.0 --activate",
    "npm@11.16.0",
    "git cat-file -e \"${TAG}^{tag}\"",
    'NPM_DIST_TAG="latest"',
    '*-beta.*) NPM_DIST_TAG="beta" ;;',
    '*-next.*) NPM_DIST_TAG="next" ;;',
    'printf \'npm_dist_tag=%s\\n\' "$NPM_DIST_TAG" >> "$GITHUB_OUTPUT"',
    "NPM_DIST_TAG: ${{ steps.release_policy.outputs.npm_dist_tag }}",
    "npm publish --provenance --access public --ignore-scripts \\",
    '--tag "$NPM_DIST_TAG"',
  ];
  for (const text of required) assert.ok(workflow.includes(text), `workflow must include ${text}`);
  for (const text of ["pull_request:", "push:", "NPM_TOKEN", "NODE_AUTH_TOKEN", "npm publish --ignore-scripts --provenance", "eval "]) {
    assert.equal(workflow.includes(text), false, `workflow must not include ${text}`);
  }
});

test("release documentation states the bounded first-package bootstrap and future OIDC path", () => {
  const packageReadme = readRepositoryFile("packages/safe-ops/README.md");
  const readme = readRepositoryFile("README.md");
  const runbook = readRepositoryFile("docs/releasing.md");

  for (const text of ["beta candidate", "pi install npm:@barbatdev/pi-safe-ops@0.1.0-beta.0", "not a sandbox", "user permissions", "user_bash"]) {
    assert.ok(packageReadme.toLowerCase().includes(text.toLowerCase()), `package README must include ${text}`);
  }
  for (const text of ["beta candidate", "0.1.0-beta.0", "not yet available", "limitations", "docs/releasing.md"]) {
    assert.ok(readme.toLowerCase().includes(text.toLowerCase()), `root README must include ${text}`);
  }
  for (const text of [
    "approved issue",
    "protected merge",
    "main CI",
    "privacy",
    "annotated package tag",
    "isolated tarball verification",
    "exact human SHA/tag/files/hash approval",
    "web login/2FA",
    "scripts disabled",
    "npm trust github @barbatdev/pi-safe-ops --file publish.yml --repository barbatdev/pi-packages --environment npm-publish --allow-publish",
    "verify/logout/destroy",
    "GitHub Release only after publish+trust",
    "no provenance",
    "never reused",
    "OIDC",
    "provenance",
    "NPM_TOKEN",
  ]) {
    assert.ok(runbook.toLowerCase().includes(text.toLowerCase()), `runbook must include ${text}`);
  }
  const normalizedRunbook = runbook.toLowerCase();
  assert.ok(normalizedRunbook.indexOf("oidc") < normalizedRunbook.indexOf("first-package bootstrap"), "the normal OIDC path must precede the bootstrap exception");
});

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

test("release smoke workflow is an isolated, release-only gate", () => {
  assert.equal(existsSync(join(repositoryDirectory, ".github/workflows/release-smoke.yml")), true, "release smoke workflow must exist");
  const workflow = readRepositoryFile(".github/workflows/release-smoke.yml");
  const boundShaExpression = "${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.event_name == 'workflow_dispatch' && inputs.sha || github.sha }}";
  assert.equal((workflow.match(/^\s*BOUND_SHA:/gm) ?? []).length, 1, "one event-derived binding is the source of truth");
  assert.ok(workflow.includes(`BOUND_SHA: ${boundShaExpression}`));
  assert.ok(workflow.includes("ref: ${{ env.BOUND_SHA }}"));
  assert.ok(workflow.includes('HEAD="$(git rev-parse HEAD)"\n          test "$HEAD" = "$BOUND_SHA"'));
  assert.ok(workflow.includes('pull_request) test "$BOUND_SHA" = "$PR_HEAD_SHA" ;;'));
  assert.ok(workflow.includes('push) test "$BOUND_SHA" = "$GITHUB_SHA"; test "$BOUND_SHA" = "$PUSH_AFTER" ;;'));
  assert.ok(workflow.includes("EVENT_REF: ${{ github.ref }}"));
  for (const text of ['test "$EVENT_REF" = "refs/heads/main"', '[[ "$BOUND_SHA" =~ ^[a-f0-9]{40}$ ]]', 'test "$BOUND_SHA" = "$GITHUB_SHA"; test "$BOUND_SHA" = "$MANUAL_SHA"', 'git ls-remote origin refs/heads/main | cut -f1)" = "$MANUAL_SHA"']) assert.ok(workflow.includes(text), `manual rerun must include ${text}`);
  const dockerRuns = workflow.match(/^\s*docker run .*$/gm) ?? [];
  assert.equal(dockerRuns.length, 2, "both Docker phases are audited");
  for (const command of dockerRuns) for (const text of ["--tmpfs /smoke-home:rw,noexec,nosuid,size=64m", "--env HOME=/smoke-home", "--env npm_config_cache=/smoke-home/.npm"]) assert.ok(command.includes(text), `Docker phase must include ${text}`);
  assert.ok(dockerRuns[1]?.includes('--env RELEASE_SMOKE_SHA="$BOUND_SHA"'));
  assert.equal(dockerRuns[1]?.includes("GITHUB_SHA"), false, "the smoke receives only the bound SHA");
  assert.equal(/\/(?:home|Users)\//.test(workflow), false, "tracked workflow passes the exact privacy path regex");
  for (const text of [
    "name: Release smoke", "pull_request:", "push:", "workflow_dispatch:", "contents: read", "timeout-minutes:",
    "actions/checkout@11d5960a326750d5838078e36cf38b85af677262", "persist-credentials: false", "fetch-depth: 1",
    "docker.io/library/node@sha256:f2bf1588ef7e8dd183d9e4cb4330a0d952204b7348ead42afb1aab11f9c4911b", "--network none",
    "npm@11.16.0", "@earendil-works/pi-coding-agent@0.82.1", "--ignore-scripts", "--read-only", "--cap-drop ALL", "--security-opt no-new-privileges",
    "github.event.pull_request.head.sha", "github.event.after", "git ls-remote origin refs/heads/main", "release-smoke.mjs", "rm -rf \"$SMOKE_ROOT\"",
  ]) assert.ok(workflow.includes(text), `release smoke must include ${text}`);
  for (const forbidden of ["pull_request_target:", "self-hosted", "secrets.", "id-token: write", "actions/cache", "upload-artifact", "download-artifact", "npm publish", "npm trust", "git tag", "gh release", "docker.sock"]) {
    assert.equal(workflow.includes(forbidden), false, `release smoke must not include ${forbidden}`);
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
    "successful `Release smoke` push run",
    "Manual dispatch is only a same-main-SHA diagnostic rerun",
  ]) {
    assert.ok(runbook.toLowerCase().includes(text.toLowerCase()), `runbook must include ${text}`);
  }
  const normalizedRunbook = runbook.toLowerCase();
  assert.ok(normalizedRunbook.indexOf("oidc") < normalizedRunbook.indexOf("first-package bootstrap"), "the normal OIDC path must precede the bootstrap exception");
});

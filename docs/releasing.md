# Package release runbook

This runbook prepares `@barbatdev/pi-safe-ops` releases. It does not authorize a local publish, tag, npm trust change, or GitHub Release.

## Normal releases: protected-main OIDC path

After the one-time bootstrap has completed, every release uses the protected-main GitHub Actions OIDC/provenance path. It uses no `NPM_TOKEN` or stored publishing secret, and the bootstrap exception is never reused.

1. Create an approved issue and release PR, then complete the protected merge to `main`.
2. Confirm the exact `main` CI result and public-safe privacy review for the release commit.
3. Require a successful `Release smoke` push run for that exact protected-main SHA before tag or publication authorization. Its bounded evidence is the commit, version, 16 package paths, archive size, and SHA-256/SHA-1/SRI hashes. Manual dispatch is only a same-main-SHA diagnostic rerun.
4. Create the exact annotated package tag `@barbatdev/pi-safe-ops@<version>` at that immutable `main` commit.
5. Verify an isolated tarball with scripts disabled and compare its package files and hash to the approved candidate.
6. Obtain exact human SHA/tag/files/hash approval.
7. Dispatch `publish.yml` from protected `main`. The workflow validates the tag and current `main`, publishes through OIDC with provenance, and uses the derived dist-tag.
8. Verify the published version and dist-tag.
9. Create the GitHub Release only after publish+trust verification succeeds.

## First-package bootstrap exception

`@barbatdev/pi-safe-ops` is absent from npm, so Trusted Publishing cannot bootstrap its first package record. The bounded exception applies only to `0.1.0-beta.0`: it has no provenance because OIDC is unavailable, and must never be reused after npm trust exists.

1. Create an approved issue and beta PR, then complete the protected merge to `main`.
2. Confirm the exact `main` CI result and public-safe privacy review for that merge commit.
3. Create the exact annotated package tag `@barbatdev/pi-safe-ops@0.1.0-beta.0` at that immutable commit.
4. Perform isolated tarball verification with scripts disabled; retain the exact package-file list and hash as approval evidence.
5. Obtain exact human SHA/tag/files/hash approval before any registry action.
6. In an isolated remote container, use interactive web login/2FA for one ephemeral beta publish with scripts disabled. Do not use a token, local workstation, GitHub Actions dispatch, or a reused environment.
7. Immediately configure npm trust with the verified npm 11.16.0 command shape:

   ```sh
   npm trust github @barbatdev/pi-safe-ops --file publish.yml --repository barbatdev/pi-packages --environment npm-publish --allow-publish
   ```

   The shape was checked with `npm@11.16.0` help before documenting it. Do not execute it until the preceding approval and successful beta publish exist.
8. Verify/logout/destroy: verify the npm version, beta dist-tag, and trusted-publisher tuple; then logout and destroy the isolated environment.
9. Create the GitHub Release only after publish+trust verification succeeds.

## Failure rules

Never publish locally. Keep every annotated tag immutable. A failed publication does not authorize a retag, a new exception, or a bypass of protected-main CI, privacy review, isolated tarball verification, exact human approval, OIDC, provenance, or npm trust.

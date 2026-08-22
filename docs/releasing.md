# Package release runbook

`@barbatdev/pi-safe-ops` is unpublished, private, and fixed at `0.0.0`. This runbook prepares maintainers for a future release; it does not authorize local publishing.

## Maintainer readiness

Use independent SemVer, Conventional Commits, and Changesets. A release PR adds the required changeset and version update; this readiness PR intentionally adds neither a changeset nor a changelog.

## External prerequisites

Before opening a release PR, confirm all of the following:

- Protect `main` and require the repository checks.
- Create the `npm-publish` GitHub environment with required reviewers.
- Configure npm Trusted Publishing for the repository, `publish.yml` workflow, and `npm-publish` environment tuple.
- Use no npm token or stored publishing secret.

## Release path

1. Prepare and merge a release PR through Changesets. The first prerelease is `0.1.0-beta.0`.
2. Fetch `origin/main` immediately before creating the exact annotated tag `@barbatdev/pi-safe-ops@<version>` at that commit. Never move, replace, or reuse a tag.
3. Dispatch `publish.yml` from protected `main`, supplying only that tag. The workflow verifies the tag, commit, manifest, package surface, and current remote `main` before OIDC publication.
4. Verify the exact npm version and dist-tag after the workflow succeeds. Create the GitHub Release only as a follow-up to successful publication.

## Failure rules

Never publish locally. If dispatch or publication fails, keep the tag immutable. Re-dispatch only when the same annotated tag still peels to current `origin/main`; otherwise prepare a new release commit and version. Do not bypass the environment, Trusted Publishing, provenance, or package checks.

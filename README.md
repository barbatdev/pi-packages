# pi-packages

A personal open-source monorepo for modular Pi packages and extensions built through public Pi package and extension mechanisms.

## Status

This repository is at an early stage. `@barbatdev/pi-safe-ops@0.1.0-beta.0` is a beta candidate, not yet available from the registry; its separate publish gate has not run. The candidate is not a support or compatibility promise, and it is not a sandbox: Pi packages run with user permissions. CI verifies typechecking, tests, and the dry-run package surface. See the maintainer-only [release runbook](docs/releasing.md) for limitations and the bounded first-package bootstrap.

## Packages

- [`@barbatdev/pi-safe-ops`](packages/safe-ops/README.md) — `0.1.0-beta.0` beta candidate; not yet available from the registry.

## Independence

pi-packages is independent from Pi and [gentle-pi](https://github.com/Gentleman-Programming/gentle-pi). It is not a fork of either project. The intent is to coexist with gentle-pi.

## Project decisions

[barbatdev](https://github.com/barbatdev) is the sole maintainer and final decision-maker. Contributions may be proposed, but acceptance, prioritization, and ongoing maintenance remain at the maintainer's discretion.

## Participate

- Read [CONTRIBUTING.md](CONTRIBUTING.md) before proposing a change.
- Use the [bug report](.github/ISSUE_TEMPLATE/bug_report.md) or [feature request](.github/ISSUE_TEMPLATE/feature_request.md) template for public proposals.
- Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
- This project is available under the [MIT License](LICENSE).

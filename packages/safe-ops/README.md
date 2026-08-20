# @barbatdev/pi-safe-ops

`@barbatdev/pi-safe-ops` is a planned native Pi package/extension for fail-closed safety checks on model-initiated package acquisition and direct SQL `DROP` commands. It is a clean-room design and does not provide a Claude-hook compatibility runtime.

> **Status: development runtime manifest present.** This package remains private, unpublished, unversioned for release, and not installable.

## Problem

A model can propose a shell command that changes a dependency graph or directly destroys database objects. This package is intended to reject narrowly defined, high-risk forms when their safety requirements cannot be proven from static command structure and supported native package-manager controls.

## Guarantees

The V1 design has one additive Pi event handler. It is intended to:

- inspect only model-initiated `tool_call` events that statically match the built-in Bash tool shape;
- leave `event.input` unchanged and leave unrelated tools and unrelated Bash commands untouched;
- block recognized unsupported or ambiguous forms rather than guessing;
- perform no confirmation, grant, telemetry, remote policy lookup, or hidden mutating command execution; it may use only documented bounded read-only probes; and
- keep package safety thresholds fixed: project files are evidence only and cannot weaken them.

`user_bash` (`!` and `!!`) is explicitly outside V1 scope.

## Supported operations

V1 is deliberately narrow:

| Area | Recognized safety boundary |
| --- | --- |
| npm and pnpm acquisition | Direct, exact registry package versions with effective native lifecycle and maturity controls that conform to the V1 contract. |
| npm and pnpm execution helpers | `npx`, `npm exec`, `pnpm dlx`, and the official `pnx` alias only when an explicit exact package version and the applicable lifecycle controls are verifiable. |
| Direct SQL | Executable `DROP TABLE`, `DROP DATABASE`, and `DROP SCHEMA` in statically recognized `psql`, `mysql`/`mariadb`, and `sqlite3` argument forms. |

The complete normative rules, command coverage, and failure behavior are in the [V1 policy contract](docs/policy-contract.md). The [threat model](docs/threat-model.md) explains the trust boundaries, exclusions, and residual risks.

## Compatibility

The package is useful standalone and is designed to coexist additively with unrelated handlers, including `gentle-pi`. It does not own common destructive shell/path, review, publication, SDD, or skill-registry policies. Pi provides no handler-order guarantee or shared authority-coordination API; fail-closed blocks therefore compose monotonically.

## Bounded read-only probes

When static classification returns `needs_controls`, V1 may plan one fresh probe set for that invocation. Runtime integration must spawn the exact `npm` or `pnpm` executable directly without a shell, using only `--version`, fixed normal-context `config get <allowlisted-key>`, and fixed explicit-global `--global config get <allowlisted-key>` argv. Each planned request carries its fixed argv and `normal` or `global` context so normalized evidence cannot satisfy a global decision with a bare request. It never probes installation, execution helpers, scripts, network metadata, broad configuration lists, or mutations. Runtime must impose fixed timeout and output caps, never log raw stdout, stderr, or configuration values, and fail closed on timeout, nonzero exit, malformed or oversized output, unsupported versions, unexpected keys, or values that do not normalize to the documented primitives, lists, and boolean maps. Probes have no grant or cache semantics.

Only npm `11.16.0` and pnpm `11.21.0` are initially supported. The normative key list and residual scope-routing risk are in the [V1 policy contract](docs/policy-contract.md).

## Limitations

This is not a shell sandbox or a general command policy. V1 uses a bounded shell lexer and strict argument grammars, not full shell parsing. Direct non-acquisition commands such as `npm run`, `npm test`, `npm view`, and `npm config` (including bounded ordinary reporting flags) are outside the supply-chain grammar and remain untouched; hidden script behavior remains outside the boundary. It blocks an acquisition reached through recognized `sudo`, `corepack`, `command`, `exec`, or `env` wrappers, or through a direct executable path with exact manager basename, because a fixed direct probe would not prove that executable. It does not claim arbitrary wrapper, function, or script coverage. It supports npm and pnpm only; Yarn, Bun, and other package managers are outside scope.

## Runtime environment

The development manifest registers the Pi extension entrypoint. Its bounded direct probes construct the standard Pi Bash PATH equivalence by prepending `getAgentDir()/bin` once to the inherited case-insensitive PATH key. A custom SDK `spawnHook` that alters PATH is outside V1 proof and is unsupported.

## Status

The V1 runtime is under development. The package is private and unpublished at version `0.0.0`; it is unversioned for release and has no installation path or publication promise.

# V1 threat model

This threat model defines the security boundary for the planned `@barbatdev/pi-safe-ops` Pi package/extension. It describes a narrow fail-closed policy, not a sandbox or a general claim that command execution is secure.

## Assets

V1 seeks to protect these assets from the covered command classes:

- dependency acquisition integrity;
- repository dependency declarations and lockfiles affected by covered acquisitions; and
- database schemas and data affected by covered `DROP` statements.

## Trust boundaries

| Boundary | Trust decision |
| --- | --- |
| Pi public event contract | Trusted as the source of model-initiated `tool_call` events and built-in Bash tool shape. |
| Installed extension bytes | Trusted as the policy implementation selected by the user. |
| Package-manager behavior | Trusted only for allowlisted versions with conformance-tested native control adapters. |
| User-global native package-manager configuration | Trusted as effective-control evidence only after bounded read-only verification. |
| Model-generated command text | Untrusted. |
| Package metadata and specifiers | Untrusted. |
| Repository content and configuration | Untrusted as policy sources; may be evidence but cannot weaken policy. |
| Custom registries | Untrusted and outside V1 acquisition support. |
| Shell composition and generated scripts | Untrusted; unsupported or unverifiable recognized forms block. |

The model is adversarial for this analysis: V1 handles both accidental and malicious model output. Malicious dependency publication is also in scope. A hostile same-user process, an operating-system sandbox escape, and compromise of the Pi runtime, extension bytes, package manager, or user-global configuration are not V1 adversaries.

## Threats and mitigations

| Threat | V1 mitigation | Guarantee boundary |
| --- | --- | --- |
| A model acquires a package by a tag, range, alias, non-registry source, or custom registry | Recognized npm and pnpm acquisitions, `npx`, `npm exec`, `pnpm dlx`, and `pnx` require exact registry versions and reject unsupported sources and weakening controls. | Only statically recognized model-initiated Bash forms are covered. |
| A newly published malicious package is acquired | Native, verified release-age controls require at least seven days and fail closed when unprovable. | V1 does not query registries or evaluate package trust, reputation, or content. |
| Dependency lifecycle or build scripts execute unexpectedly | Required native lifecycle/build controls are verified for supported managers; missing or ambiguous controls block. | This does not constrain arbitrary scripts executed outside recognized forms. |
| Lockfile-only or frozen installation accepts an immature package | These forms block until version-specific conformance proves immature locked versions are rejected. | V1 does not claim lockfile provenance or reproducibility for global installation. |
| A model directly destroys a database object | Recognized SQL client argv forms hard-block executable `DROP TABLE`, `DROP DATABASE`, and `DROP SCHEMA`; file, stdin, redirection, heredoc, substitution, generated, and unparseable SQL forms for a recognized client block as unverifiable. | SQL routed through unrecognized clients or hidden arbitrary scripts is outside V1 scope. |
| SQL text disguises a protected token in comments or literals | SQL lexical detection ignores comments and string literals while recognizing case, spacing, and `IF EXISTS`. | The detector is not a complete SQL parser. |
| Shell syntax hides a covered operation | The bounded lexer and strict argv grammars inspect immediate executables only for recognized `sudo`, `corepack`, `command`, `exec`, and `env` wrappers, block wrapped acquisitions and direct manager executable paths, and block visible `eval` or interpreter `-c` manager payloads. | V1 is not a full shell parser and does not inspect arbitrary hidden scripts, functions, or arbitrary literal argument text. |
| Another handler needs to enforce a separate policy | The handler is additive and non-owning for common destructive shell/path, review, publication, SDD, and skill-registry policies. | Pi has no handler-order guarantee or shared authority-coordination API. Fail-closed blocks compose monotonically. |

## Explicit exclusions and non-goals

V1 does not:

- inspect `user_bash` (`!` or `!!`) or non-Bash Pi tools;
- provide user confirmation, grants, telemetry, remote policy evaluation, or hidden mutating command execution; the only permitted hidden process work is the documented bounded read-only probe contract;
- support Yarn, Bun, or other package managers;
- query registry timestamps, use a registry SDK, or reimplement package release-age logic;
- parse every shell or SQL grammar, inspect arbitrary scripts, or sandbox a process;
- own general destructive shell/path policy, code review, publication, SDD, or skill-registry policy; or
- claim compatibility with a Claude hook runtime, official Pi ownership, or official Gentle AI ownership.

## Residual risks and limitations

The policy is intentionally conservative. It can block a command that is benign when it cannot prove a recognized form satisfies V1; this is a false-positive cost of fail-closed behavior. Direct non-acquisition manager commands with bounded ordinary reporting flags, `command -v`/`command -V` lookups, and unrelated literal text remain available. It does not claim coverage for arbitrary wrappers, functions, or hidden scripts; hidden script behavior remains outside the boundary and can be harmful.

The package-manager controls reduce exposure to immature releases; they do not establish that a package is trustworthy. Exact versions do not prevent a compromised published version, dependency confusion outside the recognized boundary, or malicious code already present in a repository. Native control verification depends on tested manager versions and trustworthy manager behavior. Bounded probes cover only the effective default registry and scopes directly named by requested specs; unknown transitive scope routing is not enumerated. Native age and missing-time controls still apply, but no provenance guarantee extends beyond those probed registry values.

The SQL policy prevents only the named direct destructive statements in recognized client argument forms. It does not prevent destructive SQL with other verbs, destructive application behavior, database privileges, network misuse, SQL routed through unrecognized clients, or hidden arbitrary scripts. File, stdin, redirection, heredoc, substitution, generated, and unparseable SQL forms for a recognized client block as unverifiable. Blocking an unverifiable recognized SQL form avoids falsely declaring it safe; it does not inspect its eventual runtime behavior.

V1 therefore provides precise policy enforcement for a limited set of statically recognizable model tool calls. It makes no broad security, prevention, isolation, or sandbox guarantee.

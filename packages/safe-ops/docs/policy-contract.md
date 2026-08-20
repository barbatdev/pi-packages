# V1 policy contract

This document defines the normative V1 behavior of the planned `@barbatdev/pi-safe-ops` Pi package/extension. It describes intended behavior; it does not make the package published or installable.

## 1. Event scope and failure semantics

V1 MUST install one additive handler for model-initiated Pi `tool_call` events. It MUST inspect only events that statically match the built-in Bash tool shape. `user_bash` events invoked through `!` or `!!` are out of scope and MUST NOT be inspected or blocked by this policy.

The handler MUST NOT mutate `event.input`. It MUST NOT request confirmations or grants, emit telemetry, use a remote policy service, or execute hidden mutating commands. It MAY use only the documented bounded read-only probes in section 3.3. Unrelated tools and Bash commands outside the recognized grammars MUST remain untouched.

For a recognized in-scope command, inability to prove conformance MUST block the call. A block MUST identify the failed requirement and give concrete remediation, such as using an exact registry version, establishing the required effective native controls, or using a supported static argument form. The handler MUST NOT infer safety from partial parsing, project policy, command intent, or a successful-looking command string.

Package thresholds are fixed and fail closed. Project files MAY be examined as evidence of effective package-manager configuration, but they MUST NOT override or weaken package policy.

## 2. Command recognition model

V1 MUST use a bounded shell lexer and strict argv grammars. It MUST NOT use substring matching or claim to parse the full shell language. For `sudo`, `corepack`, `command`, `exec`, and `env`, it inspects only the immediate wrapped executable after a bounded set of obvious wrapper options and environment assignments; arbitrary later arguments are not searched. An acquisition reached through one of those wrappers, or through a direct executable path whose exact basename is `npm`, `pnpm`, `npx`, or `pnx`, MUST block because a fixed direct probe would not prove the executed binary. `command -v` and `command -V` lookup forms remain unrelated. `eval` and interpreter `-c` payloads may be inspected for visible manager operation text because that explicit payload is executed; arbitrary argument text, including `echo 'npm install …'` or `env echo 'npm install …'`, is not a supply-chain candidate.

Recognized grammars MUST account for top-level separators, ordinary quoting and escapes, recognized aliases, reordered supported flags, static workspace/filter selectors, and `--`. A recognized in-scope command containing any of the following MUST block as unsafe or unverifiable:

- substitutions or backticks;
- malformed quoting;
- shell or interpreter `-c` forms;
- `eval`, functions, aliases, recognized acquisition wrappers, or direct manager executable paths;
- generated scripts, heredocs, or unsafe redirection; or
- an unsupported, ambiguous, or unparseable command shape.

This boundary does not inspect arbitrary hidden scripts. Scripts that execute destructive actions beyond a statically recognized invocation are outside the security boundary.

## 3. Supply-chain policy

### 3.1 Coverage

Only npm and pnpm are in scope. Yarn, Bun, and every other package manager are out of scope.

A direct acquisition MUST name an exact registry package version in `name@x.y.z` form, including for scoped packages. The handler MUST reject omitted versions, tags, semver ranges, npm aliases, and git, file, link, workspace, tarball, URL, alternate-registry, or custom-registry sources. It MUST also reject configuration, environment, or flags that weaken required controls. After `npm`/`pnpm add` or install, only `-D`/`--save-dev`, `-P`/`--save-prod`, `-O`/`--save-optional`, and `--save-peer` are accepted as non-policy save-target flags; their supported CLI placements do not weaken age, scripts, registry, or exactness requirements.

The minimum package release age is seven days. V1 MUST use and verify native package-manager controls for this requirement. It MUST NOT query registry timestamps or reimplement release-age logic. No V1 implementation may introduce a registry query module, registry SDK, or timestamp adapter.

Unsupported or unknown package-manager versions, failed capability probes, malformed probe output, ambiguous command shapes, and unverifiable controls MUST block. Stable block codes identify the bounded failed category without reflecting command text, probe output, or registry values: probe failure subtype; manager/version mismatch; exact-save; release age or exclusions; default/direct-scope registry; npm lifecycle; and pnpm strictness, missing-time, exotic-subdependency, helper-lifecycle, or direct-acquisition lifecycle/build policy.

### 3.2 Required effective controls

The implementation MUST verify these effective controls through version-gated conformance adapters. This contract intentionally does not prescribe a CLI spelling for those settings.

| Manager and operation | Required effective controls |
| --- | --- |
| npm project acquisition | npm `11.16.0`; `save-exact=true`; `min-release-age>=7`; no age exclusions; `ignore-scripts=true`; trusted public default and direct-scope registry evidence. Exact npm `11.16.0` has no exclusion setting: after exact-version proof, the adapter derives empty exclusions as a conformance capability rather than probing a config key. |
| pnpm direct or global acquisition | pnpm `11.21.0`; `saveExact=true`; `minimumReleaseAge>=10080`; `minimumReleaseAgeStrict=true`; `minimumReleaseAgeIgnoreMissingTime=false`; empty exclusions; trusted public default and direct-scope registry evidence; `blockExoticSubdeps=true`; and safe lifecycle policy. Safe lifecycle policy is `ignoreScripts=true`, or `dangerouslyAllowAllBuilds=false` plus `strictDepBuilds=true` plus an accepted explicit boolean `allowBuilds` map. V1 accepts only an empty map or bare unscoped valid package-name keys with boolean values; it does not claim support for pnpm's broader matcher syntax. |
| pnpm `dlx` or `pnx` helper | The same exact version, age, registry, exclusion, and exotic-subdependency controls as pnpm direct acquisition, plus `ignoreScripts=true`. In exact pnpm `11.21.0`, temporary helper installation overrides the strict build-policy evidence; `strictDepBuilds` and `allowBuilds` are therefore insufficient helper alternatives. |
| npm global acquisition, `npx`, or `npm exec` | The npm controls above and either `ignore-scripts=true` or native user/global `allow-scripts` covering every requested direct package name. |
| global npm or pnpm acquisition | The applicable direct exact-spec rules and native controls. V1 MUST NOT claim lockfile reproducibility or provenance for global installation. |

Effective manager configuration MAY be evidence, but it is not a project policy override. If a required control cannot be proved effective, the invocation MUST block.

### 3.3 Bounded read-only probe contract

Probes are only evidence collection; they do not execute the requested acquisition. For each static `needs_controls` invocation, runtime integration MUST spawn the exact `npm` or `pnpm` executable directly with no shell and no cache or grant semantics. The version request is exactly `--version`. Every config request has a planned `normal` or `global` context and fixed argv: `config get <allowlisted-key>` for normal context or `--global config get <allowlisted-key>` for global context. Normalized evidence MUST bind to that complete planned request identity; a bare config result MUST NOT satisfy a global request. Runtime MUST enforce fixed timeout and output caps; it MUST never log raw stdout, stderr, or configuration values. Timeout, nonzero exit, malformed or oversized output, unsupported version, unexpected key, or an output that cannot normalize to the expected primitive, list, or boolean-map value MUST block.

The fixed npm keys are `save-exact`, `min-release-age`, `ignore-scripts`, `allow-scripts` when global or an execution helper is requested, the effective default `registry`, and each direct package scope's `<scope>:registry`. Exact npm `11.16.0` has no `min-release-age-exclude` setting; only after normalized exact-version proof MAY the adapter derive the required empty exclusion list. It MUST NOT probe a nonexistent exclusion key. Every npm config key for a static global decision uses global context. For `npx` and `npm exec`, only the native `allow-scripts` evidence uses global context; their other controls remain normal-context evidence for the one-off invocation. The fixed pnpm keys are `saveExact`, `minimumReleaseAge`, `minimumReleaseAgeStrict`, `minimumReleaseAgeIgnoreMissingTime`, `minimumReleaseAgeExclude`, `ignoreScripts`, `blockExoticSubdeps`, `strictDepBuilds`, `dangerouslyAllowAllBuilds`, `allowBuilds`, the effective default `registry`, and each direct package scope's `<scope>:registry`; every pnpm config key for a static global decision uses global context. Direct scopes are deduplicated. Broad config lists/objects, installs, execution helpers, scripts, network metadata requests, and all mutations are prohibited probe requests.

Bounded probes enumerate only the default registry and scopes directly named by requested specs. They do not enumerate unknown transitive scope routing. Native age and missing-time controls still apply, but no provenance guarantee extends beyond the probed default and direct scopes.

### 3.4 Unsupported install and update forms

`npm update`, `npm up`, `pnpm update`, `pnpm up`, `npm x`, `npm init`, `npm create`, and `pnpm create` MUST block as unsupported in V1. For npm `11.16.0` `npx`, only optional `-y` or `--yes` immediately before one exact direct package spec suppresses the prompt; every other pre-package option MUST block. Argv after that package is executable payload and MUST NOT be treated as npm options. `pnpm dlx` and `pnx` each require one exact direct package spec. They MAY carry executable payload only when the token immediately after the package is the literal `--`; undelimited trailing argv MUST block because pnpm can parse later options as manager configuration.

Plain or lockfile-only `npm install`, `npm ci`, plain `pnpm install`, and frozen install forms MUST block in V1 until version-specific conformance proves that locked immature versions are rejected. The presence of a lockfile alone is insufficient proof.

## 4. Direct SQL DROP policy

V1 MUST hard-block executable direct `DROP TABLE`, `DROP DATABASE`, and `DROP SCHEMA` statements in these statically recognized client argv forms:

| Client | Recognized SQL source |
| --- | --- |
| `psql` | `-c` or `--command` |
| `mysql` and `mariadb` | `-e` or `--execute` |
| `sqlite3` | Direct positional SQL |

SQL lexical detection MUST ignore tokens inside SQL string literals and comments. It MUST handle case differences, spacing, and `IF EXISTS`.

For a recognized SQL client, stdin, `-f`, redirection, heredocs, substitutions, generated SQL, interpreter wrappers, and every unparseable form MUST block as unverifiable. A source file, documentation page, migration, or fixture that merely contains `DROP` text MUST NOT be blocked unless a recognized SQL client invocation executes that text.

## 5. Coverage and disposition

| Command category | V1 disposition |
| --- | --- |
| Recognized conforming npm/pnpm direct exact acquisition with verified controls | Allow. |
| Recognized npm/pnpm acquisition that is unsupported, ambiguous, or lacks verified controls | Block with remediation. |
| Recognized execution helper with an inexact or unverifiable package/control configuration | Block with remediation. |
| Recognized direct SQL client invocation that executes a protected `DROP` | Block. |
| Recognized SQL client invocation with an unverifiable SQL source or argv shape | Block with remediation. |
| Unrelated tool or Bash command | Leave untouched. |
| `user_bash` | Leave untouched; out of scope. |

## 6. Acceptance criteria

A V1 implementation conforms to this contract only if it demonstrates all of the following:

1. It registers exactly one additive handler, does not mutate `event.input`, and has none of the prohibited confirmation, grant, telemetry, remote-service, or hidden mutating-command behavior; bounded read-only probes are permitted only as specified in section 3.3.
2. It limits inspection to model-initiated built-in-Bash-shaped `tool_call` events and leaves `user_bash`, unrelated tools, and unrelated Bash untouched.
3. It rejects every prohibited direct acquisition source or version form and accepts no package release age evidence except verified native package-manager controls.
4. It proves the required npm or pnpm controls through version-gated conformance tests and blocks failed, unknown, malformed, or ambiguous probes and manager versions.
5. It blocks the named update and install forms until the required lockfile-age conformance proof exists.
6. It detects executable protected SQL `DROP` forms while ignoring literals and comments, and blocks every named unverifiable SQL input path.
7. It handles the bounded lexer cases in section 2 without substring matching or a full-shell-parsing claim.
8. It reports concrete remediation for every policy block whose safe correction is actionable.

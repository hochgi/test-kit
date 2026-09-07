# Core public API

Current truth for the published surface of `@vnatures/test-kit` and the shape of
the workspace package graph. One file, not a pile of packet histories: if you
want to know what the library exports and how the 13 packages depend on each
other today, this is the file.

Folded from the P02–P03 delta (RD-24143, RD-24144), preserved at
`docs/internal/archive/2026-09-07-P02-P03-rig-rename/delta.md`.

## Requirements

### Requirement: The lifecycle owner is named Rig
`@vnatures/test-kit` SHALL export the lifecycle owner of probes and adapters
under the name `Rig`, created by `createRig`. The published names SHALL be:

| exported name | kind |
| --- | --- |
| `Rig` | interface |
| `RigRef` | interface |
| `RigExpectations` | interface |
| `CreateRigOptions` | interface |
| `createRig` | function |

The source of the lifecycle owner SHALL live at `packages/core/src/rig.ts`.
`RigRef` is forward-declared in `packages/core/src/types.ts` to avoid a circular
import, and is exported from there.

No alias, re-export, or deprecation shim for the former `Harness`, `HarnessRef`,
`HarnessExpectations`, `CreateHarnessOptions` or `createHarness` names SHALL be
published. Those names SHALL be absent from the built type declarations.

#### Scenario: Rig surface is exported
- **WHEN** `@vnatures/test-kit` is imported
- **THEN** `createRig` is a callable export and `Rig`, `RigRef`,
  `RigExpectations` and `CreateRigOptions` are exported types

#### Scenario: the former Harness names are gone
- **WHEN** the built declarations of `@vnatures/test-kit` are read
- **THEN** none of the five former names appears as an exported name

### Requirement: The injection option key is `harness`
The factory option through which a rig is injected SHALL be spelled `harness`.
`CreateProbed*Options.harness` on the 11 domain factories SHALL be typed `Rig`;
on core (`ProbeRootConfig`, `StreamProbeRootConfig`) and on `mock`'s two
factories it SHALL be typed `RigRef` and SHALL be optional.

Correct usage therefore reads `createProbedSqlAdapter({ harness: rig, driver })`
— `Rig` is the type, `harness` is the key. This asymmetry is deliberate; see
`docs/adr/0001-rename-the-lifecycle-owner-to-rig-and-ship-2-0-0.md`.

#### Scenario: option key is `harness`, not `rig`
- **WHEN** a probed adapter is constructed by any domain factory
- **THEN** it accepts the rig under the property name `harness`, and no factory
  accepts a `rig` option key

### Requirement: Two harness-named values keep their names
The public string-literal union `origin: 'harness' | 'user'` on `RuleEntry` and
`StreamRuleEntry` SHALL keep `'harness'`. The error factory
`errors.harnessClosed()` SHALL keep its name, and its message texts SHALL remain
verbatim:

- `Harness is closed.`
- `Harness closed with ${n} unsettled waiter(s).`
- `realClock cannot advance time. Configure the harness with a fake clock to use clock.advance().`
- `Test exceeded the harness safety timeout (${ms}ms wall-clock). …`

These are observable *values*, not exported names. Consumers assert on them at
runtime, where a rename fails silently rather than at compile time.

#### Scenario: observable harness-named values are unchanged
- **WHEN** a rule entry's `origin` is read, or a closed rig is operated on
- **THEN** the origin tag is `'harness'` and the error messages are the texts
  above

### Requirement: Rig lifecycle behaviour
A `Rig` SHALL behave as follows:

- `attach(adapter)` returns the adapter it was given; `attach(promise)` returns
  a promise resolving to the attached adapter.
- `reset()` clears call history and **user-installed** rules on every attached
  probe. Rig-installed default rules (origin `'harness'`, e.g. a backed
  adapter's default forward) are **retained** — `resetProbe` removes them only
  when passed `{ includeDefaults: true }`, which `rig.reset()` does not do.
  `reset({ keepRules: true })` clears only call history and preserves
  user-installed rules as well. Adapters implementing `reset()` are reset in
  registration order; `reset()` is **fail-fast** — if an adapter's `reset()`
  rejects, `rig.reset()` rejects immediately and neither that adapter's probe
  nor any later adapter is reset. This is deliberately unlike `close()`, which
  continues past adapter errors.
- `close()` closes every attached adapter in **reverse** registration order, and
  does not fail on adapter errors.
- After close, `attach` SHALL **throw synchronously** with
  `Harness is closed.` — including when a promise is passed after close — and
  `reset()` SHALL reject with the same message. A promise attached *before*
  close rejects asynchronously when it resolves after close. `close()` itself
  SHALL be **idempotent** — calling it again returns without error.

#### Scenario: operations after close
- **WHEN** `close()` has been called and `attach`, `reset` and `close` are each
  called again
- **THEN** `attach` throws `Harness is closed.` synchronously, `reset` rejects
  with `Harness is closed.`, and `close` returns without error

### Requirement: Every workspace package is on major version 2
All 13 workspace packages under `packages/` SHALL declare a version on major
`2`. The requirement is the **major digit**, not an exact patch.

`vn-ci/init` bumps the patch read from the manifest on every merge to `main`
(`NEW_VERSION=$1.$2.($3+1)`) and pushes a `chore: bump version to vX [skip ci]`
commit before `vn-ci/build-publish` publishes, so manifests advance on their own.
The first published 2.x was `2.0.1`. Major `2` is what carries the guarantee: it
is what a consumer's `^1.x` caret refuses, and any 2.x satisfies the siblings'
`^2.0.0` peer range.

**Do not pin an exact version string in a spec or a test.** CI moves the patch
out from under it, and main goes red on the next merge.

#### Scenario: all manifests are on major 2
- **WHEN** every `packages/*/package.json` is parsed
- **THEN** each `version` is a valid `x.y.z` whose major is `2`, and none is on
  `1.x`

### Requirement: Core is a peer dependency of every sibling that needs it
Every package under `packages/` that requires `@vnatures/test-kit` SHALL declare
it in `peerDependencies` at `^2.0.0` and SHALL NOT declare it in `dependencies`.

This applies to the 11 packages that consume core: `bull`, `kafka`, `mock`,
`mysql`, `pg-knex`, `pg-kysely`, `pg-sequelize`, `redis`, `s3`, `sql`, `sqs`.
`pglite-driver` does not consume core and SHALL NOT gain a dependency on it.

Sibling-to-sibling workspace dependencies (`@vnatures/test-kit-sql`,
`@vnatures/test-kit-pglite-driver`) SHALL be ranged `^2.0.0` and SHALL remain in
`dependencies`. They are safe there because core is a peer of `sql`, so no
nested core can appear beneath it.

`examples/grpc-client` is a private workspace **consumer**, not a plugin, and
correctly keeps `@vnatures/test-kit` in `dependencies` at `^2.0.0`.

**Why peer, not dependency.** A plugin family that must share one core instance
is the textbook peer case. With core in `dependencies` at `^1.x`, a consumer
taking core 2.x got *two* copies installed — 2.x at top level and a nested 1.x
under each sibling — with no npm error, because `^1.x` was satisfied by the
nested copy. Two Rig implementations in one process share no probe registry, so a
`Rig` handed to a sibling factory bound to the other copy fails silently.

#### Scenario: core is a peer, never a direct dependency
- **WHEN** each `packages/*/package.json` is parsed
- **THEN** no `dependencies` map contains `@vnatures/test-kit`, and each of the
  11 consuming packages has `peerDependencies["@vnatures/test-kit"]` equal to
  `^2.0.0`

#### Scenario: the workspace copy is still linked after a clean install
- **WHEN** `node_modules` is removed and `npm install` is run from the repo root
- **THEN** no nested `packages/*/node_modules/@vnatures/test-kit` is
  materialized; every consumer resolves through the root symlink into
  `packages/core`

### Requirement: The two senses of "harness" stay separated
"Harness" names two unrelated things in this repository: the library's former
lifecycle owner (now `Rig`), and the industry term for the agent pipeline, which
this repo installs on itself. The agent sense SHALL remain spelled "harness" and
SHALL NOT be renamed. It is confined to:

```
.harness/
test/ci-gate/, test/docs-truth/, test/harness-scaffold/
scripts/*agent-skills*
.claude/, .cursor/, .opencode/
docs/internal/spec/harness-scaffold.md, docs/internal/archive/**
```

Renaming any of those breaks `check-agent-skills` and destroys the distinction.
Rule of thumb: the library sense lives in `packages/` and `examples/`; the agent
sense lives everywhere else.

#### Scenario: the agent-sense zone is untouched by library renames
- **WHEN** a change renames library vocabulary
- **THEN** no file under the paths above is modified

## Known gaps

| Gap | Consequence |
| --- | --- |
| Published `.d.ts` JSDoc still says "the harness" in several factories; `packages/sql/src/factory.ts:38` shows `{ harness, driver }` shorthand | Editor-hover text for 2.x consumers is stale in prose. Cosmetic; no compile impact. |
| No mechanical guard against prose naming a `rig` parameter or key | The regression class that reached PR #50 review (six sites) can recur. A docs test would catch it. |
| No mutation testing or CRAP (RD-24153) | Phase 5 can show the gate is green but not that green *means* anything: most test files resolve through `dist/`, so a mutant applied to `src` is never loaded. |
| `packages/mysql/test/integration/mysql.test.ts` is Docker-gated, and `packages/mysql/tsconfig.json` excludes `test` | Without Docker that file is neither executed nor typechecked locally. Pre-existing. |

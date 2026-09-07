# 0001 — Rename the lifecycle owner to `Rig`, and ship it as 2.0.0

- **Status:** Accepted
- **Date:** 2026-09-07
- **Tickets:** RD-24143 (rename), RD-24144 (version + dependency shape)
- **Spec delta:** [`docs/internal/spec/deltas/P02-P03-rig-rename-2.0.0.md`](../internal/spec/deltas/P02-P03-rig-rename-2.0.0.md)

## Context

One word, "harness", had come to name two different things, and this repository
is the one place that needs both of them at once.

- **The library sense.** Since 1.0.0, `@vnatures/test-kit` has exported the
  object that owns probe and adapter lifecycle — `attach` / `reset` / `close`,
  the shared `Clock`, the shared `defaultTimeout`, the safety timeout, and the
  cross-probe expectations — under that word, together with a family of
  companion types and a `create…` factory.
- **The agent sense.** In current usage — Birgitta Böckeler's framing is the one
  we have adopted internally — an agent's *harness* is everything in an AI agent
  except the model itself: the tool definitions, the prompt scaffolding, the
  loop, the gates, the skills. It is the industry term, it is what every sibling
  repository at Versatile now calls that layer, and it is not a word we control.

Those two senses collided the moment this repository installed an agent pipeline
on itself. `test-kit` now carries `.harness/`, `test/harness-scaffold/`,
`scripts/*agent-skills*`, `docs/internal/spec/harness-scaffold.md` and the
per-agent skill trees under `.claude/`, `.cursor/` and `.opencode/` — all of them
the agent sense — while `packages/core` exported the library sense from
`packages/core/src/harness.ts`. Prose could no longer disambiguate: "the harness
closes the adapters" and "the harness runs the gate" were sentences about
unrelated machinery, and no reader (human or agent) could tell which was meant
without opening the file.

The two senses are not symmetric, and that asymmetry decided which one moved.

- The library sense has a good synonym. A **rig** is an assembled, purpose-built
  arrangement of equipment that you set up, use, and strike down — which is
  exactly what `attach` / `reset` / `close` do. It is shorter, it is a noun with
  no competing meaning in this domain, and `rig.clock.advance(...)` reads better
  than what it replaced.
- The agent sense has no good synonym. It is the term of art in the wider
  ecosystem, it is what the other repositories already use, and renaming it here
  would mean this repository alone spoke a private dialect about the layer that
  most needs to be discussed across repositories.

So the library's concept yields.

## Decision

1. The exported lifecycle owner is named **`Rig`**, created by **`createRig`**,
   with `RigRef`, `RigExpectations` and `CreateRigOptions` as its companions.
   Its source lives at `packages/core/src/rig.ts`. The five former names are
   removed outright — no alias, no re-export, no deprecation shim — and are
   absent from the published type declarations. (The former names are listed in
   the spec delta linked above.)
2. All 13 workspace packages publish at **`2.0.0`**, and the 11 packages that
   consume core declare it as a `peerDependency` at `^2.0.0` rather than a
   regular dependency.
3. Three things deliberately do **not** rename, because they are not among the
   five exported names and changing them would break consumers at runtime
   rather than at compile time:
   - the injection option key, which stays spelled `harness`
     (`createProbedSqlAdapter({ harness: rig, driver })`);
   - the public `origin: 'harness' | 'user'` string-literal union on rule
     entries, which consumers assert against;
   - `errors.harnessClosed()` and its wording, which tests assert verbatim —
     the retained text `Harness is closed.` is the one place the old word
     survives in the shipped surface.
   The word collision therefore survives in three small corners. That is a
   priced trade, not an oversight: each of them is an observable *value*, and a
   second break to tidy the vocabulary would cost another major version.
4. Nothing in the agent-pipeline zone is touched. `.harness/`, `test/`,
   `scripts/`, `.claude/`, `.cursor/`, `.opencode/`,
   `docs/internal/spec/harness-scaffold.md` and `docs/internal/archive/**` keep
   the agent sense of the word. Separating the senses is the whole point; a
   blanket rename would have destroyed the distinction it was meant to create.

## Why the middle digit could not carry the break

This is the part that is easy to get wrong, because two conventions disagree and
only one of them is enforced by a machine.

Under the Package Versioning Policy (PVP), a breaking change may be signalled by
the second component of the version — a 1.0.x → 1.1.0 bump is a legitimate
"breaking" bump, and a reader who knows PVP would read it that way.

npm's resolver does not implement PVP. Every consumer of this package family
pins with a caret, and a caret on a `1.x.y` version widens to the whole major
range: `^1.0.5` means `>=1.0.5 <2.0.0`. A `1.1.0` publish therefore satisfies
every existing `^1.0.x` range in every consumer lockfile-refresh, CI cache miss,
or `npm update`, and the rename would arrive silently in repositories that never
asked for it — as a compile failure on every call site, discovered at build time
by whoever happened to run next.

Under npm's caret semantics a `1.x.y` package has exactly one lever that stops
that, and it is the leftmost digit. So the rename ships as `2.0.0`. Consumers
stay on `^1.x` and keep building until they take `2.0.0` deliberately; that is
the intended effect, not a side effect.

**Consumer cost, accepted knowingly:** 118 forced call sites across 8 consumer
repositories — "forced" meaning a site that touches one of test-kit's renamed
exported names. RD-24145 owns that migration. The roughly 1,948 consumer-defined
factory names that end in the old word (`createOrderServiceHarness` and friends)
are *not* in that count and are not touched: those name a different thing that
merely uses a rig internally.

## Why the two tickets ship atomically

RD-24143 (the rename) and RD-24144 (2.0.0 plus core-as-a-peer) land in one pull
request, because neither ordering of them avoids both traps:

- **Rename first, version second.** Core would publish a renamed surface while
  the sibling packages still listed it in `dependencies` at `^1.x`. npm would
  then materialize a *second*, 1.x copy of core nested under each sibling
  alongside the workspace-linked 2.x copy — the nested dual-install. Two
  incompatible copies of the lifecycle owner in one dependency tree is a class
  of failure that only shows up as bewildering type errors and duplicated
  module state.
- **Version first, rename second.** The packages would publish a patch or minor
  release whose declared dependency range already demanded a major version that
  does not exist yet — a patch release carrying a breaking dependency, unbuildable
  for anyone who installs it in the window between the two.

One pull request has no window. The two tickets are one semver event.

## Consequences

- Every consumer upgrade to `2.0.0` is a deliberate, reviewed act, and the
  compile errors it produces are exactly the list of sites that needed to change.
- `2.0.0` ships a visible naming inconsistency: the type is `Rig` but the option
  key that injects it is still `harness`. It is documented, it is intentional,
  and closing it is a future major bump — worth a ticket, not worth this one.
- Core became a peer dependency of the 11 packages that use it, which is what it
  always was in substance: a single shared runtime the test file and the adapters
  must agree on. Peer resolution makes a duplicated core an install-time error
  instead of a silent runtime split.
- Library documentation — the root README, everything under `docs/` that is not
  internal spec or archive, and all 13 package READMEs — now names the rig, and
  a test in `packages/core/test/unit/` keeps it that way.
- The agent sense of the word is now unambiguous everywhere it appears in this
  repository, which is the outcome the whole exercise was for.

## Alternatives considered

### Invent a new word for the agent sense (e.g. "armature") — rejected

Keeps `@vnatures/test-kit`'s published surface untouched, costs no major version,
forces no consumer call sites. Rejected because the agent sense is not ours to
rename: it is the industry term, and every sibling repository already uses it.
A private dialect for the layer that most needs cross-repository discussion
would trade a one-time, machine-checked rename inside one library for permanent
translation friction in prose, skills, tickets and onboarding — and it would
leave every newcomer's mental model wrong on arrival.

### Publish a deprecated alias alongside the new names — rejected

Export both spellings for a release or two, warn on the old one, remove it later.
Rejected because it defeats the reason for renaming. The problem was never that
the old name was hard to type; it was that both meanings were live at once in one
repository. An alias keeps both words live for months — in code, in editor
autocomplete, in search results, in the very docs that are meant to teach the new
vocabulary — and reintroduces exactly the ambiguity the rename removes. It also
does not spare consumers the work; it defers it to a moment when nothing forces
it, which in practice means it never happens and the alias becomes permanent.
A hard cut with a major version is honest about the cost and bounds it in time.

### Rename the injection option key and the `origin` union too — rejected (for now)

Would have made the vocabulary fully consistent in one break. Rejected because
those are observable *values*, not exported names: the key appears in nearly
every consumer call site, and the `origin` string is asserted at runtime. Both
sit outside RD-24145's committed forced-site estimate, which another workstream
owns. Deferred, with the inconsistency documented above.

## Footnote: the first published 2.x is 2.0.1, not 2.0.0

This ADR and the PR that carried it set every manifest to `2.0.0`, but that exact
string never reaches the registry. `vn-ci/init` reads the version out of the
manifest on every merge to `main`, bumps the patch
(`NEW_VERSION=$1.$2.($3+1)`), commits `chore: bump version to vX [skip ci]`, and
only then does `vn-ci/build-publish` run `npm publish`. So the merge that landed
the rename published **2.0.1** across all 13 packages.

Nothing about the decision changes: the whole argument above is about the
**leftmost digit**, and `2` is what a `^1.x` caret refuses. Every consumer range
is a caret, and the siblings' `^2.0.0` peer range admits any 2.x. The only
casualty is precision in prose — "we shipped 2.0.0" should be read as "we shipped
the 2.x line".

Worth knowing when reading the requirement: the spec pins the major digit, not a
frozen patch string, because CI moves the patch out from under any test that
asserts one.

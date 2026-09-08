# Glossary

Canonical terms for this repository. Each entry is a definition plus an `_Avoid_:` list of near-synonyms that must not name that concept.

## Rig

The lifecycle owner of probes and adapters, created by `createRig`. It owns attach, reset, close, the shared clock, and coordinated disposal.

The industry word was kept for the agent sense; the library concept became Rig. See `docs/adr/0001-rename-the-lifecycle-owner-to-rig-and-ship-2-0-0.md`.

_Avoid_: Harness; test harness; fixture; suite owner; lifecycle manager.

## Adapter

The object injected into the component under test. It implements the boundary contract production code expects. Tests talk to the probe, not to the adapter, after rig setup.

_Avoid_: mock; stub; fake; double; collaborator; dependency; spy.

## Probe

The test-facing control surface for an adapter. It records calls, lets the test observe and wait, program behavior, and settle pending calls. A probe is itself a selection over every call made to its adapter.

_Avoid_: spy; inspector; controller; mock handle; test double surface.

## Selection

A filtered view of a probe. Every probe is a selection over all calls. `selection.filter(predicate)` returns a narrower selection. Operations such as expect and drain live on selections; the probe is the selection that does no filtering.

_Avoid_: query; snapshot; subset; cursor; view-model.

## Filter

A `(call) => boolean` predicate that narrows a selection. Domain probes may ship typed filter sugars; those sugars wrap `filter` and stay optional.

_Avoid_: matcher; where; finder; query predicate as a different noun for this concept.

## Call

A recorded interaction with an adapter. Call shapes are plain, inspectable values that fit the boundary (method and args, SQL, S3 command, HTTP, and so on).

_Avoid_: request; invocation; message; event; interaction-record.

## Pending Call

A live call that has reached the adapter but has not yet been settled. While it is pending, the component is blocked on the returned promise. Leaving it unsettled is a valid technique so timeout and retry logic can fire.

_Avoid_: in-flight request; outstanding call; hanging call; blocked invocation; open request.

## Backing

An optional local implementation behind an adapter (PGlite behind Kysely, `ioredis-mock` behind cache, an in-memory store behind S3). If there is no backing, a pending call cannot forward and must be answered or rejected.

_Avoid_: fake database; stub implementation; in-memory server; driver; fixture store.

## Rule

Pre-programmed behavior for future matching calls. `once()` applies to the next matching call only; `always()` applies to all future matching calls. Rules are optional; tests can also settle calls by hand.

_Avoid_: Design Rules (the numbered list in `docs/concepts.md`); blinker files under `.cursor/rules/`; expectation; stub program; fixture recipe.

## Settlement

Completing a pending call with `answer` / `reject` / `forward`, or parking it by doing nothing. The successful settlement verb is `answer`.

_Avoid_: return; reply; respond; resolve; fulfill; complete.

## Porcelain

Pre-programmed behavior for dependencies the scenario is not actively testing.

_Avoid_: happy-path mock; default stub; fixture setup; background fake.

## Plumbing

Explicit, step-by-step control of the interactions the scenario is testing.

_Avoid_: manual mock; step-through; scripted dialogue; hand-driven fake.

## Goldilocks boundary

A leaf seam fat enough to skip protocol noise and thin enough that application logic stays in the component.

_Avoid_: port; hexagonal port; infrastructure seam; service facade; too-thin client; too-fat service.

## Harness

The agent pipeline: tools, prompts, loop, gates, and skills. Qualify it as the agent harness wherever the library sense of the word could be meant. The industry word was kept for the agent sense; the library lifecycle owner is Rig.

_Avoid_: Rig; lifecycle owner; createRig; test-kit factory; probe owner.

## Blinker

A file under `.cursor/rules/`. These files are blinker conventions for agents, not the published Rule API.

_Avoid_: calling `.cursor/rules/` files "rules"; Cursor rules; ESLint rules as the name of those files.

## Packet

A scoped work item under `docs/internal/packets/` that owns shape; the spec delta owns behaviour.

_Avoid_: ticket as the name of that file; epic; story; brief; RFC.

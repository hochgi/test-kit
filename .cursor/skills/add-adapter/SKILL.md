---
name: add-adapter
description: >-
  In-repo extender guide for a new domain package or an extension of an
  existing probe. Inventory packages/, walk the seven-step architecture
  walkthrough, record Goldilocks in a packet. Use when running /add-adapter
  or when shaping adapter/probe work before /spec-to-ship.
---

# add-adapter — packet for a new adapter or probe extension

This is the in-repo authoring guide. A consumer-side skill that pointed *at*
this repo went stale; this skill is inverted: it tells an agent
working **in** `@hochgi/test-kit` how to add a domain package or extend a
probe that already ships.

**Output is a packet** under `docs/internal/packets/` (`PNN-*.md`). The
packet owns **scope** and shape — what is being built, why this shape, what
is explicitly out. The **spec** owns **behaviour**. Do not write a spec
delta; `/add-adapter` stops after the packet. `/spec-to-ship` is the next
step, not part of this skill.

## Inventory coverage from `packages/`

This repository is an **npm** **workspaces** monorepo (`package.json`
`workspaces`: `packages/*`, `examples/*`).

List `packages/` and each package's `createProbed*` factory **every run**.
Do not keep a hardcoded missing-adapter list — SQS, Kafka, and MySQL already
ship, and a snapshot of "gaps" rots.

Look up, do not ask the human:

- Which domains already exist under `packages/`
- Factory names (`createProbedMysqlAdapter`, `createProbedKafkaProducer`, …)
- Whether `testcontainers` and `@testcontainers/mysql` are already
  dependencies (they are: root `package.json` and `packages/mysql`)
- `SqlDriver` in `packages/sql` (`types.ts`), not a `driver.ts` that does
  not exist

## Branch

Two in-scope shapes, one command:

1. **New** `packages/<domain>/` — a new published `@hochgi/test-kit-<domain>`
   package.
2. **Extend** an existing probe's surface — more methods, sugars, or call
   fields on a package that already exists.

Anything else is novel work: `/add-adapter` stops without a packet and leaves
grilling as the fallback.

## Known question set

Ask these as decisions. Put the answers in the packet. Look up facts above
yourself.

### Goldilocks boundary

The application seam is **too thin** (raw driver / protocol artifacts),
**too fat** (retry, batching, or business rules leak into the adapter), or
**just right** (narrowest interface that hides infrastructure and leaves
orchestration in the component).

The **Goldilocks** ruling and its justification live in the **packet**, not
in the spec.

### Call shapes

Plain inspectable records. The three in-tree families:

- `{method, args}` — mock, redis, and most interface probes
- `{sql, parameters}` — SQL family (`QueryCall`)
- `{commandName, command, input}` — S3 (and similar SDK command objects)

A new domain may use another plain shape; say why in the packet.

### Adapter category

From `docs/concepts.md`:

- **programmable mock** — no backing; calls park until answered
- **backed** — local implementation; `forward()` is meaningful
- **hybrid** — some calls forward, others must be answered (S3)
- **function boundary** — the production dependency is a function, not an
  object (presigner)

### Backing

- **PGlite** is Postgres-only. Do not propose it for MySQL or anything else.
- **testcontainers** and **`@testcontainers/mysql`** are already
  dependencies. MySQL uses them. Do not ask whether they need adding.
- None, for a programmable mock.

### Lifecycle

When the adapter owns resources, implement `ProbedResource` with `reset`
and `close` so the rig can recycle and dispose them.

### Default rule

Backed adapters typically install `probe.always().forward()` at
construction. Programmable mocks **park** (no default rule). A hybrid
forwards what the backing implements and parks or fails the rest.

### Filter sugars — strictly optional

Design Rule 13: `filter(predicate)` is the universal narrowing primitive.
Domain sugars are typed shorthands, **strictly optional**. Every probe
keeps `filter()`. Do not invent a sugar API as a separate surface.

### SQL family vs standalone

Postgres ORMs plug into the `SqlDriver` seam in `packages/sql`. A new SQL
ORM is usually a driver + thin factory, not a fork of QueryProbe.

Standalone domains (redis, kafka, sqs, s3, bull, mock) do not use
`SqlDriver`.

### Naming

- Factory: `createProbed…` matching siblings (`createProbedMysqlAdapter`,
  not `createProbedMySql*Adapter`).
- Package: `@hochgi/test-kit-<domain>`.

## Adding a New Domain Package: Walkthrough

Seven steps from `docs/architecture.md` heading **Adding a New Domain
Package: Walkthrough**. Follow them for a new package. For an extend, only
the steps that change (usually call shape, pending call, probe sugars,
adapter, factory).

1. **Define the call shape.** A normalized plain record for one
   interaction.
2. **Define the pending call shape.** `PendingCallBase` or
   `ForwardablePendingCall`, plus domain accessors.
3. **Define the probe interface.** Extend `Probe<TCall, TPending>`. Sugars
   wrap `filter()`.
4. **Implement the adapter.** Each SUT invocation `recordCall`s against
   the probe (`createProbeRoot`).
5. **Wire lifecycle.** Resources → `ProbedResource` `reset()` / `close()`.
6. **Optionally install a default rule.** Backing that can **forward** →
   `probe.always().forward()`.
7. **Define the factory.** `harness` parameter, SDK options, typed
   `ProbedAdapter`.

Target size: 200–500 lines including types and tests. Growing far past that
usually means duplicated core.

## Contract guard: `examples/grpc-client`

`examples/grpc-client` is the extender contract: a worked
`@hochgi/test-kit-grpc-client`-shaped package that must compile and pass
in CI. Read it before inventing a new layout. Match its factory / types /
probe split unless a sibling domain package is a closer precedent.

## Packet skeleton

Write `docs/internal/packets/PNN-<stem>.md` (next free `PNN`, kebab stem):

```markdown
# PNN <title>

Ticket: RD-NNNNN
Depends on: PNN (RD-NNNNN)   # or "nothing"

Scope: new packages/<domain>/ | extend <existing probe>
Goldilocks: too thin | too fat | just right
  Justification: <why this seam, in the packet>

Adapter category: programmable mock | backed | hybrid | function boundary
Call shape: { … }
Backing: none | PGlite | testcontainers | …
Lifecycle: ProbedResource reset/close | no owned resources
Filter sugars: none beyond filter() | <named sugars>
Default rule: probe.always().forward() | park
SqlDriver: yes (packages/sql) | standalone
Factory: createProbed…
Package: @hochgi/test-kit-…

Out: <explicitly not this packet>
Size: ~N tests against a ~40-test split
```

`Depends on:` is required and authoritative for ordering. Keep the queue
readable: a later packet should be pickable without opening every spec.

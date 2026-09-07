# @vnatures/test-kit

Core engine for probe-driven component testing. Provides the `Rig`,
`Clock`, lifecycle, and the `Probe` / `Selection` / `RuleBuilder` /
`Expectations` types that every domain adapter is built on top of.

You usually do not import factories from this package directly — install
the domain adapter that matches the boundary you are testing
(`@vnatures/test-kit-mock`, `@vnatures/test-kit-pg-kysely`,
`@vnatures/test-kit-redis`, `@vnatures/test-kit-s3`, …) and consume this
package transitively.

## Install

```bash
npm install --save-dev @vnatures/test-kit
```

## What this package gives you

```typescript
import {
    createRig,
    milliseconds,
    seconds,
    realClock,
    viFakeClock,
    type Rig,
    type Probe,
    type Selection,
    type RuleBuilder,
    type Expectations,
    type ProbedAdapter,
    type ProbedResource,
} from "@vnatures/test-kit";
```

- `createRig()` — Constructs a `Rig` that owns a `Clock`,
  `defaultTimeout`, cross-probe expectations, and a list of attached
  resources for cleanup.
- `Clock` factories — `realClock`, `jestFakeClock`, `viFakeClock`,
  `sinonFakeClock`, `manualClock`. The rig auto-detects Vitest /
  Jest fake timers when none is supplied.
- `Duration` factories — `milliseconds`, `seconds`, `minutes`. All
  public timing APIs use `Duration`; raw numbers are rejected.
- `Probe<TCall, TPending>` — the test-facing handle returned by every
  domain adapter. Supports `.calls`, `.filter(...)`, `.expect.*`,
  `.drain()`, `.drainAndReject(error)`.
- `Selection` / `ForwardableSelection` — the result of `probe.on(method)`
  or `probe.filter(predicate)`; programs rules via `.once()` / `.always()`
  or pulls calls via `.expect.*`.
- `RuleBuilder` — the `.answer()` / `.answerWith()` / `.reject()` /
  (when forwardable) `.forward()` grammar.
- `Expectations` — `expect.intercept`, `expect.observe`, `expect.none`,
  `expect.atLeast`, `expect.exactly`.

For full type signatures and matching semantics see
[`docs/api-surface.md`](../../docs/api-surface.md).

## Rig lifecycle

```typescript
import { createRig } from "@vnatures/test-kit";
import { createProbedMock } from "@vnatures/test-kit-mock";

let rig: Rig;

beforeEach(() => {
    rig = createRig();
});

afterEach(async () => {
    await rig.close();
});

it("uses the rig", async () => {
    const users = rig.attach(
        createProbedMock<IUserService>({ harness: rig, methods: ["getUser"] }),
    );
    users.probe.on("getUser").always().answer({ id: 1, name: "Alice" });
    // …
});
```

The rig:

- shares a single `defaultTimeout` and `Clock` across every attached probe;
- closes attached `ProbedResource`s in LIFO order on `close()`;
- exposes `rig.expect.sequence([...])` and `rig.expect.allOf([...])`
  for asserting orderings across probes (see
  [`docs/api-surface.md`](../../docs/api-surface.md#rig)).

## Building a custom domain adapter

Domain packages consume an internal-facing API (`createProbeRoot`,
`makePendingBase`, `makeForwardablePending`) to wire their own
adapter/probe pairs. The grpc-client example in `examples/grpc-client`
is a worked walkthrough; the implementation specification lives in
[`docs/internal/tech-design.md`](../../docs/internal/tech-design.md).

## Related packages

- [`@vnatures/test-kit-mock`](../mock/README.md) — programmable mock
  adapters for arbitrary TypeScript interfaces.
- [`@vnatures/test-kit-pg-kysely`](../pg-kysely/README.md),
  [`@vnatures/test-kit-pg-knex`](../pg-knex/README.md),
  [`@vnatures/test-kit-pg-sequelize`](../pg-sequelize/README.md) — SQL
  adapters backed by PGlite.
- [`@vnatures/test-kit-redis`](../redis/README.md) — cache adapter.
- [`@vnatures/test-kit-s3`](../s3/README.md) — S3 + presigner adapters.

# @vnatures/test-kit-pg-kysely

PGlite-backed Kysely adapter for component tests. Provides an in-memory
Postgres instance that boots instantly and resets cheaply — no Docker,
no real server.

## Why a Kysely adapter?

The right place to fake a database boundary is the ORM or query
builder itself, **not** a custom repository interface (which would hide
SQL bugs from the test) and **not** the raw network layer (which would
make tests verbose and infrastructure-fragile).

This package targets the `Kysely<DB>` seam explicitly. PGlite (real
Postgres compiled to WASM) backs the adapter, so JSONB, GIN indexes,
window functions, and CTEs behave exactly like a real Postgres.

If your boundary is a different ORM, install the matching package
instead:

- [`@vnatures/test-kit-pg-knex`](../pg-knex/README.md)
- [`@vnatures/test-kit-pg-sequelize`](../pg-sequelize/README.md)

## Install

```bash
npm install --save-dev @vnatures/test-kit @vnatures/test-kit-pg-kysely
```

If your test runner needs a flag for ESM dynamic imports (Jest), set:

```json
{
  "scripts": {
    "test": "NODE_OPTIONS='--experimental-vm-modules' jest --runInBand"
  }
}
```

Vitest handles this transparently.

## Quick start

```typescript
import { createRig } from "@vnatures/test-kit";
import { createProbedKyselyAdapter } from "@vnatures/test-kit-pg-kysely";
import { sql } from "kysely";

interface MyDatabase {
    users: { id: number; name: string };
}

const rig = createRig();
const db = await rig.attach(
    createProbedKyselyAdapter<MyDatabase>({
        harness: rig,
        bootstrap: async (k) => {
            await sql`
                CREATE TABLE users (
                    id SERIAL PRIMARY KEY,
                    name VARCHAR NOT NULL
                )
            `.execute(k);
        },
    }),
);

// Default rule is forward — production wiring runs against PGlite.
await db.seed("users", [{ name: "Alice" }]);

const rows = await db.adapter.selectFrom("users").select(["name"]).execute();
expect(rows).toEqual([{ name: "Alice" }]);

await rig.close();
```

## What the adapter returns

```typescript
const { adapter, probe, seed, reset, close } =
    await createProbedKyselyAdapter<DB>({
        harness: rig,
        bootstrap,
        extensions, // optional
    });
```

- `adapter: Kysely<DB>` — inject this into production wiring.
- `probe: QueryProbe` — `.calls`, `.sql(...)`, `.expect.*`,
  `.drain()`. Default rule is `always().forward()` so bootstrap, seed,
  and reset run transparently.
- `seed(table, rows)` — typed insert helper; objects/arrays are
  auto-serialized for JSONB columns.
- `reset({ keepRules? })` — drops user tables and re-runs `bootstrap`.
- `close()` — disposes Kysely + PGlite. Handled automatically by
  `rig.close()` if attached.
- `pglite` — the underlying `PgliteHandle` (see
  `@vnatures/test-kit-pglite-driver`), shared with the probed Kysely.
  Exposed so consumers can reach the SAME PGlite instance without
  constructing a disconnected listener.
- `notifications` — narrow LISTEN/NOTIFY façade over that same PGlite
  instance (convenience alias for `db.pglite.notifications`).

## Programming queries

```typescript
import { milliseconds } from "@vnatures/test-kit";

// Reject every query — useful for failure-mode tests.
db.probe.always().reject(new Error("connection lost"));

// One-shot: reject the next query, then fall back to forwarding.
db.probe.always().forward();              // baseline
db.probe.once().reject(new Error("transient")); // single failure

// Filter by SQL substring before installing a rule.
db.probe
    .filter((q) => q.sql.includes("DELETE"), "DELETE statements")
    .always()
    .reject(new Error("deletes disabled in test"));

// Plumbing: capture and forward the next query manually.
const next = await db.probe.expect.intercept({ within: milliseconds(500) });
expect(next.sql).toContain("SELECT");
next.forward();
```

`db.probe.calls` is a read-only array of every recorded
`{ sql, parameters }` (consumed or not), useful for SQL-shape
assertions. Use `db.probe.sql(...)` to filter by statement text.

## LISTEN / NOTIFY on the same instance

A `NOTIFY` issued through the probed Kysely cannot be observed on a
separately created PGlite listener — that would be a *different*
database. The probed pair exposes a notification façade backed by the
SAME PGlite instance the adapter writes through, so post-commit
delivery works exactly as in production:

```typescript
const db = await rig.attach(
    createProbedKyselyAdapter<DB>({ harness: rig, bootstrap }),
);

const received: string[] = [];
const unlisten = await db.notifications.listen("work_ready", (payload) => {
    received.push(payload);
});

// pg_notify inside a committed transaction — delivered post-commit.
await sql`select pg_notify(${'work_ready'}, ${'hello'})`.execute(db.adapter);

await flushAsync(); // PGlite delivers notifications on a later tick
expect(received).toEqual(["hello"]);

await unlisten();
```

Notes:

- Use `pg_notify(channel, payload)` (the function form) when you need
  bind parameters; PGlite 0.3.x rejects `NOTIFY` with bind params.
- Notifications are delivered **after** the transaction commits. A
  `pg_notify` inside a rolled-back transaction delivers nothing.
- The probed SQL intercept still sees the `pg_notify` statement, so
  `.filter` / `.expect.intercept` / `.always().reject` apply normally.

## PGlite extensions

PGlite ships with [bundled extensions](https://pglite.dev/extensions/)
(`uuid_ossp`, `pgcrypto`, `hstore`, `ltree`, `pgvector`, …). Pass them
via `extensions` and activate them in `bootstrap`:

```typescript
import { uuid_ossp } from "@electric-sql/pglite/contrib/uuid_ossp";

const db = await rig.attach(
    createProbedKyselyAdapter<DB>({
        harness: rig,
        extensions: { uuid_ossp },
        bootstrap: async (k) => {
            await sql.raw('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"').execute(k);
            await sql.raw(`
                CREATE TABLE users (
                    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
                    name VARCHAR NOT NULL
                )
            `).execute(k);
        },
    }),
);
```

## Component-test wiring

```typescript
import { createRig } from "@vnatures/test-kit";
import { createProbedMock } from "@vnatures/test-kit-mock";
import { createProbedKyselyAdapter } from "@vnatures/test-kit-pg-kysely";
import { Test } from "@nestjs/testing";

async function createTestHarness() {
    const rig = createRig();
    const db = await rig.attach(
        createProbedKyselyAdapter<DB>({ harness: rig, bootstrap }),
    );
    const auth = rig.attach(
        createProbedMock<IAuthService>({ harness: rig, methods: ["verify"] }),
    );

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(DB_TOKEN).useValue(db.adapter)
        .overrideProvider("IAuthService").useValue(auth.adapter)
        .compile();

    const app = moduleRef.createNestApplication();
    await app.init();

    return { rig, app, db, auth };
}
```

The `rig.close()` call in your `afterEach` runs `app.close()` —
attached resources before the rig is closed. Production teardown
order is preserved.

## See also

- [`@vnatures/test-kit-mock`](../mock/README.md) for non-SQL boundaries.
- [`docs/concepts.md`](../../docs/concepts.md) for the mental model.
- [`docs/api-surface.md`](../../docs/api-surface.md) for the full
  `QueryProbe` API.


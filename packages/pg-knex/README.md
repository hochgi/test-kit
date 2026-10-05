# @hochgi/test-kit-pg-knex

PGlite-backed Knex adapter for component tests, with the same probe
model as [`@hochgi/test-kit-pg-kysely`](../pg-kysely/README.md). Uses
[`knex-pglite`](https://www.npmjs.com/package/knex-pglite); requires
**Knex 3.x**.

## Install

```bash
npm install --save-dev @hochgi/test-kit @hochgi/test-kit-pg-knex knex
```

## Quick start

```typescript
import { createRig } from "@hochgi/test-kit";
import { createProbedKnexAdapter } from "@hochgi/test-kit-pg-knex";
import knexStringcase from "knex-stringcase";
import type { Knex } from "knex";

async function bootstrap(db: Knex) {
    await db.schema.createTable("users", (t) => {
        t.increments("id").primary();
        t.string("name").notNullable();
    });
}

const rig = createRig();
const db = await rig.attach(
    createProbedKnexAdapter({
        harness: rig,
        // Same camelCase ↔ snake_case behavior as production `Knex(knexStringcase({...}))`
        knexConfig: knexStringcase({}),
        bootstrap,
    }),
);

await db.seed("users", [{ name: "Alice" }]);
const rows = await db.adapter("users").select("*");
expect(rows).toEqual([{ id: 1, name: "Alice" }]);

await rig.close();
```

## What the adapter returns

```typescript
const { adapter, probe, seed, reset, close } =
    await createProbedKnexAdapter({
        harness: rig,
        bootstrap,
        knexConfig,  // optional; merged into the internal config (client/connection/pool ignored)
        extensions,  // optional PGlite extensions
    });
```

- `adapter: Knex` — inject this into production wiring.
- `probe: QueryProbe` — same surface as the Kysely adapter.
- `seed(table, rows)` — insert helper; JSON-serializes plain objects for
  JSONB columns. Uses an unprobed Knex internally so cleanup is not
  blocked by probe rules.
- `reset({ keepRules? })` — drops user tables in `public` and re-runs
  `bootstrap`.
- `close()` — destroys Knex and closes PGlite.

## PGlite extensions

```typescript
import { uuid_ossp } from "@electric-sql/pglite/contrib/uuid_ossp";

const db = await rig.attach(
    createProbedKnexAdapter({
        harness: rig,
        extensions: { uuid_ossp },
        bootstrap: async (k) => {
            await k.raw('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
            await k.schema.createTable("users", (t) => {
                t.uuid("id").defaultTo(k.raw("uuid_generate_v4()")).primary();
                t.string("name").notNullable();
            });
        },
    }),
);
```

## Plumbing tip: registering the waiter before Knex runs the query

Knex can dispatch a query in the same synchronous turn as the chain is
built. To intercept it, register the `expect.intercept` waiter
**before** the query is scheduled:

```typescript
const pendingPromise = db.probe.expect.intercept();
const queryPromise = new Promise((resolve, reject) => {
    setImmediate(() => {
        db.adapter("orders").select("*").then(resolve).catch(reject);
    });
});

const pending = await pendingPromise;
pending.forward();
await queryPromise;
```

## Why `connection` is a function

Knex deep-clones a plain `{ pglite }` connection object, which breaks
PGlite internals. This package uses `connection: () => ({ pglite })`,
as supported by `knex-pglite`.

## See also

- [`@hochgi/test-kit-pg-kysely`](../pg-kysely/README.md) — the same
  model with a Kysely-typed adapter; identical probe surface.
- [`docs/api-surface.md`](../../docs/api-surface.md) — `QueryProbe`
  reference.


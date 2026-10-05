# @hochgi/test-kit-pg-sequelize

PGlite-backed Sequelize v6 adapter for component tests, with the same
probe model as [`@hochgi/test-kit-pg-kysely`](../pg-kysely/README.md)
and [`@hochgi/test-kit-pg-knex`](../pg-knex/README.md).

Bridges Sequelize to PGlite via
[`@middle-management/pglite-pg-adapter`](https://www.npmjs.com/package/@middle-management/pglite-pg-adapter)
behind Sequelize's `dialectModule` hook. See [`APPENDIX.md`](../../APPENDIX.md)
for the adapter-landscape evaluation that informed this design.

## Install

```bash
npm install --save-dev @hochgi/test-kit @hochgi/test-kit-pg-sequelize sequelize
```

If your test runner needs an ESM dynamic-import flag (Jest), set:

```json
{
  "scripts": {
    "test": "NODE_OPTIONS='--experimental-vm-modules' jest --runInBand"
  }
}
```

## Quick start with `sequelize-typescript` models

```typescript
import { Sequelize } from "sequelize-typescript";
import { createRig } from "@hochgi/test-kit";
import { createProbedSequelizeAdapter } from "@hochgi/test-kit-pg-sequelize";
import Models from "../src/models";

const rig = createRig();
const db = await rig.attach(
    createProbedSequelizeAdapter({
        harness: rig,
        SequelizeClass: Sequelize,
        models: Object.values(Models),
    }),
);

// Models are registered and tables already exist on db.adapter.
const rows = await MyModel.findAll();

await rig.close();
```

The `models` option triggers `addModels(models) + sync()`. You can pass
a `bootstrap` callback alongside `models` for seed data or extra
indexes; it runs after `sync()`.

## Quick start with raw DDL

```typescript
import { Sequelize, QueryTypes } from "sequelize";
import { createRig } from "@hochgi/test-kit";
import { createProbedSequelizeAdapter } from "@hochgi/test-kit-pg-sequelize";

const rig = createRig();
const db = await rig.attach(
    createProbedSequelizeAdapter({
        harness: rig,
        bootstrap: async (s) => {
            await s.query(`
                CREATE TABLE IF NOT EXISTS users (
                    id SERIAL PRIMARY KEY,
                    name VARCHAR NOT NULL
                )
            `);
        },
    }),
);

const rows = await db.adapter.query("SELECT * FROM users", {
    type: QueryTypes.SELECT,
});
```

## What the adapter returns

```typescript
const { adapter, probe, seed, reset, close } =
    await createProbedSequelizeAdapter({
        harness: rig,
        SequelizeClass,   // optional; required when `models` is provided
        models,           // optional; sequelize-typescript model classes
        bootstrap,        // optional; runs after sync()
        preBootstrap,     // optional; runs before sync(), useful for CREATE EXTENSION
        extensions,       // optional PGlite extensions
        sequelizeOptions, // optional; merged into the internal config
    });
```

- `adapter: Sequelize` — inject this into production wiring.
- `probe: QueryProbe` — same surface as the Kysely / Knex adapters.
- `seed(table, rows)` — typed insert helper that JSON-serializes plain
  objects for JSONB columns. Uses an unprobed Sequelize so cleanup is
  not blocked by probe rules.
- `reset({ keepRules? })` — drops user tables + enum types, re-runs
  `preBootstrap`, re-registers models, re-syncs, then re-runs
  `bootstrap`.
- `close()` — disposes Sequelize and PGlite.

## PGlite extensions

```typescript
import { uuid_ossp } from "@electric-sql/pglite/contrib/uuid_ossp";

const db = await rig.attach(
    createProbedSequelizeAdapter({
        harness: rig,
        SequelizeClass,
        models: Object.values(Models),
        extensions: { uuid_ossp },
        preBootstrap: async (s) => {
            await s.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
        },
    }),
);
```

## How it works

```
SUT → Sequelize v6 → dialectModule → pglite-pg-adapter (pg.Client/Pool) → PGlite (real Postgres WASM)
```

1. PGlite runs real PostgreSQL compiled to WebAssembly — JSONB, GIN
   indexes, CTEs, and type casts behave exactly like a real Postgres.
2. `@middle-management/pglite-pg-adapter` wraps PGlite behind the
   standard `pg` module surface (`Client`, `Pool`).
3. Sequelize's `dialectModule` option substitutes the adapter for the
   real `pg` module, so Sequelize talks to PGlite without knowing the
   difference.

The adapter classes close over the PGlite instance rather than passing
it through config, to prevent Sequelize's internal `lodash.cloneDeep`
from crashing on PGlite's WASM buffers.

## Plumbing tip: registering the waiter before Sequelize runs the query

Sequelize can dispatch a query in the same synchronous turn:

```typescript
const pendingPromise = db.probe.expect.intercept();
const queryPromise = new Promise((resolve, reject) => {
    setImmediate(() => {
        db.adapter
            .query("SELECT * FROM orders", { type: QueryTypes.SELECT })
            .then(resolve)
            .catch(reject);
    });
});

const pending = await pendingPromise;
pending.forward();
await queryPromise;
```

## Known limitations / gotchas

- **`pglite-pg-adapter` is young** (v0.0.4 at time of writing). Monitor
  for breaking changes.
- **Sequelize v6 only.** Sequelize v7 removes `dialectModule` /
  `dialectModulePath`; this approach will not work with v7+ without an
  alternative mechanism.
- **UUID column validation.** PGlite enforces `DataType.UUID` strictly.
  Use proper UUID strings (e.g. `crypto.randomUUID()`) when seeding —
  arbitrary string IDs like `'test-report-1'` fail with
  `invalid input syntax for type uuid`.
- **`reset()` drops enum types.** Unlike a real Postgres DB, PGlite has
  no migration history. `reset()` drops tables **and** enum types so
  that `sync()` can recreate them cleanly on each test.
- **`uuid_generate_v4()` column defaults.** PGlite does not load
  `uuid-ossp` automatically. Either pass `extensions: { uuid_ossp }`
  and activate in `preBootstrap`, or shim manually:
  `CREATE OR REPLACE FUNCTION uuid_generate_v4() RETURNS uuid LANGUAGE SQL AS $$SELECT gen_random_uuid()$$`.

## See also

- [`@hochgi/test-kit-pg-kysely`](../pg-kysely/README.md) and
  [`@hochgi/test-kit-pg-knex`](../pg-knex/README.md) — siblings
  with identical probe semantics.
- [`docs/api-surface.md`](../../docs/api-surface.md) — `QueryProbe`
  reference.
- [`APPENDIX.md`](../../APPENDIX.md) — adapter-landscape evaluation.


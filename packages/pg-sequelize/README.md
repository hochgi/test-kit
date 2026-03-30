# @vnatures/test-kit-pg-sequelize

PGlite-backed **Sequelize v6** test database for component tests, with optional **DbProbe** (same plumbing/porcelain model as `@vnatures/test-kit-pg-kysely` and `@vnatures/test-kit-pg-knex`).

Uses [`@middle-management/pglite-pg-adapter`](https://www.npmjs.com/package/@middle-management/pglite-pg-adapter) to bridge PGlite behind Sequelize's `dialectModule` option.

> **Why not a native adapter?** No PGlite-Sequelize adapter exists in the ecosystem. See [APPENDIX.md](../../APPENDIX.md) for the full evaluation of alternatives and future recommendations.

## Install

```bash
npm install @vnatures/test-kit-pg-sequelize sequelize
```

## Quick start

### With `sequelize-typescript` models (recommended)

If your service uses `sequelize-typescript` decorated models, pass them via the `models` option. Tables are created automatically from the decorator metadata via `sync()` -- no manual DDL needed.

```typescript
import { Sequelize } from 'sequelize-typescript';
import { createTestDb } from '@vnatures/test-kit-pg-sequelize';
import Models from '../src/models';   // your sequelize-typescript model classes

const testDb = await createTestDb({
    models: Object.values(Models),
    SequelizeClass: Sequelize,         // from 'sequelize-typescript'
});

// Models are registered and tables already exist on testDb.sequelize
const result = await MyModel.findAll();
```

You can still pass a `bootstrap` function alongside `models` -- it runs after `sync()`, so it is useful for seeding fixed reference data or creating extra indexes.

#### Loading PGlite extensions

PGlite ships with [many bundled extensions](https://pglite.dev/extensions/) (`uuid-ossp`, `pgcrypto`, `hstore`, `ltree`, `pgvector`, etc.). Pass them via `extensions` — they are loaded at PGlite construction time. Then activate them with `CREATE EXTENSION` in `preBootstrap`:

```typescript
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';

const testDb = await createTestDb({
    models: Object.values(Models),
    SequelizeClass: Sequelize,
    extensions: { uuid_ossp },
    preBootstrap: async (seq) => {
        await seq.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    },
});
// uuid_generate_v4() now works in column defaults and queries
```

#### Pre-sync setup with `preBootstrap`

`preBootstrap` runs before `addModels` + `sync()` (and before `bootstrap`). It runs again at the start of each `reset()`. Use it to:

- Activate loaded extensions (`CREATE EXTENSION IF NOT EXISTS`)
- Create custom functions that model DDL depends on
- Any SQL that must precede table creation

### With raw DDL (no models)

```typescript
import { Sequelize, QueryTypes } from 'sequelize';
import { createTestDb } from '@vnatures/test-kit-pg-sequelize';

async function bootstrap(sequelize: Sequelize) {
    await sequelize.query(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            name VARCHAR NOT NULL
        )
    `);
}

const testDb = await createTestDb({ bootstrap });

// Query using Sequelize
const rows = await testDb.sequelize.query(
    'SELECT * FROM users',
    { type: QueryTypes.SELECT },
);
```

## How it works

```
Application Code → Sequelize v6 → dialectModule → pglite-pg-adapter (pg.Client/Pool) → PGlite (real Postgres WASM)
```

1. PGlite runs real PostgreSQL compiled to WebAssembly -- JSONB, GIN indexes, CTEs, and type casts all work faithfully.
2. `@middle-management/pglite-pg-adapter` wraps PGlite behind the standard `pg` module interface (`Client`, `Pool`).
3. Sequelize's `dialectModule` option substitutes our adapter for the real `pg` module, so Sequelize talks to PGlite without knowing the difference.

The adapter classes close over the PGlite instance (rather than passing it through config) to prevent Sequelize's internal `lodash.cloneDeep` from crashing on PGlite's WASM buffers.

## API

### `createTestDb(options)`

- `extensions?`: PGlite extension objects to load (e.g. `{ uuid_ossp }` from `@electric-sql/pglite/contrib/uuid_ossp`). See [PGlite Extensions](https://pglite.dev/extensions/).
- `preBootstrap?(sequelize: Sequelize)`: Runs before `models` sync. Use for `CREATE EXTENSION` and DB-level functions that model DDL depends on. Must be idempotent.
- `models?`: `sequelize-typescript` model classes. When provided, calls `addModels(models)` + `sync()` automatically. Requires `SequelizeClass`. At least one of `models` or `bootstrap` must be given.
- `SequelizeClass?`: The `Sequelize` constructor from `sequelize-typescript`. Required when `models` is provided.
- `bootstrap?(sequelize: Sequelize)`: DDL function (use `IF NOT EXISTS`). Runs after `sync()` when both `models` and `bootstrap` are provided.
- `sequelizeOptions?`: merged into the internal config; `dialect`, `dialectModule`, `dialectOptions`, and connection fields are ignored.

Returns `TestDb`:

- `sequelize`: `Sequelize` instance (PGlite), with models registered if `models` was provided.
- `reset()`: drop all user tables + enum types, re-run `preBootstrap`, re-register models + re-sync, re-run `bootstrap`.
- `seed(table, rows)`: insert rows; JSON-serializes plain objects for JSONB-like columns.
- `close()`: close Sequelize / close PGlite.

### `createProbedTestDb(options)`

Same options as `createTestDb` (including `extensions?`, `preBootstrap?`, and `models?`), plus `probe: DbProbe` on the returned object. Application code should use `sequelize`; `reset` / `seed` use an internal unprobed Sequelize so cleanup is not blocked by probe behavior. When `models` is provided, they are registered on both the probed and maintenance Sequelize instances.

### `DbProbe`

Same semantics as pg-kysely and pg-knex: `expectNext`, `expectMatching`, `whenQueried`, `alwaysForward`, `alwaysReject`, `clearBehavior`, `drain*`, `queries`, etc.

## Plumbing: `expectNext` and Sequelize scheduling

Sequelize may start the query in the same synchronous turn. Register the waiter **before** the query is scheduled:

```typescript
const pendingPromise = probe.expectNext();
const queryPromise = new Promise((resolve, reject) => {
    setImmediate(() => {
        testDb.sequelize
            .query('SELECT * FROM orders', { type: QueryTypes.SELECT })
            .then(resolve)
            .catch(reject);
    });
});
const pending = await pendingPromise;
pending.forward();
await queryPromise;
```

## Known limitations / gotchas

- **`pglite-pg-adapter` is young** (v0.0.4 as of March 2026). Monitor for breaking changes.
- **Targets Sequelize v6 only.** Sequelize v7 removes `dialectModule` and `dialectModulePath`, so this approach will not work with v7+ without an alternative mechanism.
- **`sequelize-typescript` models** are supported via the `models` option -- pass your model classes and tables are auto-created from decorator metadata.
- **`uuid_generate_v4()` column defaults**: PGlite does not load the `uuid-ossp` extension by default. If any of your models use `defaultValue: Sequelize.literal('uuid_generate_v4()')`, pass `extensions: { uuid_ossp }` and activate it in `preBootstrap` (see Quick Start above). Alternatively, you can shim the function manually: `CREATE OR REPLACE FUNCTION uuid_generate_v4() RETURNS uuid LANGUAGE SQL AS $$SELECT gen_random_uuid()$$`.
- **UUID column validation**: PGlite enforces `DataType.UUID` columns strictly. Use proper UUID strings (e.g. `crypto.randomUUID()`) when seeding — arbitrary string IDs like `'test-report-1'` will fail with `invalid input syntax for type uuid`.
- **`reset()` drops enum types**: Unlike a real Postgres DB, PGlite has no migration history. `reset()` drops all tables **and** enum types so that `sync()` can recreate them cleanly on each test.
- **`--experimental-vm-modules`**: PGlite uses dynamic `import()` internally. Jest must be launched with `node --experimental-vm-modules node_modules/.bin/jest` (or set `NODE_OPTIONS=--experimental-vm-modules`).

## Scripts

`npm test` sets `NODE_OPTIONS=--experimental-vm-modules` (required by `@electric-sql/pglite`).

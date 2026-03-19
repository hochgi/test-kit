# @vnatures/test-kit-pg-kysely

PGlite-backed Kysely test database for component tests. Provides an in-memory Postgres instance that boots instantly and resets cheaply — no Docker, no real server.

## Why Kysely-specific?

This package targets the `Kysely<DB>` seam explicitly. Different ORMs (Sequelize, Knex, etc.) have different initialization and schema patterns. Rather than a leaky "generic Postgres" abstraction, each ORM gets its own focused test-kit package if and when needed.

PGlite (real Postgres compiled to WASM) is used as an implementation detail. It handles JSONB, GIN indexes, date ranges, and type casts faithfully — unlike pg-mem which can diverge on advanced SQL.

## Install

```bash
npm install --save-dev @vnatures/test-kit-pg-kysely
```

**Node.js requirement:** PGlite needs the `--experimental-vm-modules` flag. Set it in your test script:

```json
{
  "scripts": {
    "test": "NODE_OPTIONS='--experimental-vm-modules' jest --runInBand"
  }
}
```

## Quick Start

```typescript
import { createTestDb, TestDb } from '@vnatures/test-kit-pg-kysely';
import { Kysely, sql } from 'kysely';

interface MyDatabase {
    users: { id: number; name: string };
}

async function bootstrap(db: Kysely<MyDatabase>) {
    await sql.raw(`
        CREATE TABLE users (
            id SERIAL PRIMARY KEY,
            name VARCHAR NOT NULL
        )
    `).execute(db);
}

let testDb: TestDb<MyDatabase>;

beforeAll(async () => {
    testDb = await createTestDb<MyDatabase>({ bootstrap });
});

afterAll(async () => {
    await testDb.close();
});

afterEach(async () => {
    await testDb.reset();
});

it('seeds and queries', async () => {
    await testDb.seed('users', [{ name: 'Alice' }]);

    const rows = await testDb.db
        .selectFrom('users')
        .select(['name'])
        .execute();

    expect(rows).toEqual([{ name: 'Alice' }]);
});
```

## API

### `createTestDb<DB>(options)` — simple passthrough

Creates a fresh in-memory PGlite database and returns a `TestDb` handle. All queries go straight to PGlite — no interception. Good when you only need seed-and-assert.

| Option | Type | Description |
| :--- | :--- | :--- |
| `bootstrap` | `(db: Kysely<DB>) => Promise<void>` | DDL setup: create tables, indexes, etc. Should be idempotent. |

### `TestDb<DB>`

| Property/Method | Description |
| :--- | :--- |
| `db` | The `Kysely<DB>` instance wired to the in-memory database. |
| `reset()` | Drops all user tables and re-runs the bootstrap. |
| `seed(table, rows)` | Inserts rows into a table. Objects/arrays are auto-serialized to JSON for JSONB columns. |
| `close()` | Destroys the Kysely instance and closes PGlite. |

### `createProbedTestDb<DB>(options)` — probed fake

Creates the same PGlite-backed database, but with a `DbProbe` interceptor between Kysely and PGlite. This is the database equivalent of core test-kit's `createProbePair` — you can observe, reject, or forward individual queries. Starts in `alwaysForward()` mode so setup code (bootstrap, seed, reset) works transparently.

Returns a `ProbedTestDb<DB>` which extends `TestDb<DB>` with a `probe` property.

### `DbProbe`

**Porcelain (pre-programmed behavior):**

| Method | Description |
| :--- | :--- |
| `alwaysForward()` | Default. Every query passes through to PGlite. |
| `alwaysReject(error)` | Reject every query with the given error. |
| `whenQueried().thenForward()` | One-shot: forward the next query, then fall back to permanent behavior. |
| `whenQueried().thenReject(error)` | One-shot: reject the next query with `error`. |
| `clearBehavior()` | Clear permanent and planned behaviors. Queries will hang until explicitly settled. |

**Plumbing (explicit control):**

| Method | Description |
| :--- | :--- |
| `expectNext(timeoutMs?)` | Returns a `PendingQuery` for the next unsettled query. |
| `expectMatching(predicate, timeoutMs?)` | Returns a `PendingQuery` matching a predicate on `{ sql, parameters }`. |

**Observation:**

| Method | Description |
| :--- | :--- |
| `queries` | All recorded `QueryCall` objects (sql + parameters). |
| `pendingCount()` | Number of unconsumed queries. |

**Drain helpers:**

| Method | Description |
| :--- | :--- |
| `drainAndForwardAll()` | Forward all unsettled unconsumed queries. |
| `drainAndRejectAll(error?)` | Reject all unsettled unconsumed queries. |

### `PendingQuery`

| Property/Method | Description |
| :--- | :--- |
| `sql` | The SQL string of the intercepted query. |
| `parameters` | Bind parameters. |
| `settled` | Whether the query has been forwarded or rejected. |
| `forward()` | Execute the query against PGlite and resolve with the real result. |
| `reject(error)` | Reject the query with the given error. |

## Probed Fake Example

```typescript
import { createProbedTestDb, ProbedTestDb, DbProbe } from '@vnatures/test-kit-pg-kysely';

let testDb: ProbedTestDb<MyDatabase>;
let probe: DbProbe;

beforeAll(async () => {
    testDb = await createProbedTestDb<MyDatabase>({ bootstrap });
    probe = testDb.probe;
    // starts in alwaysForward() — bootstrap and seed work transparently
});

afterAll(() => testDb.close());
afterEach(() => testDb.reset());

it('returns data from PGlite (default passthrough)', async () => {
    await testDb.seed('users', [{ name: 'Alice' }]);
    const rows = await testDb.db.selectFrom('users').selectAll().execute();
    expect(rows).toHaveLength(1);
});

it('simulates a database error', async () => {
    probe.whenQueried().thenReject(new Error('connection lost'));
    await expect(testDb.db.selectFrom('users').selectAll().execute())
        .rejects.toThrow('connection lost');
});

it('intercepts and inspects a query (plumbing)', async () => {
    probe.clearBehavior();
    const pendingPromise = probe.expectNext();
    const queryPromise = testDb.db.selectFrom('users').selectAll().execute();

    const pending = await pendingPromise;
    expect(pending.sql).toContain('users');
    pending.forward(); // let it through to PGlite
    await queryPromise;

    probe.alwaysForward(); // restore for afterEach reset
});
```

## Local consumption (before publish)

Until the package is published to GitHub Packages, consume it from the test-kit monorepo via a `file:` dependency:

```json
{
  "devDependencies": {
    "@vnatures/test-kit-pg-kysely": "file:../test-kit/packages/pg-kysely"
  }
}
```

Then build the package (`npm run build` in test-kit) and install normally in the consuming repo.

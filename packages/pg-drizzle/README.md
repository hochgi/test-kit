# @hochgi/test-kit-pg-drizzle

PGlite-backed Drizzle adapter for component tests. The system under test gets
a real `PgliteDatabase<TSchema>` from `drizzle-orm/pglite`; the probe sits
below Drizzle, at the PGlite client, so every statement Drizzle sends is a
probed call. No Docker, no real server.

## Why probe at the PGlite client?

Every Drizzle entry point — the query builder (`select` / `insert` /
`update` / `delete`), the relational API (`db.query.*`), raw
`db.execute(sql…)`, prepared queries and everything inside
`db.transaction()` — ends in PGlite's `query(sql, params, options)`. The
adapter wraps the PGlite instance in a pass-through proxy whose `query()`
(and the transaction client's `query()`) goes through the probe. Drizzle
itself runs unchanged, and pooling, retries and transaction orchestration
stay in your component.

If your boundary is a different ORM, install the matching package instead:

- [`@hochgi/test-kit-pg-kysely`](../pg-kysely/README.md)
- [`@hochgi/test-kit-pg-knex`](../pg-knex/README.md)
- [`@hochgi/test-kit-pg-sequelize`](../pg-sequelize/README.md)

## Install

```bash
npm install --save-dev @hochgi/test-kit @hochgi/test-kit-pg-drizzle drizzle-orm @electric-sql/pglite
```

Peers: `drizzle-orm` `>=0.30.6 <1` (CI exercises 0.45.x) and
`@electric-sql/pglite` `^0.3.2`.

## Quick start

```typescript
import { createRig } from "@hochgi/test-kit";
import { createProbedDrizzleAdapter } from "@hochgi/test-kit-pg-drizzle";
import { sql } from "drizzle-orm";
import { pgTable, serial, text } from "drizzle-orm/pg-core";

const users = pgTable("users", {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
});
const schema = { users };

const rig = createRig();
const db = await rig.attach(
    createProbedDrizzleAdapter({
        harness: rig,
        schema,
        bootstrap: async (maintenance) => {
            await maintenance.execute(
                sql`create table if not exists users (id serial primary key, name text not null)`,
            );
        },
    }),
);

// Default rule is forward — production wiring runs against PGlite.
await db.seed(users, [{ name: "Alice" }]);

const rows = await db.adapter.select().from(users);
expect(rows).toEqual([{ id: 1, name: "Alice" }]);
expect(await db.adapter.query.users.findMany()).toHaveLength(1);

await rig.close();
```

`bootstrap` receives an unprobed maintenance Drizzle over the same PGlite.
Supply DDL raw or via Drizzle's `migrate()`; no migration helper ships.
`bootstrap` runs again after every `reset()`, so it must be re-runnable from
an empty `public` schema.

## What the adapter returns

```typescript
const { adapter, probe, seed, reset, close, pglite, notifications } =
    await createProbedDrizzleAdapter({ harness: rig, schema, bootstrap, role, extensions, defaultTimeout });
```

- `adapter: PgliteDatabase<TSchema>` — inject this into production wiring.
  With `schema`, the relational `adapter.query.<table>` API is available.
- `probe: QueryProbe` — `.calls`, `.sql(...)`, `.filter(...)`, `.expect.*`,
  `.drain()`. Default rule is `always().forward()`.
- `seed(table, rows)` — inserts `table.$inferInsert` rows into a Drizzle
  `PgTable` through the unprobed maintenance Drizzle. No-op for empty `rows`.
- `reset({ keepRules? })` — drops user tables in `public` and re-runs
  `bootstrap`.
- `close()` — disposes PGlite. Handled automatically by `rig.close()` if
  attached.
- `pglite` — the underlying `PgliteHandle` (see
  `@hochgi/test-kit-pglite-driver`). `pglite.maintenance.execute(...)` is an
  unprobed read for assertions.
- `notifications` — LISTEN/NOTIFY façade over the same PGlite (alias for
  `pglite.notifications`); `pg_notify` sent through `adapter` reaches it
  after commit.

If `bootstrap` throws, the factory disposes PGlite and rejects with that
error.

## Programming queries

```typescript
import { milliseconds } from "@hochgi/test-kit";

db.probe.sql(/insert into/).always().reject(new Error("disk full"));
db.probe.once().reject(new Error("transient"));
db.probe.sql(/select/).once().park();

const intercepted = db.probe.sql(/from "users"/).expect.intercept({ within: milliseconds(500) });
const work = service.listUsers();
(await intercepted).forward();
await work;
```

drizzle-orm `>= 0.44` wraps every driver error in `DrizzleQueryError`, with
the original as `cause`; the adapter does not unwrap it. Assert on the
`cause` chain.

### `answer()` is a pass-through

`answer(value)` resolves PGlite's `query()` with `value` exactly as given;
Drizzle then post-processes it as if PGlite had returned it. There is no
row-shape conversion, so pass a PGlite `Results` in the shape Drizzle
expects (object rows for `db.execute`, array rows for the query builder):

```typescript
db.probe.once().answer({ rows: [{ one: 42 }], fields: [], affectedRows: 0 });
await db.adapter.execute(sql`select 1 as one`); // rows: [{ one: 42 }]
```

For a backed adapter, prefer `forward()` and seeded data.

## Transactions and savepoints

Statements inside `db.transaction()` are probed through the transaction
client. `BEGIN`, `COMMIT` and `ROLLBACK` are never calls. A nested
`tx.transaction()` is a savepoint on the same client, so you see probed
`savepoint sp1`, then the inner statements, then `release savepoint sp1`
(or `rollback to savepoint sp1` when the inner callback throws). A
catch-all rule matches them.

Drizzle sends transaction config
(`db.transaction(cb, { isolationLevel, accessMode })`) as a
`set transaction …` statement on the transaction client, so it is a probed
call too; a catch-all rule matches it.

A probe rejection that propagates out of the transaction callback rolls the
transaction back.

## Running as an application role (`role`)

PGlite's default user is the superuser `postgres`, which bypasses row-level
security. Set `role` to make application statements run as a non-owner
role:

```typescript
createProbedDrizzleAdapter({ harness: rig, schema, bootstrap, role: "app_rt" });
```

With `role` set, the adapter issues `SET LOCAL ROLE "app_rt"` (the role
quoted as an identifier) as the first statement of every application
transaction, and wraps each non-transaction statement in a short
transaction that does the same. That statement is not a call. `bootstrap`,
`seed` and `reset` stay on the owner role, so the role does not need
TRUNCATE or DROP rights. `bootstrap` must create the role and its grants.

## Seam limits

- **Only `query()` and `transaction()` are probed.** Every other PGlite
  member reached via `db.$client` (for example `exec`, `sql`, `listen`)
  passes straight through: it is not a call, no rule applies to it, and it
  does not run under `role`.
- **With `role` set, each plain statement runs in its own short
  transaction.** A non-transaction statement is wrapped in
  `BEGIN` / `SET LOCAL ROLE` / `COMMIT`, so statements Postgres refuses
  inside a transaction block — `VACUUM`, `CREATE INDEX CONCURRENTLY`, a raw
  `BEGIN` — fail. Run them in `bootstrap` or through
  `pglite.maintenance` instead.

## Limitation: one transaction at a time

PGlite runs one transaction at a time. While any statement of transaction A
is pending in the probe (captured or parked), transaction B cannot begin —
its statements are not recorded as calls until A ends — and a plain
statement is recorded but does not resolve until A ends. Concurrent calls
inside the same transaction, or concurrently outside any transaction, can
be released in any order.

If your component's timeout fires inside the transaction callback (so the
callback throws), the transaction rolls back and PGlite is free for the
next request even though the timed-out call is still pending in the probe.
A timeout raced outside the transaction does not free it: the transaction
holds PGlite until the call is settled.

Cross-transaction race tests need a multi-connection backing, which this
package does not provide.

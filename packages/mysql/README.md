# @hochgi/test-kit-mysql

Probe-driven MySQL adapter backed by a **real** MySQL 8 Testcontainer —
no mocks, no in-memory fakes. Every application query runs against a real
database and is routed through the shared SQL probe surface from
[`@hochgi/test-kit-sql`](../sql/README.md).

## Why a real-container adapter?

Some bugs only surface against a real database — MySQL-specific SQL
dialect, collation, transaction isolation, auto-increment behavior,
foreign key constraints. An in-memory fake can't catch them. This
package gives you a real MySQL 8 instance in a Docker container, with
every query observable and controllable through the probe.

If you don't need a real database, use
[`@hochgi/test-kit-pg-kysely`](../pg-kysely/README.md) (PGlite, no
Docker) instead.

## Prerequisites

- **Docker** must be running. Tests are skipped automatically via
  `describe.skipIf` when Docker is not available.
- The `mysql:8.0` image is pulled automatically on first use (or
  pre-pull it: `docker pull mysql:8.0`).

## Install

```bash
npm install --save-dev @hochgi/test-kit @hochgi/test-kit-mysql
# peer: mysql2 (consumer provides its own version)
```

## Quick start

```typescript
import { createRig } from "@hochgi/test-kit";
import { createProbedMysqlAdapter } from "@hochgi/test-kit-mysql";

const rig = createRig();
const mysql = await rig.attach(
    createProbedMysqlAdapter({
        harness: rig,
        async bootstrap(db) {
            await db.execute(
                `CREATE TABLE IF NOT EXISTS users (
                    id    INT AUTO_INCREMENT PRIMARY KEY,
                    name  VARCHAR(255) NOT NULL,
                    email VARCHAR(255) NOT NULL
                )`,
            );
        },
    }),
);

// Default rule forwards to the real MySQL pool.
await mysql.adapter.execute(
    "INSERT INTO users (name, email) VALUES (?, ?)",
    ["Alice", "alice@example.com"],
);

const [rows] = await mysql.adapter.query<
    { id: number; name: string; email: string }[]
>("SELECT id, name, email FROM users ORDER BY id");
expect(rows[0].name).toBe("Alice");

await rig.close(); // stops the container
```

## What the adapter returns

```typescript
const {
    adapter,
    probe,
    container,
    seed,
    reset,
    close,
} = await createProbedMysqlAdapter({
    harness: rig,
    bootstrap,
    image,       // default "mysql:8.0"
    database,    // default "testdb"
    username,    // default "testuser"
    password,    // default "testpass"
    defaultTimeout,
});
```

- `adapter: MysqlAdapter` — inject this into production wiring. Exposes
  `execute(sql, params)` and `query(sql, params)`, matching mysql2's
  promise `Pool` surface. `execute` uses the **prepared/binary protocol**
  (mysql2 `pool.execute`); `query` uses the **text protocol** (mysql2
  `pool.query`). Both route through the probe. Use `query()` for
  statements that can't be prepared (e.g. `SHOW TABLES`).
- `probe: QueryProbe` — `.calls`, `.sql(match)`, `.expect.*`, `.drain()`.
  Same probe surface as `@hochgi/test-kit-pg-kysely`. Default rule is
  `always().forward()` so queries run transparently against the real
  MySQL.
- `container: MysqlContainerInfo` — `{ host, port, database, username,
  password, connectionUri }` for diagnostics or alternate connections.
- `seed(table, rows)` — batch-insert rows via the maintenance pool,
  bypassing the probe.
- `reset()` — truncates all user tables (with `FOREIGN_KEY_CHECKS = 0`)
  and re-runs `bootstrap`. `rig.reset()` runs it automatically.
- `close()` — closes both pools and stops the container.
  `rig.close()` runs it automatically.

## Three verbs: `forward` / `answer` / `reject`

Same probe semantics as all SQL-backed packages:

- **`forward`** — execute against the real MySQL pool.
- **`answerWith((call) => out)`** / **`answer(out)`** — resolve with a
  caller-provided value (the query never reaches MySQL).
- **`reject(error)`** — fail the call (simulates a DB error / connection
  loss).

```typescript
// Simulate a connection failure on the next INSERT.
mysql.probe.sql(/INSERT/).once().reject(new Error("connection lost"));

// Intercept a query, inspect it, then let it through.
mysql.probe.sql(/SELECT/).always().park();
const pending = await mysql.probe.sql(/SELECT/).expect.intercept();
expect(pending.sql).toContain("SELECT");
pending.forward();
```

## Test structure: one container, many tests

Starting a container is slow (~10s). Start **one** container in
`beforeAll` and clean up between tests with `rig.reset()` (which
truncates tables + re-runs bootstrap + clears probe state):

```typescript
describe.skipIf(!hasDocker)("my MySQL tests", () => {
    let rig: Rig;
    let mysql: ProbedMysqlAdapter;

    beforeAll(async () => {
        rig = createRig();
        mysql = await rig.attach(
            createProbedMysqlAdapter({ harness: rig, bootstrap: async (db) => { /* ... */ } }),
        );
    });

    afterEach(async () => {
        await rig.reset(); // truncate + re-bootstrap + clear probe
    });

    afterAll(async () => {
        await rig.close(); // stop container
    });
});
```

## See also

- [`docs/concepts.md`](../../docs/concepts.md) for the boundary and
  backed-adapter model.
- [`docs/api-surface.md`](../../docs/api-surface.md) for the full probe
  reference.
- [`@hochgi/test-kit-pg-kysely`](../pg-kysely/README.md) for the
  PGlite (no-Docker) SQL adapter with the same probe surface.

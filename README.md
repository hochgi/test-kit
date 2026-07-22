# @vnatures/test-kit

Probe-driven component testing for TypeScript services. Drive a real component
end-to-end while keeping deterministic, in-process control over every external
dependency — databases, caches, S3, third-party APIs.

- **Real components:** the SUT runs through its production wiring; only leaf
  boundaries are faked.
- **Programmable probes:** intercept calls, inspect arguments, answer them in
  any order, reject them, drop them on the floor.
- **No infrastructure:** PGlite for SQL, in-memory backings for cache and S3,
  proxy-based mocks for everything else.

```typescript
import { createHarness } from "@vnatures/test-kit";
import { createProbedMock } from "@vnatures/test-kit-mock";
import { createProbedKyselyAdapter } from "@vnatures/test-kit-pg-kysely";

const harness = createHarness();
const users = harness.attach(
    createProbedMock<IUserService>({ harness, methods: ["getUser"] }),
);
const db = await harness.attach(
    createProbedKyselyAdapter<Database>({ harness, bootstrap }),
);

users.probe.on("getUser").always().answer({ id: 1, name: "Alice" });

const response = await supertest(app).get("/api/data");
expect(response.status).toBe(200);
```

## Why

Unit tests verify isolated logic. End-to-end tests verify the deployed system —
slowly, flakily, and with poor edge-case coverage. **Component tests** sit in
between: the component runs in-process through real wiring, only its leaf
dependencies are replaced.

Test-kit is built for **internal component tests** (in-process, in-memory
fakes, no Docker). Compared to ad-hoc mocks, you get:

- **Determinism** — no network, no shared DB.
- **Speed** — entirely in-memory.
- **Control** — easily simulate timeouts, transient errors, partial failures,
  out-of-order responses.
- **Real wiring** — the SUT exercises its real middleware, controllers, and
  services down to the boundary.

For the longer rationale, the boundary heuristic, and the mental model, read
[`docs/concepts.md`](docs/concepts.md).

## Packages

| Package | Purpose |
| :--- | :--- |
| [`@vnatures/test-kit`](packages/core/README.md) | Core probe engine: `Harness`, `Clock`, `Selection`, `RuleBuilder`, `Expectations`, shared types. Domain packages are built on top of this. |
| [`@vnatures/test-kit-mock`](packages/mock/README.md) | `createProbedMock<T>` for faking any TypeScript interface (REST clients, internal service interfaces, …). |
| [`@vnatures/test-kit-sql`](packages/sql/README.md) | Shared `QueryProbe` surface and `SqlDriver` seam consumed by every `pg-*` adapter. |
| [`@vnatures/test-kit-pg-kysely`](packages/pg-kysely/README.md) | `createProbedKyselyAdapter` — Kysely-typed PGlite-backed adapter. |
| [`@vnatures/test-kit-pg-knex`](packages/pg-knex/README.md) | `createProbedKnexAdapter` — Knex-typed PGlite-backed adapter. |
| [`@vnatures/test-kit-pg-sequelize`](packages/pg-sequelize/README.md) | `createProbedSequelizeAdapter` — Sequelize v6 PGlite-backed adapter. |
| [`@vnatures/test-kit-redis`](packages/redis/README.md) | `createProbedCacheAdapter` — focused cache interface backed by `ioredis-mock`. |
| [`@vnatures/test-kit-bull`](packages/bull/README.md) | `createProbedBullQueue` — drop-in probed Bull `Queue` with an in-memory backing. |
| [`@vnatures/test-kit-s3`](packages/s3/README.md) | `createProbedS3Adapter` and `createProbedPresignerAdapter` with an in-memory backing. |
| [`@vnatures/test-kit-sqs`](packages/sqs/README.md) | `createProbedSqsAdapter` — SQS `SQSClient` adapter with a functional in-memory backing (visibility timeout, long-poll, receipt-handle delete). |
| [`@vnatures/test-kit-kafka`](packages/kafka/README.md) | `createProbedKafkaProducer` — kafkajs-shaped `Producer` adapter with an in-memory topic log (partitioning, per-partition offsets, byte-exact reads). |
| [`@vnatures/test-kit-mysql`](packages/mysql/README.md) | `createProbedMysqlAdapter` — real MySQL 8 via Testcontainers behind the `test-kit-sql` probe seam (requires Docker). |

The package family is intentionally small. Each domain adapter targets the
"Goldilocks" boundary for its category — fat enough to skip noise (raw HTTP
headers, raw Redis commands), thin enough that real integration logic
(SQL generation, presigned URL shape, cache TTL behavior) is still exercised.

## Two ways to drive a probe

- **Porcelain.** Pre-programmed behavior for dependencies you are not actively
  testing in a given scenario:

    ```typescript
    users.probe.on("getUser").always().answer(testUser);
    users.probe.on("create").once().reject(new Error("conflict"));
    ```

- **Plumbing.** Explicit, step-by-step control of the interactions you *are*
  testing:

    ```typescript
    const call = await users.probe.on("getUser").expect.intercept();
    expect(call.args[0]).toBe("alice");
    call.answer({ id: 1, name: "Alice" });
    ```

For the full rule grammar (`once`/`always`, `answer`/`answerWith`/`reject`,
`expect.intercept`/`expect.observe`/`expect.none`), see
[`docs/api-surface.md`](docs/api-surface.md).

## A worked example

```typescript
import { createHarness } from "@vnatures/test-kit";
import { createProbedMock } from "@vnatures/test-kit-mock";
import { createProbedKyselyAdapter } from "@vnatures/test-kit-pg-kysely";

async function createTestHarness() {
    const harness = createHarness();
    const users = harness.attach(
        createProbedMock<IUserService>({ harness, methods: ["getUser"] }),
    );
    const db = await harness.attach(
        createProbedKyselyAdapter<Database>({ harness, bootstrap }),
    );

    const app = App.init({
        services: { users: users.adapter } as IServices,
        db: db.adapter,
    });

    return { harness, app, users, db };
}

it("tests the component", async () => {
    const { harness, app, users, db } = await createTestHarness();
    try {
        users.probe.on("getUser").always().answer({ id: 1, name: "Alice" });

        const responsePromise = supertest(app).get("/api/data").then((r) => r);

        const dbCall = await db.probe.expect.intercept();
        expect(dbCall.sql).toContain("SELECT");
        dbCall.forward(); // run the captured SQL against PGlite

        const response = await responsePromise;
        expect(response.status).toBe(200);
    } finally {
        await harness.close();
    }
});
```

## Documentation

- [`docs/concepts.md`](docs/concepts.md) — Mental model, vocabulary, and
  ergonomics. Read first.
- [`docs/architecture.md`](docs/architecture.md) — Package graph and what each
  module owns.
- [`docs/api-surface.md`](docs/api-surface.md) — Exhaustive API reference.
- [`APPENDIX.md`](APPENDIX.md) — Background notes on the PGlite adapter
  landscape and the Sequelize evaluation that informed
  `@vnatures/test-kit-pg-sequelize`.

## Development

```bash
# Install all workspace dependencies
npm install

# Build all packages
npm run build

# Test all packages
npm test

# Typecheck the full project graph
npm run typecheck

# Lint and format
npm run lint
npm run format

# Build/test a single package
npm run build --workspace=packages/core
npm test --workspace=packages/core
```

## Requirements

- Node.js ≥ 20.
- TypeScript ≥ 5.0 (strict mode supported and recommended).
- A test runner of your choice (Vitest and Jest are both first-class; see
  `Clock` in [`docs/api-surface.md`](docs/api-surface.md) for fake-timer
  integration).

# @hochgi/test-kit

[![CI](https://github.com/hochgi/test-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/hochgi/test-kit/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@hochgi/test-kit.svg)](https://www.npmjs.com/package/@hochgi/test-kit)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

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
import { createRig } from "@hochgi/test-kit";
import { createProbedMock } from "@hochgi/test-kit-mock";
import { createProbedKyselyAdapter } from "@hochgi/test-kit-pg-kysely";

const rig = createRig();
const users = rig.attach(
    createProbedMock<IUserService>({ harness: rig, methods: ["getUser"] }),
);
const db = await rig.attach(
    createProbedKyselyAdapter<Database>({ harness: rig, bootstrap }),
);

users.probe.on("getUser").always().answer({ id: 1, name: "Alice" });

const response = await supertest(app).get("/api/data");
expect(response.status).toBe(200);
```

## Install

Install the core plus the adapters for the dependencies your service talks to,
as dev dependencies:

```bash
npm install --save-dev @hochgi/test-kit @hochgi/test-kit-mock @hochgi/test-kit-pg-kysely
```

Adapters take `@hochgi/test-kit` as a peer dependency, along with any client
library they wrap (`kysely`, `knex`, `sequelize`, `bull`, `kafkajs`, `mysql2`,
the AWS SDK clients), so the versions your service already uses are the ones
under test.

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
| [`@hochgi/test-kit`](packages/core/README.md) | Core probe engine: `Rig`, `Clock`, `Selection`, `RuleBuilder`, `Expectations`, shared types. Domain packages are built on top of this. |
| [`@hochgi/test-kit-mock`](packages/mock/README.md) | `createProbedMock<T>` for faking any TypeScript interface (REST clients, internal service interfaces, …). |
| [`@hochgi/test-kit-sql`](packages/sql/README.md) | Shared `QueryProbe` surface and `SqlDriver` seam consumed by every `pg-*` adapter. |
| [`@hochgi/test-kit-pglite-driver`](packages/pglite-driver/README.md) | Shared PGlite lifecycle helper (`createPgliteHandle`) used by the `pg-*` packages. Published. |
| [`@hochgi/test-kit-pg-kysely`](packages/pg-kysely/README.md) | `createProbedKyselyAdapter` — Kysely-typed PGlite-backed adapter. |
| [`@hochgi/test-kit-pg-knex`](packages/pg-knex/README.md) | `createProbedKnexAdapter` — Knex-typed PGlite-backed adapter. |
| [`@hochgi/test-kit-pg-sequelize`](packages/pg-sequelize/README.md) | `createProbedSequelizeAdapter` — Sequelize v6 PGlite-backed adapter. |
| [`@hochgi/test-kit-redis`](packages/redis/README.md) | `createProbedCacheAdapter` — focused cache interface backed by `ioredis-mock`. |
| [`@hochgi/test-kit-bull`](packages/bull/README.md) | `createProbedBullQueue` — drop-in probed Bull `Queue` with an in-memory backing. |
| [`@hochgi/test-kit-s3`](packages/s3/README.md) | `createProbedS3Adapter` and `createProbedPresignerAdapter` with an in-memory backing. |
| [`@hochgi/test-kit-sqs`](packages/sqs/README.md) | `createProbedSqsAdapter` — SQS `SQSClient` adapter with a functional in-memory backing (visibility timeout, long-poll, receipt-handle delete). |
| [`@hochgi/test-kit-kafka`](packages/kafka/README.md) | `createProbedKafkaProducer` — kafkajs-shaped `Producer` adapter with an in-memory topic log (partitioning, per-partition offsets, byte-exact reads). |
| [`@hochgi/test-kit-mysql`](packages/mysql/README.md) | `createProbedMysqlAdapter` — real MySQL 8 via Testcontainers behind the `test-kit-sql` probe seam (requires Docker). |

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
import { createRig } from "@hochgi/test-kit";
import { createProbedMock } from "@hochgi/test-kit-mock";
import { createProbedKyselyAdapter } from "@hochgi/test-kit-pg-kysely";

async function createTestHarness() {
    const rig = createRig();
    const users = rig.attach(
        createProbedMock<IUserService>({ harness: rig, methods: ["getUser"] }),
    );
    const db = await rig.attach(
        createProbedKyselyAdapter<Database>({ harness: rig, bootstrap }),
    );

    const app = App.init({
        services: { users: users.adapter } as IServices,
        db: db.adapter,
    });

    return { rig, app, users, db };
}

it("tests the component", async () => {
    const { rig, app, users, db } = await createTestHarness();
    try {
        users.probe.on("getUser").always().answer({ id: 1, name: "Alice" });

        const responsePromise = supertest(app).get("/api/data").then((r) => r);

        const dbCall = await db.probe.expect.intercept();
        expect(dbCall.sql).toContain("SELECT");
        dbCall.forward(); // run the captured SQL against PGlite

        const response = await responsePromise;
        expect(response.status).toBe(200);
    } finally {
        await rig.close();
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
  `@hochgi/test-kit-pg-sequelize`.

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

# The full gate CI runs on every pull request
npm run check
```

`packages/mysql` runs a real MySQL through Testcontainers, so its tests need
Docker. Everything else runs in-process.

## Requirements

- Node.js ≥ 22.
- TypeScript ≥ 5.0 (strict mode supported and recommended).
- A test runner of your choice (Vitest and Jest are both first-class; see
  `Clock` in [`docs/api-surface.md`](docs/api-surface.md) for fake-timer
  integration).

## Contributing

Issues and pull requests are welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md).
Please report security issues privately, as described in
[`SECURITY.md`](SECURITY.md).

## License

[MIT](LICENSE) © Gilad Hoch

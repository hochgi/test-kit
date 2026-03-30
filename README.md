# @vnatures/test-kit

Probe-driven component testing for TypeScript services. Test real components with full control over every external dependency — deterministically, efficiently, and without real infrastructure.

## Motivation

Why do we component test?

Unit tests and component tests serve different, complementary purposes. Unit tests are excellent for testing the pure logic of a small unit in isolation. Component tests, on the other hand, test the behavior of a black box interacting with the "outside world". If you find yourself writing unit tests that require excessive mocking, and try to test more than a small unit of code - that might be a smell you're using the wrong testing method.

End-to-End (E2E) tests verify the fully deployed system, but they are slow, flaky, and notoriously difficult to use for simulating edge cases (like network timeouts or transient database failures).

Component tests can generally be divided into two types:
- **External Component Tests:** The component runs in a real container/process, and real I/O is routed over the network to separate fake servers (e.g. WireMock/livestub/etc'…).
- **Internal Component Tests:** The component runs in the same process as the test runner, and dependencies are faked in-memory at the code boundary.

This test-kit is specifically designed for **Internal Component Tests**. This approach hits a sweet spot by testing the real component and its internal wiring while replacing external boundaries with in-memory fakes. This gives you:
- **Determinism:** No network flakes or shared database state.
- **Speed:** Tests run entirely in-memory.
- **Control:** Easily simulate timeouts, errors, and out-of-order responses.
- **No Infrastructure:** No Docker containers or real servers required to run the test suite.

## Architecture & Core Concepts

Test-kit is built around the principles of Hexagonal Architecture (Ports and Adapters).

### 1. The Application Boundary
To test effectively, production code must be "testable" — meaning it decouples from external dependencies at the *right* level of abstraction. Finding this "Goldilocks" boundary seam is crucial:

- **Too Fat (Too High-Level):** If the boundary interface hides too much (e.g., it includes parsing, caching, or business validation logic), the component test won't actually test that logic. You end up faking too much of your own application.
- **Too Thin (Too Low-Level):** If the boundary is too low-level (e.g., raw HTTP protocols/headers, raw SQL string execution, raw Redis network sockets), tests become verbose and fragile. A transparent, backward-compatible infrastructure upgrade could break all your tests.
- **Just Right:** The boundary should represent the logical contract with the outside world. As a rule of thumb, an external service's Swagger/OpenAPI documentation is a great boundary interface: the types are DTOs (not low-level HTTP constructs), but they haven't yet been transformed into your internal domain types.

Examples of good boundaries:
- For an external REST API: A typed interface returning DTOs (e.g., `IUserService`).
- For a database: The ORM or Query Builder itself (e.g., `Kysely<Database>`), *not* a custom repository interface, so we can still test the actual SQL generation logic without dropping to the raw network layer.
- For a cache: A focused, domain-agnostic caching interface (e.g., `InMemoryCache`), not the raw Redis client.

### 2. The Probed Fake Pattern
Instead of standard mocks, test-kit uses **Probed Fakes**.
- The **fake** is injected into the component under test in place of the real implementation.
- The **probe** is the test-facing handle. It lets the test *observe* what the component sent to the dependency and *control* what comes back (and how).

### 3. Porcelain vs. Plumbing
Test-kit provides two ways to interact with probes:
- **Porcelain:** Pre-programmed behavior for dependencies you're not actively testing in a given scenario (e.g., `usersProbe.alwaysReturn("getUser", testUser)`).
- **Plumbing:** Explicit, step-by-step control for the interactions you *are* testing (e.g., waiting for a call with `expectNext()`, asserting on its arguments, and then manually calling `answer()` or `reject()`).

## Packages

Test-kit is a monorepo containing specialized packages for different types of boundaries.

| Package | Description |
| :--- | :--- |
| [`@vnatures/test-kit`](packages/core/README.md) | **Core:** Provides `createProbePair` for faking standard TypeScript interfaces (e.g., REST API boundaries), plus the Porcelain/Plumbing helpers. |
| [`@vnatures/test-kit-pg-kysely`](packages/pg-kysely/README.md) | **Database:** A probed fake for `Kysely<Database>`, backed by an in-memory PGlite instance. |
| [`@vnatures/test-kit-pg-knex`](packages/pg-knex/README.md) | **Database:** A probed fake for Knex, backed by an in-memory PGlite instance (`knex-pglite`). |
| [`@vnatures/test-kit-pg-sequelize`](packages/pg-sequelize/README.md) | **Database:** A probed fake for Sequelize v6, backed by PGlite via `pglite-pg-adapter`. See [APPENDIX.md](APPENDIX.md) for the adapter landscape and future ORM recommendations. |
| [`@vnatures/test-kit-redis`](packages/redis/README.md) | **Cache:** A probed fake for a focused caching interface, backed by `ioredis-mock`. |

## General Usage Pattern

A typical component test sets up a "Harness" that wires the real application with test-kit fakes:

```typescript
import { createProbePair } from "@vnatures/test-kit";
import { createProbedTestDb } from "@vnatures/test-kit-pg-kysely";

async function createTestHarness() {
    // 1. Create probed fakes for your boundaries
    const { fake: users, probe: usersProbe } = createProbePair<IUserService>();
    const testDb = await createProbedTestDb<Database>({ bootstrap });

    // 2. Inject fakes into your real application wiring
    const app = App.init({
        services: { users } as IServices,
        db: testDb.db,
    });

    // 3. Return the app and the probes for the tests to use
    return { app, usersProbe, dbProbe: testDb.probe };
}

it("tests the component", async () => {
    const { app, usersProbe, dbProbe } = await createTestHarness();

    // Use Porcelain to pre-program a dependency
    usersProbe.alwaysReturn("getUser", { id: 1, name: "Alice" });

    // Trigger the component
    const requestPromise = supertest(app).get("/api/data").then(r => r);

    // Use Plumbing to intercept and control the database query
    const dbCall = await dbProbe.expectNext();
    expect(dbCall.sql).toContain("SELECT");
    dbCall.forward(); // Let it execute against the in-memory PGlite

    const response = await requestPromise;
    expect(response.status).toBe(200);
});
```

## Development

```bash
# Install all workspace dependencies
npm install

# Build all packages
npm run build

# Test all packages
npm test

# Build/test a single package
npm run build --workspace=packages/core
npm test --workspace=packages/core
```

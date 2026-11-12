/**
 * Delta docs/internal/spec/deltas/P14-pg-drizzle.md
 * → "Requirement: RLS consumer acceptance example".
 *
 * Consumes @hochgi/test-kit-pg-drizzle the way the first consumer does: the
 * SUT is a per-request-transaction RLS service over a real
 * `PgliteDatabase`, running as the non-owner role `app_rt`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createRig, type Rig } from '@hochgi/test-kit';
import { createProbedDrizzleAdapter, type ProbedDrizzleAdapter } from '@hochgi/test-kit-pg-drizzle';
import {
    APP_ROLE,
    RequestTimeoutError,
    TenantService,
    bootstrapClients,
    clients,
    clientsRepository,
    schema,
    type Schema,
} from '../src/index.js';

const REQUEST_TIMEOUT_MS = 100;

interface ExampleRig {
    readonly rig: Rig;
    readonly db: ProbedDrizzleAdapter<Schema>;
    readonly service: TenantService;
}

let current: Rig | undefined;

async function createExampleRig(): Promise<ExampleRig> {
    const rig = createRig();
    current = rig;
    const db = await rig.attach(
        createProbedDrizzleAdapter<Schema>({ harness: rig, schema, bootstrap: bootstrapClients, role: APP_ROLE }),
    );
    const service = new TenantService(db.adapter, { requestTimeoutMs: REQUEST_TIMEOUT_MS });
    return { rig, db, service };
}

afterEach(async () => {
    await current?.close();
    current = undefined;
});

/** The error and its `cause` chain (drizzle-orm >= 0.44 wraps driver errors). */
function causeChain(err: unknown): unknown[] {
    const chain: unknown[] = [];
    let at: unknown = err;
    while (at !== undefined && at !== null && !chain.includes(at)) {
        chain.push(at);
        at = at instanceof Error ? at.cause : undefined;
    }
    return chain;
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
    try {
        await promise;
    } catch (err) {
        return err;
    }
    throw new Error('expected the request to fail, but it succeeded');
}

describe('Requirement: RLS consumer acceptance example', () => {
    it('Scenario: tenant isolation with two seeded tenants', async () => {
        const { db, service } = await createExampleRig();
        await db.seed(clients, [
            { customerId: 1, name: 'acme' },
            { customerId: 2, name: 'globex' },
            { customerId: 1, name: 'initech' },
        ]);

        const listed = await service.forTenant(1).transaction((tx) => clientsRepository.list(tx));

        expect(listed.map((c) => c.name)).toEqual(['acme', 'initech']);
        expect(listed.every((c) => c.customerId === 1)).toBe(true);
    });

    it('Scenario: probe-rejected write rolls back the request', async () => {
        const { db, service } = await createExampleRig();
        const writeFailed = new Error('write failed');
        db.probe
            .filter((c) => /^insert into "clients"/i.test(c.sql) && c.parameters.includes('second'), 'insert second')
            .once()
            .reject(writeFailed);

        const err = await rejectionOf(
            service.forTenant(1).transaction(async (tx) => {
                await clientsRepository.insert(tx, 'first');
                await clientsRepository.insert(tx, 'second');
            }),
        );
        const after = await service.forTenant(1).transaction((tx) => clientsRepository.list(tx));

        expect(causeChain(err)).toContain(writeFailed);
        expect(after).toEqual([]);
    });

    it('Scenario: probe-hung read times out and the next request works', async () => {
        const { db, service } = await createExampleRig();
        await db.seed(clients, [{ customerId: 1, name: 'acme' }]);
        db.probe
            .sql(/from "clients"/)
            .once()
            .park();

        const err = await rejectionOf(service.forTenant(1).transaction((tx) => clientsRepository.list(tx)));
        const next = await service.forTenant(1).transaction((tx) => clientsRepository.list(tx));

        expect(err).toBeInstanceOf(RequestTimeoutError);
        expect(next.map((c) => c.name)).toEqual(['acme']);
    });

    it('Scenario: set_config is seen before the repository query', async () => {
        const { db, service } = await createExampleRig();

        await service.forTenant(1).transaction((tx) => clientsRepository.list(tx));

        const statements = db.probe.calls.map((c) => c.sql);
        const setConfigAt = statements.findIndex((s) => s.includes('set_config'));
        const selectAt = statements.findIndex((s) => /^select\b.*from "clients"/i.test(s));
        expect(setConfigAt).toBeGreaterThanOrEqual(0);
        expect(selectAt).toBeGreaterThan(setConfigAt);
    });
});

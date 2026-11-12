/**
 * Shared fixture for the pg-drizzle integration suites
 * (delta docs/internal/spec/deltas/P14-pg-drizzle.md).
 *
 * Each `it` builds its own rig through {@link createItemsRig} and closes it in
 * `afterEach`, so a failed assertion cannot leak a PGlite instance.
 */
import { sql } from 'drizzle-orm';
import { pgTable, serial, text } from 'drizzle-orm/pg-core';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { createRig, type Rig } from '@hochgi/test-kit';
import {
    createProbedDrizzleAdapter,
    type CreateProbedDrizzleAdapterOptions,
    type ProbedDrizzleAdapter,
} from '@hochgi/test-kit-pg-drizzle';

export const items = pgTable('items', {
    id: serial('id').primaryKey(),
    name: text('name').notNull(),
});

export const schema = { items };
export type Schema = typeof schema;

export async function bootstrapItems(db: PgliteDatabase<Schema>): Promise<void> {
    await db.execute(sql.raw('create table if not exists items (id serial primary key, name text not null)'));
}

export interface ItemsRig {
    readonly rig: Rig;
    readonly db: ProbedDrizzleAdapter<Schema>;
}

export type ItemsRigOverrides = Partial<Omit<CreateProbedDrizzleAdapterOptions<Schema>, 'harness'>>;

export async function createItemsRig(overrides: ItemsRigOverrides = {}): Promise<ItemsRig> {
    const rig = createRig();
    try {
        const db = await rig.attach(
            createProbedDrizzleAdapter<Schema>({ harness: rig, schema, bootstrap: bootstrapItems, ...overrides }),
        );
        return { rig, db };
    } catch (err) {
        await rig.close();
        throw err;
    }
}

/** Unprobed read straight through the PGlite handle's maintenance executor. */
export async function maintenanceCount(db: ProbedDrizzleAdapter<Schema>, table: string): Promise<number> {
    const result = await db.pglite.maintenance.execute(`select count(*)::int as n from "${table}"`);
    return Number(result.rows[0]?.['n']);
}

/** The SUT's own timeout error, distinct from anything the probe produces. */
export class SutTimeoutError extends Error {
    constructor(ms: number) {
        super(`SUT timed out after ${String(ms)}ms`);
        this.name = 'SutTimeoutError';
    }
}

/** What a SUT does: race its own work against its own (real-timer) deadline. */
export function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new SutTimeoutError(ms)), ms);
    });
    return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/**
 * The error and every `cause` beneath it. drizzle-orm >= 0.44 wraps driver
 * errors in `DrizzleQueryError` (original as `cause`); older releases in the
 * peer range reject with the driver error itself. Asserting on the chain
 * holds for both.
 */
export function causeChain(err: unknown): unknown[] {
    const chain: unknown[] = [];
    let current: unknown = err;
    while (current !== undefined && current !== null && !chain.includes(current)) {
        chain.push(current);
        current = current instanceof Error ? current.cause : undefined;
    }
    return chain;
}

export function chainMessages(err: unknown): string[] {
    return causeChain(err).map((e) => (e instanceof Error ? e.message : String(e)));
}

export async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
    try {
        await promise;
    } catch (err) {
        return err;
    }
    throw new Error('expected the promise to reject, but it resolved');
}

export interface Tracked<T> {
    readonly promise: Promise<T>;
    readonly settled: () => boolean;
}

/** Observe settlement without consuming the outcome. */
export function track<T>(promise: Promise<T>): Tracked<T> {
    let settled = false;
    promise.then(
        () => {
            settled = true;
        },
        () => {
            settled = true;
        },
    );
    return { promise, settled: () => settled };
}

/** A short real-time pause so in-flight work gets a chance to settle. */
export function tick(ms = 25): Promise<void> {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export const TX_CONTROL = /^\s*(begin|commit|rollback)\b/i;

import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { Duration, ProbeRoot, ProbedAdapterWithLifecycle, Rig } from '@hochgi/test-kit';
import { createProbedSqlAdapter, type QueryCall, type QueryPendingCall, type QueryProbe } from '@hochgi/test-kit-sql';
import { createPgliteHandle, type PgliteHandle } from '@hochgi/test-kit-pglite-driver';
import { createDrizzleSqlDriver, createProbedPglite } from './driver.js';

export interface CreateProbedDrizzleAdapterOptions<TSchema extends Record<string, unknown> = Record<string, never>> {
    readonly harness: Rig;
    /**
     * Drizzle schema (tables and relations). When given, the probed
     * `adapter` supports the relational `db.query.<table>` API for it.
     */
    readonly schema?: TSchema;
    /**
     * Runs once at construction and again after every `reset()`, on an
     * unprobed maintenance Drizzle over the same PGlite, as the owner role.
     * Must be re-runnable from an empty `public` schema.
     */
    readonly bootstrap: (db: PgliteDatabase<TSchema>) => Promise<void>;
    /**
     * When set, every application statement runs as this role via an
     * unprobed `SET LOCAL ROLE "<role>"` at the start of each transaction.
     */
    readonly role?: string;
    readonly extensions?: Record<string, unknown>;
    readonly defaultTimeout?: Duration;
}

export type ProbedDrizzleAdapter<TSchema extends Record<string, unknown> = Record<string, never>> =
    ProbedAdapterWithLifecycle<PgliteDatabase<TSchema>, QueryProbe> & {
        /** Insert rows through the unprobed maintenance Drizzle. No-op for an empty `rows`. */
        seed<TTable extends PgTable>(table: TTable, rows: ReadonlyArray<TTable['$inferInsert']>): Promise<void>;
        /** The underlying PGlite lifecycle handle, shared with the probed Drizzle. */
        readonly pglite: PgliteHandle;
        /** LISTEN/NOTIFY façade over the same PGlite. Alias for `pglite.notifications`. */
        readonly notifications: PgliteHandle['notifications'];
    };

export async function createProbedDrizzleAdapter<TSchema extends Record<string, unknown> = Record<string, never>>(
    options: CreateProbedDrizzleAdapterOptions<TSchema>,
): Promise<ProbedDrizzleAdapter<TSchema>> {
    const handle = await createPgliteHandle({ extensions: options.extensions });

    // The probed client is built before the probe root it records into, so it
    // reaches the root through this closure; no query runs before construction ends.
    const getRoot = (): ProbeRoot<QueryCall, QueryPendingCall> => sqlAdapter.probeRoot;
    const probed = createProbedPglite({ pglite: handle.pglite, getRoot, role: options.role });
    const driver = createDrizzleSqlDriver(handle, probed);
    const sqlAdapter = createProbedSqlAdapter({
        harness: options.harness,
        defaultTimeout: options.defaultTimeout,
        driver,
    });

    const config = options.schema === undefined ? {} : { schema: options.schema };
    const adapter = drizzle<TSchema>(probed, config);
    // Bootstrap, seed and reset run unprobed, as PGlite's owner role.
    const maintenance = drizzle<TSchema>(handle.pglite, config);

    try {
        await options.bootstrap(maintenance);
    } catch (err) {
        await driver.close();
        throw err;
    }

    return {
        adapter,
        probe: sqlAdapter.probe,
        pglite: handle,
        notifications: handle.notifications,

        async seed(table, rows) {
            if (rows.length === 0) return;
            await maintenance.insert(table).values([...rows]);
        },

        async reset() {
            await driver.reset();
            await options.bootstrap(maintenance);
        },

        close: () => driver.close(),
    };
}

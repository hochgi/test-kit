import { Kysely } from 'kysely';
import { type Duration, type Harness, type ProbeRoot, type ProbedAdapterWithLifecycle } from '@vnatures/test-kit';
import { createProbedSqlAdapter, type QueryCall, type QueryPendingCall, type QueryProbe } from '@vnatures/test-kit-sql';
import { createPgliteHandle, type PgliteHandle } from '@vnatures/test-kit-pglite-driver';
import { ProbedKyselyDialect, createKyselySqlDriver } from './driver.js';

export interface CreateProbedKyselyAdapterOptions<DB> {
    readonly harness: Harness;
    readonly bootstrap: (db: Kysely<DB>) => Promise<void>;
    readonly extensions?: Record<string, unknown>;
    readonly defaultTimeout?: Duration;
}

export type ProbedKyselyAdapter<DB> = ProbedAdapterWithLifecycle<Kysely<DB>, QueryProbe> & {
    seed<Table extends keyof DB & string>(table: Table, rows: ReadonlyArray<Record<string, unknown>>): Promise<void>;
    /**
     * The underlying PGlite lifecycle handle, shared with the probed Kysely.
     * Exposed so consumers can reach the SAME PGlite instance — e.g. to run
     * `LISTEN`/`NOTIFY` via {@link PgliteHandle.notifications} — without
     * constructing a separate (and disconnected) listener.
     */
    readonly pglite: PgliteHandle;
    /**
     * Narrow LISTEN/NOTIFY façade over the same PGlite instance the probed
     * Kysely writes through. Convenience alias for `pglite.notifications`.
     */
    readonly notifications: PgliteHandle['notifications'];
};

export async function createProbedKyselyAdapter<DB>(
    options: CreateProbedKyselyAdapterOptions<DB>,
): Promise<ProbedKyselyAdapter<DB>> {
    const handle = await createPgliteHandle({ extensions: options.extensions });

    // The SqlDriver / probeRoot are wired via a getter so the dialect can
    // reference probeRoot before it's constructed (canonical pattern).
    let probeRoot: ProbeRoot<QueryCall, QueryPendingCall> | null = null;
    const getRoot = (): ProbeRoot<QueryCall, QueryPendingCall> => {
        if (!probeRoot) {
            throw new Error('pg-kysely: probeRoot accessed before adapter construction completed.');
        }
        return probeRoot;
    };

    // Application-facing Kysely instance — every query routes through the
    // probe via ProbedKyselyDialect/ProbedDriver/ProbedConnection.
    const kysely = new Kysely<DB>({
        dialect: new ProbedKyselyDialect(handle.pglite, getRoot),
    });

    // Maintenance Kysely — used for bootstrap/seed/reset; bypasses the probe.
    const { PGliteDialect } = await import('kysely-pglite-dialect');
    const maintenanceKysely = new Kysely<DB>({
        dialect: new PGliteDialect(handle.pglite),
    });

    // Now construct the SqlAdapter (which constructs probeRoot).
    const driver = createKyselySqlDriver(handle, getRoot);
    const sqlAdapter = createProbedSqlAdapter({
        harness: options.harness,
        defaultTimeout: options.defaultTimeout,
        driver,
    });
    probeRoot = sqlAdapter.probeRoot;

    // Bootstrap on the maintenance connection.
    try {
        await options.bootstrap(maintenanceKysely);
    } catch (err) {
        try {
            await kysely.destroy();
        } catch {
            // ignore
        }
        try {
            await maintenanceKysely.destroy();
        } catch {
            // ignore
        }
        await handle.close();
        throw err;
    }

    return {
        adapter: kysely,
        probe: sqlAdapter.probe,
        pglite: handle,
        notifications: handle.notifications,

        async seed(table, rows) {
            await seedInto(maintenanceKysely, table as keyof DB & string, rows);
        },

        async reset() {
            await handle.truncateAllUserTables();
            await options.bootstrap(maintenanceKysely);
        },

        async close() {
            try {
                await kysely.destroy();
            } catch {
                // ignore
            }
            try {
                await maintenanceKysely.destroy();
            } catch {
                // ignore
            }
            await handle.close();
        },
    };
}

async function seedInto<DB, Table extends keyof DB & string>(
    maintenance: Kysely<DB>,
    table: Table,
    rows: ReadonlyArray<Record<string, unknown>>,
): Promise<void> {
    if (rows.length === 0) return;

    const prepared = rows.map((row) => {
        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row)) {
            out[key] = serializeForJsonb(value);
        }
        return out;
    });

    // Cast widely; Kysely's typed insertInto/values are too narrow for a
    // seed helper that accepts arbitrary records.
    await (
        maintenance.insertInto(table as never).values(prepared as never) as unknown as { execute(): Promise<unknown> }
    ).execute();
}

function serializeForJsonb(value: unknown): unknown {
    if (value !== null && typeof value === 'object' && !Buffer.isBuffer(value) && !(value instanceof Date)) {
        return JSON.stringify(value);
    }
    return value;
}

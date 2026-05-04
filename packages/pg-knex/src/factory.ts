import type { Knex } from 'knex';
import { type Duration, type Harness, type ProbeRoot, type ProbedAdapterWithLifecycle } from '@vnatures/test-kit';
import {
    createProbedSqlAdapter,
    type QueryCall,
    type QueryPendingCall,
    type QueryProbe,
    type SqlDriver,
} from '@vnatures/test-kit-sql';
import { createPgliteHandle } from '@vnatures/test-kit-pglite-driver';
import { createPgliteKnex, createProbedPgliteKnex } from './driver.js';

export interface CreateProbedKnexAdapterOptions {
    readonly harness: Harness;
    readonly bootstrap: (knex: Knex) => Promise<void>;
    readonly extensions?: Record<string, unknown>;
    readonly knexConfig?: Partial<Knex.Config>;
    readonly defaultTimeout?: Duration;
}

export type ProbedKnexAdapter = ProbedAdapterWithLifecycle<Knex, QueryProbe> & {
    seed(table: string, rows: ReadonlyArray<Record<string, unknown>>): Promise<void>;
};

export async function createProbedKnexAdapter(options: CreateProbedKnexAdapterOptions): Promise<ProbedKnexAdapter> {
    const handle = await createPgliteHandle({ extensions: options.extensions });

    let probeRoot: ProbeRoot<QueryCall, QueryPendingCall> | null = null;
    const getRoot = (): ProbeRoot<QueryCall, QueryPendingCall> => {
        if (!probeRoot) {
            throw new Error('pg-knex: probeRoot accessed before adapter construction completed.');
        }
        return probeRoot;
    };

    const probedKnex = createProbedPgliteKnex(handle.pglite, getRoot, options.knexConfig);
    const maintenanceKnex = createPgliteKnex(handle.pglite, options.knexConfig);

    const driver: SqlDriver = {
        onApplicationQuery(call) {
            // Knex's _query override calls recordCall directly; this method is
            // unused on the application path but kept for SqlDriver interface
            // completeness.
            return getRoot().recordCall(call, () => handle.maintenance.execute(call.sql, [...call.parameters]));
        },
        async reset() {
            await handle.truncateAllUserTables();
        },
        async close() {
            await handle.close();
        },
    };

    const sqlAdapter = createProbedSqlAdapter({
        harness: options.harness,
        defaultTimeout: options.defaultTimeout,
        driver,
    });
    probeRoot = sqlAdapter.probeRoot;

    try {
        await options.bootstrap(maintenanceKnex);
    } catch (err) {
        try {
            await probedKnex.destroy();
        } catch {
            // ignore
        }
        try {
            await maintenanceKnex.destroy();
        } catch {
            // ignore
        }
        await handle.close();
        throw err;
    }

    return {
        adapter: probedKnex,
        probe: sqlAdapter.probe,

        async seed(table, rows) {
            if (rows.length === 0) return;
            const prepared = rows.map((row) => {
                const out: Record<string, unknown> = {};
                for (const [key, value] of Object.entries(row)) {
                    out[key] = serializeForJsonb(value);
                }
                return out;
            });
            await maintenanceKnex(table).insert(prepared);
        },

        async reset() {
            await handle.truncateAllUserTables();
            await options.bootstrap(maintenanceKnex);
        },

        async close() {
            try {
                await probedKnex.destroy();
            } catch {
                // ignore
            }
            try {
                await maintenanceKnex.destroy();
            } catch {
                // ignore
            }
            await handle.close();
        },
    };
}

function serializeForJsonb(value: unknown): unknown {
    if (value !== null && typeof value === 'object' && !Buffer.isBuffer(value) && !(value instanceof Date)) {
        return JSON.stringify(value);
    }
    return value;
}

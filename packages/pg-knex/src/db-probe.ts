/* eslint-disable max-classes-per-file */
import { PGlite } from '@electric-sql/pglite';
import knex, { type Knex } from 'knex';
import { DbProbe } from '@vnatures/test-kit';

import type { BootstrapFn, TestDb } from './test-db';
import { createPgliteKnex, dropAllUserTables, stripConflictingKnexOptions, KnexPGLiteClient } from './test-db';

// Re-export so consumers can import everything from this package without
// needing to add @vnatures/test-kit as a direct dependency.
export { DbProbe } from '@vnatures/test-kit';
export type { QueryCall, PendingQuery } from '@vnatures/test-kit';

// ── Probed Knex client ────────────────────────────────────────────────────────
// One Knex Client subclass per probed DB instance, closing over `DbProbe`, so
// the probe is always visible in `_query` without mutating `client.config`
// (Knex may replace the config object internally).

function createProbedPgliteClientClass(probe: DbProbe): typeof KnexPGLiteClient {
    return class ProbedPGLiteClient extends KnexPGLiteClient {
        // Knex Client typings omit internal _query; knex-pglite implements it.
        // `super._query()` cannot be used because TypeScript doesn't know about
        // this undocumented method, so we look it up on the prototype directly.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, no-underscore-dangle, @typescript-eslint/require-await, @typescript-eslint/dot-notation
        async _query(connection: PGlite, obj: any): Promise<any> {
            type QueryHook = (c: PGlite, o: unknown) => Promise<unknown>;
            // eslint-disable-next-line @typescript-eslint/dot-notation
            const parentQuery = (KnexPGLiteClient.prototype as unknown as Record<string, QueryHook>)['_query'];
            const run = (): Promise<unknown> => parentQuery.call(this, connection, obj);
            return probe.recordQuery(
                { sql: obj.sql as string, parameters: (obj.bindings ?? []) as ReadonlyArray<unknown> },
                run,
            );
        }
    };
}

function createProbedPgliteKnex(pglite: PGlite, probe: DbProbe, extraConfig?: Partial<Knex.Config>): Knex {
    const ClientClass = createProbedPgliteClientClass(probe);
    const config = {
        ...stripConflictingKnexOptions(extraConfig),
        client: ClientClass,
        connection: () => ({ pglite }),
    } as Knex.Config;
    return knex(config);
}

// ── Public factory ────────────────────────────────────────────────────────────

export interface ProbedTestDbOptions {
    bootstrap: BootstrapFn;
    knexConfig?: Partial<Knex.Config>;
}

export interface ProbedTestDb extends TestDb {
    readonly probe: DbProbe;
}

export async function createProbedTestDb(options: ProbedTestDbOptions): Promise<ProbedTestDb> {
    const pglite = new PGlite();
    await pglite.waitReady;
    const probe = new DbProbe();
    const db = createProbedPgliteKnex(pglite, probe, options.knexConfig);
    const maintenanceDb = createPgliteKnex(pglite, options.knexConfig);

    probe.alwaysForward();

    try {
        await options.bootstrap(maintenanceDb);
    } catch (err) {
        try {
            await db.destroy();
        } catch {
            /* ignore */
        }
        try {
            await maintenanceDb.destroy();
        } catch {
            /* ignore */
        }
        try {
            await pglite.close();
        } catch {
            /* ignore */
        }
        throw err;
    }

    return {
        db,
        probe,

        async reset() {
            await dropAllUserTables(maintenanceDb);
            await options.bootstrap(maintenanceDb);
        },

        async seed(table, rows) {
            if (rows.length === 0) return;

            const prepared = rows.map((row) => {
                const out: Record<string, unknown> = {};
                for (const [key, value] of Object.entries(row)) {
                    out[key] =
                        value !== null &&
                        typeof value === 'object' &&
                        !Buffer.isBuffer(value) &&
                        !(value instanceof Date)
                            ? JSON.stringify(value)
                            : value;
                }
                return out;
            });

            await maintenanceDb(table).insert(prepared);
        },

        async close() {
            try {
                await db.destroy();
            } catch {
                /* knex-pglite may have already closed PGlite */
            }
            try {
                await maintenanceDb.destroy();
            } catch {
                /* knex-pglite may have already closed PGlite */
            }
            try {
                await pglite.close();
            } catch {
                /* may already be closed by a destroy above */
            }
        },
    };
}

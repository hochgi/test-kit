/* eslint-disable max-classes-per-file */
import { EventEmitter } from 'events';
import { PGlite } from '@electric-sql/pglite';
import { Client, Pool } from '@middle-management/pglite-pg-adapter';
import { Sequelize, type Options as SequelizeOptions } from 'sequelize';
import { DbProbe } from '@vnatures/test-kit';

import type { BootstrapFn, ModelCtor, SequelizeCtor, TestDb } from './test-db';
import { buildSequelizeConfig, createPgliteSequelize, dropAllUserTables, syncModels } from './test-db';

export { DbProbe } from '@vnatures/test-kit';
export type { QueryCall, PendingQuery } from '@vnatures/test-kit';

// ── Probed dialect module ────────────────────────────────────────────────────
// Builds Client/Pool subclasses that close over both the PGlite instance (to
// avoid deep-clone crashes) and a DbProbe instance (to intercept queries).

function interceptQuery(
    probe: DbProbe,
    superQuery: (...args: any[]) => any,
    textOrConfig: any,
    valuesOrCallback?: any,
    callback?: any,
): any {
    let sql: string;
    let parameters: ReadonlyArray<unknown>;

    if (typeof textOrConfig === 'string') {
        sql = textOrConfig;
        parameters = Array.isArray(valuesOrCallback) ? valuesOrCallback : [];
    } else if (textOrConfig && typeof textOrConfig === 'object' && 'text' in textOrConfig) {
        sql = textOrConfig.text;
        parameters = textOrConfig.values ?? [];
    } else {
        return superQuery(textOrConfig, valuesOrCallback, callback);
    }

    let actualCallback: ((...args: any[]) => void) | undefined;
    if (typeof valuesOrCallback === 'function') {
        actualCallback = valuesOrCallback;
    } else if (typeof callback === 'function') {
        actualCallback = callback;
    }

    // Always forward in promise mode -- the adapter's query() returns void when
    // a callback is supplied, so we must strip the callback and call the
    // promise-returning overload instead.
    const forwardFn = (): Promise<unknown> => {
        if (typeof textOrConfig === 'string') {
            // String overload: query(text, values?)
            if (parameters.length > 0) {
                return superQuery(textOrConfig, parameters) as Promise<unknown>;
            }
            return superQuery(textOrConfig) as Promise<unknown>;
        }
        // Config-object overload: query({ text, values }). Values are already
        // inside the config — pass as a single argument.
        return superQuery(textOrConfig) as Promise<unknown>;
    };

    const probePromise = probe.recordQuery({ sql, parameters }, forwardFn);

    if (actualCallback) {
        probePromise.then((result) => actualCallback(null, result)).catch((err) => actualCallback(err));
        return undefined;
    }

    return probePromise;
}

function buildProbedDialectModule(pglite: PGlite, probe: DbProbe) {
    class ProbedClient extends Client {
        constructor(_config: any) {
            super({ pglite });
            (this as any).connection = new EventEmitter();
        }

        connect(callback?: (err: Error | null) => void): any {
            const promise = super.connect();
            if (typeof callback === 'function') {
                promise.then(() => callback(null)).catch((err: Error) => callback(err));
                return undefined;
            }
            return promise;
        }

        end(callback?: (err: Error | null) => void): any {
            const promise = super.end();
            if (typeof callback === 'function') {
                promise.then(() => callback(null)).catch((err: Error) => callback(err));
                return undefined;
            }
            return promise;
        }

        query(textOrConfig: any, valuesOrCallback?: any, callback?: any): any {
            return interceptQuery(probe, super.query.bind(this), textOrConfig, valuesOrCallback, callback);
        }
    }

    class ProbedPool extends Pool {
        constructor(_config: any) {
            super({ pglite, max: 1 });
        }

        query(textOrConfig: any, valuesOrCallback?: any, callback?: any): any {
            return interceptQuery(probe, super.query.bind(this), textOrConfig, valuesOrCallback, callback);
        }
    }

    const types = {
        getTypeParser: () => (value: unknown) => value,
        setTypeParser: () => {},
        arrayParser: {
            create: (_value: string, _parser: (...args: any[]) => any) => ({
                parse: () => _value,
            }),
        },
    };

    return { Client: ProbedClient, Pool: ProbedPool, types };
}

function createProbedPgliteSequelize(
    pglite: PGlite,
    probe: DbProbe,
    extraOptions?: Partial<SequelizeOptions>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    SequelizeCls: new (...args: any[]) => any = Sequelize,
): Sequelize {
    return new SequelizeCls(buildSequelizeConfig(buildProbedDialectModule(pglite, probe), extraOptions));
}

// ── Public factory ────────────────────────────────────────────────────────────

export interface ProbedTestDbOptions {
    /** PGlite extensions to load. See `TestDbOptions.extensions`. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    extensions?: Record<string, any>;
    /**
     * Pre-sync setup: activate extensions, create DB-level functions.
     * Runs before `models` sync and `bootstrap`. See `TestDbOptions.preBootstrap`.
     */
    preBootstrap?: BootstrapFn;
    /** Optional when `models` is provided. */
    bootstrap?: BootstrapFn;
    /** `sequelize-typescript` model classes; auto-registers and syncs tables. Requires `SequelizeClass`. */
    models?: ModelCtor[];
    /** The `Sequelize` class from `sequelize-typescript`. Required when `models` is provided. */
    SequelizeClass?: SequelizeCtor;
    sequelizeOptions?: Partial<SequelizeOptions>;
}

export interface ProbedTestDb extends TestDb {
    readonly probe: DbProbe;
}

export async function createProbedTestDb(options: ProbedTestDbOptions): Promise<ProbedTestDb> {
    if (!options.models?.length && !options.bootstrap) {
        throw new Error(
            'createProbedTestDb: provide at least one of `models` (sequelize-typescript classes) or `bootstrap` (DDL function)',
        );
    }
    if (options.models?.length && !options.SequelizeClass) {
        throw new Error(
            "createProbedTestDb: `SequelizeClass` is required when `models` is provided. Pass `Sequelize` from 'sequelize-typescript'.",
        );
    }

    const pglite = new PGlite(options.extensions ? { extensions: options.extensions } : undefined);
    await pglite.waitReady;
    const probe = new DbProbe();
    const sequelize = createProbedPgliteSequelize(pglite, probe, options.sequelizeOptions, options.SequelizeClass);
    const maintenanceSequelize = createPgliteSequelize(pglite, options.sequelizeOptions, options.SequelizeClass);

    probe.alwaysForward();

    try {
        if (options.preBootstrap) {
            await options.preBootstrap(maintenanceSequelize);
        }
        if (options.models?.length) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (maintenanceSequelize as any).addModels(options.models);
            await syncModels(maintenanceSequelize);
        }
        if (options.bootstrap) {
            await options.bootstrap(maintenanceSequelize);
        }
        // Register models on the probed sequelize so model statics (e.g.
        // Model.findAll) resolve via the probed connection. No sync() here --
        // tables were already created above on the shared PGlite instance.
        if (options.models?.length) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (sequelize as any).addModels(options.models);
        }
    } catch (err) {
        try {
            await sequelize.close();
        } catch {
            /* ignore */
        }
        try {
            await maintenanceSequelize.close();
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
        sequelize,
        probe,

        async reset() {
            await dropAllUserTables(maintenanceSequelize);
            if (options.preBootstrap) {
                await options.preBootstrap(maintenanceSequelize);
            }
            if (options.models?.length) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (maintenanceSequelize as any).addModels(options.models);
                await syncModels(maintenanceSequelize);
            }
            if (options.bootstrap) {
                await options.bootstrap(maintenanceSequelize);
            }
            if (options.models?.length) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (sequelize as any).addModels(options.models);
            }
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

            await maintenanceSequelize.getQueryInterface().bulkInsert(table, prepared);
        },

        async close() {
            try {
                await sequelize.close();
            } catch {
                /* adapter may have already closed PGlite */
            }
            try {
                await maintenanceSequelize.close();
            } catch {
                /* may have already closed */
            }
            try {
                await pglite.close();
            } catch {
                /* may already be closed */
            }
        },
    };
}

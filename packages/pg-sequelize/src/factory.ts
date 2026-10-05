import { Sequelize, type Options as SequelizeOptions } from 'sequelize';
import { type Duration, type Rig, type ProbeRoot, type ProbedAdapterWithLifecycle } from '@hochgi/test-kit';
import {
    createProbedSqlAdapter,
    type QueryCall,
    type QueryPendingCall,
    type QueryProbe,
    type SqlDriver,
} from '@hochgi/test-kit-sql';
import { createPgliteHandle } from '@hochgi/test-kit-pglite-driver';
import {
    buildMaintenanceDialectModule,
    buildProbedDialectModule,
    buildSequelizeConfig,
    dropAllUserTables,
    syncModels,
} from './dialect.js';

export type ModelCtor = abstract new (...args: unknown[]) => unknown;
export type SequelizeCtor = new (...args: unknown[]) => Sequelize;

export interface CreateProbedSequelizeAdapterOptions {
    readonly harness: Rig;
    readonly bootstrap?: (sequelize: Sequelize) => Promise<void>;
    readonly preBootstrap?: (sequelize: Sequelize) => Promise<void>;
    readonly models?: ReadonlyArray<ModelCtor>;
    readonly SequelizeClass?: SequelizeCtor;
    readonly extensions?: Record<string, unknown>;
    readonly sequelizeOptions?: Partial<SequelizeOptions>;
    readonly defaultTimeout?: Duration;
}

export type ProbedSequelizeAdapter = ProbedAdapterWithLifecycle<Sequelize, QueryProbe> & {
    seed(table: string, rows: ReadonlyArray<Record<string, unknown>>): Promise<void>;
};

// eslint-disable-next-line complexity, max-lines-per-function -- existing factory over the published budget; extract on next touch
export async function createProbedSequelizeAdapter(
    options: CreateProbedSequelizeAdapterOptions,
): Promise<ProbedSequelizeAdapter> {
    if (!options.models?.length && !options.bootstrap) {
        throw new Error(
            'createProbedSequelizeAdapter: provide at least one of `models` (sequelize-typescript classes) or `bootstrap` (DDL function).',
        );
    }
    if (options.models?.length && !options.SequelizeClass) {
        throw new Error(
            "createProbedSequelizeAdapter: `SequelizeClass` is required when `models` is provided. Pass `Sequelize` from 'sequelize-typescript'.",
        );
    }

    const handle = await createPgliteHandle({ extensions: options.extensions });

    let probeRoot: ProbeRoot<QueryCall, QueryPendingCall> | null = null;
    const getRoot = (): ProbeRoot<QueryCall, QueryPendingCall> => {
        if (!probeRoot) {
            throw new Error('pg-sequelize: probeRoot accessed before adapter construction completed.');
        }
        return probeRoot;
    };

    const SequelizeCls = options.SequelizeClass ?? Sequelize;

    const probedSequelize = new SequelizeCls(
        buildSequelizeConfig(buildProbedDialectModule(handle.pglite, getRoot), options.sequelizeOptions),
    );
    const maintenanceSequelize = new SequelizeCls(
        buildSequelizeConfig(buildMaintenanceDialectModule(handle.pglite), options.sequelizeOptions),
    );

    const driver: SqlDriver = {
        onApplicationQuery(call) {
            // Sequelize dialect's query intercept calls recordCall directly.
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

    // Bootstrap on the maintenance connection.
    try {
        if (options.preBootstrap) {
            await options.preBootstrap(maintenanceSequelize);
        }
        if (options.models?.length) {
            (
                maintenanceSequelize as unknown as {
                    addModels(models: ReadonlyArray<ModelCtor>): void;
                }
            ).addModels(options.models);
            await syncModels(maintenanceSequelize);
        }
        if (options.bootstrap) {
            await options.bootstrap(maintenanceSequelize);
        }
        // Register models on the probed instance too so model statics resolve
        // through the probe. No sync — tables already exist on shared PGlite.
        if (options.models?.length) {
            (
                probedSequelize as unknown as {
                    addModels(models: ReadonlyArray<ModelCtor>): void;
                }
            ).addModels(options.models);
        }
    } catch (err) {
        try {
            await probedSequelize.close();
        } catch {
            // ignore
        }
        try {
            await maintenanceSequelize.close();
        } catch {
            // ignore
        }
        await handle.close();
        throw err;
    }

    return {
        adapter: probedSequelize,
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
            await maintenanceSequelize.getQueryInterface().bulkInsert(table, prepared);
        },

        async reset() {
            await dropAllUserTables(maintenanceSequelize);
            if (options.preBootstrap) {
                await options.preBootstrap(maintenanceSequelize);
            }
            if (options.models?.length) {
                (
                    maintenanceSequelize as unknown as {
                        addModels(models: ReadonlyArray<ModelCtor>): void;
                    }
                ).addModels(options.models);
                await syncModels(maintenanceSequelize);
            }
            if (options.bootstrap) {
                await options.bootstrap(maintenanceSequelize);
            }
            if (options.models?.length) {
                (
                    probedSequelize as unknown as {
                        addModels(models: ReadonlyArray<ModelCtor>): void;
                    }
                ).addModels(options.models);
            }
        },

        async close() {
            try {
                await probedSequelize.close();
            } catch {
                // ignore
            }
            try {
                await maintenanceSequelize.close();
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

/* eslint-disable max-classes-per-file, @typescript-eslint/no-explicit-any */
import { EventEmitter } from 'node:events';
import type { PGlite } from '@electric-sql/pglite';
import { Client, Pool } from '@middle-management/pglite-pg-adapter';
import { Sequelize, type Options as SequelizeOptions } from 'sequelize';
import type { ProbeRoot } from '@vnatures/test-kit';
import type { QueryCall, QueryPendingCall } from '@vnatures/test-kit-sql';

/**
 * Strip options that must be owned by test-kit.
 */
export function stripConflictingOptions(opts: Partial<SequelizeOptions> | undefined): Partial<SequelizeOptions> {
    if (!opts) return {};
    const {
        dialect: _d,
        dialectModule: _dm,
        dialectOptions: _do,
        host: _h,
        port: _p,
        username: _u,
        password: _pw,
        database: _db,
        ...rest
    } = opts;
    return rest;
}

/**
 * Sequelize options that prevent the Postgres connection manager from sending
 * multi-statement SET queries after connecting. PGlite does not support
 * multiple commands in a single prepared statement.
 */
export const PGLITE_SAFE_OPTIONS = {
    standardConformingStrings: false,
    clientMinMessages: false,
    keepDefaultTimezone: true,
} as Partial<SequelizeOptions>;

export function buildSequelizeConfig(
    dialectModule: unknown,
    extraOptions?: Partial<SequelizeOptions>,
): SequelizeOptions {
    return {
        logging: false,
        ...stripConflictingOptions(extraOptions),
        ...PGLITE_SAFE_OPTIONS,
        dialect: 'postgres',
        dialectModule,
        host: 'localhost',
        port: 5432,
        username: 'test',
        password: 'test',
        database: 'test',
        pool: { max: 1, min: 0, idle: 1000 },
    } as SequelizeOptions;
}

const TYPES_STUB = {
    getTypeParser: () => (value: unknown) => value,
    setTypeParser: () => {},
    arrayParser: {
        create: (value: string) => ({ parse: () => value }),
    },
};

/**
 * Maintenance dialect — un-probed; used for bootstrap/seed/reset.
 */
export function buildMaintenanceDialectModule(pglite: PGlite): unknown {
    class BoundClient extends Client {
        constructor(_config: unknown) {
            super({ pglite });
            // Sequelize accesses `client.connection.on(...)`; the adapter leaves
            // this as a plain object — replace with a no-op EventEmitter.
            (this as unknown as { connection: EventEmitter }).connection = new EventEmitter();
        }

        connect(callback?: (err: Error | null) => void): any {
            const promise = super.connect();
            if (typeof callback === 'function') {
                promise.then(
                    () => callback(null),
                    (e: Error) => callback(e),
                );
                return undefined;
            }
            return promise;
        }

        end(callback?: (err: Error | null) => void): any {
            const promise = super.end();
            if (typeof callback === 'function') {
                promise.then(
                    () => callback(null),
                    (e: Error) => callback(e),
                );
                return undefined;
            }
            return promise;
        }
    }

    class BoundPool extends Pool {
        constructor(_config: unknown) {
            super({ pglite, max: 1 });
        }
    }

    return { Client: BoundClient, Pool: BoundPool, types: TYPES_STUB };
}

/**
 * Probed dialect — every query() goes through the probeRoot.
 */
export function buildProbedDialectModule(
    pglite: PGlite,
    getRoot: () => ProbeRoot<QueryCall, QueryPendingCall>,
): unknown {
    function interceptQuery(
        superQuery: (...args: unknown[]) => unknown,
        textOrConfig: unknown,
        valuesOrCallback?: unknown,
        callback?: unknown,
    ): unknown {
        let sql: string;
        let parameters: ReadonlyArray<unknown>;

        if (typeof textOrConfig === 'string') {
            sql = textOrConfig;
            parameters = Array.isArray(valuesOrCallback) ? valuesOrCallback : [];
        } else if (textOrConfig !== null && typeof textOrConfig === 'object' && 'text' in textOrConfig) {
            const cfg = textOrConfig as { text: string; values?: ReadonlyArray<unknown> };
            sql = cfg.text;
            parameters = cfg.values ?? [];
        } else {
            // Pass through anything we don't recognize.
            return superQuery(textOrConfig, valuesOrCallback, callback);
        }

        let actualCallback: ((...args: unknown[]) => void) | undefined;
        if (typeof valuesOrCallback === 'function') {
            actualCallback = valuesOrCallback as (...args: unknown[]) => void;
        } else if (typeof callback === 'function') {
            actualCallback = callback as (...args: unknown[]) => void;
        }

        const forwardFn = (): Promise<unknown> => {
            if (typeof textOrConfig === 'string') {
                if (parameters.length > 0) {
                    return superQuery(textOrConfig, parameters) as Promise<unknown>;
                }
                return superQuery(textOrConfig) as Promise<unknown>;
            }
            return superQuery(textOrConfig) as Promise<unknown>;
        };

        const probePromise = getRoot().recordCall({ sql, parameters }, forwardFn);

        if (actualCallback) {
            probePromise.then(
                (result) => actualCallback(null, result),
                (e: unknown) => actualCallback(e),
            );
            return undefined;
        }
        return probePromise;
    }

    class ProbedClient extends Client {
        constructor(_config: unknown) {
            super({ pglite });
            (this as unknown as { connection: EventEmitter }).connection = new EventEmitter();
        }

        connect(callback?: (err: Error | null) => void): any {
            const promise = super.connect();
            if (typeof callback === 'function') {
                promise.then(
                    () => callback(null),
                    (e: Error) => callback(e),
                );
                return undefined;
            }
            return promise;
        }

        end(callback?: (err: Error | null) => void): any {
            const promise = super.end();
            if (typeof callback === 'function') {
                promise.then(
                    () => callback(null),
                    (e: Error) => callback(e),
                );
                return undefined;
            }
            return promise;
        }

        query(textOrConfig: any, valuesOrCallback?: any, callback?: any): any {
            return interceptQuery(
                super.query.bind(this) as (...args: unknown[]) => unknown,
                textOrConfig,
                valuesOrCallback,
                callback,
            );
        }
    }

    class ProbedPool extends Pool {
        constructor(_config: unknown) {
            super({ pglite, max: 1 });
        }

        query(textOrConfig: any, valuesOrCallback?: any, callback?: any): any {
            return interceptQuery(
                super.query.bind(this) as (...args: unknown[]) => unknown,
                textOrConfig,
                valuesOrCallback,
                callback,
            );
        }
    }

    return { Client: ProbedClient, Pool: ProbedPool, types: TYPES_STUB };
}

/**
 * Sync model tables on a PGlite-backed Sequelize instance. Sequelize's
 * sync() unconditionally calls `showIndex` after creating each table; PGlite
 * returns array columns as JS arrays which Sequelize then crashes on.
 * Stubbing showIndex to return [] is safe against a fresh PGlite (no
 * pre-existing indexes).
 */
export async function syncModels(sequelize: Sequelize): Promise<void> {
    const qi = sequelize.getQueryInterface();
    const originalShowIndex = qi.showIndex.bind(qi);
    qi.showIndex = (async () => []) as unknown as typeof qi.showIndex;
    try {
        await sequelize.sync({ force: false, alter: false });
    } finally {
        qi.showIndex = originalShowIndex;
    }
}

/**
 * Drop all user-created tables and enum types in the public schema.
 */
export async function dropAllUserTables(sequelize: Sequelize): Promise<void> {
    const [tables] = await sequelize.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
    const tableNames = (tables as Array<{ tablename: string }>).map((r) => r.tablename);
    if (tableNames.length > 0) {
        const list = tableNames.map((n) => `"${n.replace(/"/g, '""')}"`).join(', ');
        await sequelize.query(`DROP TABLE IF EXISTS ${list} CASCADE`);
    }

    const [enumTypes] = await sequelize.query(
        `SELECT typname FROM pg_type JOIN pg_namespace ON pg_namespace.oid = pg_type.typnamespace WHERE typcategory = 'E' AND nspname = 'public'`,
    );
    const enumNames = (enumTypes as Array<{ typname: string }>).map((r) => r.typname);
    if (enumNames.length > 0) {
        const list = enumNames.map((n) => `"public"."${n.replace(/"/g, '""')}"`).join(', ');
        await sequelize.query(`DROP TYPE IF EXISTS ${list} CASCADE`);
    }
}

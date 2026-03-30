/* eslint-disable max-classes-per-file */
import { EventEmitter } from 'events';
import { PGlite } from '@electric-sql/pglite';
import { Client, Pool } from '@middle-management/pglite-pg-adapter';
import { Sequelize, type Options as SequelizeOptions } from 'sequelize';

export type BootstrapFn = (sequelize: Sequelize) => Promise<void>;

/**
 * A `sequelize-typescript` model class. Typed loosely so this package does not
 * need `sequelize-typescript` as a peer dependency -- `sequelize-typescript`'s
 * `ModelCtor` is assignable to this type.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ModelCtor = abstract new (...args: any[]) => any;

/**
 * A constructor for a Sequelize class that supports `addModels()`.
 * Accepts the `Sequelize` class from `sequelize-typescript` (which extends
 * plain `Sequelize` and has multiple constructor overloads).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SequelizeCtor = new (...args: any[]) => any;

export interface TestDbOptions {
    /**
     * PGlite extensions to load at database construction time.
     * Pass extension objects from `@electric-sql/pglite/contrib/*` or other
     * PGlite extension packages. Extensions are loaded before any SQL runs.
     *
     * After loading, you still need `CREATE EXTENSION IF NOT EXISTS "..."` to
     * activate them -- use `preBootstrap` for that.
     *
     * ```typescript
     * import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
     *
     * createTestDb({
     *     extensions: { uuid_ossp },
     *     preBootstrap: async (seq) => {
     *         await seq.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
     *     },
     *     models: [...],
     *     SequelizeClass: Sequelize,
     * });
     * ```
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    extensions?: Record<string, any>;
    /**
     * Pre-sync setup: activate extensions, create DB-level functions, or any
     * DDL that model tables depend on.
     * Called once at creation and again before each `reset()` re-sync.
     * Should be idempotent (use `CREATE OR REPLACE` / `IF NOT EXISTS`).
     *
     * Runs BEFORE `models` sync and `bootstrap`.
     */
    preBootstrap?: BootstrapFn;
    /**
     * DDL bootstrap: create tables, indexes, etc.
     * Called once at creation and again after each reset.
     * Should be idempotent (use IF NOT EXISTS).
     *
     * Optional when `models` is provided -- tables are created via
     * `sequelize.sync()` from decorator metadata. Use `bootstrap` alongside
     * `models` to create extensions, extra indexes, or to seed fixed data.
     */
    bootstrap?: BootstrapFn;
    /**
     * `sequelize-typescript` model classes to register on the Sequelize
     * instance via `addModels()`. When provided, tables are created
     * automatically from decorator metadata before `bootstrap` runs.
     *
     * Requires `SequelizeClass` to be provided alongside `models`.
     *
     * At least one of `models` or `bootstrap` must be provided.
     */
    models?: ModelCtor[];
    /**
     * The `Sequelize` class from `sequelize-typescript`. Required when
     * `models` is provided so that `addModels()` is available on the instance.
     *
     * ```typescript
     * import { Sequelize } from 'sequelize-typescript';
     * createTestDb({ models: Object.values(Models), SequelizeClass: Sequelize });
     * ```
     */
    SequelizeClass?: SequelizeCtor;
    /**
     * Extra Sequelize options merged into the internal config (e.g. `define`,
     * `hooks`, `logging`). `dialect`, `dialectModule`, and connection fields
     * (`host`, `port`, `username`, `password`, `database`) are owned by
     * test-kit and will be overridden.
     */
    sequelizeOptions?: Partial<SequelizeOptions>;
}

/** @internal Strip options that must be owned by test-kit. */
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
 * Build a `dialectModule` whose `Client` / `Pool` classes close over the given
 * PGlite instance.
 *
 * Sequelize's ConnectionManager calls `_.cloneDeep(sequelize.config)`, which
 * breaks on PGlite internals (huge typed arrays). By closing over `pglite`
 * instead of passing it through `dialectOptions`, the instance is never visible
 * to lodash.
 *
 * The Postgres connection manager creates a client with
 * `new this.lib.Client(connectionConfig)`. Our subclass ignores the config
 * Sequelize passes and uses the closed-over PGlite.
 *
 * @internal
 */
function buildDialectModule(pglite: PGlite) {
    class BoundClient extends Client {
        constructor(_config: any) {
            super({ pglite });
            // Sequelize's Postgres connection manager accesses `client.connection`
            // and calls `.on('parameterStatus', ...)` / `.removeListener(...)` on it.
            // The adapter leaves `connection` as a plain object (`{}`). We replace it
            // with a no-op EventEmitter so those calls don't throw.
            (this as any).connection = new EventEmitter();
        }

        // Sequelize's Postgres connection manager calls `client.connect(cb)` and
        // `promisify(cb => connection.end(cb))()` -- both expect Node-style
        // callbacks, but the adapter only supports the promise form. Bridge them.
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
    }

    class BoundPool extends Pool {
        constructor(_config: any) {
            super({ pglite, max: 1 });
        }
    }

    // Sequelize's Postgres connection manager accesses `this.lib.types` for
    // type parsing. Provide a minimal stub that returns values as-is.
    const types = {
        getTypeParser: () => (value: unknown) => value,
        setTypeParser: () => {},
        arrayParser: {
            create: (_value: string, _parser: (...args: any[]) => any) => ({
                parse: () => _value,
            }),
        },
    };

    return { Client: BoundClient, Pool: BoundPool, types };
}

/**
 * Sequelize options that prevent the Postgres connection manager from sending
 * multi-statement SET queries after connecting. PGlite does not support
 * multiple commands in a single prepared statement.
 *
 * @internal Exported for reuse in db-probe.ts.
 */
export const PGLITE_SAFE_OPTIONS = {
    standardConformingStrings: false,
    clientMinMessages: false,
    keepDefaultTimezone: true,
} as Partial<SequelizeOptions>;

/**
 * Build the full Sequelize options object for a PGlite-backed instance.
 * Merges user options, PGlite-safe defaults, and the dialect module.
 * `logging` defaults to `false` but can be overridden via `extraOptions`.
 *
 * @internal Exported for reuse in db-probe.ts.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildSequelizeConfig(dialectModule: any, extraOptions?: Partial<SequelizeOptions>): SequelizeOptions {
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

/**
 * Create a Sequelize instance backed by PGlite via the pg-adapter dialectModule.
 * @internal
 */
export function createPgliteSequelize(
    pglite: PGlite,
    extraOptions?: Partial<SequelizeOptions>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    SequelizeCls: new (...args: any[]) => any = Sequelize,
): Sequelize {
    return new SequelizeCls(buildSequelizeConfig(buildDialectModule(pglite), extraOptions));
}

/**
 * Sync model tables on a PGlite-backed Sequelize instance.
 *
 * Sequelize's `sync()` unconditionally calls `showIndex` after creating each
 * table. The `showIndex` query returns PG array columns (`array_agg`,
 * `int2vector`) that PGlite returns as JS typed/regular arrays rather than
 * Postgres text-protocol strings. Sequelize's result processor calls
 * `.split()` and `fromArray()` on these values, which crashes.
 *
 * Since we always sync against a fresh PGlite (no pre-existing indexes),
 * stubbing `showIndex` to return `[]` is safe -- Sequelize will create all
 * model-defined indexes via `addIndex`, and PK indexes are created by
 * `CREATE TABLE` itself.
 *
 * @internal
 */
export async function syncModels(sequelize: Sequelize): Promise<void> {
    const qi = sequelize.getQueryInterface();
    const originalShowIndex = qi.showIndex.bind(qi);
    // PGlite returns index metadata columns (`array_agg`, `int2vector`) as JS
    // arrays rather than Postgres text-protocol strings. Sequelize's
    // `fromArray()` helper calls `.split()` on these values and crashes.
    // Since we always sync against a fresh PGlite (no pre-existing indexes),
    // returning an empty array is safe -- Sequelize will create all
    // model-defined indexes via `addIndex`.
    // eslint-disable-next-line @typescript-eslint/require-await
    qi.showIndex = async () => [];
    try {
        await sequelize.sync({ force: false, alter: false });
    } finally {
        qi.showIndex = originalShowIndex;
    }
}

/**
 * Drop all user-created tables and enum types in the public schema.
 *
 * Tables are dropped first (CASCADE handles FK constraints). Enum types are
 * dropped after tables to avoid FK-owned enum references. Both must be cleaned
 * up between test resets so that `sequelize.sync()` starts from a clean slate
 * on each `reset()` call.
 *
 * @internal
 */
export async function dropAllUserTables(sequelize: Sequelize): Promise<void> {
    const [tables] = await sequelize.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
    const tableNames = (tables as Array<{ tablename: string }>).map((r) => r.tablename);
    if (tableNames.length > 0) {
        const tableList = tableNames.map((n) => `"${n.replace(/"/g, '""')}"`).join(', ');
        await sequelize.query(`DROP TABLE IF EXISTS ${tableList} CASCADE`);
    }

    // Drop user-created enum types so they are re-created cleanly on next sync.
    const [enumTypes] = await sequelize.query(
        `SELECT typname FROM pg_type JOIN pg_namespace ON pg_namespace.oid = pg_type.typnamespace WHERE typcategory = 'E' AND nspname = 'public'`,
    );
    const enumNames = (enumTypes as Array<{ typname: string }>).map((r) => r.typname);
    if (enumNames.length > 0) {
        const enumList = enumNames.map((n) => `"public"."${n.replace(/"/g, '""')}"`).join(', ');
        await sequelize.query(`DROP TYPE IF EXISTS ${enumList} CASCADE`);
    }
}

export interface TestDb {
    /** Sequelize instance wired to the in-memory PGlite database. */
    readonly sequelize: Sequelize;

    /**
     * Drop all user tables and re-run the bootstrap.
     * Gives each test (or describe block) a clean slate.
     */
    reset(): Promise<void>;

    /**
     * Insert seed rows into a table.
     * Convenience wrapper around `queryInterface.bulkInsert`; serializes
     * objects/arrays to JSON for JSONB columns automatically.
     */
    seed(table: string, rows: ReadonlyArray<Record<string, unknown>>): Promise<void>;

    /** Close the Sequelize connection and the underlying PGlite database. */
    close(): Promise<void>;
}

export async function createTestDb(options: TestDbOptions): Promise<TestDb> {
    if (!options.models?.length && !options.bootstrap) {
        throw new Error(
            'createTestDb: provide at least one of `models` (sequelize-typescript classes) or `bootstrap` (DDL function)',
        );
    }
    if (options.models?.length && !options.SequelizeClass) {
        throw new Error(
            "createTestDb: `SequelizeClass` is required when `models` is provided. Pass `Sequelize` from 'sequelize-typescript'.",
        );
    }

    const pglite = new PGlite(options.extensions ? { extensions: options.extensions } : undefined);
    await pglite.waitReady;
    const sequelize = createPgliteSequelize(pglite, options.sequelizeOptions, options.SequelizeClass);

    try {
        if (options.preBootstrap) {
            await options.preBootstrap(sequelize);
        }
        if (options.models?.length) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (sequelize as any).addModels(options.models);
            await syncModels(sequelize);
        }
        if (options.bootstrap) {
            await options.bootstrap(sequelize);
        }
    } catch (err) {
        try {
            await sequelize.close();
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

        async reset() {
            await dropAllUserTables(sequelize);
            if (options.preBootstrap) {
                await options.preBootstrap(sequelize);
            }
            if (options.models?.length) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (sequelize as any).addModels(options.models);
                await syncModels(sequelize);
            }
            if (options.bootstrap) {
                await options.bootstrap(sequelize);
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

            await sequelize.getQueryInterface().bulkInsert(table, prepared);
        },

        async close() {
            try {
                await sequelize.close();
            } catch {
                /* adapter may have already closed PGlite */
            }
            try {
                await pglite.close();
            } catch {
                /* may already be closed */
            }
        },
    };
}

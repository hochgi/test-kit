import { createPool, type Pool as Mysql2Pool } from 'mysql2/promise';
import { MySqlContainer } from '@testcontainers/mysql';
import { type ProbeRoot } from '@vnatures/test-kit';
import { createProbedSqlAdapter, type QueryCall, type QueryPendingCall, type SqlDriver } from '@vnatures/test-kit-sql';
import type {
    CreateProbedMysqlAdapterOptions,
    MaintenancePool,
    MysqlAdapter,
    MysqlContainerInfo,
    ProbedMysqlAdapter,
} from './types.js';

/** Internal call type that extends QueryCall with a protocol discriminator. */
interface MysqlQueryCall extends QueryCall {
    readonly protocol: 'execute' | 'query';
}

export async function createProbedMysqlAdapter(options: CreateProbedMysqlAdapterOptions): Promise<ProbedMysqlAdapter> {
    // ── Start the container ────────────────────────────────────────────
    const database = options.database ?? 'testdb';
    const username = options.username ?? 'testuser';
    const password = options.password ?? 'testpass';
    const container = new MySqlContainer(options.image ?? 'mysql:8.0')
        .withDatabase(database)
        .withUsername(username)
        .withUserPassword(password);
    const started = await container.start();

    const connectionUri = started.getConnectionUri();
    const containerInfo: MysqlContainerInfo = {
        host: started.getHost(),
        port: started.getPort(),
        database: started.getDatabase(),
        username: started.getUsername(),
        password: started.getUserPassword(),
        connectionUri,
    };

    // ── Create pools ───────────────────────────────────────────────────
    // Application pool — queries go through the probe.
    const appPool = createPool({ uri: connectionUri, multipleStatements: false });
    // Maintenance pool — bypasses the probe for bootstrap/seed/reset.
    const maintenancePool = createPool({ uri: connectionUri, multipleStatements: true });

    const maintenance: MaintenancePool = {
        async execute<T = unknown>(sql: string, params?: ReadonlyArray<unknown>): Promise<[T, unknown[]]> {
            const [result, fields] = await maintenancePool.execute(sql, params as unknown[] as never);
            return [result as T, fields as unknown[]];
        },
        async query<T = unknown>(sql: string, params?: ReadonlyArray<unknown>): Promise<[T, unknown[]]> {
            const [result, fields] = await maintenancePool.query(sql, params as unknown[] as never);
            return [result as T, fields as unknown[]];
        },
    };

    // ── Wire the SqlDriver / probeRoot ─────────────────────────────────
    let probeRoot: ProbeRoot<QueryCall, QueryPendingCall> | null = null;
    const getRoot = (): ProbeRoot<QueryCall, QueryPendingCall> => {
        if (!probeRoot) {
            throw new Error('test-kit-mysql: probeRoot accessed before adapter construction completed.');
        }
        return probeRoot;
    };

    const driver = createMysqlSqlDriver(appPool, maintenancePool, maintenance, getRoot, options.bootstrap);
    const sqlAdapter = createProbedSqlAdapter({
        harness: options.harness,
        defaultTimeout: options.defaultTimeout,
        driver,
    });
    probeRoot = sqlAdapter.probeRoot;

    // ── Bootstrap on the maintenance pool ──────────────────────────────
    try {
        await options.bootstrap(maintenance);
    } catch (err) {
        try {
            await appPool.end();
        } catch {
            // ignore
        }
        try {
            await maintenancePool.end();
        } catch {
            // ignore
        }
        // The probe root is registered before bootstrap runs, so a bootstrap
        // failure must dispose it too — otherwise the harness leaks probe state
        // even though adapter construction failed.
        probeRoot?.dispose();
        await started.stop();
        throw err;
    }

    // ── Build the probed adapter ───────────────────────────────────────
    const adapter: MysqlAdapter = {
        async execute<T = unknown>(sql: string, params?: ReadonlyArray<unknown>): Promise<[T, unknown[]]> {
            const call: MysqlQueryCall = { sql, parameters: params ? [...params] : [], protocol: 'execute' };
            const result = await driver.onApplicationQuery(call);
            return result as [T, unknown[]];
        },
        async query<T = unknown>(sql: string, params?: ReadonlyArray<unknown>): Promise<[T, unknown[]]> {
            const call: MysqlQueryCall = { sql, parameters: params ? [...params] : [], protocol: 'query' };
            const result = await driver.onApplicationQuery(call);
            return result as [T, unknown[]];
        },
    };

    return {
        adapter,
        probe: sqlAdapter.probe,
        container: containerInfo,

        async seed(table: string, rows: ReadonlyArray<Record<string, unknown>>): Promise<void> {
            await seedInto(maintenance, table, rows);
        },

        async reset() {
            await driver.reset();
        },

        async close() {
            await driver.close();
            probeRoot?.dispose();
            await started.stop();
        },
    };
}

// ── SqlDriver implementation ───────────────────────────────────────────

function createMysqlSqlDriver(
    appPool: Mysql2Pool,
    maintenancePool: Mysql2Pool,
    maintenance: MaintenancePool,
    getRoot: () => ProbeRoot<QueryCall, QueryPendingCall>,
    bootstrap: (maintenance: MaintenancePool) => Promise<void>,
): SqlDriver {
    return {
        onApplicationQuery(call: QueryCall): Promise<unknown> {
            const protocol = (call as MysqlQueryCall).protocol ?? 'execute';
            return getRoot().recordCall(call, async () => {
                if (protocol === 'query') {
                    // Text protocol (mysql2 `query`): supports statements that
                    // can't be prepared (e.g. multi-statements, some DDL).
                    const [result, fields] = await appPool.query(call.sql, call.parameters as unknown[] as never);
                    return [result, fields];
                }
                // Prepared/binary protocol (mysql2 `execute`).
                const [result, fields] = await appPool.execute(call.sql, call.parameters as unknown[] as never);
                return [result, fields];
            });
        },

        async reset(): Promise<void> {
            await truncateAllUserTables(maintenancePool);
            await bootstrap(maintenance);
        },

        async close(): Promise<void> {
            try {
                await appPool.end();
            } catch {
                // ignore
            }
            try {
                await maintenancePool.end();
            } catch {
                // ignore
            }
        },
    };
}

// ── Helpers ────────────────────────────────────────────────────────────

async function truncateAllUserTables(pool: Mysql2Pool): Promise<void> {
    // Disable FK checks during truncation to avoid ordering issues.
    await pool.query('SET FOREIGN_KEY_CHECKS = 0');
    try {
        const [rows] = await pool.query(
            `SELECT table_name AS t
             FROM information_schema.tables
             WHERE table_schema = DATABASE()
               AND table_type = 'BASE TABLE'`,
        );
        const tableNames = (rows as Array<{ t: string }>).map((r) => r.t);
        for (const table of tableNames) {
            // TRUNCATE is not parameterised — table names are from the DB
            // catalog, not user input.
            await pool.query(`TRUNCATE TABLE \`${table}\``);
        }
    } finally {
        await pool.query('SET FOREIGN_KEY_CHECKS = 1');
    }
}

async function seedInto(
    maintenance: MaintenancePool,
    table: string,
    rows: ReadonlyArray<Record<string, unknown>>,
): Promise<void> {
    if (rows.length === 0) return;

    const columns = Object.keys(rows[0]);
    if (columns.length === 0) return;

    // Require a uniform row shape: seedInto builds a single multi-row INSERT
    // from the first row's columns, so heterogeneous rows would silently drop
    // extra fields or insert `undefined` for missing ones. Fail fast instead.
    const expected = new Set(columns);
    for (let i = 1; i < rows.length; i += 1) {
        const keys = Object.keys(rows[i]);
        if (keys.length !== columns.length || keys.some((k) => !expected.has(k))) {
            throw new Error(
                `test-kit-mysql seed(${JSON.stringify(table)}): every row must have the same columns. ` +
                    `Row 0 has [${columns.join(', ')}] but row ${i} has [${keys.join(', ')}].`,
            );
        }
    }

    const placeholders = columns.map(() => '?').join(', ');
    const columnList = columns.map((c) => `\`${c}\``).join(', ');
    const valueGroups = rows.map(() => `(${placeholders})`).join(', ');

    const params: unknown[] = [];
    for (const row of rows) {
        for (const col of columns) {
            params.push(serializeValue(row[col]));
        }
    }

    // Table name is trusted (from test code), not user input.
    await maintenance.query(`INSERT INTO \`${table}\` (${columnList}) VALUES ${valueGroups}`, params);
}

function serializeValue(value: unknown): unknown {
    if (value !== null && typeof value === 'object' && !Buffer.isBuffer(value) && !(value instanceof Date)) {
        return JSON.stringify(value);
    }
    return value;
}

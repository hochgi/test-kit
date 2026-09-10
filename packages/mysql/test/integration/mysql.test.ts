/**
 * @vnatures/test-kit-mysql — acceptance tests.
 *
 * Uses a real MySQL 8 Testcontainer (requires Docker). The entire suite
 * is skipped via `describe.skipIf` when Docker is not reachable.
 *
 * One container is started in `beforeAll` and reused across tests; `reset()`
 * truncates user tables and re-runs bootstrap between each test.
 *
 * Mirrors the assertion style in packages/pg-kysely/test/integration/probe.test.ts.
 *
 * Acceptance (from the brief):
 *  1. A probed INSERT/SELECT round-trips through a real MySQL 8 container.
 *  2. The probe intercepts and can reject a query (simulating a DB error).
 *  3. reset() truncates user tables and re-runs bootstrap.
 *  4. seed() inserts rows via the maintenance pool (bypassing the probe).
 *  5. The probe sees every application query with sql + parameters.
 */
import { execSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRig, type Rig } from '@vnatures/test-kit';
import { createProbedMysqlAdapter, type ProbedMysqlAdapter } from '@vnatures/test-kit-mysql';

// Evaluate Docker availability once at module load for describe.skipIf.
function dockerAvailable(): boolean {
    try {
        execSync('docker info', { stdio: 'ignore', timeout: 5_000 });
        return true;
    } catch {
        return false;
    }
}

const hasDocker = dockerAvailable();

// eslint-disable-next-line max-lines-per-function -- existing test suite over the published budget; extract on next touch
describe.skipIf(!hasDocker)('createProbedMysqlAdapter', () => {
    let rig: Rig;
    let mysql: ProbedMysqlAdapter;

    // Start ONE container for the whole suite.
    beforeAll(async () => {
        rig = createRig();
        mysql = await rig.attach(
            createProbedMysqlAdapter({
                harness: rig,
                async bootstrap(maintenance) {
                    await maintenance.execute(
                        `CREATE TABLE IF NOT EXISTS users (
                            id    INT AUTO_INCREMENT PRIMARY KEY,
                            name  VARCHAR(255) NOT NULL,
                            email VARCHAR(255) NOT NULL
                        )`,
                    );
                },
            }),
        );
    });

    afterAll(async () => {
        await rig.close();
    });

    // Clear probe state + truncate/re-bootstrap between tests.
    afterEach(async () => {
        await rig.reset();
    });

    it('round-trips INSERT → SELECT through a real MySQL 8 container', async () => {
        await mysql.adapter.execute('INSERT INTO users (name, email) VALUES (?, ?)', ['Alice', 'alice@example.com']);

        const [rows] = await mysql.adapter.query<
            {
                id: number;
                name: string;
                email: string;
            }[]
        >('SELECT id, name, email FROM users ORDER BY id');

        expect(rows).toHaveLength(1);
        expect(rows[0].name).toBe('Alice');
        expect(rows[0].email).toBe('alice@example.com');
    });

    it('probe sees every application query with sql and parameters', async () => {
        await mysql.adapter.execute('INSERT INTO users (name, email) VALUES (?, ?)', ['Bob', 'bob@example.com']);
        await mysql.adapter.query('SELECT * FROM users');

        expect(mysql.probe.calls).toHaveLength(2);
        expect(mysql.probe.calls[0].sql).toContain('INSERT INTO users');
        expect(mysql.probe.calls[0].parameters).toEqual(['Bob', 'bob@example.com']);
        expect(mysql.probe.calls[1].sql).toContain('SELECT * FROM users');
    });

    it('probe.sql(match) narrows by SQL text', async () => {
        await mysql.adapter.execute('INSERT INTO users (name, email) VALUES (?, ?)', ['Carol', 'carol@example.com']);
        await mysql.adapter.query('SELECT * FROM users');

        const inserts = mysql.probe.sql('INSERT INTO users (name, email) VALUES (?, ?)');
        expect(inserts.calls).toHaveLength(1);

        const selects = mysql.probe.sql(/SELECT/);
        expect(selects.calls).toHaveLength(1);
    });

    it('seed() rejects heterogeneous row shapes instead of silently dropping fields', async () => {
        await expect(
            mysql.seed('users', [
                { name: 'Dave', email: 'dave@example.com' },
                { name: 'Erin' }, // missing `email` — different shape
            ]),
        ).rejects.toThrow(/every row must have the same columns/);
    });

    it('probe reject simulates a DB error', async () => {
        mysql.probe
            .sql(/INSERT/)
            .once()
            .reject(new Error('connection lost'));

        await expect(
            mysql.adapter.execute('INSERT INTO users (name, email) VALUES (?, ?)', ['Dave', 'dave@example.com']),
        ).rejects.toThrow('connection lost');

        // The rejected insert did not reach the DB.
        const [rows] = await mysql.adapter.query<{ count: number }[]>('SELECT COUNT(*) AS count FROM users');
        expect(rows[0].count).toBe(0);
    });

    it('probe intercept can park and then forward', async () => {
        mysql.probe
            .sql(/INSERT/)
            .always()
            .park();

        const pendingPromise = mysql.probe.sql(/INSERT/).expect.intercept();
        const insertPromise = mysql.adapter.execute('INSERT INTO users (name, email) VALUES (?, ?)', [
            'Eve',
            'eve@example.com',
        ]);

        const pending = await pendingPromise;
        expect(pending.sql).toContain('INSERT INTO users');
        expect(pending.parameters).toEqual(['Eve', 'eve@example.com']);
        pending.forward();

        await insertPromise;
        const [rows] = await mysql.adapter.query<{ name: string }[]>('SELECT name FROM users');
        expect(rows.map((r) => r.name)).toEqual(['Eve']);
    });

    it('seed() inserts rows via the maintenance pool (bypassing the probe)', async () => {
        await mysql.seed('users', [
            { name: 'Frank', email: 'frank@example.com' },
            { name: 'Grace', email: 'grace@example.com' },
        ]);

        // seed bypasses the probe — no calls recorded (reset already ran
        // in beforeEach, clearing probe state).
        expect(mysql.probe.calls).toHaveLength(0);

        const [rows] = await mysql.adapter.query<{ name: string }[]>('SELECT name FROM users ORDER BY id');
        expect(rows.map((r) => r.name)).toEqual(['Frank', 'Grace']);
    });

    it('reset() truncates user tables and re-runs bootstrap', async () => {
        await mysql.adapter.execute('INSERT INTO users (name, email) VALUES (?, ?)', ['Heidi', 'heidi@example.com']);
        const [before] = await mysql.adapter.query<{ count: number }[]>('SELECT COUNT(*) AS count FROM users');
        expect(before[0].count).toBe(1);

        await mysql.reset();

        const [after] = await mysql.adapter.query<{ count: number }[]>('SELECT COUNT(*) AS count FROM users');
        expect(after[0].count).toBe(0);
    });

    it('container metadata is exposed', async () => {
        expect(mysql.container.host).toBeTruthy();
        expect(mysql.container.port).toBeGreaterThan(0);
        expect(mysql.container.database).toBe('testdb');
        expect(mysql.container.username).toBe('testuser');
        expect(mysql.container.connectionUri).toContain('mysql://');
    });

    it('adapter.query() uses the text protocol, not the prepared protocol (M4)', async () => {
        // SHOW TABLES is not preparable via mysql2's execute() on MySQL 8
        // — it returns ER_UNSUPPORTED_PS. The text query() protocol handles
        // it fine. This proves query() routes through appPool.query(), not
        // appPool.execute().
        const [rows] = await mysql.adapter.query<Array<{ [k: string]: unknown }>>("SHOW TABLES LIKE 'users'");

        // The 'users' table should appear in the result.
        expect(rows.length).toBeGreaterThanOrEqual(1);

        // query() with placeholders also works (text protocol escapes them).
        await mysql.adapter.execute('INSERT INTO users (name, email) VALUES (?, ?)', ['QueryTest', 'qt@example.com']);
        const [found] = await mysql.adapter.query<{ name: string }[]>('SELECT name FROM users WHERE email = ?', [
            'qt@example.com',
        ]);
        expect(found[0].name).toBe('QueryTest');
    });
});

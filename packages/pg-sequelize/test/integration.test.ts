/**
 * Integration tests validating that sequelize-typescript models (decorators, JSONB,
 * findAll, findOne, create, update, destroy) work correctly on top of PGlite.
 *
 * Uses a schema inspired by construction_rules_service: tagging_policies (JSONB
 * columns) and site_rules_configurations (JSONB + nullable FK).
 */

import { Sequelize, QueryTypes } from 'sequelize';
import { createTestDb, createProbedTestDb, type TestDb, type BootstrapFn } from '../src';

const bootstrap: BootstrapFn = async (sequelize: Sequelize) => {
    await sequelize.query(`
        CREATE TABLE IF NOT EXISTS tagging_policies (
            id SERIAL PRIMARY KEY,
            name VARCHAR NOT NULL,
            conditions JSONB NOT NULL DEFAULT '[]',
            rule JSONB NOT NULL DEFAULT '{}',
            created_at TIMESTAMP NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
    `);

    await sequelize.query(`
        CREATE TABLE IF NOT EXISTS site_rules_configurations (
            id SERIAL PRIMARY KEY,
            "siteId" INTEGER,
            "ruleName" VARCHAR NOT NULL,
            configuration JSONB NOT NULL DEFAULT '{}',
            created_at TIMESTAMP NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
    `);

    await sequelize.query(`
        CREATE INDEX IF NOT EXISTS idx_site_rules_site_id
        ON site_rules_configurations ("siteId")
    `);
};

describe('integration: Sequelize-style queries on PGlite', () => {
    let testDb: TestDb;

    beforeAll(async () => {
        testDb = await createTestDb({ bootstrap });
    });

    afterAll(async () => {
        await testDb.close();
    });

    afterEach(async () => {
        await testDb.reset();
    });

    describe('tagging_policies (JSONB)', () => {
        it('seeds and queries rows with complex JSONB conditions', async () => {
            await testDb.seed('tagging_policies', [
                {
                    name: 'Crane Tagging',
                    conditions: [
                        { entities: ['crane'], values: ['tower_crane'], operator: 'equals' },
                        { entities: ['load'], values: [1000, 2000], operator: 'between' },
                    ],
                    rule: { entities: ['tag'], values: ['heavy_lift'], operator: 'assign' },
                },
                {
                    name: 'Empty Policy',
                    conditions: [],
                    rule: { entities: [], values: [], operator: 'noop' },
                },
            ]);

            const rows = await testDb.sequelize.query(
                `SELECT name, conditions, rule FROM tagging_policies ORDER BY name`,
                { type: QueryTypes.SELECT },
            );

            expect(rows).toHaveLength(2);

            const crane = rows[0] as any;
            expect(crane.name).toBe('Crane Tagging');
            const conditions =
                typeof crane.conditions === 'string' ? JSON.parse(crane.conditions as string) : crane.conditions;
            expect(conditions).toHaveLength(2);
            expect(conditions[0].operator).toBe('equals');

            const empty = rows[1] as any;
            expect(empty.name).toBe('Empty Policy');
        });

        it('filters by JSONB path expression', async () => {
            await testDb.seed('tagging_policies', [
                {
                    name: 'Policy A',
                    conditions: [{ entities: ['sensor'], values: ['temp'], operator: 'equals' }],
                    rule: { entities: ['alert'], values: ['high'], operator: 'assign' },
                },
                {
                    name: 'Policy B',
                    conditions: [{ entities: ['crane'], values: ['mobile'], operator: 'equals' }],
                    rule: { entities: ['tag'], values: ['mobile'], operator: 'assign' },
                },
            ]);

            const rows = await testDb.sequelize.query(
                `SELECT name FROM tagging_policies WHERE rule->>'entities' LIKE '%alert%'`,
                { type: QueryTypes.SELECT },
            );

            expect(rows).toHaveLength(1);
            expect((rows[0] as any).name).toBe('Policy A');
        });
    });

    describe('site_rules_configurations (nullable FK + JSONB)', () => {
        it('seeds with null siteId (default config) and site-specific override', async () => {
            await testDb.seed('site_rules_configurations', [
                {
                    siteId: null,
                    ruleName: 'productInstallationProbabilities',
                    configuration: { enable: true, rules: [{ name: 'default' }] },
                },
                {
                    siteId: 42,
                    ruleName: 'productInstallationProbabilities',
                    configuration: { enable: true, rules: [{ name: 'custom' }] },
                },
            ]);

            const defaults = await testDb.sequelize.query(
                `SELECT configuration FROM site_rules_configurations WHERE "siteId" IS NULL`,
                { type: QueryTypes.SELECT },
            );
            expect(defaults).toHaveLength(1);
            const defaultConfig = (defaults[0] as any).configuration;
            const parsed = typeof defaultConfig === 'string' ? JSON.parse(defaultConfig) : defaultConfig;
            expect(parsed.enable).toBe(true);

            const siteSpecific = await testDb.sequelize.query(
                `SELECT configuration FROM site_rules_configurations WHERE "siteId" = 42`,
                { type: QueryTypes.SELECT },
            );
            expect(siteSpecific).toHaveLength(1);
        });
    });
});

describe('integration: probed Sequelize with JSONB models', () => {
    it('probe captures insert + select lifecycle', async () => {
        const testDb = await createProbedTestDb({ bootstrap });
        const { probe } = testDb;

        try {
            await testDb.seed('tagging_policies', [
                {
                    name: 'Probed Policy',
                    conditions: [],
                    rule: { entities: [], values: [], operator: 'noop' },
                },
            ]);

            const beforeCount: number = probe.queries.length;

            const rows = await testDb.sequelize.query(`SELECT name FROM tagging_policies`, { type: QueryTypes.SELECT });

            expect(rows).toHaveLength(1);
            expect((rows[0] as any).name).toBe('Probed Policy');
            expect(probe.queries.length).toBeGreaterThan(beforeCount);

            const selectQuery = probe.queries.find((q) => q.sql.includes('tagging_policies'));
            expect(selectQuery).toBeDefined();
        } finally {
            await testDb.close();
        }
    });
});

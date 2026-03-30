/**
 * Tests the `models` option on createTestDb / createProbedTestDb.
 *
 * Uses real sequelize-typescript @Table / @Column decorated model classes to
 * validate that:
 *  - Models are auto-registered and tables are synced without any bootstrap fn.
 *  - Model static methods (findAll, create, destroy) work against PGlite.
 *  - JSONB columns serialize / deserialize correctly.
 *  - `bootstrap` still runs after sync when both are provided (e.g. for extra DDL).
 *  - `createProbedTestDb` registers models on both probed and maintenance connections.
 *  - `reset()` recreates the schema from model decorators.
 */

/* eslint-disable max-classes-per-file */
import 'reflect-metadata';
import { Table, Column, Model, DataType, PrimaryKey, AutoIncrement, AllowNull, Sequelize } from 'sequelize-typescript';
import { InferAttributes, InferCreationAttributes, CreationOptional, QueryTypes } from 'sequelize';
import { createTestDb, createProbedTestDb } from '../src';

// ── Test models ──────────────────────────────────────────────────────────────

@Table({ tableName: 'products', timestamps: false, underscored: true })
class Product extends Model<InferAttributes<Product>, InferCreationAttributes<Product>> {
    @PrimaryKey
    @AutoIncrement
    @Column(DataType.INTEGER)
    declare id: CreationOptional<number>;

    @Column(DataType.STRING)
    declare name: string;

    @Column(DataType.INTEGER)
    declare priceCents: number;

    @AllowNull(true)
    @Column(DataType.JSONB)
    declare metadata: CreationOptional<Record<string, unknown> | null>;
}

@Table({ tableName: 'orders', timestamps: true, underscored: true })
class Order extends Model<InferAttributes<Order>, InferCreationAttributes<Order>> {
    @PrimaryKey
    @AutoIncrement
    @Column(DataType.INTEGER)
    declare id: CreationOptional<number>;

    @Column(DataType.INTEGER)
    declare productId: number;

    @Column(DataType.INTEGER)
    declare quantity: number;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('createTestDb with models option', () => {
    describe('models only (no bootstrap)', () => {
        it('creates tables from decorator metadata and supports model CRUD', async () => {
            const testDb = await createTestDb({ models: [Product], SequelizeClass: Sequelize });

            try {
                await Product.create({ name: 'Widget', priceCents: 1999, metadata: null });
                await Product.create({
                    name: 'Gadget',
                    priceCents: 4999,
                    metadata: { color: 'red', stock: 42 },
                });

                const all = await Product.findAll({ order: [['priceCents', 'ASC']] });
                expect(all).toHaveLength(2);
                expect(all[0].name).toBe('Widget');
                expect(all[1].name).toBe('Gadget');
                expect(all[1].metadata).toMatchObject({ color: 'red', stock: 42 });
            } finally {
                await testDb.close();
            }
        });

        it('seed() inserts rows readable by model statics', async () => {
            const testDb = await createTestDb({ models: [Product], SequelizeClass: Sequelize });

            try {
                await testDb.seed('products', [
                    { name: 'Seeded Item', price_cents: 999, metadata: JSON.stringify({ tag: 'test' }) },
                ]);

                const found = await Product.findOne({ where: { name: 'Seeded Item' } });
                expect(found).not.toBeNull();
                expect(found!.priceCents).toBe(999);
            } finally {
                await testDb.close();
            }
        });

        it('reset() drops and recreates tables', async () => {
            const testDb = await createTestDb({ models: [Product], SequelizeClass: Sequelize });

            try {
                await Product.create({ name: 'Before Reset', priceCents: 100, metadata: null });
                expect(await Product.count()).toBe(1);

                await testDb.reset();

                expect(await Product.count()).toBe(0);

                // Tables still exist after reset
                const rows = await testDb.sequelize.query(`SELECT tablename FROM pg_tables WHERE schemaname='public'`, {
                    type: QueryTypes.SELECT,
                });
                const tables = (rows as Array<{ tablename: string }>).map((r) => r.tablename);
                expect(tables).toContain('products');
            } finally {
                await testDb.close();
            }
        });
    });

    describe('models + bootstrap (extra DDL)', () => {
        it('runs bootstrap after sync so extra tables/indexes can be added', async () => {
            let bootstrapCalled = false;

            const testDb = await createTestDb({
                models: [Product],
                SequelizeClass: Sequelize,
                bootstrap: async (seq) => {
                    bootstrapCalled = true;
                    // Extra index not expressible via decorators
                    await seq.query(`CREATE INDEX IF NOT EXISTS idx_products_price ON products (price_cents)`);
                },
            });

            try {
                expect(bootstrapCalled).toBe(true);

                await Product.create({ name: 'Indexed', priceCents: 500, metadata: null });
                const rows = await Product.findAll({ where: { priceCents: 500 } });
                expect(rows).toHaveLength(1);
            } finally {
                await testDb.close();
            }
        });
    });

    describe('bootstrap only (no models — backward compat)', () => {
        it('still works with only bootstrap provided (no SequelizeClass needed)', async () => {
            const testDb = await createTestDb({
                bootstrap: async (seq) => {
                    await seq.query(
                        `CREATE TABLE IF NOT EXISTS legacy_items (id SERIAL PRIMARY KEY, label VARCHAR NOT NULL)`,
                    );
                },
            });

            try {
                await testDb.seed('legacy_items', [{ label: 'hello' }]);
                const rows = await testDb.sequelize.query(`SELECT label FROM legacy_items`, {
                    type: QueryTypes.SELECT,
                });
                expect(rows).toHaveLength(1);
                expect((rows[0] as any).label).toBe('hello');
            } finally {
                await testDb.close();
            }
        });
    });

    describe('validation', () => {
        it('throws when neither models nor bootstrap is provided', async () => {
            await expect(createTestDb({})).rejects.toThrow('createTestDb');
        });

        it('throws when models provided without SequelizeClass', async () => {
            await expect(createTestDb({ models: [Product] })).rejects.toThrow('SequelizeClass');
        });
    });

    describe('multiple models with associations', () => {
        it('syncs both models and allows raw joins', async () => {
            const testDb = await createTestDb({ models: [Product, Order], SequelizeClass: Sequelize });

            try {
                const product = await Product.create({ name: 'Chair', priceCents: 19900, metadata: null });
                await Order.create({ productId: product.id, quantity: 3 });

                const rows = await testDb.sequelize.query(
                    `SELECT o.quantity, p.name FROM orders o JOIN products p ON o.product_id = p.id`,
                    { type: QueryTypes.SELECT },
                );

                expect(rows).toHaveLength(1);
                expect((rows[0] as any).name).toBe('Chair');
                expect((rows[0] as any).quantity).toBe(3);
            } finally {
                await testDb.close();
            }
        });
    });
});

describe('createTestDb with extensions option', () => {
    it('loads uuid-ossp extension and uuid_generate_v4() works in queries', async () => {
        // @ts-expect-error — TS "node" moduleResolution can't resolve wildcard package exports
        const { uuid_ossp } = await import('@electric-sql/pglite/contrib/uuid_ossp');

        const testDb = await createTestDb({
            extensions: { uuid_ossp },
            preBootstrap: async (seq) => {
                await seq.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
            },
            bootstrap: async (seq) => {
                await seq.query(`
                    CREATE TABLE IF NOT EXISTS uuid_test (
                        id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
                        label VARCHAR NOT NULL
                    )
                `);
            },
        });

        try {
            await testDb.seed('uuid_test', [{ label: 'auto-uuid' }]);
            const rows = await testDb.sequelize.query(`SELECT id, label FROM uuid_test`, {
                type: QueryTypes.SELECT,
            });
            expect(rows).toHaveLength(1);
            const row = rows[0] as { id: string; label: string };
            expect(row.label).toBe('auto-uuid');
            // Verify the id is a valid UUID (generated by uuid_generate_v4)
            expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
        } finally {
            await testDb.close();
        }
    });

    it('extensions survive reset()', async () => {
        // @ts-expect-error — TS "node" moduleResolution can't resolve wildcard package exports
        const { uuid_ossp } = await import('@electric-sql/pglite/contrib/uuid_ossp');

        const testDb = await createTestDb({
            extensions: { uuid_ossp },
            preBootstrap: async (seq) => {
                await seq.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
            },
            bootstrap: async (seq) => {
                await seq.query(`
                    CREATE TABLE IF NOT EXISTS uuid_test (
                        id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
                        label VARCHAR NOT NULL
                    )
                `);
            },
        });

        try {
            await testDb.seed('uuid_test', [{ label: 'before-reset' }]);
            await testDb.reset();

            // After reset, extension is still loaded (PGlite keeps it) and preBootstrap re-activates it
            await testDb.seed('uuid_test', [{ label: 'after-reset' }]);
            const rows = await testDb.sequelize.query(`SELECT id, label FROM uuid_test`, {
                type: QueryTypes.SELECT,
            });
            expect(rows).toHaveLength(1);
            const row = rows[0] as { id: string; label: string };
            expect(row.label).toBe('after-reset');
            expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
        } finally {
            await testDb.close();
        }
    });

    it('extensions work with sequelize-typescript models', async () => {
        // @ts-expect-error — TS "node" moduleResolution can't resolve wildcard package exports
        const { uuid_ossp } = await import('@electric-sql/pglite/contrib/uuid_ossp');

        @Table({ tableName: 'uuid_products', timestamps: false })
        class UuidProduct extends Model<InferAttributes<UuidProduct>, InferCreationAttributes<UuidProduct>> {
            @PrimaryKey
            @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuid_generate_v4()') })
            declare id: CreationOptional<string>;

            @Column(DataType.STRING)
            declare name: string;
        }

        const testDb = await createTestDb({
            extensions: { uuid_ossp },
            preBootstrap: async (seq) => {
                await seq.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
            },
            models: [UuidProduct],
            SequelizeClass: Sequelize,
        });

        try {
            const product = await UuidProduct.create({ name: 'Extension-powered' });
            expect(product.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

            const found = await UuidProduct.findByPk(product.id);
            expect(found).not.toBeNull();
            expect(found!.name).toBe('Extension-powered');
        } finally {
            await testDb.close();
        }
    });
});

describe('createProbedTestDb with extensions option', () => {
    it('loads extension and probe intercepts queries', async () => {
        // @ts-expect-error — TS "node" moduleResolution can't resolve wildcard package exports
        const { uuid_ossp } = await import('@electric-sql/pglite/contrib/uuid_ossp');

        const testDb = await createProbedTestDb({
            extensions: { uuid_ossp },
            preBootstrap: async (seq) => {
                await seq.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
            },
            bootstrap: async (seq) => {
                await seq.query(`
                    CREATE TABLE IF NOT EXISTS uuid_probed (
                        id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
                        label VARCHAR NOT NULL
                    )
                `);
            },
        });

        try {
            const before: number = testDb.probe.queries.length;
            await testDb.sequelize.query(`INSERT INTO uuid_probed (label) VALUES ('probed-ext')`, {
                type: QueryTypes.INSERT,
            });
            expect(testDb.probe.queries.length).toBeGreaterThan(before);

            const rows = await testDb.sequelize.query(`SELECT id, label FROM uuid_probed`, {
                type: QueryTypes.SELECT,
            });
            expect(rows).toHaveLength(1);
            const row = rows[0] as { id: string; label: string };
            expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/i);
        } finally {
            await testDb.close();
        }
    });
});

describe('createProbedTestDb with models option', () => {
    it('probe intercepts model queries', async () => {
        const testDb = await createProbedTestDb({ models: [Product], SequelizeClass: Sequelize });

        try {
            const before: number = testDb.probe.queries.length;

            await Product.create({ name: 'Probed', priceCents: 777, metadata: null });
            const all = await Product.findAll();

            expect(all).toHaveLength(1);
            expect(testDb.probe.queries.length).toBeGreaterThan(before);
        } finally {
            await testDb.close();
        }
    });

    it('reset() works with models on probed testDb', async () => {
        const testDb = await createProbedTestDb({ models: [Product], SequelizeClass: Sequelize });

        try {
            await Product.create({ name: 'Before', priceCents: 100, metadata: null });
            await testDb.reset();
            expect(await Product.count()).toBe(0);
        } finally {
            await testDb.close();
        }
    });
});

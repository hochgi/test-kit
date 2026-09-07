/**
 * Translated from v1 packages/pg-sequelize/test/sequelize-typescript-models.test.ts
 * to v2 grammar.
 *
 * Validates that sequelize-typescript decorated model classes work with
 * createProbedSequelizeAdapter via the `models` option:
 *  - Models are auto-registered and tables are synced without bootstrap.
 *  - Model statics (findAll, findOne, create, count, destroy) work.
 *  - JSONB columns serialize and deserialize.
 *  - bootstrap still runs after sync when both options are provided.
 *  - reset() preserves the schema.
 *  - probe captures queries triggered by model methods.
 */
/* eslint-disable max-classes-per-file */
import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'vitest';
import { AllowNull, AutoIncrement, Column, DataType, Model, PrimaryKey, Sequelize, Table } from 'sequelize-typescript';
import type { CreationOptional, InferAttributes, InferCreationAttributes } from 'sequelize';
import { createRig, type Rig } from '@vnatures/test-kit';
import { createProbedSequelizeAdapter } from '@vnatures/test-kit-pg-sequelize';

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

describe('createProbedSequelizeAdapter — models option', () => {
    let rig: Rig;

    afterEach(async () => {
        if (rig) await rig.close();
    });

    describe('models only (no bootstrap)', () => {
        it('creates tables from decorator metadata and supports CRUD', async () => {
            rig = createRig();
            await rig.attach(
                createProbedSequelizeAdapter({
                    harness: rig,
                    models: [Product],
                    SequelizeClass: Sequelize,
                }),
            );

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
        });

        it('seed() inserts rows readable by model statics', async () => {
            rig = createRig();
            const db = await rig.attach(
                createProbedSequelizeAdapter({
                    harness: rig,
                    models: [Product],
                    SequelizeClass: Sequelize,
                }),
            );

            await db.seed('products' as never, [
                {
                    name: 'Seeded Item',
                    price_cents: 999,
                    metadata: JSON.stringify({ tag: 'test' }),
                },
            ]);

            const found = await Product.findOne({ where: { name: 'Seeded Item' } });
            expect(found).not.toBeNull();
            expect(found!.priceCents).toBe(999);
        });

        it('rig.reset() drops and recreates tables', async () => {
            rig = createRig();
            await rig.attach(
                createProbedSequelizeAdapter({
                    harness: rig,
                    models: [Product],
                    SequelizeClass: Sequelize,
                }),
            );

            await Product.create({ name: 'Before Reset', priceCents: 100, metadata: null });
            expect(await Product.count()).toBe(1);

            await rig.reset();
            expect(await Product.count()).toBe(0);
        });
    });

    describe('models + bootstrap combined', () => {
        it('bootstrap runs after sync; both work together', async () => {
            rig = createRig();
            await rig.attach(
                createProbedSequelizeAdapter({
                    harness: rig,
                    models: [Product, Order],
                    SequelizeClass: Sequelize,
                    bootstrap: async (sequelize) => {
                        await sequelize.query(`CREATE INDEX IF NOT EXISTS idx_products_name ON products(name)`);
                    },
                }),
            );

            await Product.create({ name: 'Alpha', priceCents: 100, metadata: null });
            const found = await Product.findOne({ where: { name: 'Alpha' } });
            expect(found).not.toBeNull();
        });
    });

    describe('probe captures queries from model statics', () => {
        it('records model.findAll() and model.create() through the probe', async () => {
            rig = createRig();
            const db = await rig.attach(
                createProbedSequelizeAdapter({
                    harness: rig,
                    models: [Product],
                    SequelizeClass: Sequelize,
                }),
            );

            const before = db.probe.calls.length;

            await Product.create({ name: 'Tracked', priceCents: 250, metadata: null });
            await Product.findAll();

            expect(db.probe.calls.length).toBeGreaterThan(before);

            const insertCall = db.probe.calls.find((c) => c.sql.includes('INSERT'));
            expect(insertCall).toBeDefined();

            const selectCall = db.probe.calls.find((c) => c.sql.includes('SELECT') && c.sql.includes('products'));
            expect(selectCall).toBeDefined();
        });
    });
});

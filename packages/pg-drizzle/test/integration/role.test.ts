/**
 * Delta P14 → "Requirement: Optional application role".
 *
 * PGlite's default user is the superuser `postgres`, which bypasses RLS; the
 * `role` option makes application statements run as a non-owner role while
 * bootstrap, seed and reset stay on the owner.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { integer, pgTable, serial, text } from 'drizzle-orm/pg-core';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { createRig, type Rig } from '@hochgi/test-kit';
import { createProbedDrizzleAdapter, type ProbedDrizzleAdapter } from '@hochgi/test-kit-pg-drizzle';
import { chainMessages, createItemsRig, rejectionOf, type ItemsRig } from './fixtures.js';

const ROLE = 'app_rt';

const notes = pgTable('notes', {
    id: serial('id').primaryKey(),
    customerId: integer('customer_id')
        .notNull()
        .default(sql`current_setting('app.customer_id', true)::int`),
    body: text('body').notNull(),
});

const schema = { notes };
type Schema = typeof schema;

/** Re-runnable from an empty `public` schema; the role survives reset. */
async function bootstrap(db: PgliteDatabase<Schema>): Promise<void> {
    const statements = [
        `do $$ begin
            if not exists (select 1 from pg_roles where rolname = '${ROLE}') then
                create role ${ROLE} nologin;
            end if;
        end $$`,
        `create table if not exists notes (
            id serial primary key,
            customer_id int not null default current_setting('app.customer_id', true)::int,
            body text not null
        )`,
        'alter table notes enable row level security',
        `create policy tenant_isolation on notes
            using (customer_id = current_setting('app.customer_id', true)::int)
            with check (customer_id = current_setting('app.customer_id', true)::int)`,
        `grant select, insert on notes to ${ROLE}`,
        `grant usage on sequence notes_id_seq to ${ROLE}`,
    ];
    for (const statement of statements) {
        await db.execute(sql.raw(statement));
    }
}

let rig: Rig | undefined;

async function createRoleRig(): Promise<ProbedDrizzleAdapter<Schema>> {
    rig = createRig();
    return rig.attach(createProbedDrizzleAdapter<Schema>({ harness: rig, schema, bootstrap, role: ROLE }));
}

let itemsCtx: ItemsRig | undefined;

afterEach(async () => {
    await rig?.close();
    rig = undefined;
    await itemsCtx?.rig.close();
    itemsCtx = undefined;
});

describe('Requirement: Optional application role', () => {
    it('Scenario: current_user is the role inside and outside transactions', async () => {
        const db = await createRoleRig();

        const outside = await db.adapter.execute(sql`select current_user as who`);
        const inside = await db.adapter.transaction(async (tx) => tx.execute(sql`select current_user as who`));

        expect(outside.rows).toEqual([{ who: ROLE }]);
        expect(inside.rows).toEqual([{ who: ROLE }]);
        expect(db.probe.calls.length).toBeGreaterThan(0);
        expect(db.probe.calls.filter((c) => /set\s+local\s+role/i.test(c.sql))).toEqual([]);
    });

    it('Scenario: without role, plain statements run outside a transaction', async () => {
        itemsCtx = await createItemsRig();
        const { db } = itemsCtx;

        // Postgres refuses VACUUM inside a transaction block, so this resolves
        // only when an unset role sends the statement straight to PGlite.
        await expect(db.adapter.execute(sql`vacuum items`)).resolves.toBeDefined();
        expect(db.probe.calls.map((c) => c.sql)).toEqual(['vacuum items']);
    });

    it('Scenario: RLS filters reads and rejects cross-tenant writes', async () => {
        const db = await createRoleRig();
        await db.seed(notes, [
            { customerId: 1, body: 'one-a' },
            { customerId: 1, body: 'one-b' },
            { customerId: 2, body: 'two-a' },
        ]);

        const visible = await db.adapter.transaction(async (tx) => {
            await tx.execute(sql`select set_config('app.customer_id', ${'1'}, true)`);
            return tx.select().from(notes);
        });
        const crossTenant = await rejectionOf(
            db.adapter.transaction(async (tx) => {
                await tx.execute(sql`select set_config('app.customer_id', ${'1'}, true)`);
                await tx.insert(notes).values({ customerId: 2, body: 'smuggled' });
            }),
        );

        expect(visible.map((n) => n.body).sort()).toEqual(['one-a', 'one-b']);
        expect(chainMessages(crossTenant).some((m) => /row-level security/i.test(m))).toBe(true);
    });

    it('Scenario: seed and reset still run as owner', async () => {
        const db = await createRoleRig();

        await db.seed(notes, [{ customerId: 1, body: 'seeded' }]);
        await rig?.reset();

        const tables = await db.pglite.maintenance.execute(
            `select tablename from pg_tables where schemaname = 'public' and tablename = 'notes'`,
        );
        expect(tables.rows).toHaveLength(1);
        const rows = await db.adapter.transaction(async (tx) => {
            await tx.execute(sql`select set_config('app.customer_id', ${'1'}, true)`);
            return tx.select().from(notes);
        });
        expect(rows).toEqual([]);
        expect(await db.pglite.maintenance.execute('select count(*)::int as n from notes')).toEqual({
            rows: [{ n: 0 }],
        });
    });
});

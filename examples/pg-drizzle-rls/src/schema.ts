import { sql } from 'drizzle-orm';
import { integer, pgTable, serial, text } from 'drizzle-orm/pg-core';
import type { PgliteDatabase } from 'drizzle-orm/pglite';

/** The non-owner runtime role the application connects as. */
export const APP_ROLE = 'app_rt';

export const clients = pgTable('clients', {
    id: serial('id').primaryKey(),
    customerId: integer('customer_id')
        .notNull()
        .default(sql`current_setting('app.customer_id', true)::int`),
    name: text('name').notNull(),
});

export const schema = { clients };
export type Schema = typeof schema;
export type Database = PgliteDatabase<Schema>;

/**
 * Owner-side DDL: runtime role, tenant-scoped `clients` table, RLS policy and
 * grants. Re-runnable from an empty `public` schema (roles survive a reset).
 */
const BOOTSTRAP_SQL: readonly string[] = [
    `do $$ begin
        if not exists (select 1 from pg_roles where rolname = '${APP_ROLE}') then
            create role ${APP_ROLE} nologin;
        end if;
    end $$`,
    `create table if not exists clients (
        id serial primary key,
        customer_id int not null default current_setting('app.customer_id', true)::int,
        name text not null
    )`,
    'alter table clients enable row level security',
    `create policy clients_tenant_isolation on clients
        using (customer_id = current_setting('app.customer_id', true)::int)
        with check (customer_id = current_setting('app.customer_id', true)::int)`,
    `grant select, insert, update, delete on clients to ${APP_ROLE}`,
    `grant usage on sequence clients_id_seq to ${APP_ROLE}`,
];

export async function bootstrapClients(db: Database): Promise<void> {
    for (const statement of BOOTSTRAP_SQL) {
        await db.execute(sql.raw(statement));
    }
}

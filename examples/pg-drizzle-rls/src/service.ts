import { asc, sql } from 'drizzle-orm';
import { clients, type Database } from './schema.js';

export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export class RequestTimeoutError extends Error {
    constructor(ms: number) {
        super(`request timed out after ${String(ms)}ms`);
        this.name = 'RequestTimeoutError';
    }
}

export interface TenantScope {
    /** One request: one transaction, tenant set first, bounded by the request timeout. */
    transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
}

export interface TenantServiceOptions {
    readonly requestTimeoutMs: number;
}

/**
 * Per-request-transaction RLS pattern: every request opens a transaction,
 * sets `app.customer_id` transaction-locally, then runs its work. The
 * timeout is enforced inside the transaction callback, so a timed-out
 * request rolls back and releases the connection.
 */
export class TenantService {
    constructor(
        private readonly db: Database,
        private readonly options: TenantServiceOptions,
    ) {}

    forTenant(customerId: number): TenantScope {
        return {
            transaction: <T>(work: (tx: Tx) => Promise<T>): Promise<T> =>
                this.db.transaction((tx) =>
                    withTimeout(
                        (async () => {
                            await tx.execute(sql`select set_config('app.customer_id', ${String(customerId)}, true)`);
                            return work(tx);
                        })(),
                        this.options.requestTimeoutMs,
                    ),
                ),
        };
    }
}

export interface ClientRow {
    readonly id: number;
    readonly customerId: number;
    readonly name: string;
}

/** Repository queries; tenant scoping comes from RLS, not from a WHERE clause. */
export const clientsRepository = {
    list(tx: Tx): Promise<ClientRow[]> {
        return Promise.resolve(tx.select().from(clients).orderBy(asc(clients.id)));
    },
    async insert(tx: Tx, name: string): Promise<void> {
        await tx.insert(clients).values({ name });
    },
};

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new RequestTimeoutError(ms)), ms);
    });
    return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

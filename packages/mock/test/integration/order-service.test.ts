/**
 * Translated from v1 packages/core/test/app-demo.test.ts to v2 grammar.
 *
 * Realistic component test: an OrderService with multiple injected boundaries.
 * Demonstrates the v2 rig pattern (createRig + rig.attach), the
 * once/always rule grammar, and live intercept-based plumbing assertions.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRig, milliseconds, type Rig } from '@vnatures/test-kit';
import { createProbedMock } from '@vnatures/test-kit-mock';

// ── Domain types ────────────────────────────────────────────────────────────

type User = { id: number; name: string; email: string };
type Product = { id: number; name: string; price: number; stock: number };
type PaymentResult = { success: boolean; transactionId?: string; error?: string };
type OrderItem = { productId: number; qty: number };
type Order = {
    id: string;
    userId: number;
    items: OrderItem[];
    total: number;
    status: string;
};

interface UserService {
    getUser(id: number): Promise<User>;
}
interface ProductService {
    getProduct(id: number): Promise<Product>;
    reserveStock(productId: number, qty: number): Promise<boolean>;
    releaseStock(productId: number, qty: number): Promise<void>;
}
interface PaymentGateway {
    charge(userId: number, amount: number): Promise<PaymentResult>;
}
interface EventBus {
    publish(topic: string, event: unknown): Promise<void>;
}

// ── Component under test ────────────────────────────────────────────────────

class OrderService {
    constructor(
        private users: UserService,
        private products: ProductService,
        private payments: PaymentGateway,
        private events: EventBus,
    ) {}

    async createOrder(userId: number, items: OrderItem[]): Promise<Order> {
        const user = await this.users.getUser(userId);

        const productLookups = items.map((item) => this.products.getProduct(item.productId));
        const products = await Promise.all(productLookups);
        const total = items.reduce((sum, item, i) => sum + products[i].price * item.qty, 0);

        for (const item of items) {
            const reserved = await this.products.reserveStock(item.productId, item.qty);
            if (!reserved) throw new Error(`Insufficient stock for product ${item.productId}`);
        }

        const payment = await this.payments.charge(userId, total);
        if (!payment.success) {
            for (const item of items) {
                await this.products.releaseStock(item.productId, item.qty);
            }
            throw new Error(`Payment failed: ${payment.error}`);
        }

        const order: Order = {
            id: `ORD-${Date.now()}`,
            userId,
            items,
            total,
            status: 'confirmed',
        };
        await this.events.publish('orders', { type: 'OrderCreated', order, user });
        return order;
    }

    async createOrderWithTimeout(userId: number, items: OrderItem[], timeoutMs: number): Promise<Order> {
        return Promise.race([
            this.createOrder(userId, items),
            new Promise<Order>((_, reject) =>
                setTimeout(() => reject(new Error('Order creation timed out')), timeoutMs),
            ),
        ]);
    }
}

// ── Test fixtures ───────────────────────────────────────────────────────────

const testUser: User = { id: 1, name: 'Gilad', email: 'gilad@versatile.ai' };
const testProducts: Product[] = [
    { id: 101, name: 'Steel Beam', price: 250, stock: 50 },
    { id: 102, name: 'Concrete Block', price: 80, stock: 200 },
];
const testItems: OrderItem[] = [
    { productId: 101, qty: 2 },
    { productId: 102, qty: 5 },
];

function createTestHarness(rig: Rig) {
    const users = rig.attach(createProbedMock<UserService>({ methods: ['getUser'] }));
    const products = rig.attach(
        createProbedMock<ProductService>({
            methods: ['getProduct', 'reserveStock', 'releaseStock'],
        }),
    );
    const payments = rig.attach(createProbedMock<PaymentGateway>({ methods: ['charge'] }));
    const events = rig.attach(createProbedMock<EventBus>({ methods: ['publish'] }));

    const service = new OrderService(users.adapter, products.adapter, payments.adapter, events.adapter);

    return {
        service,
        users: users.probe,
        products: products.probe,
        payments: payments.probe,
        events: events.probe,
    };
}

describe('OrderService — pre-programmed style (rules)', () => {
    let rig: Rig;
    beforeEach(() => {
        rig = createRig();
    });
    afterEach(async () => {
        await rig.close();
    });

    it('creates an order when every dep is pre-programmed via one-shots', async () => {
        const { service, users, products, payments, events } = createTestHarness(rig);

        users.on('getUser').once().answer(testUser);
        products.on('getProduct').once().answer(testProducts[0]);
        products.on('getProduct').once().answer(testProducts[1]);
        products.on('reserveStock').once().answer(true);
        products.on('reserveStock').once().answer(true);
        payments.on('charge').once().answer({ success: true, transactionId: 'TXN-1' });
        events.on('publish').once().answer(undefined);

        const order = await service.createOrder(1, testItems);

        expect(order.userId).toBe(1);
        expect(order.total).toBe(2 * 250 + 5 * 80);
        expect(order.status).toBe('confirmed');
    });

    it('uses always() for boring deps and focuses on payment behavior', async () => {
        const { service, users, products, payments } = createTestHarness(rig);

        users.on('getUser').always().answer(testUser);
        products.on('getProduct').always().answer(testProducts[0]);
        products.on('reserveStock').always().answer(true);
        products.on('releaseStock').always().answer(undefined);

        payments.on('charge').once().answer({ success: false, error: 'insufficient funds' });

        await expect(service.createOrder(1, [{ productId: 101, qty: 1 }])).rejects.toThrow(
            'Payment failed: insufficient funds',
        );
    });
});

describe('OrderService — plumbing style (intercept each call)', () => {
    let rig: Rig;
    beforeEach(() => {
        rig = createRig();
    });
    afterEach(async () => {
        await rig.close();
    });

    it('verifies the exact sequence of dependency calls', async () => {
        const { service, users, products, payments, events } = createTestHarness(rig);

        const orderPromise = service.createOrder(1, [{ productId: 101, qty: 2 }]);

        const userCall = await users.expect.intercept();
        expect(userCall.method).toBe('getUser');
        expect(userCall.args).toEqual([1]);
        userCall.answer(testUser);

        const productCall = await products.expect.intercept();
        expect(productCall.method).toBe('getProduct');
        expect(productCall.args).toEqual([101]);
        productCall.answer(testProducts[0]);

        const reserveCall = await products.expect.intercept();
        expect(reserveCall.method).toBe('reserveStock');
        expect(reserveCall.args).toEqual([101, 2]);
        reserveCall.answer(true);

        const payCall = await payments.expect.intercept();
        expect(payCall.method).toBe('charge');
        expect(payCall.args).toEqual([1, 500]);
        payCall.answer({ success: true, transactionId: 'TXN-42' });

        const eventCall = await events.expect.intercept();
        expect(eventCall.method).toBe('publish');
        expect(eventCall.args[0]).toBe('orders');
        expect((eventCall.args[1] as { type: string }).type).toBe('OrderCreated');
        eventCall.answer(undefined);

        const order = await orderPromise;
        expect(order.status).toBe('confirmed');
    });

    it('answers concurrent product lookups out of order', async () => {
        const { service, users, products, payments, events } = createTestHarness(rig);

        const orderPromise = service.createOrder(1, testItems);

        (await users.expect.intercept()).answer(testUser);

        const product2Call = await products
            .filter((c) => c.method === 'getProduct' && c.args[0] === 102)
            .expect.intercept();
        const product1Call = await products
            .filter((c) => c.method === 'getProduct' && c.args[0] === 101)
            .expect.intercept();

        product2Call.answer(testProducts[1]);
        product1Call.answer(testProducts[0]);

        (await products.expect.intercept()).answer(true);
        (await products.expect.intercept()).answer(true);
        (await payments.expect.intercept()).answer({
            success: true,
            transactionId: 'TXN-99',
        });
        (await events.expect.intercept()).answer(undefined);

        const order = await orderPromise;
        expect(order.total).toBe(2 * 250 + 5 * 80);
    });
});

describe('OrderService — payment failure rolls back stock', () => {
    let rig: Rig;
    beforeEach(() => {
        rig = createRig();
    });
    afterEach(async () => {
        await rig.close();
    });

    it('releases stock for all items when payment fails and does not publish event', async () => {
        const { service, users, products, payments, events } = createTestHarness(rig);

        const orderPromise = service.createOrder(1, testItems).catch((e: unknown) => e);

        (await users.expect.intercept()).answer(testUser);
        (await products.expect.intercept()).answer(testProducts[0]);
        (await products.expect.intercept()).answer(testProducts[1]);
        (await products.expect.intercept()).answer(true);
        (await products.expect.intercept()).answer(true);
        (await payments.expect.intercept()).answer({
            success: false,
            error: 'card declined',
        });

        const release1 = await products.expect.intercept();
        expect(release1.method).toBe('releaseStock');
        expect(release1.args).toEqual([101, 2]);
        release1.answer(undefined);

        const release2 = await products.expect.intercept();
        expect(release2.method).toBe('releaseStock');
        expect(release2.args).toEqual([102, 5]);
        release2.answer(undefined);

        const error = (await orderPromise) as Error;
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toContain('card declined');

        await events.expect.none({ within: milliseconds(0) });
    });
});

describe('OrderService — event bus assertions', () => {
    let rig: Rig;
    beforeEach(() => {
        rig = createRig();
    });
    afterEach(async () => {
        await rig.close();
    });

    it('publishes OrderCreated event with correct payload', async () => {
        const { service, users, products, payments, events } = createTestHarness(rig);

        users.on('getUser').always().answer(testUser);
        products.on('getProduct').always().answer(testProducts[0]);
        products.on('reserveStock').always().answer(true);
        payments.on('charge').always().answer({ success: true, transactionId: 'TXN-1' });

        const orderPromise = service.createOrder(1, [{ productId: 101, qty: 1 }]);

        const eventCall = await events.expect.intercept();
        expect(eventCall.args[0]).toBe('orders');
        const payload = eventCall.args[1] as { type: string; order: Order; user: User };
        expect(payload.type).toBe('OrderCreated');
        expect(payload.order.total).toBe(250);
        expect(payload.user.email).toBe('gilad@versatile.ai');
        eventCall.answer(undefined);

        await orderPromise;
    });

    it('does not publish event when payment fails', async () => {
        const { service, users, products, payments, events } = createTestHarness(rig);

        users.on('getUser').always().answer(testUser);
        products.on('getProduct').always().answer(testProducts[0]);
        products.on('reserveStock').always().answer(true);
        products.on('releaseStock').always().answer(undefined);
        payments.on('charge').once().answer({ success: false, error: 'declined' });

        await expect(service.createOrder(1, [{ productId: 101, qty: 1 }])).rejects.toThrow();

        await events.expect.none({ within: milliseconds(0) });
    });
});

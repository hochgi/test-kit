/**
 * Realistic component test demo: OrderService
 *
 * Demonstrates how to test a service with multiple dependencies using probe pairs.
 * All dependencies are probed — no real IO, no real clock.
 */
import { createProbePair, whenCalled, alwaysReturn, alwaysCall, PendingCall } from "../src";

// ── Domain types ──

type User = { id: number; name: string; email: string };
type Product = { id: number; name: string; price: number; stock: number };
type PaymentResult = { success: boolean; transactionId?: string; error?: string };
type OrderItem = { productId: number; qty: number };
type Order = { id: string; userId: number; items: OrderItem[]; total: number; status: string };

// ── Dependency interfaces (the "ports") ──

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

// ── Component under test ──

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
            if (!reserved) {
                throw new Error(`Insufficient stock for product ${item.productId}`);
            }
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
            status: "confirmed",
        };

        await this.events.publish("orders", { type: "OrderCreated", order, user });

        return order;
    }

    async createOrderWithTimeout(userId: number, items: OrderItem[], timeoutMs: number): Promise<Order> {
        return Promise.race([
            this.createOrder(userId, items),
            new Promise<Order>((_, reject) =>
                setTimeout(() => reject(new Error("Order creation timed out")), timeoutMs),
            ),
        ]);
    }
}

// ── Helpers ──

const testUser: User = { id: 1, name: "Gilad", email: "gilad@versatile.ai" };
const testProducts: Product[] = [
    { id: 101, name: "Steel Beam", price: 250, stock: 50 },
    { id: 102, name: "Concrete Block", price: 80, stock: 200 },
];
const testItems: OrderItem[] = [
    { productId: 101, qty: 2 },
    { productId: 102, qty: 5 },
];

function createHarness() {
    const { fake: users, probe: usersProbe } = createProbePair<UserService>();
    const { fake: products, probe: productsProbe } = createProbePair<ProductService>();
    const { fake: payments, probe: paymentsProbe } = createProbePair<PaymentGateway>();
    const { fake: events, probe: eventsProbe } = createProbePair<EventBus>();

    const service = new OrderService(users, products, payments, events);

    return { service, users, products, payments, events, usersProbe, productsProbe, paymentsProbe, eventsProbe };
}

// ── Tests ──

describe("OrderService — porcelain style (pre-programmed responses)", () => {
    it("creates an order with all dependencies pre-programmed", async () => {
        const { service, users, products, payments, events } = createHarness();

        whenCalled(users, "getUser").thenReturn(testUser);
        whenCalled(products, "getProduct").thenReturn(testProducts[0]);
        whenCalled(products, "getProduct").thenReturn(testProducts[1]);
        whenCalled(products, "reserveStock").thenReturn(true);
        whenCalled(products, "reserveStock").thenReturn(true);
        whenCalled(payments, "charge").thenReturn({ success: true, transactionId: "TXN-1" });
        whenCalled(events, "publish").thenReturn(undefined);

        const order = await service.createOrder(1, testItems);

        expect(order.userId).toBe(1);
        expect(order.total).toBe(2 * 250 + 5 * 80);
        expect(order.status).toBe("confirmed");
    });

    it("uses alwaysReturn for precondition deps, focus on payment", async () => {
        const { service, users, products, payments, events } = createHarness();

        alwaysReturn(users, "getUser", testUser);
        alwaysReturn(products, "getProduct", testProducts[0]);
        alwaysReturn(products, "reserveStock", true);
        alwaysReturn(products, "releaseStock", undefined);
        alwaysReturn(events, "publish", undefined);

        whenCalled(payments, "charge").thenReturn({ success: false, error: "insufficient funds" });

        await expect(service.createOrder(1, [{ productId: 101, qty: 1 }]))
            .rejects.toThrow("Payment failed: insufficient funds");
    });
});

describe("OrderService — plumbing style (observe and control each call)", () => {
    it("verifies the exact sequence of dependency calls", async () => {
        const { service, usersProbe, productsProbe, paymentsProbe, eventsProbe } = createHarness();

        const orderPromise = service.createOrder(1, [{ productId: 101, qty: 2 }]).then(r => r);

        const userCall = await usersProbe.expectNext();
        expect(userCall.method).toBe("getUser");
        expect(userCall.args).toEqual([1]);
        userCall.answer(testUser);

        const productCall = await productsProbe.expectNext();
        expect(productCall.method).toBe("getProduct");
        expect(productCall.args).toEqual([101]);
        productCall.answer(testProducts[0]);

        const reserveCall = await productsProbe.expectNext();
        expect(reserveCall.method).toBe("reserveStock");
        expect(reserveCall.args).toEqual([101, 2]);
        reserveCall.answer(true);

        const payCall = await paymentsProbe.expectNext();
        expect(payCall.method).toBe("charge");
        expect(payCall.args).toEqual([1, 500]);
        payCall.answer({ success: true, transactionId: "TXN-42" });

        const eventCall = await eventsProbe.expectNext();
        expect(eventCall.method).toBe("publish");
        expect(eventCall.args[0]).toBe("orders");
        expect((eventCall.args[1] as any).type).toBe("OrderCreated");
        eventCall.answer(undefined);

        const order = await orderPromise;
        expect(order.status).toBe("confirmed");
    });

    it("answers concurrent product lookups out of order", async () => {
        const { service, usersProbe, productsProbe, paymentsProbe, eventsProbe } = createHarness();

        const orderPromise = service.createOrder(1, testItems).then(r => r);

        const userCall = await usersProbe.expectNext();
        userCall.answer(testUser);

        const product2Call = await productsProbe.expectMatching(
            (c) => c.method === "getProduct" && (c.args[0] as number) === 102,
        );
        const product1Call = await productsProbe.expectMatching(
            (c) => c.method === "getProduct" && (c.args[0] as number) === 101,
        );

        product2Call.answer(testProducts[1]);
        product1Call.answer(testProducts[0]);

        const r1 = await productsProbe.expectNext();
        r1.answer(true);
        const r2 = await productsProbe.expectNext();
        r2.answer(true);

        const pay = await paymentsProbe.expectNext();
        pay.answer({ success: true, transactionId: "TXN-99" });

        const evt = await eventsProbe.expectNext();
        evt.answer(undefined);

        const order = await orderPromise;
        expect(order.total).toBe(2 * 250 + 5 * 80);
    });
});

describe("OrderService — payment failure rolls back stock", () => {
    it("releases stock for all items when payment fails", async () => {
        const { service, usersProbe, productsProbe, paymentsProbe, eventsProbe } = createHarness();

        const orderPromise = service.createOrder(1, testItems).catch((e) => e);

        (await usersProbe.expectNext()).answer(testUser);
        (await productsProbe.expectNext()).answer(testProducts[0]);
        (await productsProbe.expectNext()).answer(testProducts[1]);
        (await productsProbe.expectNext()).answer(true);
        (await productsProbe.expectNext()).answer(true);

        const payCall = await paymentsProbe.expectNext();
        payCall.answer({ success: false, error: "card declined" });

        const release1 = await productsProbe.expectNext();
        expect(release1.method).toBe("releaseStock");
        expect(release1.args).toEqual([101, 2]);
        release1.answer(undefined);

        const release2 = await productsProbe.expectNext();
        expect(release2.method).toBe("releaseStock");
        expect(release2.args).toEqual([102, 5]);
        release2.answer(undefined);

        const error = await orderPromise;
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toContain("card declined");

        await eventsProbe.expectNoMsgWithin(0);
    });
});

describe("OrderService — timeout with fake clock", () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it("times out when payment gateway does not respond", async () => {
        const { service, usersProbe, productsProbe, paymentsProbe } = createHarness();

        const orderPromise = service.createOrderWithTimeout(1, [{ productId: 101, qty: 1 }], 5000);

        (await usersProbe.expectNext()).answer(testUser);
        (await productsProbe.expectNext()).answer(testProducts[0]);
        (await productsProbe.expectNext()).answer(true);

        await paymentsProbe.expectNext();

        jest.advanceTimersByTime(5000);

        await expect(orderPromise).rejects.toThrow("Order creation timed out");
    });
});

describe("OrderService — event bus assertions", () => {
    it("publishes OrderCreated event with correct payload", async () => {
        const { service, users, products, payments, eventsProbe } = createHarness();

        alwaysReturn(users, "getUser", testUser);
        alwaysReturn(products, "getProduct", testProducts[0]);
        alwaysReturn(products, "reserveStock", true);
        alwaysReturn(payments, "charge", { success: true, transactionId: "TXN-1" });

        const orderPromise = service.createOrder(1, [{ productId: 101, qty: 1 }]).then(r => r);

        const eventCall = await eventsProbe.expectNext();
        expect(eventCall.args[0]).toBe("orders");

        const payload = eventCall.args[1] as { type: string; order: Order; user: User };
        expect(payload.type).toBe("OrderCreated");
        expect(payload.order.total).toBe(250);
        expect(payload.user.email).toBe("gilad@versatile.ai");

        eventCall.answer(undefined);
        await orderPromise;
    });

    it("does not publish event when payment fails", async () => {
        const { service, users, products, payments, eventsProbe } = createHarness();

        alwaysReturn(users, "getUser", testUser);
        alwaysReturn(products, "getProduct", testProducts[0]);
        alwaysReturn(products, "reserveStock", true);
        alwaysReturn(products, "releaseStock", undefined);
        whenCalled(payments, "charge").thenReturn({ success: false, error: "declined" });

        await expect(service.createOrder(1, [{ productId: 101, qty: 1 }])).rejects.toThrow();

        await eventsProbe.expectNoMsgWithin(0);
    });
});

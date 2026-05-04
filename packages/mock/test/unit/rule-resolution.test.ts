/**
 * Phase 2 tests for the four-tier rule resolution model.
 *
 * Per docs/v2-concepts.md §"Rule Resolution":
 *   Tier 1a — observers (notify-only, FIFO)
 *   Tier 1b — capturing waiters (intercept, FIFO)
 *   Tier 2  — one-shot rules (single global FIFO queue)
 *   Tier 3  — permanent rules (LIFO stack)
 *
 * These scenarios go beyond what v1 supported and validate the v2-only
 * behaviors that emerge from the tiered model.
 */
import { describe, expect, it } from 'vitest';
import { milliseconds } from '@vnatures/test-kit';
import { createProbedMock } from '@vnatures/test-kit-mock';

interface Service {
    charge(amount: number): Promise<{ ok: boolean }>;
    publish(topic: string, event: unknown): Promise<void>;
    getProduct(id: number): Promise<{ id: number; name: string }>;
    reserveStock(id: number, qty: number): Promise<boolean>;
}

describe('Tier 1a — observers fire BEFORE capturing intercepts (same selection)', () => {
    it('observer registered first sees the call before the intercept captures it', async () => {
        const { adapter, probe } = createProbedMock<Service>({
            methods: ['charge', 'publish', 'getProduct', 'reserveStock'],
        });

        const observed: number[] = [];
        const observerPromise = probe.on('charge').expect.observe();
        const interceptPromise = probe.on('charge').expect.intercept();

        void adapter.charge(100);

        const observed1 = await observerPromise;
        observed.push(observed1.args[0] as number);

        const pending = await interceptPromise;
        expect(pending.method).toBe('charge');
        expect(pending.args).toEqual([100]);
        expect(observed).toEqual([100]);

        pending.answer({ ok: true });
    });
});

describe('Tier 2 — sequential one-shot rules fire in registration order (FIFO)', () => {
    it('three sequential once().answer() rules fire 1st-call→1st-rule, 2nd→2nd, 3rd→3rd', async () => {
        const { adapter, probe } = createProbedMock<Service>({
            methods: ['charge', 'publish', 'getProduct', 'reserveStock'],
        });

        probe.on('getProduct').once().answer({ id: 1, name: 'A' });
        probe.on('getProduct').once().answer({ id: 2, name: 'B' });
        probe.on('getProduct').once().answer({ id: 3, name: 'C' });

        await expect(adapter.getProduct(0)).resolves.toEqual({ id: 1, name: 'A' });
        await expect(adapter.getProduct(0)).resolves.toEqual({ id: 2, name: 'B' });
        await expect(adapter.getProduct(0)).resolves.toEqual({ id: 3, name: 'C' });
    });

    it('interleaved one-shots across selections respect FIFO with predicate filtering', async () => {
        const { adapter, probe } = createProbedMock<Service>({
            methods: ['charge', 'publish', 'getProduct', 'reserveStock'],
        });

        probe.on('getProduct').once().answer({ id: 100, name: 'A' });
        probe.on('reserveStock').once().answer(true);
        probe.on('getProduct').once().answer({ id: 200, name: 'B' });

        await expect(adapter.getProduct(0)).resolves.toEqual({ id: 100, name: 'A' });
        await expect(adapter.reserveStock(0, 1)).resolves.toBe(true);
        await expect(adapter.getProduct(0)).resolves.toEqual({ id: 200, name: 'B' });
    });
});

describe('Tier 2 over Tier 3 — one-shot beats permanent unconditionally', () => {
    it('a one-shot installed AFTER a permanent still wins', async () => {
        const { adapter, probe } = createProbedMock<Service>({
            methods: ['charge', 'publish', 'getProduct', 'reserveStock'],
        });

        probe.on('getProduct').always().answer({ id: 999, name: 'permanent' });
        probe.on('getProduct').once().answer({ id: 1, name: 'one-shot' });

        await expect(adapter.getProduct(0)).resolves.toEqual({ id: 1, name: 'one-shot' });
        await expect(adapter.getProduct(0)).resolves.toEqual({ id: 999, name: 'permanent' });
    });

    it('a one-shot installed BEFORE a permanent still wins for the first call', async () => {
        const { adapter, probe } = createProbedMock<Service>({
            methods: ['charge', 'publish', 'getProduct', 'reserveStock'],
        });

        probe.on('getProduct').once().answer({ id: 1, name: 'one-shot' });
        probe.on('getProduct').always().answer({ id: 999, name: 'permanent' });

        await expect(adapter.getProduct(0)).resolves.toEqual({ id: 1, name: 'one-shot' });
        await expect(adapter.getProduct(0)).resolves.toEqual({ id: 999, name: 'permanent' });
    });
});

describe('Tier 3 — permanent rules form a LIFO stack (newest wins)', () => {
    it('a later-installed always() overrides an earlier-installed always()', async () => {
        const { adapter, probe } = createProbedMock<Service>({
            methods: ['charge', 'publish', 'getProduct', 'reserveStock'],
        });

        probe.on('charge').always().answer({ ok: false });
        // The newer rule should win.
        probe.on('charge').always().answer({ ok: true });

        await expect(adapter.charge(100)).resolves.toEqual({ ok: true });
    });
});

describe('expect.observe does NOT consume — observer + permanent both trigger', () => {
    it('observer awaiter resolves AND the permanent rule still fires', async () => {
        const { adapter, probe } = createProbedMock<Service>({
            methods: ['charge', 'publish', 'getProduct', 'reserveStock'],
        });

        probe.on('charge').always().answer({ ok: true });

        const observerPromise = probe.on('charge').expect.observe();
        const callPromise = adapter.charge(50);

        const observed = await observerPromise;
        expect(observed.args).toEqual([50]);

        await expect(callPromise).resolves.toEqual({ ok: true });
    });
});

describe('Filter chain conjunction — filter(p1).filter(p2)', () => {
    it('matches only calls satisfying both predicates', async () => {
        const { adapter, probe } = createProbedMock<Service>({
            methods: ['charge', 'publish', 'getProduct', 'reserveStock'],
        });

        probe.always().park(); // park everything; we'll intercept selectively.

        const selection = probe
            .filter((c) => c.method === 'reserveStock', 'method=reserveStock')
            .filter((c) => (c.args[1] as number) > 5, 'qty>5');

        const pendingPromise = selection.expect.intercept();

        void adapter.reserveStock(1, 3); // doesn't match (qty too low)
        void adapter.reserveStock(1, 10); // matches both predicates

        const pending = await pendingPromise;
        expect(pending.args).toEqual([1, 10]);
        pending.answer(true);
    });

    it('times out if no call matches the conjunction', async () => {
        const { adapter, probe } = createProbedMock<Service>({
            methods: ['charge', 'publish', 'getProduct', 'reserveStock'],
        });

        probe.always().park();

        const selection = probe.filter((c) => c.method === 'charge').filter((c) => (c.args[0] as number) > 1000);

        const promise = selection.expect.intercept({ within: milliseconds(50) });

        void adapter.charge(50); // matches first predicate but not second
        void adapter.publish('topic', 'event'); // doesn't match first

        await expect(promise).rejects.toThrow(/Timed out/);
    });
});

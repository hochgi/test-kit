/**
 * @vnatures/test-kit-kafka — acceptance tests.
 *
 * Mirrors the assertion style in packages/pg-kysely/test/integration/probe.test.ts.
 *
 * Acceptance (from the brief):
 *  1. send → topicLog sees exact bytes/ordering per key.
 *  2. probe reject simulates broker-down.
 *  3. duplicate send appends (no dedup — at-least-once is the consumer's
 *     problem).
 *
 * Also covers: per-partition offsets, sendBatch, intercept/park/forward,
 * connect/disconnect routed through the probe.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRig, type Rig } from '@vnatures/test-kit';
import { brokerDownError, createProbedKafkaProducer, type ProbedKafkaProducer } from '@vnatures/test-kit-kafka';

// eslint-disable-next-line max-lines-per-function -- existing test suite over the published budget; extract on next touch
describe('createProbedKafkaProducer', () => {
    let rig: Rig;
    let kafka: ProbedKafkaProducer;

    beforeEach(() => {
        rig = createRig();
        kafka = rig.attach(createProbedKafkaProducer({ harness: rig, partitionsPerTopic: 4 }));
    });

    afterEach(async () => {
        await rig.close();
    });

    // eslint-disable-next-line max-lines-per-function -- existing test suite over the published budget; extract on next touch
    describe('send → topicLog', () => {
        it('topicLog sees exact bytes/ordering per key', async () => {
            await kafka.adapter.send({
                topic: 'orders',
                messages: [
                    { key: 'cust-A', value: 'o1', headers: { src: 'web' } },
                    { key: 'cust-B', value: 'o2' },
                    { key: 'cust-A', value: 'o3' },
                ],
            });

            const log = kafka.topicLog('orders');
            expect(log).toHaveLength(3);

            // Exact bytes.
            expect(log[0].key!.toString()).toBe('cust-A');
            expect(log[0].value!.toString()).toBe('o1');
            expect(log[0].headers['src'].toString()).toBe('web');
            expect(log[1].key!.toString()).toBe('cust-B');
            expect(log[1].value!.toString()).toBe('o2');

            // Same key → same partition → per-key order preserved.
            const a = log.filter((e) => e.key!.toString() === 'cust-A');
            expect(a.map((e) => e.value!.toString())).toEqual(['o1', 'o3']);
            expect(a.every((e) => e.partition === a[0].partition)).toBe(true);
            expect(a[0].offset).toBeLessThan(a[1].offset);

            // Per-partition offsets are contiguous and monotonic from 0.
            const byPartition = new Map<number, number[]>();
            for (const e of log) {
                const arr = byPartition.get(e.partition) ?? [];
                arr.push(e.offset);
                byPartition.set(e.partition, arr);
            }
            for (const offsets of byPartition.values()) {
                expect(offsets).toEqual(offsets.map((_, i) => i));
            }
            // The two cust-A messages are on the same partition with
            // strictly increasing offsets (per-key order preserved).
            expect(a[0].offset).toBeLessThan(a[1].offset);
        });

        it('string and Buffer values are normalized to Buffer bytes', async () => {
            await kafka.adapter.send({
                topic: 't',
                messages: [
                    { value: 'text', key: 'k' },
                    { value: Buffer.from([0x00, 0xff]), key: 'k' },
                ],
            });

            const log = kafka.topicLog('t');
            expect(log[0].value!.toString('utf-8')).toBe('text');
            expect(Array.from(log[1].value!)).toEqual([0x00, 0xff]);
        });

        it('null value / null key are preserved', async () => {
            await kafka.adapter.send({
                topic: 't',
                messages: [{ value: null, key: null }],
            });
            const log = kafka.topicLog('t');
            expect(log[0].value).toBeNull();
            expect(log[0].key).toBeNull();
        });

        it('array-valued headers are preserved as Buffer[] (H1)', async () => {
            await kafka.adapter.send({
                topic: 't',
                messages: [
                    {
                        value: 'v',
                        headers: {
                            scalar: 's',
                            multi: ['a', 'b'],
                            mixed: [Buffer.from('x'), 'y'],
                        },
                    },
                ],
            });

            const log = kafka.topicLog('t');
            const headers = log[0].headers;

            // Scalar header → single Buffer.
            expect(Array.isArray(headers['scalar'])).toBe(false);
            expect((headers['scalar'] as Buffer).toString()).toBe('s');

            // Array header → Buffer[] with each element preserved.
            expect(Array.isArray(headers['multi'])).toBe(true);
            const multi = headers['multi'] as Buffer[];
            expect(multi).toHaveLength(2);
            expect(multi[0].toString()).toBe('a');
            expect(multi[1].toString()).toBe('b');

            // Mixed Buffer/string array.
            const mixed = headers['mixed'] as Buffer[];
            expect(mixed).toHaveLength(2);
            expect(mixed[0].toString()).toBe('x');
            expect(mixed[1].toString()).toBe('y');
        });
    });

    describe('duplicate send appends (no dedup)', () => {
        it('sending the same key/value twice produces two log entries', async () => {
            await kafka.adapter.send({
                topic: 't',
                messages: [{ key: 'k', value: 'v' }],
            });
            await kafka.adapter.send({
                topic: 't',
                messages: [{ key: 'k', value: 'v' }],
            });

            const log = kafka.topicLog('t');
            expect(log).toHaveLength(2);
            expect(log.map((e) => e.value!.toString())).toEqual(['v', 'v']);
            expect(log[0].offset).toBe(0);
            expect(log[1].offset).toBe(1);
        });
    });

    describe('probe control', () => {
        it('probe reject simulates broker-down; topicLog sees nothing', async () => {
            kafka.probe.on('send').once().reject(brokerDownError());

            await expect(
                kafka.adapter.send({
                    topic: 't',
                    messages: [{ key: 'k', value: 'v' }],
                }),
            ).rejects.toMatchObject({ name: 'KafkaJSBrokerNotFound' });

            expect(kafka.topicLog('t')).toEqual([]);
        });

        it('probe.topic(name) narrows and intercepts a send to a specific topic', async () => {
            kafka.probe.topic('orders').always().park();

            const pendingPromise = kafka.probe.topic('orders').expect.intercept();
            const sendPromise = kafka.adapter.send({
                topic: 'orders',
                messages: [{ value: 'x' }],
            });

            const pending = await pendingPromise;
            expect(pending.method).toBe('send');
            expect(pending.topic).toBe('orders');
            expect(pending.messages?.[0].value).toBe('x');
            pending.forward();
            const meta = (await sendPromise) as unknown as Array<{
                topicName: string;
            }>;
            expect(meta[0].topicName).toBe('orders');
            expect(kafka.topicLog('orders')).toHaveLength(1);
        });

        it('intercept then reject (broker-down) leaves the topic log empty', async () => {
            kafka.probe.on('send').always().park();

            const pendingPromise = kafka.probe.on('send').expect.intercept();
            const sendPromise = kafka.adapter.send({
                topic: 't',
                messages: [{ value: 'y' }],
            });

            const pending = await pendingPromise;
            pending.reject(brokerDownError());
            await expect(sendPromise).rejects.toMatchObject({
                name: 'KafkaJSBrokerNotFound',
            });
            expect(kafka.topicLog('t')).toEqual([]);
        });

        it('records each send in probe.calls with topic and messages', async () => {
            await kafka.adapter.send({ topic: 'a', messages: [{ value: '1' }] });
            await kafka.adapter.send({ topic: 'b', messages: [{ value: '2' }] });

            expect(kafka.probe.calls).toHaveLength(2);
            expect(kafka.probe.calls[0].topic).toBe('a');
            expect(kafka.probe.calls[1].topic).toBe('b');

            expect(kafka.probe.on('send').filter((c) => c.topic === 'a').calls).toHaveLength(1);
        });
    });

    describe('sendBatch', () => {
        it('appends messages across multiple topics and returns metadata', async () => {
            const meta = (await kafka.adapter.sendBatch({
                topicMessages: [
                    { topic: 't1', messages: [{ key: 'k', value: 'a' }] },
                    { topic: 't2', messages: [{ value: 'b' }] },
                ],
            })) as unknown as Array<{ topicName: string }>;

            expect(meta).toHaveLength(2);
            expect(meta.map((m) => m.topicName)).toEqual(['t1', 't2']);
            expect(kafka.topicLog('t1')).toHaveLength(1);
            expect(kafka.topicLog('t2')).toHaveLength(1);
        });
    });

    describe('connect / disconnect', () => {
        it('connect and disconnect are routed through the probe and resolve', async () => {
            await kafka.adapter.connect();
            await kafka.adapter.disconnect();

            expect(kafka.probe.on('connect').calls).toHaveLength(1);
            expect(kafka.probe.on('disconnect').calls).toHaveLength(1);
        });

        it('rejecting connect simulates broker-down at startup', async () => {
            kafka.probe.on('connect').once().reject(brokerDownError());

            await expect(kafka.adapter.connect()).rejects.toMatchObject({
                name: 'KafkaJSBrokerNotFound',
            });
        });
    });

    describe('reset / close', () => {
        it('reset empties topic logs but keeps the adapter usable', async () => {
            await kafka.adapter.send({
                topic: 't',
                messages: [{ value: '1' }],
            });
            expect(kafka.topicLog('t')).toHaveLength(1);

            await kafka.reset();
            expect(kafka.topicLog('t')).toEqual([]);

            // Still usable after reset.
            await kafka.adapter.send({
                topic: 't',
                messages: [{ value: '2' }],
            });
            expect(kafka.topicLog('t')).toHaveLength(1);
            expect(kafka.topicLog('t')[0].value!.toString()).toBe('2');
        });
    });
});

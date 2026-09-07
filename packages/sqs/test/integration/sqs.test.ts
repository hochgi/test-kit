/**
 * @vnatures/test-kit-sqs — acceptance tests.
 *
 * Mirrors the assertion style in packages/pg-kysely/test/integration/probe.test.ts.
 *
 * Acceptance (from the brief):
 *  1. happy produce → consume → ack (send, receive, delete).
 *  2. nacked/unacked message reappears after visibility timeout with
 *     ApproximateReceiveCount 2.
 *  3. long-poll parked until a send arrives.
 *  4. probe can reject a receive to simulate transport failure.
 *
 * Timing is driven by `rig.clock` under vitest fake timers
 * (visibility timeout expiry, long-poll wait). See the backing's header
 * comment for the fake-timer rationale.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    ChangeMessageVisibilityCommand,
    DeleteMessageCommand,
    GetQueueUrlCommand,
    ReceiveMessageCommand,
    SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { createRig, seconds, type Rig } from '@vnatures/test-kit';
import { createProbedSqsAdapter, type ProbedSqsAdapter } from '@vnatures/test-kit-sqs';

const QUEUE_NAME = 'test-queue';

describe('createProbedSqsAdapter', () => {
    let rig: Rig;
    let sqs: ProbedSqsAdapter;

    beforeEach(() => {
        vi.useFakeTimers();
        rig = createRig();
        sqs = rig.attach(
            createProbedSqsAdapter({ harness: rig, queueName: QUEUE_NAME, defaultVisibilityTimeoutSeconds: 30 }),
        );
    });

    afterEach(async () => {
        await rig.close();
        vi.useRealTimers();
    });

    async function send(body: string): Promise<string> {
        const res = (await sqs.adapter.send(new SendMessageCommand({ QueueUrl: sqs.queueUrl, MessageBody: body }))) as {
            MessageId: string;
        };
        return res.MessageId;
    }

    async function receive(opts?: { max?: number; wait?: number; visibilityTimeout?: number }): Promise<
        | {
              Messages?: Array<{
                  MessageId: string;
                  ReceiptHandle: string;
                  Body: string;
                  Attributes?: Record<string, string>;
              }>;
          }
        | undefined
    > {
        return sqs.adapter.send(
            new ReceiveMessageCommand({
                QueueUrl: sqs.queueUrl,
                MaxNumberOfMessages: opts?.max ?? 1,
                WaitTimeSeconds: opts?.wait ?? 0,
                VisibilityTimeout: opts?.visibilityTimeout,
                AttributeNames: ['All'],
            }),
        ) as Promise<ReturnType<typeof receive>>;
    }

    describe('happy produce → consume → ack', () => {
        it('sends, receives the message, and deletes it; a second receive is empty', async () => {
            await send('hello');

            const first = await receive({ max: 1 });
            expect(first?.Messages).toHaveLength(1);
            expect(first?.Messages?.[0].Body).toBe('hello');
            const handle = first!.Messages![0].ReceiptHandle;
            expect(handle).toBeDefined();

            await sqs.adapter.send(new DeleteMessageCommand({ QueueUrl: sqs.queueUrl, ReceiptHandle: handle }));

            // Advancing past the visibility timeout should NOT redeliver — it was deleted.
            await rig.clock.advance(seconds(60));
            const second = await receive({ max: 1 });
            expect(second?.Messages).toBeUndefined();
        });

        it('records each call in probe.calls with commandName and input', async () => {
            await send('a');
            await receive({ max: 1 });

            expect(sqs.probe.calls).toHaveLength(2);
            expect(sqs.probe.calls[0].commandName).toBe('SendMessageCommand');
            expect(sqs.probe.calls[0].input).toMatchObject({ QueueUrl: sqs.queueUrl, MessageBody: 'a' });
            expect(sqs.probe.calls[1].commandName).toBe('ReceiveMessageCommand');
        });
    });

    describe('default receive attributes (no AttributeNames)', () => {
        it('surfaces the three system attributes even when AttributeNames is omitted', async () => {
            await send('attrs');
            const res = (await sqs.adapter.send(
                new ReceiveMessageCommand({ QueueUrl: sqs.queueUrl, MaxNumberOfMessages: 1 }),
            )) as { Messages?: Array<{ Attributes?: Record<string, string> }> };
            const attrs = res.Messages![0].Attributes!;
            expect(attrs.ApproximateReceiveCount).toBe('1');
            expect(attrs.SentTimestamp).toBeDefined();
            // Regression: ApproximateFirstReceiveTimestamp must be surfaced by
            // default (the README documents all three), populated after receive.
            expect(attrs.ApproximateFirstReceiveTimestamp).toBeDefined();
            expect(attrs.ApproximateFirstReceiveTimestamp).not.toBe('');
        });
    });

    describe('deterministic MessageId', () => {
        it('emits a stable counter-based id with no random component', async () => {
            const id1 = await send('one');
            const id2 = await send('two');
            expect(id1).toMatch(/^msg-[0-9a-f]{12}$/);
            expect(id2).toMatch(/^msg-[0-9a-f]{12}$/);
            expect(id1).not.toBe(id2);
        });
    });

    describe('visibility timeout redelivery', () => {
        it('an unacked message reappears after the visibility timeout with ApproximateReceiveCount 2', async () => {
            await send('task');

            const first = await receive({ max: 1, visibilityTimeout: 30 });
            expect(first?.Messages).toHaveLength(1);
            expect(first?.Messages?.[0].Attributes?.ApproximateReceiveCount).toBe('1');
            // Do NOT delete — leave it unacked.

            // Before the timeout: nothing to receive.
            await rig.clock.advance(seconds(10));
            const early = await receive({ max: 1 });
            expect(early?.Messages).toBeUndefined();

            // After the timeout: redelivered with count 2 and a NEW receipt handle.
            await rig.clock.advance(seconds(30));
            const second = await receive({ max: 1 });
            expect(second?.Messages).toHaveLength(1);
            expect(second?.Messages?.[0].Body).toBe('task');
            expect(second?.Messages?.[0].Attributes?.ApproximateReceiveCount).toBe('2');
            expect(second?.Messages?.[0].ReceiptHandle).not.toBe(first!.Messages![0].ReceiptHandle);
        });

        it('a stale receipt handle (from before redelivery) is a no-op on delete', async () => {
            await send('stale');

            const first = await receive({ max: 1, visibilityTimeout: 30 });
            const staleHandle = first!.Messages![0].ReceiptHandle;

            // Let it become visible again (redeliverable), then receive with a fresh handle.
            await rig.clock.advance(seconds(30));
            await receive({ max: 1 });

            // Deleting with the stale handle is a no-op: message still present.
            await sqs.adapter.send(new DeleteMessageCommand({ QueueUrl: sqs.queueUrl, ReceiptHandle: staleHandle }));
            await rig.clock.advance(seconds(31));
            const third = await receive({ max: 1 });
            expect(third?.Messages).toHaveLength(1);

            // Deleting with the CURRENT handle (from the most recent receive)
            // removes it for good.
            const currentHandle = third!.Messages![0].ReceiptHandle;
            await sqs.adapter.send(new DeleteMessageCommand({ QueueUrl: sqs.queueUrl, ReceiptHandle: currentHandle }));
            await rig.clock.advance(seconds(31));
            const fourth = await receive({ max: 1 });
            expect(fourth?.Messages).toBeUndefined();
        });

        it('ChangeMessageVisibility(0) makes a received message immediately visible again', async () => {
            await send('reset-vt');

            const first = await receive({ max: 1, visibilityTimeout: 30 });
            const handle = first!.Messages![0].ReceiptHandle;

            await sqs.adapter.send(
                new ChangeMessageVisibilityCommand({
                    QueueUrl: sqs.queueUrl,
                    ReceiptHandle: handle,
                    VisibilityTimeout: 0,
                }),
            );

            // No time advance needed — VT was reset to 0.
            const again = await receive({ max: 1 });
            expect(again?.Messages).toHaveLength(1);
            expect(again?.Messages?.[0].Attributes?.ApproximateReceiveCount).toBe('2');
        });
    });

    describe('long-poll', () => {
        it('a receive with WaitTimeSeconds parks until a send arrives', async () => {
            // Start a long-poll receive with no messages available.
            const parked = receive({ max: 1, wait: 20 });

            // Let a microtask flush; the receive should be parked (unresolved).
            await Promise.resolve();
            // Advancing less than the wait window must NOT resolve it (no message).
            await rig.clock.advance(seconds(5));
            // Pending still — but we can't easily assert "pending"; instead, deliver.
            const sendPromise = sqs.adapter.send(
                new SendMessageCommand({ QueueUrl: sqs.queueUrl, MessageBody: 'late' }),
            );
            await sendPromise;

            const result = (await parked) as { Messages?: Array<{ Body: string }> };
            expect(result.Messages).toHaveLength(1);
            expect(result.Messages?.[0].Body).toBe('late');

            // The wait timer must have been cancelled — advancing past the wait
            // window must not produce a spurious second resolution. A subsequent
            // receive should be empty (the message was delivered to the parked one).
            await rig.clock.advance(seconds(25));
            const next = await receive({ max: 1 });
            // The delivered message is now invisible (visibility timeout); nothing available.
            expect(next?.Messages).toBeUndefined();
        });

        it('a parked receive resolves with empty when the wait window elapses with no send', async () => {
            const parked = receive({ max: 1, wait: 10 });

            await rig.clock.advance(seconds(10));

            const result = (await parked) as { Messages?: unknown };
            expect(result.Messages).toBeUndefined();
        });

        it('two concurrent long-poll receives are both served (M1)', async () => {
            // Park two receives on an empty queue.
            const parkedA = receive({ max: 1, wait: 20 });
            const parkedB = receive({ max: 1, wait: 20 });
            await Promise.resolve(); // let microtasks flush

            // Send two messages — both parked receives should be served.
            await send('msg-a');
            await send('msg-b');

            const [resultA, resultB] = await Promise.all([parkedA, parkedB]);
            const bodies = [
                (resultA as { Messages?: Array<{ Body: string }> })?.Messages?.[0]?.Body,
                (resultB as { Messages?: Array<{ Body: string }> })?.Messages?.[0]?.Body,
            ].sort();
            expect(bodies).toEqual(['msg-a', 'msg-b']);
        });

        it('reset() resolves a parked long-poll with empty instead of hanging (L1)', async () => {
            // Start a long-poll that will be interrupted by reset.
            const parked = receive({ max: 1, wait: 30 });
            await Promise.resolve(); // let it park

            // Reset must settle the parked receive, not leave it dangling.
            await sqs.reset();

            // The parked promise must resolve (not hang).
            const result = (await parked) as { Messages?: unknown };
            expect(result.Messages).toBeUndefined();
        });
    });

    describe('probe control', () => {
        it('probe can reject a receive to simulate transport failure', async () => {
            await send('x');

            sqs.probe.command(ReceiveMessageCommand).once().reject(new Error('transport failure'));

            await expect(sqs.adapter.send(new ReceiveMessageCommand({ QueueUrl: sqs.queueUrl }))).rejects.toThrow(
                'transport failure',
            );

            // After the one-shot rejection, the default forward resumes; the
            // message is still there (the rejected receive never consumed it).
            const res = (await sqs.adapter.send(
                new ReceiveMessageCommand({ QueueUrl: sqs.queueUrl, AttributeNames: ['All'] }),
            )) as { Messages?: Array<{ Body: string }> };
            expect(res.Messages).toHaveLength(1);
            expect(res.Messages?.[0].Body).toBe('x');
        });

        it('probe.command(ctor) narrows and intercepts a send', async () => {
            sqs.probe.command(SendMessageCommand).always().park();

            const pendingPromise = sqs.probe.command(SendMessageCommand).expect.intercept();
            const sendPromise = sqs.adapter.send(
                new SendMessageCommand({ QueueUrl: sqs.queueUrl, MessageBody: 'intercepted' }),
            );

            const pending = await pendingPromise;
            expect(pending.commandName).toBe('SendMessageCommand');
            expect((pending.input as { MessageBody: string }).MessageBody).toBe('intercepted');
            pending.forward();
            const res = (await sendPromise) as { MessageId: string };
            expect(res.MessageId).toBeDefined();
        });

        it('GetQueueUrlCommand returns the configured queue URL', async () => {
            const res = (await sqs.adapter.send(new GetQueueUrlCommand({ QueueName: QUEUE_NAME }))) as {
                QueueUrl: string;
            };
            expect(res.QueueUrl).toBe(sqs.queueUrl);
        });
    });
});

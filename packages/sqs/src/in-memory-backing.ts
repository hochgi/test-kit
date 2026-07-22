/**
 * Functional in-memory SQS backing (bull-pattern), not elasticmq/localstack.
 *
 * Implements the standard-queue semantics the consumer exercises:
 *  - visibility timeout: a received message is invisible until the timeout
 *    elapses, then becomes redeliverable with an incremented
 *    `ApproximateReceiveCount`.
 *  - long-poll receive: a receive with `WaitTimeSeconds > 0` and no available
 *    message parks until a message arrives or the wait window elapses.
 *  - `DeleteMessage` by receipt handle; a stale handle (from an earlier
 *    receive, before redelivery) is a no-op, matching real SQS.
 *  - `ChangeMessageVisibility` reschedules the visibility timeout (0 = visible
 *    immediately).
 *  - `DelaySeconds` on send delays first visibility.
 *
 * FIFO is intentionally NOT implemented (consumer uses standard queues).
 *
 * Timing is fake-timer friendly: scheduling uses the ambient `setTimeout`
 * (so it follows whatever timer system the test installs — vitest/jest fake
 * timers, sinon, or real) and deadlines are computed against `clock.now()`.
 * Drive visibility expiry and long-poll waits with `harness.clock.advance(...)`
 * under fake timers. This mirrors the bull in-memory backing's approach.
 */
import type { Clock } from '@vnatures/test-kit';

/** Default visibility timeout (seconds) when neither queue nor receive set it. */
export const DEFAULT_VISIBILITY_TIMEOUT_SECONDS = 30;
/** SQS hard limit on messages returned per receive. */
export const MAX_MESSAGES_PER_RECEIVE = 10;
/** SQS default wait for a short poll. */
export const DEFAULT_WAIT_TIME_SECONDS = 0;

interface SqsMessageAttributeValue {
    readonly DataType?: string;
    readonly StringValue?: string;
    readonly BinaryValue?: Uint8Array;
    readonly StringListValues?: ReadonlyArray<string>;
    readonly BinaryListValues?: ReadonlyArray<Uint8Array>;
}

interface SqsStoredMessage {
    readonly messageId: string;
    body: string;
    messageAttributes: Record<string, SqsMessageAttributeValue>;
    readonly sentAt: number;
    receiveCount: number;
    firstReceiveAt: number | undefined;
    /** 0 = visible now; otherwise the `clock.now()` ms timestamp when visible. */
    visibleAt: number;
    /** The receipt handle issued on the most recent receive; stale once redelivered. */
    currentReceiptHandle: string | undefined;
    /** Pending visibility-timeout timer; cancelled on delete / visibility change. */
    visibilityTimer: ReturnType<typeof setTimeout> | undefined;
}

interface ParkedReceive {
    readonly resolve: (result: unknown) => void;
    readonly maxNumberOfMessages: number;
    readonly visibilityTimeoutSeconds: number;
    readonly attributeNames: ReadonlyArray<string> | undefined;
    readonly messageAttributeNames: ReadonlyArray<string> | undefined;
    waitTimer: ReturnType<typeof setTimeout> | undefined;
    settled: boolean;
}

interface SqsQueue {
    readonly url: string;
    readonly name: string;
    defaultVisibilityTimeoutSeconds: number;
    messages: SqsStoredMessage[];
    parkedReceives: ParkedReceive[];
}

/** Commands the backing implements end-to-end. */
export const SUPPORTED_SQS_COMMANDS: ReadonlySet<string> = new Set([
    'SendMessageCommand',
    'ReceiveMessageCommand',
    'DeleteMessageCommand',
    'ChangeMessageVisibilityCommand',
    'GetQueueUrlCommand',
    'CreateQueueCommand',
]);

export class InMemorySqsBacking {
    private readonly queues = new Map<string, SqsQueue>();
    private readonly clock: Clock;
    private nextMessageId = 1;
    private nextReceiptHandle = 1;

    constructor(clock: Clock, initialQueue?: { name: string; url: string; defaultVisibilityTimeoutSeconds?: number }) {
        this.clock = clock;
        if (initialQueue) this.ensureQueue(initialQueue.url, initialQueue.name, initialQueue.defaultVisibilityTimeoutSeconds);
    }

    /** Wipe every queue's messages and cancel pending timers. */
    reset(): void {
        for (const q of this.queues.values()) {
            for (const m of q.messages) {
                if (m.visibilityTimer) clearTimeout(m.visibilityTimer);
            }
            this.settleParkedReceives(q);
            q.messages = [];
        }
    }

    /** Drop everything — queues and messages. */
    clear(): void {
        for (const q of this.queues.values()) {
            for (const m of q.messages) {
                if (m.visibilityTimer) clearTimeout(m.visibilityTimer);
            }
            this.settleParkedReceives(q);
        }
        this.queues.clear();
    }

    /** Direct test fixture: enqueue a visible message without going through dispatch. */
    putMessage(queueUrl: string, body: string, messageAttributes?: Record<string, SqsMessageAttributeValue>): string {
        const q = this.ensureQueue(queueUrl);
        const messageId = this.makeMessageId();
        q.messages.push({
            messageId,
            body,
            messageAttributes: messageAttributes ?? {},
            sentAt: this.clock.now(),
            receiveCount: 0,
            firstReceiveAt: undefined,
            visibleAt: 0,
            currentReceiptHandle: undefined,
            visibilityTimer: undefined,
        });
        return messageId;
    }

    getQueue(queueUrl: string): SqsQueue | undefined {
        return this.queues.get(queueUrl);
    }

    /**
     * Dispatch a command (identified by constructor name) against the backing.
     * Returns a Promise mirroring the AWS SDK response shape, or `undefined`
     * when the command is not supported (the caller decides loud-failure).
     */
    async dispatch(commandName: string, input: unknown): Promise<unknown> {
        const i = (input ?? {}) as Record<string, unknown>;
        switch (commandName) {
            case 'SendMessageCommand':
                return this.handleSend(i);
            case 'ReceiveMessageCommand':
                return this.handleReceive(i);
            case 'DeleteMessageCommand':
                return this.handleDelete(i);
            case 'ChangeMessageVisibilityCommand':
                return this.handleChangeVisibility(i);
            case 'GetQueueUrlCommand':
                return this.handleGetQueueUrl(i);
            case 'CreateQueueCommand':
                return this.handleCreateQueue(i);
            default:
                return undefined;
        }
    }

    // ── Per-command handlers ───────────────────────────────────────────────

    private handleSend(input: Record<string, unknown>): Record<string, unknown> {
        const queueUrl = input.QueueUrl as string;
        const q = this.ensureQueue(queueUrl);
        const body = input.MessageBody as string;
        const delaySeconds = (input.DelaySeconds as number | undefined) ?? 0;
        const messageAttributes =
            (input.MessageAttributes as Record<string, SqsMessageAttributeValue> | undefined) ?? {};
        const messageId = this.makeMessageId();
        const now = this.clock.now();
        const visibleAt = delaySeconds > 0 ? now + delaySeconds * 1000 : 0;

        const msg: SqsStoredMessage = {
            messageId,
            body,
            messageAttributes,
            sentAt: now,
            receiveCount: 0,
            firstReceiveAt: undefined,
            visibleAt,
            currentReceiptHandle: undefined,
            visibilityTimer: undefined,
        };
        q.messages.push(msg);

        if (delaySeconds > 0) {
            this.scheduleRedelivery(msg, queueUrl, delaySeconds * 1000);
        } else {
            // Immediately available — a parked long-poll may pick it up.
            this.maybePumpParked(queueUrl);
        }

        return {
            MessageId: messageId,
            MD5OfMessageBody: md5ish(body),
            ...(Object.keys(messageAttributes).length > 0 ? { MD5OfMessageAttributes: md5ish(JSON.stringify(messageAttributes)) } : {}),
        };
    }

    private handleReceive(input: Record<string, unknown>): Promise<unknown> {
        const queueUrl = input.QueueUrl as string;
        const q = this.ensureQueue(queueUrl);
        const maxNumberOfMessages = clampInt(
            (input.MaxNumberOfMessages as number | undefined) ?? 1,
            1,
            MAX_MESSAGES_PER_RECEIVE,
        );
        const visibilityTimeoutSeconds =
            (input.VisibilityTimeout as number | undefined) ?? q.defaultVisibilityTimeoutSeconds;
        const waitTimeSeconds = (input.WaitTimeSeconds as number | undefined) ?? DEFAULT_WAIT_TIME_SECONDS;
        const attributeNames = normalizeAttributeNames(
            (input.MessageSystemAttributeNames as ReadonlyArray<string> | undefined) ??
                (input.AttributeNames as ReadonlyArray<string> | undefined),
        );
        const messageAttributeNames = (input.MessageAttributeNames as ReadonlyArray<string> | undefined) ?? undefined;

        const deliver = (count: number): unknown => {
            const picked = this.takeAvailable(q, count, visibilityTimeoutSeconds);
            if (picked.length === 0) return { Messages: undefined };
            return {
                Messages: picked.map((m) => this.shapeReceivedMessage(m, attributeNames, messageAttributeNames)),
            };
        };

        const available = this.countAvailable(q, maxNumberOfMessages);
        if (available > 0) {
            return Promise.resolve(deliver(maxNumberOfMessages));
        }

        // Nothing available right now.
        if (waitTimeSeconds <= 0) {
            return Promise.resolve({ Messages: undefined });
        }

        // Long-poll: park until a message arrives or the wait window elapses.
        return new Promise<unknown>((resolve) => {
            const parked: ParkedReceive = {
                resolve,
                maxNumberOfMessages,
                visibilityTimeoutSeconds,
                attributeNames,
                messageAttributeNames,
                waitTimer: undefined,
                settled: false,
            };
            parked.waitTimer = setTimeout(() => {
                if (parked.settled) return;
                parked.settled = true;
                // Remove from the FIFO array.
                const idx = q.parkedReceives.indexOf(parked);
                if (idx >= 0) q.parkedReceives.splice(idx, 1);
                resolve({ Messages: undefined });
            }, waitTimeSeconds * 1000);
            q.parkedReceives.push(parked);
        });
    }

    private handleDelete(input: Record<string, unknown>): Record<string, unknown> {
        const queueUrl = input.QueueUrl as string;
        const receiptHandle = input.ReceiptHandle as string;
        const q = this.queues.get(queueUrl);
        if (q) {
            const idx = q.messages.findIndex((m) => m.currentReceiptHandle === receiptHandle);
            if (idx >= 0) {
                const [removed] = q.messages.splice(idx, 1);
                if (removed.visibilityTimer) clearTimeout(removed.visibilityTimer);
            }
            // A stale handle (no match) is a no-op, like real SQS.
        }
        return {};
    }

    private handleChangeVisibility(input: Record<string, unknown>): Record<string, unknown> {
        const queueUrl = input.QueueUrl as string;
        const receiptHandle = input.ReceiptHandle as string;
        const visibilityTimeoutSeconds = (input.VisibilityTimeout as number | undefined) ?? 0;
        const q = this.queues.get(queueUrl);
        if (q) {
            const msg = q.messages.find((m) => m.currentReceiptHandle === receiptHandle);
            if (msg) {
                if (visibilityTimeoutSeconds <= 0) {
                    if (msg.visibilityTimer) clearTimeout(msg.visibilityTimer);
                    msg.visibilityTimer = undefined;
                    msg.visibleAt = 0;
                    this.maybePumpParked(queueUrl);
                } else {
                    msg.visibleAt = this.clock.now() + visibilityTimeoutSeconds * 1000;
                    this.scheduleRedelivery(msg, queueUrl, visibilityTimeoutSeconds * 1000);
                }
            }
            // Stale handle: no-op.
        }
        return {};
    }

    private handleGetQueueUrl(input: Record<string, unknown>): Record<string, unknown> {
        const queueName = input.QueueName as string;
        const q = this.findByQueueName(queueName) ?? this.ensureQueue(defaultQueueUrl(queueName), queueName);
        return { QueueUrl: q.url };
    }

    private handleCreateQueue(input: Record<string, unknown>): Record<string, unknown> {
        const queueName = input.QueueName as string;
        const url = defaultQueueUrl(queueName);
        const attrs = (input.Attributes as Record<string, string> | undefined) ?? {};
        const vt = attrs['VisibilityTimeout'] ? parseInt(attrs['VisibilityTimeout'], 10) : undefined;
        this.ensureQueue(url, queueName, vt);
        return { QueueUrl: url };
    }

    // ── Helpers ────────────────────────────────────────────────────────────

    private ensureQueue(
        url: string,
        name?: string,
        defaultVisibilityTimeoutSeconds?: number,
    ): SqsQueue {
        let q = this.queues.get(url);
        if (!q) {
            q = {
                url,
                name: name ?? deriveQueueName(url),
                defaultVisibilityTimeoutSeconds: defaultVisibilityTimeoutSeconds ?? DEFAULT_VISIBILITY_TIMEOUT_SECONDS,
                messages: [],
                parkedReceives: [],
            };
            this.queues.set(url, q);
        }
        return q;
    }

    private findByQueueName(name: string): SqsQueue | undefined {
        for (const q of this.queues.values()) {
            if (q.name === name) return q;
        }
        return undefined;
    }

    /**
     * Peek: count how many messages are currently visible (without consuming).
     * Stops at `count`.
     */
    private countAvailable(q: SqsQueue, count: number): number {
        const now = this.clock.now();
        let n = 0;
        for (const msg of q.messages) {
            if (n >= count) break;
            if (msg.visibleAt <= now) n += 1;
        }
        return n;
    }

    /**
     * Consume up to `count` visible messages: apply the visibility timeout
     * to each, issue a fresh receipt handle, and schedule redelivery. Returns
     * the picked messages in queue order.
     */
    private takeAvailable(q: SqsQueue, count: number, visibilityTimeoutSeconds: number): SqsStoredMessage[] {
        const now = this.clock.now();
        const picked: SqsStoredMessage[] = [];
        for (const msg of q.messages) {
            if (picked.length >= count) break;
            if (msg.visibleAt <= now) {
                msg.receiveCount += 1;
                if (msg.firstReceiveAt === undefined) msg.firstReceiveAt = now;
                msg.currentReceiptHandle = this.makeReceiptHandle();
                msg.visibleAt = now + visibilityTimeoutSeconds * 1000;
                this.scheduleRedelivery(msg, q.url, visibilityTimeoutSeconds * 1000);
                picked.push(msg);
            }
        }
        return picked;
    }

    private shapeReceivedMessage(
        msg: SqsStoredMessage,
        attributeNames: ReadonlyArray<string> | undefined,
        messageAttributeNames: ReadonlyArray<string> | undefined,
    ): Record<string, unknown> {
        const allAttrs: Record<string, string> = {
            ApproximateReceiveCount: String(msg.receiveCount),
            SentTimestamp: String(Math.floor(msg.sentAt)),
            ApproximateFirstReceiveTimestamp: msg.firstReceiveAt !== undefined ? String(Math.floor(msg.firstReceiveAt)) : '',
        };
        const attrs = filterAttributes(allAttrs, attributeNames);

        let messageAttributes: Record<string, SqsMessageAttributeValue> = msg.messageAttributes;
        if (messageAttributeNames && !messageAttributeNames.includes('All') && !messageAttributeNames.includes('.*')) {
            const filtered: Record<string, SqsMessageAttributeValue> = {};
            for (const k of messageAttributeNames) {
                if (msg.messageAttributes[k]) filtered[k] = msg.messageAttributes[k];
            }
            messageAttributes = filtered;
        }

        const out: Record<string, unknown> = {
            MessageId: msg.messageId,
            ReceiptHandle: msg.currentReceiptHandle,
            Body: msg.body,
            MD5OfBody: md5ish(msg.body),
        };
        if (Object.keys(attrs).length > 0) out.Attributes = attrs;
        if (Object.keys(messageAttributes).length > 0) {
            out.MessageAttributes = messageAttributes;
            out.MD5OfMessageAttributes = md5ish(JSON.stringify(messageAttributes));
        }
        return out;
    }

    /**
     * (Re)schedule a message to become visible after `delayMs`, clearing any
     * existing timer first. Shared by send (DelaySeconds), receive redelivery,
     * and ChangeMessageVisibility so the redelivery mechanics live in one place.
     */
    private scheduleRedelivery(msg: SqsStoredMessage, queueUrl: string, delayMs: number): void {
        if (msg.visibilityTimer) clearTimeout(msg.visibilityTimer);
        msg.visibilityTimer = setTimeout(() => {
            msg.visibilityTimer = undefined;
            msg.visibleAt = 0;
            this.maybePumpParked(queueUrl);
        }, delayMs);
    }

    /**
     * If long-poll receives are parked on this queue and at least one message
     * is now available, deliver to waiters oldest-first until messages run
     * out or all waiters are served.
     */
    private maybePumpParked(queueUrl: string): void {
        const q = this.queues.get(queueUrl);
        if (!q || q.parkedReceives.length === 0) return;

        while (q.parkedReceives.length > 0) {
            const parked = q.parkedReceives[0];
            if (parked.settled) {
                q.parkedReceives.shift();
                continue;
            }
            if (this.countAvailable(q, parked.maxNumberOfMessages) <= 0) break;
            // Consume and deliver.
            q.parkedReceives.shift();
            if (parked.waitTimer) clearTimeout(parked.waitTimer);
            parked.settled = true;
            const picked = this.takeAvailable(q, parked.maxNumberOfMessages, parked.visibilityTimeoutSeconds);
            parked.resolve({
                Messages: picked.length > 0
                    ? picked.map((m) => this.shapeReceivedMessage(m, parked.attributeNames, parked.messageAttributeNames))
                    : undefined,
            });
        }
    }

    /** Resolve all parked receives with an empty response (used by reset/clear). */
    private settleParkedReceives(q: SqsQueue): void {
        for (const parked of q.parkedReceives) {
            if (!parked.settled) {
                parked.settled = true;
                if (parked.waitTimer) clearTimeout(parked.waitTimer);
                parked.resolve({ Messages: undefined });
            }
        }
        q.parkedReceives = [];
    }

    private makeMessageId(): string {
        const n = this.nextMessageId;
        this.nextMessageId += 1;
        // SQS-style MessageId is a UUID; we emit a deterministic hex-ish id
        // (monotonic counter, no randomness) so snapshot-style assertions stay
        // stable across runs.
        return `msg-${n.toString(16).padStart(12, '0')}`;
    }

    private makeReceiptHandle(): string {
        const n = this.nextReceiptHandle;
        this.nextReceiptHandle += 1;
        return `rh-${n.toString(36)}-${Math.random().toString(16).slice(2, 10)}`;
    }
}

// ── Pure helpers ───────────────────────────────────────────────────────────

function clampInt(v: number, lo: number, hi: number): number {
    const n = Math.floor(v);
    if (Number.isNaN(n)) return lo;
    return Math.max(lo, Math.min(hi, n));
}

function normalizeAttributeNames(names: ReadonlyArray<string> | undefined): ReadonlyArray<string> | undefined {
    if (!names || names.length === 0) return undefined;
    return names;
}

function filterAttributes(
    all: Record<string, string>,
    names: ReadonlyArray<string> | undefined,
): Record<string, string> {
    if (!names) {
        // Default: surface the three system attributes the README documents
        // (ApproximateReceiveCount / SentTimestamp / ApproximateFirstReceiveTimestamp).
        return {
            ApproximateReceiveCount: all.ApproximateReceiveCount,
            SentTimestamp: all.SentTimestamp,
            ApproximateFirstReceiveTimestamp: all.ApproximateFirstReceiveTimestamp,
        };
    }
    if (names.includes('All') || names.includes('.*')) return all;
    const out: Record<string, string> = {};
    for (const n of names) {
        if (all[n] !== undefined) out[n] = all[n];
    }
    return out;
}

function defaultQueueUrl(queueName: string): string {
    return `https://sqs.test/000000000000/${queueName}`;
}

function deriveQueueName(url: string): string {
    const slash = url.lastIndexOf('/');
    return slash >= 0 ? url.slice(slash + 1) : url;
}

/**
 * Stable, non-cryptographic MD5-ish digest for response parity. Tests rarely
 * pin these values; the shape (32 hex chars) is what matters.
 */
function md5ish(s: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i += 1) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    const hex = h.toString(16).padStart(8, '0');
    return (hex + hex + hex + hex).slice(0, 32);
}

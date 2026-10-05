/**
 * Functional in-memory Kafka backing — an append-only topic log per topic,
 * partitioned by key hash. No broker, no Zookeeper, no Docker.
 *
 * Partitioning matches kafkajs' default partitioner contract:
 *  - an explicit `message.partition` wins (clamped to `[0, partitionsPerTopic)`);
 *  - else a keyed message is hashed (`murmur2`-compatible modulo) to a
 *    partition — same key ⇒ same partition ⇒ stable per-key ordering;
 *  - a keyless, partition-less message goes to partition 0.
 *
 * No dedup: duplicate sends append (at-least-once is the consumer's
 * problem), matching the brief.
 *
 * Offsets are per-(topic, partition), monotonic from 0.
 */
import type { Clock } from '@hochgi/test-kit';
import type { KafkaMessageInput, ProducerBatch, RecordMetadata, TopicLogEntry } from './types.js';

interface StoredEntry extends TopicLogEntry {}

interface TopicState {
    readonly topic: string;
    entries: StoredEntry[];
    /** Per-partition next offset. */
    nextOffset: number[];
}

export interface CreateInMemoryKafkaBackingOptions {
    /** Number of partitions per topic (default 4). */
    readonly partitionsPerTopic?: number;
    /** Clock used for default message timestamps (default: wall-clock Date.now()). */
    readonly clock?: Clock;
}

export class InMemoryKafkaBacking {
    private readonly topics = new Map<string, TopicState>();
    private readonly partitionsPerTopic: number;
    private readonly clock: Clock | undefined;
    private appendCounter = 0;

    constructor(options?: CreateInMemoryKafkaBackingOptions) {
        this.partitionsPerTopic = options?.partitionsPerTopic ?? 4;
        this.clock = options?.clock;
    }

    /** Wipe every topic log. */
    reset(): void {
        this.topics.clear();
        this.appendCounter = 0;
    }

    /** Drop everything. */
    clear(): void {
        this.topics.clear();
        this.appendCounter = 0;
    }

    /** Append a single `send`'s messages; returns kafkajs-shaped RecordMetadata[]. */
    appendSend(topic: string, messages: ReadonlyArray<KafkaMessageInput>): RecordMetadata[] {
        const state = this.ensureTopic(topic);
        const metadata: RecordMetadata[] = [];
        for (const msg of messages) {
            const partition = this.resolvePartition(msg);
            const offset = state.nextOffset[partition];
            state.nextOffset[partition] = offset + 1;
            const entry: StoredEntry = {
                topic,
                partition,
                offset,
                key: toBuffer(msg.key),
                value: toBuffer(msg.value),
                headers: normalizeHeaders(msg.headers),
                timestamp: msg.timestamp ?? String(this.clock?.now() ?? Date.now()),
                appendIndex: this.appendCounter,
            };
            this.appendCounter += 1;
            state.entries.push(entry);
            metadata.push({
                topicName: topic,
                partition,
                errorCode: 0,
                offset: String(offset),
                timestamp: entry.timestamp,
            });
        }
        return metadata;
    }

    /** Append a `sendBatch`'s topic-messages; returns kafkajs-shaped RecordMetadata[]. */
    appendBatch(batch: ProducerBatch): RecordMetadata[] {
        const out: RecordMetadata[] = [];
        for (const tm of batch.topicMessages ?? []) {
            out.push(...this.appendSend(tm.topic, tm.messages));
        }
        return out;
    }

    /**
     * Read the topic log for assertions. Entries are returned in global
     * append (send) order; each carries its `partition` and per-partition
     * `offset`, so per-key / per-partition ordering is preserved and
     * trivially filterable.
     */
    topicLog(topic: string): TopicLogEntry[] {
        const state = this.topics.get(topic);
        if (!state) return [];
        // Return a defensive copy in append order.
        return state.entries.slice();
    }

    /** All topics that have received at least one message. */
    topicsWithMessages(): string[] {
        return Array.from(this.topics.keys()).filter((t) => this.topics.get(t)!.entries.length > 0);
    }

    // ── Helpers ────────────────────────────────────────────────────────────

    private ensureTopic(topic: string): TopicState {
        let state = this.topics.get(topic);
        if (!state) {
            state = {
                topic,
                entries: [],
                nextOffset: new Array(this.partitionsPerTopic).fill(0),
            };
            this.topics.set(topic, state);
        }
        return state;
    }

    private resolvePartition(msg: KafkaMessageInput): number {
        if (msg.partition !== undefined) {
            return clampPartition(msg.partition, this.partitionsPerTopic);
        }
        if (msg.key !== undefined && msg.key !== null) {
            const keyBytes = toBuffer(msg.key);
            if (keyBytes !== null) {
                // Hash the RAW key bytes — kafkajs' DefaultPartitioner does the
                // same. `& 0x7fffffff` (kafkajs' `toPositive`) makes binary /
                // non-UTF-8 keys land on the same partition as production.
                return (murmur2(keyBytes) & 0x7fffffff) % this.partitionsPerTopic;
            }
        }
        return 0;
    }
}

// ── Pure helpers ───────────────────────────────────────────────────────────

type HeaderValue = Buffer | string | (Buffer | string)[] | undefined;
type HeadersInput = Readonly<Record<string, HeaderValue>>;

function toBuffer(v: Buffer | string | null | undefined): Buffer | null {
    if (v === undefined || v === null) return null;
    if (Buffer.isBuffer(v)) return v;
    // Only `string` remains in the kafkajs type union (Buffer | string | null | undefined).
    return Buffer.from(v, 'utf-8');
}

/** Normalize a single header value (scalar or array) to Buffer(s). */
function toHeaderValue(v: HeaderValue): Buffer | Buffer[] {
    if (v === undefined) return Buffer.alloc(0);
    if (Array.isArray(v)) {
        return v.map((el) => toBuffer(el)).filter((b): b is Buffer => b !== null);
    }
    return toBuffer(v) ?? Buffer.alloc(0);
}

function normalizeHeaders(headers: HeadersInput | undefined): Readonly<Record<string, Buffer | Buffer[]>> {
    if (!headers) return {};
    const out: Record<string, Buffer | Buffer[]> = {};
    for (const [k, v] of Object.entries(headers)) {
        out[k] = toHeaderValue(v);
    }
    return out;
}

function clampPartition(p: number, partitions: number): number {
    const n = Math.floor(p);
    if (Number.isNaN(n)) return 0;
    // Real Kafka rejects out-of-range partitions; the in-memory backing
    // clamps to a valid partition so tests don't need to coordinate the
    // exact partition count unless they're asserting on it.
    return ((n % partitions) + partitions) % partitions;
}

/**
 * Murmur2 (32-bit) hash — the algorithm kafkajs' DefaultPartitioner uses
 * (via `murmur2` from its `utils`), reproduced here so same-key messages
 * deterministically land on the same partition without importing kafkajs
 * internals. The exact partition index is not load-bearing for tests
 * (they assert per-key ordering, not specific partition numbers), but
 * using the canonical hash keeps behavior faithful.
 */
function murmur2(data: Buffer): number {
    const totalLength = data.length;
    const seed = 0x9747b28c;
    // m and r are constants for murmur2
    const m = 0x5bd1e995;
    const r = 24;

    let h = seed ^ totalLength;
    let i = 0;
    let remaining = totalLength;
    while (remaining >= 4) {
        let k =
            (data[i] & 0xff) |
            ((data[i + 1] & 0xff) << 8) |
            ((data[i + 2] & 0xff) << 16) |
            ((data[i + 3] & 0xff) << 24);
        k = Math.imul(k, m);
        k ^= k >>> r;
        k = Math.imul(k, m);
        h = Math.imul(h, m) ^ k;
        i += 4;
        remaining -= 4;
    }
    // Handle the last few bytes.
    if (remaining >= 3) h ^= (data[i + 2] & 0xff) << 16;
    if (remaining >= 2) h ^= (data[i + 1] & 0xff) << 8;
    if (remaining >= 1) {
        h ^= data[i] & 0xff;
        h = Math.imul(h, m);
    }
    h ^= h >>> 13;
    h = Math.imul(h, m);
    h ^= h >>> 15;
    return h >>> 0;
}

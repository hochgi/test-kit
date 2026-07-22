import type {
    ForwardablePendingCall,
    ForwardableProbe,
    ForwardableSelection,
} from '@vnatures/test-kit';
import type {
    Message as KafkaMessageInput,
    ProducerBatch,
    ProducerRecord,
    RecordMetadata,
} from 'kafkajs';

// Re-export the kafkajs shapes consumers build against at the producer
// boundary, so they don't need a second import site.
export type { KafkaMessageInput, ProducerBatch, ProducerRecord, RecordMetadata };

/**
 * The application-facing producer boundary. Matches kafkajs'
 * `producer().send({ topic, messages })` shape (plus `sendBatch`,
 * `connect`, `disconnect`).
 */
export interface KafkaProducer {
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    send(record: ProducerRecord): Promise<RecordMetadata[]>;
    sendBatch(batch: ProducerBatch): Promise<RecordMetadata[]>;
}

export type KafkaMethod = 'send' | 'sendBatch' | 'connect' | 'disconnect';

/**
 * One recorded producer call. `topic`/`messages` are extracted for the
 * `send` method so the probe can filter by topic without digging into
 * `args`; `args` carries the raw arguments for completeness.
 */
export interface KafkaCall {
    readonly method: KafkaMethod;
    readonly topic: string | undefined;
    readonly messages: ReadonlyArray<KafkaMessageInput> | undefined;
    readonly args: ReadonlyArray<unknown>;
}

export interface KafkaPendingCall<TResult = unknown> extends ForwardablePendingCall<KafkaCall, TResult> {
    readonly method: KafkaMethod;
    readonly topic: string | undefined;
    readonly messages: ReadonlyArray<KafkaMessageInput> | undefined;
    readonly args: ReadonlyArray<unknown>;
}

export interface KafkaProbe extends ForwardableProbe<KafkaCall, KafkaPendingCall> {
    /** Narrow by method (e.g. `probe.on('send')`). */
    on(method: KafkaMethod): ForwardableSelection<KafkaCall, KafkaPendingCall>;
    /** Narrow to `send` calls on a specific topic. */
    topic(name: string): ForwardableSelection<KafkaCall, KafkaPendingCall>;
}

/**
 * A single appended message in a topic log, as returned by
 * {@link ProbedKafkaProducer.topicLog}. Bytes (`key`, `value`, header
 * values) are normalized to `Buffer` (or `null`) so tests can assert exact
 * bytes. `offset` is the per-partition offset; `appendIndex` is the global
 * append (send) order across the topic.
 */
export interface TopicLogEntry {
    readonly topic: string;
    readonly partition: number;
    readonly offset: number;
    readonly key: Buffer | null;
    readonly value: Buffer | null;
    readonly headers: Readonly<Record<string, Buffer | Buffer[]>>;
    readonly timestamp: string;
    readonly appendIndex: number;
}

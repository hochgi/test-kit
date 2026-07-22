import {
    createProbeRoot,
    emptyFilterChain,
    errors,
    makeForwardablePending,
    type CallRecord,
    type Duration,
    type ForwardablePendingCall,
    type ForwardableSelection,
    type Harness,
    type ProbeRoot,
    type ProbedAdapterWithLifecycle,
} from '@vnatures/test-kit';
import type { ProducerBatch, ProducerRecord, RecordMetadata } from 'kafkajs';
import type { KafkaCall, KafkaMethod, KafkaPendingCall, KafkaProbe, KafkaProducer, TopicLogEntry } from './types.js';
import { InMemoryKafkaBacking } from './in-memory-backing.js';

export interface CreateProbedKafkaProducerOptions {
    readonly harness: Harness;
    /** Number of partitions per topic (default 4). */
    readonly partitionsPerTopic?: number;
    readonly defaultTimeout?: Duration;
}

export type ProbedKafkaProducer = ProbedAdapterWithLifecycle<KafkaProducer, KafkaProbe> & {
    /**
     * Read the in-memory topic log for assertions. Returns entries in
     * global append (send) order, each tagged with `partition` and
     * per-partition `offset`.
     */
    topicLog(topic: string): TopicLogEntry[];
};

export function createProbedKafkaProducer(options: CreateProbedKafkaProducerOptions): ProbedKafkaProducer {
    const backing = new InMemoryKafkaBacking({
        partitionsPerTopic: options.partitionsPerTopic,
        clock: options.harness.clock,
    });

    const root: ProbeRoot<KafkaCall, KafkaPendingCall> = createProbeRoot<KafkaCall, KafkaPendingCall>({
        harness: options.harness,
        defaultTimeout: options.defaultTimeout,
        forwardable: true,
        pendingFactory: (record) => makeKafkaPending(record as CallRecord<KafkaCall, KafkaPendingCall>),
        defaultRules: [
            {
                action: { kind: 'forward' },
                filter: emptyFilterChain as {
                    predicates: ReadonlyArray<{ fn: (call: KafkaCall) => boolean; label: string }>;
                    label: string;
                },
            },
        ],
    });

    const probe = root.probe as unknown as KafkaProbe;
    (probe as { on: (method: KafkaMethod) => unknown }).on = (method: KafkaMethod) =>
        root.probe.filter((call) => call.method === method, `method === '${method}'`) as unknown as ForwardableSelection<
            KafkaCall,
            KafkaPendingCall
        >;
    (probe as { topic: (name: string) => unknown }).topic = (name: string) =>
        root.probe.filter(
            (call) => call.method === 'send' && call.topic === name,
            `method='send' AND topic='${name}'`,
        ) as unknown as ForwardableSelection<KafkaCall, KafkaPendingCall>;

    const recordSend = (record: ProducerRecord): Promise<RecordMetadata[]> => {
        const call: KafkaCall = {
            method: 'send',
            topic: record.topic,
            messages: record.messages,
            args: [record],
        };
        return root.recordCall(call, async () => backing.appendSend(record.topic, record.messages)) as Promise<
            RecordMetadata[]
        >;
    };

    const recordSendBatch = (batch: ProducerBatch): Promise<RecordMetadata[]> => {
        const call: KafkaCall = {
            method: 'sendBatch',
            topic: undefined,
            messages: undefined,
            args: [batch],
        };
        return root.recordCall(call, async () => backing.appendBatch(batch)) as Promise<RecordMetadata[]>;
    };

    const recordConnect = (): Promise<void> => {
        const call: KafkaCall = { method: 'connect', topic: undefined, messages: undefined, args: [] };
        return root.recordCall(call, async () => {
            /* no-op backing: no broker to connect to */
        }) as Promise<void>;
    };

    const recordDisconnect = (): Promise<void> => {
        const call: KafkaCall = { method: 'disconnect', topic: undefined, messages: undefined, args: [] };
        return root.recordCall(call, async () => {
            /* no-op backing */
        }) as Promise<void>;
    };

    const adapter: KafkaProducer = {
        connect: recordConnect,
        disconnect: recordDisconnect,
        send: recordSend,
        sendBatch: recordSendBatch,
    };

    return {
        adapter,
        probe,
        topicLog: (topic: string) => backing.topicLog(topic),
        async reset() {
            backing.reset();
        },
        async close() {
            backing.clear();
            root.dispose();
        },
    };
}

/** A broker-down error shape (name matches kafkajs' `KafkaJSBrokerNotFound`). */
export function brokerDownError(message = 'Broker not found'): Error {
    const err = new Error(message);
    err.name = 'KafkaJSBrokerNotFound';
    return err;
}

// Ensure `errors` import is retained for the unsupported-forward template even
// though the producer currently forwards every method.
void errors;

function makeKafkaPending(record: CallRecord<KafkaCall, KafkaPendingCall>): KafkaPendingCall {
    const label = record.call.method === 'send' && record.call.topic ? `send→${record.call.topic}` : record.call.method;
    const base = makeForwardablePending<KafkaCall>(
        record as CallRecord<KafkaCall, ForwardablePendingCall<KafkaCall>>,
        label,
    );
    const pending = Object.create(base) as ForwardablePendingCall<KafkaCall>;
    Object.defineProperty(pending, 'method', {
        get: () => record.call.method,
        enumerable: true,
        configurable: true,
    });
    Object.defineProperty(pending, 'topic', {
        get: () => record.call.topic,
        enumerable: true,
        configurable: true,
    });
    Object.defineProperty(pending, 'messages', {
        get: () => record.call.messages,
        enumerable: true,
        configurable: true,
    });
    Object.defineProperty(pending, 'args', {
        get: () => record.call.args,
        enumerable: true,
        configurable: true,
    });
    return pending as KafkaPendingCall;
}

# @vnatures/test-kit-kafka

Probe-driven Kafka **producer** boundary adapter with an in-memory topic
log — no broker, no Zookeeper, no Docker.

## Why a producer-only adapter?

The consumer's Kafka interaction at the test boundary is a **producer**
(`kafka.producer().send({ topic, messages })`). Consuming (consumer
groups, offset commits, rebalancing) happens inside the stream-processing
framework — not at the injectable seam. Faking that seam means faking a
kafkajs-shaped `Producer`, not a broker.

This package targets `Producer.send` / `Producer.sendBatch` explicitly and
appends sent messages to an in-memory per-topic log you can read back for
assertions.

If your boundary is SQS, use
[`@vnatures/test-kit-sqs`](../sqs/README.md). If you need a
consumer-side stream mock, see
[`@vnatures/test-kit-mock`](../mock/README.md).

## Install

```bash
npm install --save-dev @vnatures/test-kit @vnatures/test-kit-kafka
# peer: kafkajs (consumer provides its own version)
```

## Quick start

```typescript
import { createRig } from "@vnatures/test-kit";
import { createProbedKafkaProducer } from "@vnatures/test-kit-kafka";

const rig = createRig();
const kafka = rig.attach(createProbedKafkaProducer({ harness: rig }));

// Default rule forwards to the in-memory topic log.
await kafka.adapter.send({
    topic: "orders",
    messages: [
        { key: "cust-A", value: "o1", headers: { src: "web" } },
        { key: "cust-A", value: "o3" },
    ],
});

const log = kafka.topicLog("orders");
expect(log).toHaveLength(2);
expect(log[0].value!.toString()).toBe("o1");

await rig.close();
```

## What the adapter returns

```typescript
const { adapter, probe, topicLog, reset, close } = createProbedKafkaProducer({
    harness: rig,
    partitionsPerTopic, // default 4
    defaultTimeout,
});
```

- `adapter: KafkaProducer` — inject this into production wiring. Matches
  the kafkajs `Producer` shape: `send`, `sendBatch`, `connect`,
  `disconnect`.
- `probe: KafkaProbe` — `.calls`, `.on(method)`, `.topic(name)`,
  `.expect.*`, `.drain()`, `.drainAndReject(error)`. Default rule is
  `always().forward()` so sends append transparently to the topic log.
- `topicLog(topic)` — read back the in-memory log for assertions. Entries
  are returned in global append (send) order, each tagged with
  `partition` and per-partition `offset`.
- `reset()` — empties every topic log; `rig.reset()` runs it
  automatically.
- `close()` — disposes the backing; `rig.close()` runs it
  automatically.

## Three verbs: `forward` / `answer` / `reject`

Every intercepted call can be settled three ways:

- **`forward`** — append to the in-memory topic log (for `send` /
  `sendBatch`) or no-op (for `connect` / `disconnect`).
- **`answerWith((call) => out)`** / **`answer(out)`** — resolve with a
  caller-provided value.
- **`reject(error)`** — fail the call.

```typescript
// Simulate broker-down on the next send.
import { brokerDownError } from "@vnatures/test-kit-kafka";
kafka.probe.on("send").once().reject(brokerDownError());

// Intercept a send to a specific topic, inspect it, then forward.
kafka.probe.topic("orders").always().park();
const pending = await kafka.probe.topic("orders").expect.intercept();
expect(pending.messages?.[0].value).toBe("o1");
pending.forward();
```

## Semantics that are real

- **Partitioning.** Matches kafkajs' default partitioner contract:
  - an explicit `message.partition` wins (clamped to
    `[0, partitionsPerTopic)`);
  - else a keyed message is murmur2-hashed to a partition — same key ⇒
    same partition ⇒ stable per-key ordering;
  - a keyless, partition-less message goes to partition 0.
- **Per-partition offsets.** Monotonic from 0, per `(topic, partition)`.
- **No dedup.** Duplicate sends append. At-least-once is the consumer's
  problem — the backing faithfully represents what the producer sent.
- **Byte normalization.** `key`, `value`, and header values are
  normalized to `Buffer` (or `null`) in the topic log, so tests can
  assert exact bytes regardless of whether the producer sent strings or
  buffers. Multi-value headers (kafkajs `IHeaders` arrays) are preserved
  as `Buffer[]`.
- **Clock-aware timestamps.** When `rig.clock` is threaded into the
  backing (the factory does this automatically), default message
  timestamps use `clock.now()` instead of wall-clock `Date.now()`, so
  they're deterministic under fake timers and manual clocks.

## `brokerDownError()`

A helper that constructs an `Error` with `name: "KafkaJSBrokerNotFound"`
— the shape kafkajs throws when no broker is reachable. Use it with
`.reject(...)` to simulate transport failures:

```typescript
kafka.probe.on("connect").once().reject(brokerDownError());
await expect(kafka.adapter.connect()).rejects.toMatchObject({
    name: "KafkaJSBrokerNotFound",
});
```

## See also

- [`docs/concepts.md`](../../docs/concepts.md) for the boundary and
  backed-adapter model.
- [`docs/api-surface.md`](../../docs/api-surface.md) for the full probe
  reference.
- [`@vnatures/test-kit-sqs`](../sqs/README.md) for the sibling messaging
  adapter.

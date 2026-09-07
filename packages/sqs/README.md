# @vnatures/test-kit-sqs

Probe-driven SQS adapter for component tests, backed by a functional
in-memory queue — no elasticmq, no localstack, no Docker.

## Why an SQS adapter?

The right place to fake an SQS boundary is the `SQSClient` itself, **not**
a hand-rolled queue interface (which would hide SDK-shape bugs from the
test) and **not** the raw HTTP layer (which would make tests verbose and
infrastructure-fragile).

This package targets the `SQSClient.send(command)` seam explicitly. An
in-memory backing implements the standard-queue semantics that matter for
component tests: visibility timeout, long-poll receive, receipt-handle
deletion, and `ChangeMessageVisibility`.

If your boundary is S3, use
[`@vnatures/test-kit-s3`](../s3/README.md) instead.

## Install

```bash
npm install --save-dev @vnatures/test-kit @vnatures/test-kit-sqs
# peer: @aws-sdk/client-sqs (consumer provides its own version)
```

## Quick start

```typescript
import { createRig, seconds } from "@vnatures/test-kit";
import {
    createProbedSqsAdapter,
} from "@vnatures/test-kit-sqs";
import {
    SendMessageCommand,
    ReceiveMessageCommand,
    DeleteMessageCommand,
} from "@aws-sdk/client-sqs";

const rig = createRig();
const sqs = rig.attach(
    createProbedSqsAdapter({ harness: rig, queueName: "work", defaultVisibilityTimeoutSeconds: 30 }),
);

// Default rule forwards to the in-memory backing.
await sqs.adapter.send(
    new SendMessageCommand({ QueueUrl: sqs.queueUrl, MessageBody: "hello" }),
);

const res = await sqs.adapter.send(
    new ReceiveMessageCommand({ QueueUrl: sqs.queueUrl, AttributeNames: ["All"] }),
);
const msg = res.Messages![0];
expect(msg.Body).toBe("hello");

await sqs.adapter.send(
    new DeleteMessageCommand({ QueueUrl: sqs.queueUrl, ReceiptHandle: msg.ReceiptHandle }),
);

await rig.close();
```

## What the adapter returns

```typescript
const { adapter, probe, queueUrl, queueName, reset, close } =
    createProbedSqsAdapter({
        harness: rig,
        queueName,                       // default "test-queue"
        queueUrl,                        // default derived from queueName
        defaultVisibilityTimeoutSeconds, // default 30
    });
```

- `adapter: SQSClient` — inject this into production wiring. `.send` is
  overridden to dispatch by `command.constructor.name` (a plain string,
  robust to duplicate SDK copies in monorepos).
- `probe: SqsProbe` — `.calls`, `.command(CommandClass)`,
  `.command(name)`, `.expect.*`, `.drain()`, `.drainAndReject(error)`.
  Default rule is `always().forward()` so send/receive/delete run
  transparently against the in-memory backing.
- `queueUrl` / `queueName` — the configured queue identity.
- `reset()` — empties every queue and cancels pending timers; useful
  between tests. `rig.reset()` runs it automatically.
- `close()` — disposes the backing; `rig.close()` runs it
  automatically.

## Three verbs: `forward` / `answer` / `reject`

Every intercepted call can be settled three ways:

- **`forward`** — execute the in-memory backing.
  - `createProbedSqsAdapter` supports `SendMessage`, `ReceiveMessage`,
    `DeleteMessage`, `ChangeMessageVisibility`, `GetQueueUrl`, and
    `CreateQueue`. Any other command throws the templated
    `unsupportedForward` error on `forward`; tests must program an
    explicit `answer` or `reject`.
- **`answerWith((call) => out)`** / **`answer(out)`** — resolve with a
  caller-provided value.
- **`reject(error)`** — fail the call.

```typescript
// Simulate a transport failure on the next receive.
sqs.probe.command(ReceiveMessageCommand).once().reject(new Error("transport failure"));

// Stub a send without touching the backing.
sqs.probe.command(SendMessageCommand).once().answer({ MessageId: "stub-1" });
```

## Semantics that are real (driven by `rig.clock`)

Timing is fake-timer friendly: the backing schedules with the ambient
`setTimeout` (so it follows vitest/jest/sinon fake timers or real timers)
and computes deadlines against `rig.clock.now()`. Drive visibility
expiry and long-poll waits with `rig.clock.advance(...)` under fake
timers.

- **Visibility timeout.** A received message is invisible until the
  timeout elapses, then becomes redeliverable with an incremented
  `ApproximateReceiveCount`. The per-receive `VisibilityTimeout` input
  overrides the queue default; the queue default comes from
  `defaultVisibilityTimeoutSeconds` (30s).
- **Long-poll receive.** A `ReceiveMessageCommand` with
  `WaitTimeSeconds > 0` and no available message parks until a message
  arrives (answered immediately) or the wait window elapses (resolved
  with `{ Messages: undefined }`).
- **`DeleteMessage` by receipt handle.** A stale handle (from an earlier
  receive, before redelivery) is a no-op, matching real SQS. Only the
  current handle removes the message.
- **`ChangeMessageVisibility`.** Reschedules the visibility timeout of a
  message identified by its current receipt handle. `VisibilityTimeout:
  0` makes the message immediately visible again.
- **`DelaySeconds`** on send delays first visibility.
- **`ApproximateReceiveCount` / `SentTimestamp` /
  `ApproximateFirstReceiveTimestamp`** are populated in `Attributes`
  (request them via `AttributeNames: ["All"]`; they're surfaced by
  default even without an explicit request, for test ergonomics).

FIFO queues are intentionally **not** implemented (the consumer uses
standard queues).

## Clock & fake timers

```typescript
import { vi } from "vitest";
import { createRig, seconds } from "@vnatures/test-kit";

beforeEach(() => {
    vi.useFakeTimers();
    rig = createRig(); // auto-detects the active fake clock
});

it("redelivers after the visibility timeout", async () => {
    await sqs.adapter.send(new SendMessageCommand({ QueueUrl: sqs.queueUrl, MessageBody: "x" }));
    const first = await sqs.adapter.send(
        new ReceiveMessageCommand({ QueueUrl: sqs.queueUrl, AttributeNames: ["All"] }),
    );
    expect(first.Messages![0].Attributes!.ApproximateReceiveCount).toBe("1");

    await rig.clock.advance(seconds(30));

    const second = await sqs.adapter.send(
        new ReceiveMessageCommand({ QueueUrl: sqs.queueUrl, AttributeNames: ["All"] }),
    );
    expect(second.Messages![0].Attributes!.ApproximateReceiveCount).toBe("2");
});
```

## See also

- [`docs/concepts.md`](../../docs/concepts.md) for the boundary and
  backed-adapter model.
- [`docs/api-surface.md`](../../docs/api-surface.md) for the full probe
  reference.
- [`@vnatures/test-kit-s3`](../s3/README.md) for the sibling AWS SDK
  client adapter.

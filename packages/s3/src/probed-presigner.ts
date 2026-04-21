import type { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { RequestPresigningArguments } from '@smithy/types';
import { S3Probe } from './s3-probe';
import { NotImplementedError } from './errors';

/**
 * The leaf boundary for S3 pre-signed URL generation. Production code depends
 * on this interface; production wires it as `{ signUrl: getSignedUrl }` from
 * `@aws-sdk/s3-request-presigner`, tests wire the probed fake.
 *
 * Deliberately typed as `typeof getSignedUrl` so a production impl can literally
 * be the real SDK function — no adapters, no wrappers.
 */
export interface Presigner {
    readonly signUrl: typeof getSignedUrl;
}

/** Shape recorded on the probe for every presign call. */
export interface PresignCallInput {
    readonly commandInput: unknown;
    readonly options: RequestPresigningArguments | undefined;
}

export interface ProbedPresigner {
    readonly presigner: Presigner;
    readonly probe: S3Probe;
}

/**
 * Probed presigner: implements the `Presigner` interface so `signUrl` calls
 * are routed through an `S3Probe`. Unlike `createProbedS3Client`, `forward()`
 * always throws `NotImplementedError` — there is no real backend because
 * producing a signed URL that actually works would require real AWS credentials
 * and network I/O. Tests MUST program behavior:
 *
 *   probe.alwaysAnswer((call) => `https://fake/${(call.input as PresignCallInput).commandInput.Key}`);
 *   probe.whenCalled(PutObjectCommand).thenAnswer('https://fake/put');
 *
 * `probe.calls[i].input` has shape `PresignCallInput` — `{ commandInput, options }` —
 * so tests can assert on `expiresIn` alongside `Bucket` / `Key`.
 */
export function createProbedPresigner(): ProbedPresigner {
    const probe = new S3Probe();

    // Define as a function expression so its TS type matches `typeof getSignedUrl`
    // (which is a generic arrow). We return `Promise<string>` which matches the
    // SDK signature.
    const signUrl: typeof getSignedUrl = (client, command, options) => {
        const commandName =
            (command as { constructor?: { name?: string } } | null)?.constructor?.name ?? 'UnknownCommand';
        const commandInput = (command as { input?: unknown } | null)?.input ?? {};
        const envelope: PresignCallInput = { commandInput, options };
        return probe.recordCall(commandName, envelope, () =>
            Promise.reject(
                new NotImplementedError(
                    commandName,
                    'presigner cannot generate real signed URLs in tests. Program behavior via probe.whenCalled(Cmd).thenAnswer(url) or probe.alwaysAnswer((call) => url).',
                ),
            ),
        ) as Promise<string>;
    };

    return {
        presigner: { signUrl },
        probe,
    };
}

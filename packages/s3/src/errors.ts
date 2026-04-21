export class NotImplementedError extends Error {
    public readonly commandName: string;

    constructor(commandName: string, detail?: string) {
        const suffix = detail ? `: ${detail}` : '';
        super(
            `test-kit-s3: "${commandName}" is not implemented${suffix}. Use probe.whenCalled(...).thenAnswer(...) / probe.alwaysAnswer(...) or handle it via expectNext().`,
        );
        this.name = 'NotImplementedError';
        this.commandName = commandName;
    }
}

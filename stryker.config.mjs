/** @type {import('@stryker-mutator/core').PartialStrykerOptions} */
const config = {
    $schema: './node_modules/@stryker-mutator/core/schema/stryker-schema.json',
    packageManager: 'npm',
    testRunner: 'vitest',
    vitest: {
        configFile: 'vitest.mutation.config.ts',
        related: false,
    },
    reporters: ['html', 'json', 'clear-text', 'progress'],
    mutator: {
        excludedMutations: ['StringLiteral', 'ObjectLiteral'],
    },
    thresholds: {
        high: 80,
        low: 60,
        break: null,
    },
    jsonReporter: {
        fileName: 'reports/mutation/mutation.json',
    },
    htmlReporter: {
        fileName: 'reports/mutation/index.html',
    },
    timeoutMS: 60_000,
    timeoutFactor: 1.5,
};

export default config;

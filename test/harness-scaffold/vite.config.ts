import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        name: 'harness-scaffold',
        environment: 'node',
        dir: path.dirname(fileURLToPath(import.meta.url)),
        include: ['**/*.test.ts'],
        testTimeout: 30_000,
    },
});

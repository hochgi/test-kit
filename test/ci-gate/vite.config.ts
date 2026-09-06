import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        name: 'ci-gate',
        environment: 'node',
        dir: path.dirname(fileURLToPath(import.meta.url)),
        include: ['**/*.test.ts'],
    },
});

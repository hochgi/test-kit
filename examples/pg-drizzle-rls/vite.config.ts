import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        name: 'example-pg-drizzle-rls',
        environment: 'node',
        globals: true,
        include: ['test/**/*.test.ts'],
    },
});

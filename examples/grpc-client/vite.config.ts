import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        name: 'example-grpc-client',
        environment: 'node',
        globals: true,
        include: ['test/**/*.test.ts'],
    },
});

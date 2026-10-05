import { defineConfig } from 'vitest/config';
import dts from 'vite-plugin-dts';

export default defineConfig({
    build: {
        lib: {
            entry: './src/index.ts',
            formats: ['es', 'cjs'],
            fileName: (format) => `index.${format === 'es' ? 'js' : 'cjs'}`,
        },
        rollupOptions: {
            external: [/^node:/, /^@hochgi\//, /^testcontainers/, /^@testcontainers\//, 'mysql2', 'mysql2/promise'],
        },
        sourcemap: true,
        minify: false,
        target: 'node20',
    },
    plugins: [
        dts({
            rollupTypes: true,
            tsconfigPath: './tsconfig.json',
        }),
    ],
    test: {
        name: 'mysql',
        environment: 'node',
        globals: true,
        include: ['test/**/*.test.ts'],
        // Real Docker containers: give them time to start.
        testTimeout: 120_000,
        hookTimeout: 120_000,
    },
});

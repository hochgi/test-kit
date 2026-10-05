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
            external: [/^node:/, /^@hochgi\//, 'bull'],
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
        name: 'bull',
        environment: 'node',
        globals: true,
        include: ['test/**/*.test.ts'],
    },
});

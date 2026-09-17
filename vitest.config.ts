import { defineConfig } from 'vitest/config';

// Root Vitest config: test.projects lists every package and root test/ project.
export default defineConfig({
    test: {
        projects: [
            'packages/core',
            'packages/mock',
            'packages/sql',
            'packages/pglite-driver',
            'packages/redis',
            'packages/bull',
            'packages/s3',
            'packages/sqs',
            'packages/kafka',
            'packages/mysql',
            'packages/pg-kysely',
            'packages/pg-knex',
            'packages/pg-sequelize',
            'examples/grpc-client',
            'test/ci-gate',
            'test/harness-scaffold',
            'test/harness-prose',
            'test/docs-truth',
        ],
    },
});

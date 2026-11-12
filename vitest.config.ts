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
            'packages/pg-drizzle',
            'examples/grpc-client',
            'examples/pg-drizzle-rls',
            'test/ci-gate',
            'test/harness-scaffold',
            'test/harness-prose',
            'test/docs-truth',
        ],
    },
});

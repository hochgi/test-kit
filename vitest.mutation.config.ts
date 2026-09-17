import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));

const ALL_PACKAGE_TESTS = 'packages/*/test/**/*.test.ts';
const MYSQL_TEST_GLOB = 'packages/mysql/test/**';
const CORE_LAYOUT_TEST_FILES = [
    'packages/core/test/unit/rig-docs-naming.test.ts',
    'packages/core/test/unit/rig-rename-layout.test.ts',
    'packages/core/test/unit/package-graph.test.ts',
    'packages/core/test/unit/rig-public-surface.test.ts',
] as const;

type PackageManifest = {
    name?: unknown;
    private?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStrykerPackage(): string {
    const filePath = path.join(root, '.stryker-package');
    if (!existsSync(filePath)) {
        return '';
    }
    return readFileSync(filePath, 'utf8').trim();
}

function publishedPackageAliases(): Record<string, string> {
    const packagesRoot = path.join(root, 'packages');
    const aliases: Record<string, string> = {};
    for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
            continue;
        }
        const manifestPath = path.join(packagesRoot, entry.name, 'package.json');
        if (!existsSync(manifestPath)) {
            continue;
        }
        const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
        if (!isRecord(parsed)) {
            continue;
        }
        const manifest = parsed as PackageManifest;
        if (manifest.private === true || typeof manifest.name !== 'string') {
            continue;
        }
        aliases[manifest.name] = path.join(packagesRoot, entry.name, 'src/index.ts');
    }
    return aliases;
}

function mutationTestGlobs(packageName: string): { include: string[]; exclude: string[] } {
    const layoutExclude = [...CORE_LAYOUT_TEST_FILES];
    if (packageName === 'core') {
        return { include: [ALL_PACKAGE_TESTS], exclude: [...layoutExclude, MYSQL_TEST_GLOB] };
    }
    if (packageName === '') {
        return { include: [ALL_PACKAGE_TESTS], exclude: layoutExclude };
    }
    if (packageName === 'mysql') {
        return { include: [`packages/${packageName}/test/**/*.test.ts`], exclude: layoutExclude };
    }
    return {
        include: [`packages/${packageName}/test/**/*.test.ts`],
        exclude: [...layoutExclude, MYSQL_TEST_GLOB],
    };
}

const strykerPackage = readStrykerPackage();
const { include, exclude } = mutationTestGlobs(strykerPackage);

export default defineConfig({
    resolve: {
        alias: publishedPackageAliases(),
    },
    test: {
        environment: 'node',
        globals: true,
        include,
        exclude,
        typecheck: {
            enabled: false,
        },
        server: {
            deps: {
                inline: [/^@vnatures\//], // transform @vnatures/ workspace packages
            },
        },
    },
});

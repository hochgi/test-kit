import { spawnSync } from 'node:child_process';
import {
    chmodSync,
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const mutationConfigRelative = 'vitest.mutation.config.ts';
const strykerPackagePath = path.join(repoRoot, '.stryker-package');
const mutationPackageRelative = 'scripts/mutation-package.sh';
const mutationIncrementalRelative = 'scripts/mutation-incremental.sh';
const changedSrcRelative = 'scripts/changed-src.sh';
const crapReportRelative = 'scripts/crap-report.js';
const expectedCheck = 'npm run format:check && npm run lint && npm run typecheck && npm run build && npm test';

const coreLayoutTestFiles = [
    'packages/core/test/unit/rig-docs-naming.test.ts',
    'packages/core/test/unit/rig-rename-layout.test.ts',
    'packages/core/test/unit/package-graph.test.ts',
    'packages/core/test/unit/rig-public-surface.test.ts',
] as const;

const strykerConfigNames = [
    'stryker.config.mjs',
    'stryker.config.js',
    'stryker.config.ts',
    'stryker.config.json',
    'stryker.conf.mjs',
    'stryker.conf.js',
    'stryker.conf.json',
] as const;

const mutationJsonCandidates = [
    'reports/mutation/mutation.json',
    'reports/mutation.json',
    'reports/mutation/mutation-report.json',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readUtf8(filePath: string): string {
    return readFileSync(filePath, 'utf8');
}

function readRequired(relative: string): string {
    const abs = path.join(repoRoot, relative);
    expect(existsSync(abs), `${relative} must exist`).toBe(true);
    return readUtf8(abs);
}

function readRootPackage(): Record<string, unknown> {
    const parsed: unknown = JSON.parse(readRequired('package.json'));
    return isRecord(parsed) ? parsed : {};
}

function stringMap(value: unknown): Record<string, string> {
    if (!isRecord(value)) {
        return {};
    }
    const out: Record<string, string> = {};
    for (const [key, entry] of Object.entries(value)) {
        if (typeof entry === 'string') {
            out[key] = entry;
        }
    }
    return out;
}

function readRootScripts(): Record<string, string> {
    return stringMap(readRootPackage()['scripts']);
}

function readDevDependencies(): Record<string, string> {
    return stringMap(readRootPackage()['devDependencies']);
}

function writeStrykerPackage(packageName: string): void {
    writeFileSync(strykerPackagePath, `${packageName}\n`);
}

function stringList(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((entry): entry is string => typeof entry === 'string');
}

function mutationIncludeExclude(config: unknown): { include: string[]; exclude: string[] } {
    if (!isRecord(config) || !isRecord(config['test'])) {
        return { include: [], exclude: [] };
    }
    const test = config['test'];
    return {
        include: stringList(test['include']),
        exclude: stringList(test['exclude']),
    };
}

function aliasMap(config: unknown): Record<string, string> {
    if (!isRecord(config) || !isRecord(config['resolve'])) {
        return {};
    }
    const alias = config['resolve']['alias'];
    const out: Record<string, string> = {};
    if (Array.isArray(alias)) {
        for (const entry of alias) {
            if (!isRecord(entry)) {
                continue;
            }
            const find = entry['find'];
            const replacement = entry['replacement'];
            if (typeof find === 'string' && typeof replacement === 'string') {
                out[find] = replacement;
            }
        }
        return out;
    }
    if (!isRecord(alias)) {
        return {};
    }
    for (const [key, value] of Object.entries(alias)) {
        if (typeof value === 'string') {
            out[key] = value;
        }
    }
    return out;
}

async function loadMutationConfig(): Promise<{
    include: string[];
    exclude: string[];
    aliases: Record<string, string>;
}> {
    const { loadConfigFromFile } = await import('vite');
    const loaded = await loadConfigFromFile(
        { command: 'serve', mode: 'test' },
        path.join(repoRoot, mutationConfigRelative),
        repoRoot,
        'silent',
    );
    expect(loaded, `${mutationConfigRelative} must load`).toBeTruthy();
    const config = loaded?.config;
    const globs = mutationIncludeExclude(config);
    expect(globs.include.length, 'loaded mutation config must set test.include').toBeGreaterThan(0);
    return { ...globs, aliases: aliasMap(config) };
}

async function loadMutationTestGlobs(): Promise<{ include: string[]; exclude: string[] }> {
    const loaded = await loadMutationConfig();
    return { include: loaded.include, exclude: loaded.exclude };
}

const gitAuthorEnv = {
    GIT_AUTHOR_NAME: 'p12-mutation-test',
    GIT_AUTHOR_EMAIL: 'p12-mutation-test@example.com',
    GIT_COMMITTER_NAME: 'p12-mutation-test',
    GIT_COMMITTER_EMAIL: 'p12-mutation-test@example.com',
};

function fixtureEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, ...gitAuthorEnv };
    delete env.GIT_DIR;
    delete env.GIT_WORK_TREE;
    delete env.GIT_INDEX_FILE;
    delete env.GIT_OBJECT_DIRECTORY;
    delete env.GIT_COMMON_DIR;
    return env;
}

function gitAt(cwd: string, args: string[]): void {
    const result = spawnSync('git', args, {
        cwd,
        encoding: 'utf8',
        env: fixtureEnv(),
    });
    expect(result.status, `git ${args.join(' ')} failed: ${result.stderr}`).toBe(0);
}

function writeTreeFile(root: string, relative: string, contents: string): void {
    const abs = path.join(root, relative);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
}

function createUnchangedSrcFixture(): string {
    const fixture = mkdtempSync(path.join(tmpdir(), 'p12-mutation-skip-'));
    gitAt(fixture, ['init', '-b', 'main']);
    mkdirSync(path.join(fixture, 'scripts'), { recursive: true });
    copyFileSync(path.join(repoRoot, changedSrcRelative), path.join(fixture, changedSrcRelative));
    copyFileSync(path.join(repoRoot, mutationIncrementalRelative), path.join(fixture, mutationIncrementalRelative));
    writeTreeFile(fixture, mutationPackageRelative, '#!/usr/bin/env bash\necho STRYKER_INVOKED "$1" >&2\nexit 0\n');
    chmodSync(path.join(fixture, mutationPackageRelative), 0o755);
    writeTreeFile(fixture, 'packages/core/src/index.ts', 'export const value = 1;\n');
    writeTreeFile(fixture, 'packages/core/test/unit/example.test.ts', 'export {};\n');
    gitAt(fixture, ['add', '.']);
    gitAt(fixture, ['commit', '--no-gpg-sign', '--no-verify', '-m', 'unchanged production src']);
    return fixture;
}

function createNestedSrcChangeFixture(): string {
    const fixture = createUnchangedSrcFixture();
    gitAt(fixture, ['checkout', '-b', 'nested-src']);
    writeTreeFile(fixture, 'packages/s3/src/s3-client/store.ts', 'export const value = 2;\n');
    writeTreeFile(fixture, 'packages/s3/test/unit/example.test.ts', 'export {};\n');
    gitAt(fixture, ['add', '.']);
    gitAt(fixture, ['commit', '--no-gpg-sign', '--no-verify', '-m', 'nested production src']);
    return fixture;
}

function createSrcTestFileChangeFixture(): string {
    const fixture = createUnchangedSrcFixture();
    gitAt(fixture, ['checkout', '-b', 'src-test-file']);
    writeTreeFile(fixture, 'packages/core/src/example.test.ts', 'export const testOnly = 1;\n');
    writeTreeFile(fixture, 'packages/core/src/example.spec.tsx', 'export const specOnly = 1;\n');
    gitAt(fixture, ['add', '.']);
    gitAt(fixture, ['commit', '--no-gpg-sign', '--no-verify', '-m', 'src test files']);
    return fixture;
}

function runIncremental(fixture: string) {
    return spawnSync('bash', ['scripts/mutation-incremental.sh'], {
        cwd: fixture,
        encoding: 'utf8',
        timeout: 20_000,
        env: fixtureEnv(),
    });
}

function publishedWorkspacePackages(): Array<{ dir: string; name: string }> {
    const packagesRoot = path.join(repoRoot, 'packages');
    const found: Array<{ dir: string; name: string }> = [];
    for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
            continue;
        }
        const manifestPath = path.join(packagesRoot, entry.name, 'package.json');
        if (!existsSync(manifestPath)) {
            continue;
        }
        const parsed: unknown = JSON.parse(readUtf8(manifestPath));
        if (!isRecord(parsed) || parsed['private'] === true || typeof parsed['name'] !== 'string') {
            continue;
        }
        found.push({ dir: entry.name, name: parsed['name'] });
    }
    return found;
}

function strykerConfigRelative(): string {
    const found = strykerConfigNames.find((name) => existsSync(path.join(repoRoot, name)));
    expect(found, 'a Stryker config file must exist at the repository root').toEqual(expect.any(String));
    return found ?? strykerConfigNames[0];
}

function mutantCounts(report: unknown): { total: number; killed: number } {
    if (!isRecord(report) || !isRecord(report['files'])) {
        return { total: 0, killed: 0 };
    }
    let total = 0;
    let killed = 0;
    for (const file of Object.values(report['files'])) {
        if (!isRecord(file) || !Array.isArray(file['mutants'])) {
            continue;
        }
        for (const mutant of file['mutants']) {
            total += 1;
            if (isRecord(mutant) && mutant['status'] === 'Killed') {
                killed += 1;
            }
        }
    }
    return { total, killed };
}

function coverageKeys(): string[] {
    const reportPath = path.join(repoRoot, 'coverage', 'coverage-final.json');
    expect(existsSync(reportPath), 'coverage/coverage-final.json must exist').toBe(true);
    const parsed: unknown = JSON.parse(readUtf8(reportPath));
    return isRecord(parsed) ? Object.keys(parsed) : [];
}

function spawnTimeout(command: string, args: string[], timeout: number) {
    return spawnSync(command, args, {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout,
        env: process.env,
    });
}

afterEach(() => {
    if (existsSync(strykerPackagePath)) {
        unlinkSync(strykerPackagePath);
    }
});

describe('Mutation-only Vite config aliases workspace packages to source', () => {
    it('mutation config aliases each workspace package to src/index.ts', async () => {
        const { aliases } = await loadMutationConfig();
        expect(
            aliases['@hochgi/test-kit'] ?? '',
            '@hochgi/test-kit must alias to packages/core/src/index.ts',
        ).toContain('packages/core/src/index.ts');
        expect(
            aliases['@hochgi/test-kit-mock'] ?? '',
            '@hochgi/test-kit-mock must alias to packages/mock/src/index.ts',
        ).toContain('packages/mock/src/index.ts');
        for (const pkg of publishedWorkspacePackages()) {
            expect(aliases[pkg.name] ?? '', `${pkg.name} must alias to packages/${pkg.dir}/src/index.ts`).toContain(
                `packages/${pkg.dir}/src/index.ts`,
            );
        }
    });

    it('mutation config does not load the default project graph', () => {
        const source = readRequired(mutationConfigRelative);
        expect(source.includes('defineWorkspace'), 'must not contain defineWorkspace').toBe(false);
        expect(source.includes('test.projects'), 'must not contain test.projects').toBe(false);
        expect(
            /typecheck[\s\S]{0,120}enabled:\s*false|typecheck:\s*false|enabled:\s*false/.test(source),
            'typecheck enabled must be false',
        ).toBe(true);
        expect(source.includes('inline'), 'must set test.server.deps.inline').toBe(true);
        expect(source.includes('@hochgi/'), 'inline must transform @hochgi/ packages').toBe(true);
    });

    it('Stryker uses the mutation config and disables related mode', () => {
        const source = readRequired(strykerConfigRelative());
        expect(/testRunner:\s*['"]vitest['"]|"testRunner":\s*"vitest"/.test(source), 'testRunner must be vitest').toBe(
            true,
        );
        expect(
            source.includes('vitest.mutation.config.ts'),
            'vitest.configFile must be vitest.mutation.config.ts',
        ).toBe(true);
        expect(/related:\s*false|"related":\s*false/.test(source), 'vitest.related must be false').toBe(true);
        expect(/break:\s*null|"break":\s*null/.test(source), 'thresholds.break must be null').toBe(true);
        expect(/vitest\.dir|dir:\s*['"]packages\//.test(source), 'must not scope via Stryker vitest.dir').toBe(false);
    });

    it('mutation vitest loads source, not dist', async () => {
        expect(existsSync(path.join(repoRoot, mutationConfigRelative)), 'vitest.mutation.config.ts must exist').toBe(
            true,
        );
        writeStrykerPackage('core');
        const { createServer } = await import('vite');
        const server = await createServer({
            configFile: path.join(repoRoot, mutationConfigRelative),
            root: repoRoot,
            server: { middlewareMode: true },
        });
        try {
            const resolved = await server.pluginContainer.resolveId('@hochgi/test-kit');
            const resolvedPath = resolved && typeof resolved.id === 'string' ? resolved.id : '';
            expect(resolvedPath.includes('packages/core/src'), 'resolved path must contain packages/core/src').toBe(
                true,
            );
            expect(
                resolvedPath.includes('packages/core/dist'),
                'resolved path must not contain packages/core/dist',
            ).toBe(false);
        } finally {
            await server.close();
        }
    });
});

describe('Per-package mutation runner', () => {
    it("mutation-package writes .stryker-package and mutates that package's src", () => {
        const source = readRequired(mutationPackageRelative);
        expect(source.includes('.stryker-package'), 'must write the package directory name to .stryker-package').toBe(
            true,
        );
        expect(source.includes('stryker'), 'must invoke Stryker').toBe(true);
        expect(source.includes('--mutate') || /mutate/.test(source), 'must invoke Stryker with a --mutate glob').toBe(
            true,
        );
        expect(
            /packages\/.*src/.test(source) || source.includes('packages/'),
            'mutate glob must be under packages/<name>/src',
        ).toBe(true);
        expect(source.includes('*.tsx'), 'mutate glob must include TypeScript TSX sources').toBe(true);
    });

    it("mutation include for mock is that package's tests only", async () => {
        writeStrykerPackage('mock');
        const { include } = await loadMutationTestGlobs();
        expect(include, 'include must contain packages/mock/test/**/*.test.ts').toContain(
            'packages/mock/test/**/*.test.ts',
        );
        expect(
            include,
            'must not contain packages/core/test/**/*.test.ts as a required match for a mock-only run',
        ).not.toContain('packages/core/test/**/*.test.ts');
        expect(include, 'must not require packages/*/test/**/*.test.ts for a mock-only run').not.toContain(
            'packages/*/test/**/*.test.ts',
        );
    });

    it("mutation include for mysql is that package's tests only", async () => {
        writeStrykerPackage('mysql');
        const { include, exclude } = await loadMutationTestGlobs();
        expect(include, 'include must contain packages/mysql/test/**/*.test.ts').toContain(
            'packages/mysql/test/**/*.test.ts',
        );
        expect(exclude, 'must not exclude packages/mysql/test/** when mutating mysql').not.toContain(
            'packages/mysql/test/**',
        );
    });

    it('CRAP include without .stryker-package still runs mysql tests', async () => {
        const { include, exclude } = await loadMutationTestGlobs();
        expect(include, 'empty package include must cover packages/*/test/**/*.test.ts').toContain(
            'packages/*/test/**/*.test.ts',
        );
        expect(exclude, 'CRAP must not exclude packages/mysql/test/**').not.toContain('packages/mysql/test/**');
    });

    it('mutation include for core covers sibling in-process tests and drops layout files', async () => {
        writeStrykerPackage('core');
        const { include, exclude } = await loadMutationTestGlobs();
        expect(include, 'include must cover packages/*/test/**/*.test.ts').toContain('packages/*/test/**/*.test.ts');
        for (const layoutFile of coreLayoutTestFiles) {
            expect(exclude, `exclude must list ${layoutFile}`).toContain(layoutFile);
        }
        expect(exclude, 'must exclude packages/mysql/test/**').toContain('packages/mysql/test/**');
    });

    it('mysql mutation concurrency is 1', () => {
        const stryker = readRequired(strykerConfigRelative());
        const runner = existsSync(path.join(repoRoot, mutationPackageRelative))
            ? readUtf8(path.join(repoRoot, mutationPackageRelative))
            : '';
        const haystack = `${stryker}\n${runner}`;
        expect(/concurrency/.test(haystack), 'mysql Stryker configuration must set concurrency').toBe(true);
        expect(
            /mysql[\s\S]{0,400}concurrency[\s\S]{0,80}\b1\b/.test(haystack) ||
                /concurrency[\s\S]{0,80}\b1\b[\s\S]{0,400}mysql/.test(haystack) ||
                /concurrency:\s*1\b/.test(haystack),
            'concurrency must be 1 when the package is mysql',
        ).toBe(true);
    });
});

describe('Incremental mutation runner', () => {
    it('incremental mutation skips when no production src changed', () => {
        const fixture = createUnchangedSrcFixture();
        try {
            const result = runIncremental(fixture);
            expect(result.error, 'incremental runner must not time out').toBeUndefined();
            expect(result.status, 'must exit 0 when no production src changed').toBe(0);
            expect(`${result.stdout}\n${result.stderr}`).not.toContain('STRYKER_INVOKED');
        } finally {
            rmSync(fixture, { recursive: true, force: true });
        }
    });

    it('incremental mutation includes a package when nested src changed', () => {
        const fixture = createNestedSrcChangeFixture();
        try {
            const result = runIncremental(fixture);
            expect(result.error, 'incremental runner must not time out').toBeUndefined();
            expect(result.status, 'must exit 0 after mutating the nested package').toBe(0);
            expect(`${result.stdout}\n${result.stderr}`).toContain('STRYKER_INVOKED s3');
        } finally {
            rmSync(fixture, { recursive: true, force: true });
        }
    });

    it('incremental mutation skips src test and spec files', () => {
        const fixture = createSrcTestFileChangeFixture();
        try {
            const result = runIncremental(fixture);
            expect(result.error, 'incremental runner must not time out').toBeUndefined();
            expect(result.status, 'must exit 0 when only src test files changed').toBe(0);
            expect(`${result.stdout}\n${result.stderr}`).not.toContain('STRYKER_INVOKED');
        } finally {
            rmSync(fixture, { recursive: true, force: true });
        }
    });

    it('incremental mutation does not treat a find error as no tests', () => {
        const source = readRequired(mutationIncrementalRelative);
        expect(source.includes('package_has_tests'), 'must define package_has_tests').toBe(true);
        expect(source.includes('2>/dev/null || true'), 'must not swallow find errors').toBe(false);
        expect(source.includes('find failed'), 'a find error must fail the runner').toBe(true);
    });
});

describe('A zero-mutant Stryker success is a failure', () => {
    it('mutating a glob that matches no source fails', () => {
        const script = path.join(repoRoot, mutationPackageRelative);
        expect(existsSync(script), `${mutationPackageRelative} must exist`).toBe(true);
        const result = spawnTimeout('bash', [script, '__no_such_package__'], 30_000);
        expect(result.error, 'per-package runner must not time out').toBeUndefined();
        expect(result.status, 'a mutate glob that matches no source must exit non-zero').not.toBe(0);
    });

    it('duration.ts mutation produces a non-zero mutant count', () => {
        expect(existsSync(path.join(repoRoot, mutationConfigRelative)), 'vitest.mutation.config.ts must exist').toBe(
            true,
        );
        readRequired(strykerConfigRelative());
        const strykerBin = path.join(repoRoot, 'node_modules', '.bin', 'stryker');
        expect(existsSync(strykerBin), 'stryker must be installed').toBe(true);
        writeStrykerPackage('core');
        rmSync(path.join(repoRoot, 'reports', 'mutation'), { recursive: true, force: true });
        const result = spawnTimeout(strykerBin, ['run', '--mutate', 'packages/core/src/duration.ts'], 180_000);
        expect(result.error, 'duration.ts mutation must not time out').toBeUndefined();
        expect(result.status, 'duration.ts mutation must exit 0').toBe(0);
        const reportRelative = mutationJsonCandidates.find((candidate) => existsSync(path.join(repoRoot, candidate)));
        expect(reportRelative, 'Stryker JSON report must exist').toEqual(expect.any(String));
        const report: unknown = JSON.parse(readUtf8(path.join(repoRoot, reportRelative ?? mutationJsonCandidates[0])));
        const counts = mutantCounts(report);
        expect(counts.total, 'JSON report must record more than 0 mutants').toBeGreaterThan(0);
        expect(counts.killed, 'JSON report must record more than 0 killed mutants').toBeGreaterThan(0);
    }, 180_000);

    it('the shipped per-package runner instruments and kills mutants for sql', () => {
        const script = path.join(repoRoot, mutationPackageRelative);
        expect(existsSync(script), `${mutationPackageRelative} must exist`).toBe(true);
        expect(existsSync(path.join(repoRoot, 'packages', 'sql', 'src')), 'packages/sql/src must exist').toBe(true);
        rmSync(path.join(repoRoot, 'reports', 'mutation'), { recursive: true, force: true });
        const result = spawnTimeout('bash', [script, 'sql'], 300_000);
        expect(result.error, 'the shipped runner must not time out').toBeUndefined();
        expect(
            result.status,
            `the shipped runner must exit 0 for sql: ${result.stdout ?? ''}\n${result.stderr ?? ''}`,
        ).toBe(0);
        const reportRelative = mutationJsonCandidates.find((candidate) => existsSync(path.join(repoRoot, candidate)));
        expect(reportRelative, 'Stryker JSON report must exist').toEqual(expect.any(String));
        const report: unknown = JSON.parse(readUtf8(path.join(repoRoot, reportRelative ?? mutationJsonCandidates[0])));
        const counts = mutantCounts(report);
        expect(counts.total, 'the shipped runner must instrument more than 0 mutants').toBeGreaterThan(0);
        expect(counts.killed, 'the shipped runner must kill more than 0 mutants').toBeGreaterThan(0);
    }, 300_000);

    it('the per-package runner passes exactly one --mutate flag', () => {
        const source = readRequired(mutationPackageRelative);
        const commandLines = source
            .split('\n')
            .filter((line) => !line.trimStart().startsWith('#'))
            .join('\n');
        const occurrences = commandLines.match(/--mutate\b/g) ?? [];
        expect(occurrences.length, 'repeating --mutate keeps only the last glob, so the runner must pass it once').toBe(
            1,
        );
        expect(source, 'the single glob must cover .ts and .tsx under that package src and exclude .d.ts').toMatch(
            /--mutate "packages\/\$\{pkg\}\/src\/\*\*\/\*\.ts,[^"]*packages\/\$\{pkg\}\/src\/\*\*\/\*\.tsx,[^"]*!packages\/\$\{pkg\}\/src\/\*\*\/\*\.d\.ts/,
        );
    });
});

describe('CRAP scores source functions from istanbul coverage', () => {
    it('crap-report.js lives under the existing scripts directory', () => {
        const scriptsDir = path.join(repoRoot, 'scripts');
        expect(existsSync(scriptsDir), 'scripts/ must exist').toBe(true);
        const names = readdirSync(scriptsDir);
        expect(names, 'scripts/ must contain crap-report.js').toContain('crap-report.js');
        expect(names, 'scripts/ must contain agent-sync-lib.sh').toContain('agent-sync-lib.sh');
        expect(names, 'scripts/ must contain sync-agent-skills.sh').toContain('sync-agent-skills.sh');
        expect(names, 'scripts/ must contain check-agent-skills.sh').toContain('check-agent-skills.sh');
    });

    it('crap-report uses istanbul statementMap and packages/*/src', () => {
        const source = readRequired(crapReportRelative);
        expect(source.includes('statementMap'), 'must contain statementMap').toBe(true);
        expect(source.includes('packages/*/src'), 'must contain packages/*/src').toBe(true);
        expect(source.includes('CRAP(m) = comp(m)^2 * (1 - cov(m))^3 + comp(m)'), 'must contain the CRAP formula').toBe(
            true,
        );
        expect(
            /['"`]specs\//.test(source) || /path\.join\([^)]*specs/.test(source),
            'must not treat specs/ as tests',
        ).toBe(false);
        expect(source.includes("'packages/*/src/**/*.ts'"), 'must not pass a non-glob ** pathspec to git').toBe(false);
        expect(source.includes("'packages'"), 'patch diff pathspec must be the packages/ tree').toBe(true);
        expect(source.includes('maxBuffer'), 'git diff must raise spawnSync maxBuffer').toBe(true);
        expect(
            source.includes('git diff against') && source.includes('failed'),
            'a failed git diff must fail the CRAP report, not drop the patch',
        ).toBe(true);
    });

    it('crap scripts exist, use istanbul, and are not in check', () => {
        const scripts = readRootScripts();
        const dev = readDevDependencies();
        expect(scripts['crap'], 'root package.json must define scripts.crap').toEqual(expect.any(String));
        expect(scripts['crap:changed'], 'root package.json must define scripts.crap:changed').toEqual(
            expect.any(String),
        );
        expect(dev['@vitest/coverage-istanbul'], 'devDependencies must contain @vitest/coverage-istanbul').toEqual(
            expect.any(String),
        );
        const crap = scripts['crap'] ?? '';
        expect(
            crap.includes('istanbul') || crap.includes('vitest.mutation.config.ts'),
            'scripts.crap must name istanbul or vitest.mutation.config.ts',
        ).toBe(true);
        expect(scripts['check'] ?? expectedCheck, 'scripts.check must not contain crap').not.toMatch(/crap/);
    });
});

describe('Istanbul coverage keys are TypeScript sources', () => {
    it('istanbul coverage keys are TypeScript sources', () => {
        expect(existsSync(path.join(repoRoot, mutationConfigRelative)), 'vitest.mutation.config.ts must exist').toBe(
            true,
        );
        writeStrykerPackage('core');
        rmSync(path.join(repoRoot, 'coverage'), { recursive: true, force: true });
        const vitestBin = path.join(repoRoot, 'node_modules', '.bin', 'vitest');
        const result = spawnTimeout(
            vitestBin,
            [
                'run',
                '--config',
                mutationConfigRelative,
                '--coverage',
                '--coverage.provider',
                'istanbul',
                '--coverage.reporter',
                'json',
                'packages/core/test/unit/duration.test.ts',
            ],
            60_000,
        );
        expect(result.error, 'istanbul coverage run must not time out').toBeUndefined();
        expect(result.status, 'istanbul coverage run must exit 0').toBe(0);
        const keys = coverageKeys();
        expect(
            keys.some((key) => key.includes('packages/core/src/') && key.endsWith('.ts')),
            'coverage-final.json must have a packages/core/src/**/*.ts key',
        ).toBe(true);
        expect(
            keys.some((key) => key.includes('packages/core/dist/')),
            'coverage-final.json must not have a packages/core/dist/ key',
        ).toBe(false);
    }, 60_000);
});

describe('changed-src.sh resolves origin/main and packages/*/src', () => {
    it('resolve_patch_base prefers origin/main then main', () => {
        const source = readRequired(changedSrcRelative);
        expect(source.includes('resolve_patch_base'), 'must define resolve_patch_base').toBe(true);
        expect(source.includes('origin/main'), 'resolve_patch_base must contain origin/main').toBe(true);
        expect(source.includes('vn/main'), 'must not contain the old vn/main remote').toBe(false);
        expect(source.includes('main'), 'resolve_patch_base must contain main').toBe(true);
        expect(source.includes('vn/master'), 'must not contain vn/master').toBe(false);
        expect(source.includes('origin/master'), 'must not contain origin/master').toBe(false);
    });

    it('changed_src_files is packages/*/src, not root src or specs', () => {
        const source = readRequired(changedSrcRelative);
        expect(source.includes('changed_src_files'), 'must define changed_src_files').toBe(true);
        expect(source.includes('packages/'), 'changed_src_files must name packages/').toBe(true);
        expect(source.includes('src'), 'changed_src_files must name src').toBe(true);
        expect(
            / -- src(?:\s|$)/.test(source),
            'must not use a pathspec that is exactly src at the repository root',
        ).toBe(false);
        expect(source.includes('/specs/'), 'must not grep for /specs/').toBe(false);
        expect(source.includes('grep -E -v'), 'test/spec exclusion must be ERE').toBe(true);
        expect(source.includes('(test|spec)'), 'test/spec exclusion must use ERE grouping').toBe(true);
        expect(source.includes('\\(test\\|spec\\)'), 'must not use BRE grouping under grep -E').toBe(false);
    });
});

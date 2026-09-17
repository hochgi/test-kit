import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

const harnessMarkdownDirs = [
    '.cursor/agents',
    '.cursor/skills',
    '.cursor/commands',
    '.claude/agents',
    '.claude/skills',
    '.claude/commands',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function publishedPackageNames(): readonly string[] {
    const manifests = gitLsFiles(['packages']).filter((file) => /^packages\/[^/]+\/package.json$/.test(file));
    const names: string[] = [];
    for (const file of manifests) {
        const parsed: unknown = JSON.parse(readUtf8(path.join(repoRoot, file)));
        if (!isRecord(parsed) || typeof parsed['name'] !== 'string' || parsed['name'].trim() === '') {
            throw new Error(`invalid package manifest ${file}`);
        }
        if (parsed['private'] === true) {
            continue;
        }
        names.push(parsed['name']);
    }
    names.sort();
    if (names.length === 0) {
        throw new Error('expected at least one published workspace package');
    }
    return names;
}

const publishedPackages = publishedPackageNames();

const consumerFacingExports = [
    'autoDetectClock',
    'ManualClock',
    'pgliteTypes',
    'InMemoryKafkaBacking',
    'InMemorySqsBacking',
    'SUPPORTED_SQS_COMMANDS',
    'DEFAULT_VISIBILITY_TIMEOUT_SECONDS',
    'BullProcessor',
    'BullJobType',
    'BullQueueType',
    'InMemoryJob',
    'JobCounts',
    'ModelCtor',
    'SequelizeCtor',
    'CreateProbedSqlAdapterOptions',
    'PgliteNotifications',
    'CreatePgliteHandleOptions',
    'StreamChunkOf',
    'StreamExpectations',
    'StreamPendingCallBase',
    'createChannel',
    'makeStreamPendingBase',
] as const;

const v2DocFilenames = ['v2-concepts.md', 'v2-api-surface.md', 'v2-architecture.md', 'v2-tech-design.md'] as const;

const forbiddenLayoutSrcPaths = [
    'packages/core/src/selection.ts',
    'packages/core/src/rule-builder.ts',
    'packages/core/src/expectations.ts',
    'packages/core/src/pending-call.ts',
    'packages/core/src/probe-root.ts',
    'packages/mock/src/proxy.ts',
    'packages/sql/src/driver.ts',
    'packages/pglite-driver/src/lifecycle.ts',
    'packages/pglite-driver/src/maintenance-connection.ts',
    'packages/pg-kysely/src/seed.ts',
    'packages/pg-kysely/src/reset.ts',
    'packages/pg-knex/src/seed.ts',
    'packages/pg-knex/src/reset.ts',
    'packages/pg-sequelize/src/seed.ts',
    'packages/pg-sequelize/src/reset.ts',
    'packages/redis/src/adapter.ts',
    'packages/s3/src/adapter.ts',
    'packages/s3/src/s3-client/adapter.ts',
    'packages/s3/src/presigner/adapter.ts',
    'packages/s3/src/command-extraction.ts',
] as const;

const currentBackingPatterns: ReadonlyArray<RegExp> = [
    /with mock-aws-s3(?:-v3)? backing/i,
    /disk-backed [`']?mock-aws-s3/i,
    /wraps [`']?mock-aws-s3/i,
    /against mock-aws-s3/i,
    /through mock-aws-s3(?:-v3)? disk/i,
    /from mock-aws-s3-v3/i,
    /one backing \(mock-aws-s3/i,
    /mock-aws-s3(?:-v3)? wiring/i,
    /mock-aws-s3 live/i,
    /createMockS3Backing/,
];

const presentTenseDefectPhrases = [
    '41 known defects',
    '41 of them',
    'until RD-24142 lands',
    'docs currently lie',
] as const;

type CorpusEntry = { readonly file: string; readonly content: string };

function readUtf8(filePath: string): string {
    return readFileSync(filePath, 'utf8');
}

function gitLsFiles(pathspecs: readonly string[]): string[] {
    const listed = execFileSync('git', ['ls-files', '-z', '--', ...pathspecs], {
        cwd: repoRoot,
        encoding: 'utf8',
    });
    return listed.split('\0').filter((file) => file !== '');
}

function isNoisePath(file: string): boolean {
    return file.startsWith('.claude/worktrees/') || file.split('/').includes('dist');
}

function isLibraryDoc(file: string): boolean {
    if (isNoisePath(file) || !file.endsWith('.md')) {
        return false;
    }
    if (file === 'README.md' || file === 'APPENDIX.md') {
        return true;
    }
    if (file.startsWith('docs/internal/spec/') || file.startsWith('docs/internal/packets/')) {
        return false;
    }
    if (file.startsWith('docs/internal/archive/')) {
        return false;
    }
    if (file.startsWith('docs/')) {
        return true;
    }
    return /^packages\/[^/]+\/README\.md$/.test(file);
}

function loadCorpus(files: readonly string[]): CorpusEntry[] {
    return files.map((file) => ({ file, content: readUtf8(path.join(repoRoot, file)) }));
}

function libraryDocs(): CorpusEntry[] {
    return loadCorpus(gitLsFiles(['README.md', 'APPENDIX.md', 'docs', 'packages']).filter(isLibraryDoc));
}

function implementationCorpus(): CorpusEntry[] {
    return loadCorpus(
        gitLsFiles(['packages']).filter(
            (file) => file.endsWith('.ts') && file.startsWith('packages/') && !isNoisePath(file),
        ),
    );
}

function harnessMarkdown(): CorpusEntry[] {
    const listed = gitLsFiles([...harnessMarkdownDirs]).filter(
        (file) => (file.endsWith('.md') || file.endsWith('.mdc')) && !isNoisePath(file),
    );
    return loadCorpus(listed);
}

function s3ImplementationCorpus(): CorpusEntry[] {
    return implementationCorpus().filter((entry) => entry.file.startsWith('packages/s3/'));
}

function filesWhere(corpus: readonly CorpusEntry[], predicate: (content: string, file: string) => boolean): string[] {
    return corpus.filter((entry) => predicate(entry.content, entry.file)).map((entry) => entry.file);
}

function identifierOccurs(content: string, identifier: string): boolean {
    return new RegExp(`\\b${identifier}\\b`).test(content);
}

function documentsUnorderedExpectApi(content: string): boolean {
    return /harness\.expect\.unordered/.test(content) || /\.unordered\(/.test(content);
}

function documentsQueryProbeQueries(content: string): boolean {
    return (
        /\bdb\.probe\.queries\b/.test(content) ||
        /\bprobe\.queries\b/.test(content) ||
        /\bQueryProbe\.queries\b/.test(content) ||
        /QueryProbe[\s\S]{0,160}`\.queries`/.test(content) ||
        /QueryProbe[\s\S]{0,160}\.queries\b/.test(content)
    );
}

function documentsPositionalCreateProbedSqlAdapter(content: string): boolean {
    return /createProbedSqlAdapter\(\s*driver\s*,\s*harness/.test(content);
}

function sentenceIsHistoricalReplacement(sentence: string): boolean {
    return /replac(?:e|es|ed|ing)|previous|older|former|no longer/i.test(sentence);
}

function currentBackingClaims(content: string): string[] {
    const sentences = content.split(/(?<=[.!?])\s+|\n/);
    const hits: string[] = [];
    for (const sentence of sentences) {
        if (sentenceIsHistoricalReplacement(sentence)) {
            continue;
        }
        for (const pattern of currentBackingPatterns) {
            if (pattern.test(sentence)) {
                hits.push(sentence.trim());
                break;
            }
        }
    }
    return hits;
}

function vitestTitles(source: string): string[] {
    const titles: string[] = [];
    const re = /\b(?:it|test|describe)\(\s*(['"`])([\s\S]*?)\1/g;
    let match: RegExpExecArray | null = re.exec(source);
    while (match !== null) {
        const title = match[2];
        if (title !== undefined) {
            titles.push(title);
        }
        match = re.exec(source);
    }
    return titles;
}

function markdownSection(text: string, heading: string): string {
    const lines = text.split('\n');
    const start = lines.findIndex((line) => line === heading || line.startsWith(`${heading} `));
    if (start === -1) {
        return '';
    }
    const hashes = heading.match(/^#+/)?.[0]?.length ?? 2;
    const collected: string[] = [];
    const deeper = new RegExp(`^#{1,${String(hashes)}}\\s`);
    for (let i = start + 1; i < lines.length; i += 1) {
        const line = lines[i];
        if (line !== undefined && deeper.test(line)) {
            break;
        }
        if (line !== undefined) {
            collected.push(line);
        }
    }
    return collected.join('\n');
}

function firstFence(section: string): string {
    const match = section.match(/```[^\n]*\n([\s\S]*?)```/);
    return match?.[1] ?? '';
}

function namesPublishedPackage(text: string, pkg: string): boolean {
    if (pkg === '@vnatures/test-kit') {
        return /@vnatures\/test-kit(?!-)/.test(text);
    }
    return text.includes(pkg);
}

function missingPublishedPackages(text: string): string[] {
    return publishedPackages.filter((pkg) => !namesPublishedPackage(text, pkg));
}

type LayoutNode = { readonly depth: number; readonly name: string; readonly isDir: boolean };

function layoutLineNode(line: string): LayoutNode | undefined {
    const flattened = line.replace(/[│├└]/g, ' ').replace(/─/g, ' ');
    const match = flattened.match(/^( *)(\S.*)$/);
    if (match?.[1] === undefined || match[2] === undefined) {
        return undefined;
    }
    const depth = Math.floor(match[1].length / 4);
    const rest = match[2].replace(/\s{2,}.*$/, '').trim();
    const isDir = rest.endsWith('/');
    const name = rest.replace(/\/$/, '');
    if (name === '' || name === '...' || name === '…') {
        return undefined;
    }
    return { depth, name, isDir };
}

function parseLayoutTree(tree: string): { files: string[]; dirs: string[] } {
    const stack: string[] = [];
    const files: string[] = [];
    const dirs: string[] = [];
    for (const line of tree.split('\n')) {
        const node = layoutLineNode(line);
        if (node === undefined) {
            continue;
        }
        stack.length = node.depth;
        const parent = stack.join('/');
        const full = parent === '' ? node.name : `${parent}/${node.name}`;
        const relative = full.replace(/^test-kit\//, '');
        if (node.isDir) {
            stack.push(node.name);
            dirs.push(relative);
        } else {
            files.push(relative);
        }
    }
    return { files, dirs };
}

function repositoryLayoutTree(architecture: string): string {
    return firstFence(markdownSection(architecture, '## Repository Layout'));
}

function layoutMentionsPath(files: readonly string[], dirs: readonly string[], target: string): boolean {
    if (files.includes(target) || dirs.includes(target)) {
        return true;
    }
    return files.some((file) => file.startsWith(`${target}/`)) || dirs.some((dir) => dir.startsWith(`${target}/`));
}

function citesV2DocFilename(content: string): boolean {
    return v2DocFilenames.some((name) => content.includes(name));
}

function definesHttpCurrentApi(content: string): boolean {
    if (
        /export\s+(?:interface|type)\s+HttpClient\b/.test(content) ||
        /export\s+(?:interface|type)\s+HttpCall\b/.test(content) ||
        /export\s+(?:interface|type)\s+HttpPendingCall\b/.test(content) ||
        /export\s+(?:interface|type)\s+HttpProbe\b/.test(content)
    ) {
        return true;
    }
    if (/^#{2,3} .*(HTTP Client Adapter|test-kit-http)/m.test(content)) {
        const heading = content.match(/^#{2,3} .*(?:HTTP Client Adapter|test-kit-http).*$/m)?.[0];
        if (heading === undefined) {
            return false;
        }
        const body = markdownSection(content, heading);
        const substantive = body
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line !== '' && !line.startsWith('```'));
        const oneLineNotShipped = substantive.length <= 3 && /not shipped/i.test(body);
        return !oneLineNotShipped;
    }
    return false;
}

function listsLiveHttpPackage(content: string): boolean {
    return /packages\/http\/|\bhttp\/\s+\(planned/.test(content) || /└── http\/|├── http\//.test(content);
}

function claimsPgliteDriverPrivate(content: string): boolean {
    if (!/pglite-driver|test-kit-pglite/.test(content)) {
        return false;
    }
    return (
        /private:\s*true/.test(content) ||
        /workspace-internal(?:-only)?/.test(content) ||
        /\bunpublished\b/.test(content)
    );
}

function presentsTsdAsInstalled(content: string): boolean {
    if (!/\btsd\b/.test(content)) {
        return false;
    }
    if (/not in the lockfile|not in the lock file|is not installed/i.test(content)) {
        return false;
    }
    return /using `tsd`|`tsd` or |or `tsd`/.test(content);
}

function claimsPgliteDriverHasTestDir(content: string): boolean {
    if (/for `core` and `pglite-driver`/.test(content)) {
        return true;
    }
    if (/pglite-driver[\s\S]{0,80}test\/unit/.test(content)) {
        return true;
    }
    if (/packages\/pglite-driver\/[\s\S]{0,80}has a `test\//.test(content)) {
        return true;
    }
    return /pglite-driver\/[\s\S]{0,400}?└── test\//.test(content);
}

function interfaceDecl(content: string, name: string): string | undefined {
    const match = content.match(new RegExp(`export\\s+interface\\s+${name}\\b[^{]*\\{`));
    return match?.[0];
}

function typeAliasObjectDecl(content: string, name: string): string | undefined {
    const match = content.match(new RegExp(`export\\s+type\\s+${name}\\b[^=]*=\\s*\\{`));
    return match?.[0];
}

function extendsForwardableProbe(content: string, name: string): boolean {
    return new RegExp(`export\\s+interface\\s+${name}\\s+extends\\s+ForwardableProbe\\b`).test(content);
}

function relativeMarkdownTargets(markdown: string): string[] {
    const targets: string[] = [];
    const re = /\[[^\]]*\]\(([^)]+)\)/g;
    let match: RegExpExecArray | null = re.exec(markdown);
    while (match !== null) {
        const target = match[1];
        if (target !== undefined && !/^[a-z]+:/i.test(target) && !target.startsWith('#') && !target.startsWith('/')) {
            targets.push(target.split('#')[0] ?? target);
        }
        match = re.exec(markdown);
    }
    return targets;
}

const docs = libraryDocs();
const impl = implementationCorpus();
const harness = harnessMarkdown();
const s3Impl = s3ImplementationCorpus();
const architecture = readUtf8(path.join(repoRoot, 'docs/architecture.md'));
const apiSurface = readUtf8(path.join(repoRoot, 'docs/api-surface.md'));
const techDesign = readUtf8(path.join(repoRoot, 'docs/internal/tech-design.md'));
const rootReadme = readUtf8(path.join(repoRoot, 'README.md'));
const appendix = readUtf8(path.join(repoRoot, 'APPENDIX.md'));
const redisReadme = readUtf8(path.join(repoRoot, 'packages/redis/README.md'));
const sqlReadme = readUtf8(path.join(repoRoot, 'packages/sql/README.md'));
const s3Readme = readUtf8(path.join(repoRoot, 'packages/s3/README.md'));
const concepts = readUtf8(path.join(repoRoot, 'docs/concepts.md'));
const migration = readUtf8(path.join(repoRoot, 'docs/internal/migration-from-v1.md'));
const vitestConfigPath = path.join(repoRoot, 'vitest.config.ts');

describe('Phantom public APIs are absent from library docs', () => {
    it('phantom S3 commandsOf is absent', () => {
        expect(
            filesWhere(docs, (content) => identifierOccurs(content, 'commandsOf')),
            'library docs must not contain the identifier commandsOf',
        ).toEqual([]);
    });

    it('phantom harness.expect.unordered is absent', () => {
        expect(
            filesWhere(docs, documentsUnorderedExpectApi),
            'library docs must not contain unordered( as a harness.expect API',
        ).toEqual([]);
    });

    it('phantom InMemoryCache is absent', () => {
        expect(
            filesWhere(docs, (content) => identifierOccurs(content, 'InMemoryCache')),
            'library docs must not contain the identifier InMemoryCache',
        ).toEqual([]);
    });

    it('phantom NotImplementedError is absent', () => {
        expect(
            filesWhere(docs, (content) => identifierOccurs(content, 'NotImplementedError')),
            'library docs must not contain the identifier NotImplementedError',
        ).toEqual([]);
    });

    it('phantom QueryProbe.queries is absent', () => {
        expect(
            filesWhere(docs, documentsQueryProbeQueries),
            'library docs must not document .queries as a QueryProbe or SQL probe member',
        ).toEqual([]);
    });

    it('phantom SqlDriver executeForward and formatBoundParameters are absent', () => {
        expect(
            filesWhere(docs, (content) => identifierOccurs(content, 'executeForward')),
            'library docs must not contain executeForward',
        ).toEqual([]);
        expect(
            filesWhere(docs, (content) => identifierOccurs(content, 'formatBoundParameters')),
            'library docs must not contain formatBoundParameters',
        ).toEqual([]);
    });

    it('createProbedSqlAdapter is not documented as positional', () => {
        expect(
            filesWhere(docs, documentsPositionalCreateProbedSqlAdapter),
            'library docs must not show createProbedSqlAdapter(driver, harness, …)',
        ).toEqual([]);
        const mentioning = docs.filter((entry) => entry.content.includes('createProbedSqlAdapter'));
        expect(mentioning.length, 'createProbedSqlAdapter must still be documented').toBeGreaterThan(0);
        const joined = mentioning.map((entry) => entry.content).join('\n');
        expect(joined.includes('createProbedSqlAdapter({'), 'must show a single options object').toBe(true);
        expect(
            /harness[\s\S]{0,80}driver|driver[\s\S]{0,80}harness/.test(joined),
            'options must include harness and driver',
        ).toBe(true);
        expect(
            joined.includes('{ probe, probeRoot') || joined.includes('probeRoot'),
            'must return { probe, probeRoot }',
        ).toBe(true);
        expect(joined.includes('probed pair'), 'must not document an adapter/probe pair return').toBe(false);
    });
});

describe('Redis README matches CacheAdapter and Duration', () => {
    it('redis README names CacheAdapter and CacheProbe', () => {
        expect(redisReadme.includes('CacheAdapter'), 'must name CacheAdapter as the injected adapter type').toBe(true);
        expect(redisReadme.includes('CacheProbe'), 'must name CacheProbe as the probe type').toBe(true);
        expect(redisReadme.includes('MethodProbe'), 'must not name MethodProbe as the redis probe type').toBe(false);
    });

    it('redis README timing parameters are Duration', () => {
        const heading =
            markdownSection(redisReadme, '## The `CacheAdapter` interface') ||
            markdownSection(redisReadme, '## The CacheAdapter interface');
        const sketch = firstFence(heading);
        expect(sketch, 'CacheAdapter sketch must exist in packages/redis/README.md').not.toEqual('');
        expect(sketch).toMatch(/ttl\?:\s*Duration/);
        expect(sketch).toMatch(/options:\s*\{\s*readonly ttl:\s*Duration\s*\}/);
        expect(sketch).not.toMatch(/\bmode\b/);
        expect(sketch).not.toMatch(/"PX"|"EX"/);
        expect(sketch).toMatch(/Duration\s*\|\s*\(\(result:\s*T\)\s*=>\s*Duration\)/);
    });
});

describe('SQL README matches QueryCall, QueryProbe, and SqlDriver', () => {
    it('QueryCall is documented without a raw-statement field', () => {
        expect(sqlReadme.includes('QueryCall'), 'sql README must describe QueryCall').toBe(true);
        expect(sqlReadme).toMatch(/\{\s*sql,\s*parameters\s*\}|sql:\s*string[\s\S]{0,120}parameters:/);
        expect(sqlReadme).not.toMatch(/raw statement/i);
        expect(sqlReadme).not.toMatch(/\braw\s*:/);
    });

    it('SqlDriver in architecture matches source', () => {
        const sketch = firstFence(markdownSection(architecture, '## The SqlDriver Seam'));
        expect(sketch.includes('onApplicationQuery'), 'SqlDriver sketch must include onApplicationQuery').toBe(true);
        expect(sketch.includes('reset'), 'SqlDriver sketch must include reset').toBe(true);
        expect(sketch.includes('close'), 'SqlDriver sketch must include close').toBe(true);
        expect(/\bforward\s*\(/.test(sketch), 'SqlDriver sketch must not include a forward method').toBe(false);
    });
});

describe('S3 docs match in-memory backing and recorded call shapes', () => {
    it('mock-aws-s3 is not the current S3 backing', () => {
        const docHits = filesWhere(docs, (content) => currentBackingClaims(content).length > 0);
        expect(docHits, 'library docs must not claim mock-aws-s3 is the current backing').toEqual([]);
        const implHits = filesWhere(s3Impl, (content) => currentBackingClaims(content).length > 0);
        expect(implHits, 'S3 implementation corpus must not claim mock-aws-s3 is the current backing').toEqual([]);
        const titleHits = s3Impl
            .filter((entry) => entry.file.startsWith('packages/s3/test/'))
            .flatMap((entry) =>
                vitestTitles(entry.content)
                    .filter((title) => /mock-aws-s3-v3/.test(title))
                    .map((title) => `${entry.file}: ${title}`),
            );
        expect(titleHits, 'S3 integration test titles must not name mock-aws-s3-v3 as the backing').toEqual([]);
    });

    it('S3 reset and close are not filesystem operations', () => {
        const s3Api = markdownSection(apiSurface, '## S3 Adapter API');
        expect(s3Api).not.toMatch(/empt(?:y|ies) the local directory/i);
        expect(s3Api).not.toMatch(/remove[sd]? the temporary local directory/i);
        expect(s3Api).not.toMatch(/local directory's content/i);
    });

    it('localDirectory is documented as deprecated and ignored', () => {
        const s3Api = markdownSection(apiSurface, '## S3 Adapter API');
        expect(s3Api).toMatch(/CreateProbedS3AdapterOptions|localDirectory/);
        expect(s3Api).toMatch(/deprecated/i);
        expect(s3Api).toMatch(/ignored/i);
        expect(s3Api).toMatch(/empty string|always ''|always ""|always `''`/);
    });

    it('presigner has no default rule', () => {
        expect(s3Readme).toMatch(/park/i);
        expect(s3Readme).toMatch(/no default rule/i);
        expect(s3Readme).not.toMatch(/Default rule for presigner is reject/i);
        expect(s3Readme).not.toMatch(/default is `reject`|default is reject/i);
    });

    it('S3 and Presign call shapes match source', () => {
        expect(s3Readme).toMatch(/\{\s*commandName,\s*command,\s*input\s*\}/);
        expect(s3Readme).not.toMatch(/\{\s*commandName,\s*command,\s*input,\s*options\s*\}/);
        expect(s3Readme).toMatch(/\{\s*commandName,\s*commandInput,\s*options\s*\}/);
        expect(s3Readme).not.toMatch(/\{\s*commandInput,\s*options\s*\}\s*=\s*call\.input/);
        expect(s3Readme).toMatch(/commandInput/);
    });
});

describe('pg factory types in api-surface match source', () => {
    it('knex factory options include extensions and knexConfig', () => {
        const optionsStart = apiSurface.indexOf('export type CreateProbedKnexAdapterOptions');
        expect(optionsStart, 'CreateProbedKnexAdapterOptions declaration must exist').toBeGreaterThan(-1);
        const options = apiSurface.slice(optionsStart, optionsStart + 800);
        expect(options).toMatch(/extensions\?/);
        expect(options).toMatch(/knexConfig\?/);
        const handleStart = apiSurface.indexOf('export type ProbedKnexAdapter');
        expect(handleStart, 'ProbedKnexAdapter declaration must exist').toBeGreaterThan(-1);
        const handle = apiSurface.slice(handleStart, handleStart + 400);
        expect(handle).toMatch(/ProbedAdapterWithLifecycle/);
    });

    it('sequelize factory options match source', () => {
        const optionsStart = apiSurface.indexOf('export type CreateProbedSequelizeAdapterOptions');
        expect(optionsStart, 'CreateProbedSequelizeAdapterOptions declaration must exist').toBeGreaterThan(-1);
        const options = apiSurface.slice(optionsStart, optionsStart + 900);
        expect(options).toMatch(/bootstrap\?/);
        expect(options).toMatch(/preBootstrap\?/);
        expect(options).toMatch(/models\?/);
        expect(options).toMatch(/SequelizeClass\?/);
        expect(options).toMatch(/extensions\?/);
        expect(options).toMatch(/sequelizeOptions\?/);
        const handleStart = apiSurface.indexOf('export type ProbedSequelizeAdapter');
        expect(handleStart, 'ProbedSequelizeAdapter declaration must exist').toBeGreaterThan(-1);
        const handle = apiSurface.slice(handleStart, handleStart + 500);
        expect(handle).toMatch(/seed\(table:\s*string,\s*rows:\s*ReadonlyArray<Record<string,\s*unknown>>\)/);
        expect(handle).toMatch(/ProbedAdapterWithLifecycle/);
    });

    it('kysely handle documents pglite and notifications', () => {
        const handleStart = apiSurface.indexOf('export type ProbedKyselyAdapter');
        expect(handleStart, 'ProbedKyselyAdapter declaration must exist').toBeGreaterThan(-1);
        const handle = apiSurface.slice(handleStart, handleStart + 700);
        expect(handle).toMatch(/\bpglite\b/);
        expect(handle).toMatch(/\bnotifications\b/);
        expect(handle).toMatch(/ProbedAdapterWithLifecycle/);
    });
});

describe('Unshipped HTTP package is not presented as current', () => {
    it('test-kit-http is not documented as a live package', () => {
        expect(
            filesWhere(docs, definesHttpCurrentApi),
            'library docs must not define HttpClient/HttpCall/HttpPendingCall/HttpProbe as current API',
        ).toEqual([]);
        expect(
            filesWhere(docs, listsLiveHttpPackage),
            'library docs must not list packages/http/ as part of the live repository tree',
        ).toEqual([]);
    });
});

describe('Live documentation filenames are current', () => {
    it('v2-prefixed doc filenames are not cited as live paths', () => {
        expect(filesWhere(docs, citesV2DocFilename), 'library docs must not cite v2-*.md as live paths').toEqual([]);
        expect(
            filesWhere(impl, citesV2DocFilename),
            'implementation corpus must not cite v2-*.md as live paths',
        ).toEqual([]);
    });
});

describe('pglite-driver is documented as published', () => {
    it('pglite-driver is not documented as private', () => {
        const pgliteIndex = readUtf8(path.join(repoRoot, 'packages/pglite-driver/src/index.ts'));
        expect(claimsPgliteDriverPrivate(pgliteIndex), 'pglite-driver src comments must not claim private: true').toBe(
            false,
        );
        expect(
            filesWhere(docs, claimsPgliteDriverPrivate),
            'library docs must not state that pglite-driver is private: true or unpublished',
        ).toEqual([]);
    });
});

describe("pg-kysely's dialect dependency is named correctly", () => {
    it('APPENDIX names kysely-pglite-dialect', () => {
        const kyselyRow = appendix
            .split('\n')
            .find((line) => line.includes('Kysely') && line.includes('test-kit-pg-kysely'));
        const surface = kyselyRow ?? appendix;
        expect(surface.includes('kysely-pglite-dialect'), 'APPENDIX must name kysely-pglite-dialect').toBe(true);
        expect(
            /kysely-pglite(?!-dialect)/.test(surface),
            'APPENDIX must not claim kysely-pglite is that dependency',
        ).toBe(false);
    });
});

describe('Package inventories list every published workspace package', () => {
    it('root README package table is complete', () => {
        const table = markdownSection(rootReadme, '## Packages');
        expect(missingPublishedPackages(table), 'Packages table must include a row for each published package').toEqual(
            [],
        );
    });

    it('architecture package graph is complete', () => {
        const graph = markdownSection(architecture, '## Package Graph');
        expect(graph.includes('kafka') || namesPublishedPackage(graph, '@vnatures/test-kit-kafka')).toBe(true);
        expect(graph.includes('sqs') || namesPublishedPackage(graph, '@vnatures/test-kit-sqs')).toBe(true);
        expect(graph.includes('mysql') || namesPublishedPackage(graph, '@vnatures/test-kit-mysql')).toBe(true);
        expect(
            missingPublishedPackages(graph),
            'Package Graph and domain-layer list must name all thirteen packages',
        ).toEqual([]);
    });

    it('api-surface package names list is complete', () => {
        const names = markdownSection(apiSurface, '## Package Names');
        expect(names.includes('@vnatures/test-kit-sql')).toBe(true);
        expect(names.includes('@vnatures/test-kit-pglite-driver')).toBe(true);
        expect(missingPublishedPackages(names), 'Package Names must list all thirteen published packages').toEqual([]);
    });
});

describe('architecture repository layout matches the tree', () => {
    it('architecture layout files exist on disk', () => {
        const tree = repositoryLayoutTree(architecture);
        const parsed = parseLayoutTree(tree);
        const namedSrcFiles = parsed.files.filter((file) => /^packages\/[^/]+\/src\//.test(file));
        expect(namedSrcFiles.length, 'Repository Layout tree must name packages/*/src files').toBeGreaterThan(0);
        const missing = namedSrcFiles.filter((file) => !existsSync(path.join(repoRoot, file)));
        expect(missing, 'every packages/*/src file named in the Repository Layout tree must exist').toEqual([]);
        const forbiddenHits = forbiddenLayoutSrcPaths.filter((file) => parsed.files.includes(file));
        expect(forbiddenHits, 'Repository Layout must not name files that do not exist').toEqual([]);
        const uniqueForbiddenNames = [
            'selection.ts',
            'rule-builder.ts',
            'expectations.ts',
            'pending-call.ts',
            'probe-root.ts',
            'command-extraction.ts',
            'lifecycle.ts',
            'maintenance-connection.ts',
        ];
        expect(
            uniqueForbiddenNames.filter((name) => new RegExp(`\\b${name.replace('.', '\\.')}\\b`).test(tree)),
            'Repository Layout must not name removed core/sql/s3/pglite-driver files',
        ).toEqual([]);
    });

    it('architecture layout includes the omitted packages and files', () => {
        const tree = repositoryLayoutTree(architecture);
        const parsed = parseLayoutTree(tree);
        expect(layoutMentionsPath(parsed.files, parsed.dirs, 'packages/bull')).toBe(true);
        expect(layoutMentionsPath(parsed.files, parsed.dirs, 'packages/kafka')).toBe(true);
        expect(layoutMentionsPath(parsed.files, parsed.dirs, 'packages/mysql')).toBe(true);
        expect(layoutMentionsPath(parsed.files, parsed.dirs, 'packages/sqs')).toBe(true);
        expect(parsed.files.includes('docs/internal/tech-design.md') || tree.includes('tech-design.md')).toBe(true);
        expect(parsed.files.includes('packages/core/src/expectation-engine.ts')).toBe(true);
        expect(parsed.files.includes('packages/core/src/stream-probe-engine.ts')).toBe(true);
        expect(parsed.files.includes('packages/core/src/stream-types.ts')).toBe(true);
        expect(parsed.files.includes('packages/core/src/types.ts')).toBe(true);
        expect(tree).toMatch(/concepts\.md/);
        expect(tree).toMatch(/api-surface\.md/);
        expect(tree).toMatch(/architecture\.md/);
        expect(tree).not.toMatch(/v2-concepts\.md|v2-api-surface\.md|v2-architecture\.md|v2-tech-design\.md/);
    });
});

describe('tech-design build section matches the manifests', () => {
    it('tech-design module path is dist/index.js', () => {
        const build = markdownSection(techDesign, '## Build & Distribution');
        expect(build).toMatch(/"module":\s*"\.\/dist\/index\.js"/);
        expect(build).not.toMatch(/"module":\s*"\.\/dist\/index\.mjs"/);
        expect(build).toMatch(/"import"/);
        expect(build).toMatch(/"require"/);
        expect(build).toMatch(/\.d\.cts/);
        expect(build).not.toMatch(/"version":\s*"2\.0\.0"/);
    });

    it('tech-design root scripts match package.json', () => {
        const build = markdownSection(techDesign, '## Build & Distribution');
        expect(build).not.toMatch(/"build":\s*"tsc --build &&/);
        expect(build).toMatch(/lint --workspaces --if-present/);
        expect(build).toMatch(/format:check/);
        expect(build).toMatch(/"vite":\s*"\^6|"vite":\s*"6/);
        expect(build).toMatch(/"vitest":\s*"\^3|"vitest":\s*"3/);
        expect(build).toMatch(/"eslint":\s*"\^8|"eslint":\s*"8/);
        expect(build).toMatch(/pretest/);
        expect(build).not.toMatch(/test:watch/);
        expect(build).toMatch(/\.\/packages\/bull/);
        expect(build).toMatch(/\.\/packages\/kafka/);
        expect(build).toMatch(/\.\/packages\/mysql/);
        expect(build).toMatch(/\.\/packages\/sqs/);
        expect(build).toMatch(/\.\/examples\/grpc-client/);
        expect(build).not.toMatch(/lists no `devDependencies`/);
        expect(build).toMatch(/own `devDependencies`|declare their own `devDependencies`/);
    });

    it('tech-design does not claim pglite-driver has tests or that tsd is installed', () => {
        expect(
            claimsPgliteDriverHasTestDir(techDesign),
            'tech-design must not claim pglite-driver has a test/ directory',
        ).toBe(false);
        expect(
            claimsPgliteDriverHasTestDir(architecture),
            'architecture must not claim pglite-driver has a test/ directory',
        ).toBe(false);
        expect(
            presentsTsdAsInstalled(techDesign),
            'tech-design must not present tsd as installed without a lockfile caveat',
        ).toBe(false);
        expect(
            presentsTsdAsInstalled(architecture),
            'architecture must not present tsd as installed without a lockfile caveat',
        ).toBe(false);
    });
});

describe('Resolved design decisions are not listed as open', () => {
    it('architecture does not list shipped decisions as open', () => {
        const open = markdownSection(architecture, '## Decisions Still Open (for Implementation Phase)');
        expect(open).not.toMatch(/createProbeRoot/);
        expect(open).not.toMatch(/Internal storage representation/i);
        expect(open).not.toMatch(/pglite-driver/);
        expect(open).not.toMatch(/Error class hierarchy/i);
        expect(open).not.toMatch(/Package naming/i);
        expect(open).not.toMatch(/boundary-probe/);
    });

    it('QueryProbe package location is not hedged', () => {
        expect(apiSurface).toMatch(/QueryProbe/);
        expect(apiSurface).toMatch(/@vnatures\/test-kit-sql/);
        expect(apiSurface).not.toMatch(/or a sibling/);
    });
});

describe('Named consumer-facing exports appear in api-surface', () => {
    it('consumer-facing exports are named in api-surface', () => {
        const missing = consumerFacingExports.filter((name) => !apiSurface.includes(name));
        expect(missing, 'each named consumer-facing export must appear in docs/api-surface.md').toEqual([]);
    });
});

describe('api-surface type sketches match source aliases', () => {
    it('probes that forward are documented as ForwardableProbe', () => {
        expect(extendsForwardableProbe(apiSurface, 'QueryProbe')).toBe(true);
        expect(extendsForwardableProbe(apiSurface, 'CacheProbe')).toBe(true);
        expect(extendsForwardableProbe(apiSurface, 'S3Probe')).toBe(true);
        expect(apiSurface).not.toMatch(/Finalized v2 API Decisions/);
        expect(apiSurface).not.toMatch(/part of the v2 target/);
    });

    it('call shapes are documented as interfaces', () => {
        for (const name of ['QueryCall', 'CacheCall', 'BullQueueCall', 'S3Call', 'PresignCall', 'SqsCall'] as const) {
            expect(interfaceDecl(apiSurface, name), `${name} must be documented as an interface`).toEqual(
                expect.any(String),
            );
            expect(typeAliasObjectDecl(apiSurface, name), `${name} must not be a type alias to an object literal`).toBe(
                undefined,
            );
        }
    });

    it('error templates include command wording, atLeast, and cannotForwardNoBacking', () => {
        const errors = markdownSection(apiSurface, '## Error Message Requirements');
        expect(errors).toMatch(/Cannot forward \{domain\} command/);
        expect(errors).not.toMatch(/Cannot forward \{domain\} call/);
        expect(errors).toMatch(/waiting for atLeast\(/);
        expect(errors).toMatch(/Cannot forward: this probe has no backing\./);
    });
});

describe('v1/v2 framing matches shipped 1.x', () => {
    it('migration tables are not headed v1 vs v2', () => {
        expect(migration).not.toMatch(/\|\s*v1\s*\|\s*v2\s*\|/);
    });

    it('concepts.md does not describe the shipped API as v2', () => {
        expect(concepts).not.toContain('v2 uses');
        expect(concepts).not.toContain('A v2 adapter');
        expect(concepts).not.toContain('v2 inverts the model');
    });
});

describe('Relative documentation links resolve', () => {
    it('pglite-driver README exists', () => {
        expect(existsSync(path.join(repoRoot, 'packages/pglite-driver/README.md'))).toBe(true);
    });

    it('sql README pglite-driver link resolves', () => {
        const targets = relativeMarkdownTargets(sqlReadme).filter((target) =>
            target.includes('pglite-driver/README.md'),
        );
        expect(targets.length, 'sql README must link to pglite-driver/README.md').toBeGreaterThan(0);
        for (const target of targets) {
            const resolved = path.resolve(path.join(repoRoot, 'packages/sql'), target);
            expect(existsSync(resolved), `resolved link ${target} must exist`).toBe(true);
        }
    });
});

describe('Harness prose does not claim the 41 defects are still open', () => {
    it('present-tense 41-defect caveat is gone', () => {
        const hits = filesWhere(harness, (content) =>
            presentTenseDefectPhrases.some((phrase) => content.includes(phrase)),
        );
        expect(hits, 'harness markdown must not claim the 41 defects are still outstanding').toEqual([]);
    });
});

describe('Docs-truth tests run on the root test path', () => {
    it('docs-truth tests are in the Vitest workspace', () => {
        expect(existsSync(vitestConfigPath), 'vitest.config.ts must exist').toBe(true);
        const config = readUtf8(vitestConfigPath);
        expect(config.includes('test.projects'), 'vitest.config.ts must contain test.projects').toBe(true);
        expect(
            config.includes('test/docs-truth'),
            'vitest.config.ts test.projects must include a project that picks up the tests for this capability',
        ).toBe(true);
    });
});

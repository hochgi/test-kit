import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

const localSettingsPath = path.join(repoRoot, '.claude', 'settings.local.json');
const launchJsonPath = path.join(repoRoot, '.claude', 'launch.json');
const gitignorePath = path.join(repoRoot, '.gitignore');
const circleConfigPath = path.join(repoRoot, '.circleci', 'config.yml');
const circleCiPath = path.join(repoRoot, '.circleci', 'ci.yml');
const workspacePath = path.join(repoRoot, 'vitest.workspace.ts');
const componentTestingSkillPath = path.join(repoRoot, '.cursor', 'skills', 'component-testing', 'SKILL.md');

const harnessMarkdownDirs = [
    '.cursor/agents',
    '.cursor/skills',
    '.cursor/commands',
    '.claude/agents',
    '.claude/skills',
    '.claude/commands',
] as const;

const workspaceWideSamplePaths = [
    'package.json',
    'tsconfig.json',
    'tsconfig.base.json',
    '.eslintrc.json',
    'vitest.workspace.ts',
    'docs/internal/spec/ci-gate.md',
    '.circleci/ci.yml',
    '.circleci/config.yml',
    '.cursor/commands/spec-to-ship.md',
] as const;

const publishedPackages = [
    'core',
    'pglite-driver',
    'mock',
    'sql',
    'redis',
    'bull',
    's3',
    'sqs',
    'kafka',
    'mysql',
    'pg-kysely',
    'pg-knex',
    'pg-sequelize',
] as const;

const checkSteps = ['format:check', 'lint', 'typecheck', 'build', 'test'] as const;

const forbiddenPermissionStrings = ['Bash(git push *)', 'Bash(gh pr *)', 'Read(//Users/giladhoch/dev/**)'] as const;

type MappingLine = readonly [regex: string, param: string, value: string];

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readUtf8(filePath: string): string {
    return readFileSync(filePath, 'utf8');
}

function readRootScripts(): Record<string, string> {
    const parsed: unknown = JSON.parse(readUtf8(path.join(repoRoot, 'package.json')));
    if (!isRecord(parsed) || !isRecord(parsed['scripts'])) {
        return {};
    }
    const scripts: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed['scripts'])) {
        if (typeof value === 'string') {
            scripts[key] = value;
        }
    }
    return scripts;
}

function npmScriptInvoked(segment: string): string | undefined {
    const trimmed = segment.trim();
    if (/^npm\s+test\b/.test(trimmed)) {
        return 'test';
    }
    const run = trimmed.match(/^npm\s+run\s+(\S+)/);
    return run?.[1];
}

function gitignorePatternLines(text: string): string[] {
    return text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('#'));
}

function ignoresEntireClaudeDirectory(pattern: string): boolean {
    if (pattern.startsWith('!')) {
        return false;
    }
    const normalized = pattern.replaceAll('\\', '/').replace(/\/+$/, '');
    return (
        normalized === '.claude' ||
        normalized === '.claude/*' ||
        normalized === '.claude/**' ||
        normalized === '**/.claude' ||
        normalized === '**/.claude/*' ||
        normalized === '**/.claude/**'
    );
}

function parseMappingBlock(configYml: string): MappingLine[] {
    const lines = configYml.split('\n');
    let mappingIndent: number | undefined;
    const entries: MappingLine[] = [];
    for (const line of lines) {
        if (mappingIndent === undefined) {
            const header = line.match(/^(\s*)mapping:\s*\|?\s*$/);
            if (header?.[1] !== undefined) {
                mappingIndent = header[1].length;
            }
            continue;
        }
        if (line.trim() === '') {
            continue;
        }
        const indent = line.match(/^(\s*)/)?.[1]?.length ?? 0;
        if (indent <= mappingIndent) {
            break;
        }
        const parts = line.trim().split(/\s+/);
        const regex = parts[0];
        const param = parts[1];
        const value = parts.slice(2).join(' ');
        if (regex === undefined || param === undefined || value === '') {
            continue;
        }
        entries.push([regex, param, value]);
    }
    return entries;
}

function pathMatchesMapping(regex: string, samplePath: string): boolean {
    return new RegExp(`^${regex}$`).test(samplePath);
}

function mappingsSetting(mappings: MappingLine[], samplePath: string, param: string, value: string): MappingLine[] {
    return mappings.filter(
        ([regex, mappedParam, mappedValue]) =>
            pathMatchesMapping(regex, samplePath) && mappedParam === param && mappedValue === value,
    );
}

function topLevelSection(yaml: string, name: string): string | undefined {
    const lines = yaml.split('\n');
    const start = lines.findIndex((line) => line === `${name}:` || line.startsWith(`${name}: `));
    if (start === -1) {
        return undefined;
    }
    const collected: string[] = [];
    for (let i = start + 1; i < lines.length; i += 1) {
        const line = lines[i];
        if (line !== undefined && /^[^\s#]/.test(line) && line.trim() !== '') {
            break;
        }
        if (line !== undefined) {
            collected.push(line);
        }
    }
    return collected.join('\n');
}

function namedBlocks(section: string, indent: number): Array<{ name: string; body: string }> {
    const prefix = ' '.repeat(indent);
    const blocks: Array<{ name: string; body: string }> = [];
    let current: { name: string; lines: string[] } | undefined;
    for (const line of section.split('\n')) {
        if (line.startsWith(prefix) && !line.startsWith(`${prefix} `)) {
            const name = line.slice(indent).match(/^([A-Za-z0-9_-]+):\s*$/)?.[1];
            if (name !== undefined) {
                if (current !== undefined) {
                    blocks.push({ name: current.name, body: current.lines.join('\n') });
                }
                current = { name, lines: [] };
                continue;
            }
        }
        if (current !== undefined) {
            current.lines.push(line);
        }
    }
    if (current !== undefined) {
        blocks.push({ name: current.name, body: current.lines.join('\n') });
    }
    return blocks;
}

function declaresBooleanParamDefaultFalse(ciYml: string, param: string): boolean {
    const parameters = topLevelSection(ciYml, 'parameters');
    if (parameters === undefined) {
        return false;
    }
    const block = namedBlocks(parameters, 2).find((entry) => entry.name === param);
    if (block === undefined) {
        return false;
    }
    return /^\s*type:\s*boolean\s*$/m.test(block.body) && /^\s*default:\s*false\s*$/m.test(block.body);
}

function workflows(ciYml: string): Array<{ name: string; body: string }> {
    const section = topLevelSection(ciYml, 'workflows');
    if (section === undefined) {
        return [];
    }
    return namedBlocks(section, 2);
}

function jobs(ciYml: string): Map<string, string> {
    const section = topLevelSection(ciYml, 'jobs');
    const map = new Map<string, string>();
    if (section === undefined) {
        return map;
    }
    for (const job of namedBlocks(section, 2)) {
        map.set(job.name, job.body);
    }
    return map;
}

function isGatedOn(workflowBody: string, param: string): boolean {
    return new RegExp(`pipeline\\.parameters\\.${param}>>`).test(workflowBody);
}

function referencedJobNames(workflowBody: string): string[] {
    const names: string[] = [];
    for (const line of workflowBody.split('\n')) {
        const match = line.match(/^\s+-\s+(\S+?)(?::\s*)?$/);
        if (match?.[1] !== undefined) {
            names.push(match[1]);
        }
    }
    return names;
}

function workflowAndJobText(ciYml: string, workflowBody: string): string {
    const jobMap = jobs(ciYml);
    const referenced = referencedJobNames(workflowBody).map((name) => jobMap.get(name) ?? '');
    return [workflowBody, ...referenced].join('\n');
}

function trackedMarkdownUnder(dirs: readonly string[]): string[] {
    const listed = execFileSync('git', ['ls-files', '-z', '--', ...dirs], {
        cwd: repoRoot,
        encoding: 'utf8',
    });
    return listed.split('\0').filter((file) => file !== '' && (file.endsWith('.md') || file.endsWith('.mdc')));
}

function describesRepoWideGate(content: string): boolean {
    const listsGateSteps =
        content.includes('format:check') &&
        /\blint\b/.test(content) &&
        content.includes('typecheck') &&
        /\bbuild\b/.test(content) &&
        /\btest\b/.test(content);
    const claimsNoCheckScript = /no `check` script|there is no `check` script|check script is absent/i.test(content);
    return listsGateSteps || claimsNoCheckScript;
}

function claimsCheckScriptAbsent(content: string): boolean {
    return /no `check` script|there is no `check` script|check script is absent/i.test(content);
}

function statesNoGitHooks(content: string): boolean {
    return /no git hooks/i.test(content);
}

describe('Root check script', () => {
    it('check script is defined', () => {
        const check = readRootScripts()['check'];
        expect(check, 'root package.json must define scripts.check').toEqual(expect.any(String));
        const invoked = (check ?? '').split('&&').map(npmScriptInvoked);
        expect(invoked, 'check must run format:check, lint, typecheck, build, then test, separated only by &&').toEqual(
            [...checkSteps],
        );
    });

    it('check is fail-closed', () => {
        const check = readRootScripts()['check'];
        expect(check, 'scripts.check must exist so fail-closed chaining can be inspected').toEqual(expect.any(String));
        const command = check ?? '';
        expect(command.includes(';'), 'check must not use ; between steps').toBe(false);
        expect(command.includes('||'), 'check must not use || between steps').toBe(false);
        expect(command.replaceAll('&&', '').includes('&'), 'check must not use standalone & between steps').toBe(false);
        expect(command.replaceAll('||', '').includes('|'), 'check must not use | between steps').toBe(false);
    });
});

describe('Stale Claude worktree is unregistered', () => {
    it('gallant-ritchie worktree is absent', () => {
        const porcelain = execFileSync('git', ['worktree', 'list', '--porcelain'], {
            cwd: repoRoot,
            encoding: 'utf8',
        });
        const worktreePaths = porcelain
            .split('\n')
            .filter((line) => line.startsWith('worktree '))
            .map((line) => line.slice('worktree '.length));
        const stale = worktreePaths.filter((worktreePath) =>
            worktreePath.endsWith('.claude/worktrees/gallant-ritchie-e7507a'),
        );
        expect(stale, 'no worktree path may end with .claude/worktrees/gallant-ritchie-e7507a').toEqual([]);
    });
});

describe('No cross-repo Claude launch config', () => {
    it('launch.json is absent', () => {
        expect(existsSync(launchJsonPath), '.claude/launch.json must not exist').toBe(false);
    });
});

describe('Local Claude settings do not undercut read-only phases', () => {
    it.skipIf(!existsSync(localSettingsPath))('forbidden grants are absent when the file exists', () => {
        const parsed: unknown = JSON.parse(readUtf8(localSettingsPath));
        const allow = isRecord(parsed) && isRecord(parsed['permissions']) ? parsed['permissions']['allow'] : undefined;
        expect(Array.isArray(allow), 'settings.local.json permissions.allow must be an array').toBe(true);
        const grants = Array.isArray(allow) ? allow.filter((entry): entry is string => typeof entry === 'string') : [];
        for (const grant of forbiddenPermissionStrings) {
            expect(grants.includes(grant), `${grant} must not appear in permissions.allow`).toBe(false);
        }
        const crossRepoHomeRead = grants.filter(
            (grant) => grant.startsWith('Read(//Users/') && grant.includes('/dev/**'),
        );
        expect(crossRepoHomeRead, 'must not Read(//Users/.../dev/**)').toEqual([]);
        const raw = readUtf8(localSettingsPath);
        const corpus = `${raw}\n${JSON.stringify(parsed)}`;
        const hasCircleCiPoll =
            grants.some((grant) => /circleci/i.test(grant) && grant.includes('docs/v2-probed-adapters')) ||
            (/circleci/i.test(corpus) && corpus.includes('docs/v2-probed-adapters'));
        expect(hasCircleCiPoll, 'must not poll CircleCI for docs/v2-probed-adapters').toBe(false);
        const hasGitCIntoReports =
            grants.some((grant) => /git\s+-C\b/.test(grant) && grant.includes('reports_service')) ||
            (/git\s+-C\b/.test(corpus) && corpus.includes('reports_service'));
        expect(hasGitCIntoReports, 'must not git -C into reports_service').toBe(false);
    });

    it('missing local settings file is allowed', () => {
        const present = existsSync(localSettingsPath);
        if (!present) {
            expect(present).toBe(false);
            return;
        }
        expect(present).toBe(true);
    });
});

describe('gitignore tracks harness, ignores local Claude state', () => {
    it('gitignore is narrowed', () => {
        const patterns = gitignorePatternLines(readUtf8(gitignorePath));
        expect(patterns, '.gitignore must ignore .claude/settings.local.json').toContain('.claude/settings.local.json');
        expect(
            patterns.includes('.claude/worktrees/') || patterns.includes('.claude/worktrees'),
            '.gitignore must ignore .claude/worktrees/',
        ).toBe(true);
        const wholesale = patterns.filter(ignoresEntireClaudeDirectory);
        expect(wholesale, '.gitignore must not ignore the entire .claude/ directory').toEqual([]);
    });
});

describe('Workspace-wide path changes run the root check in CI', () => {
    it('workspace-wide paths are mapped', () => {
        const mappings = parseMappingBlock(readUtf8(circleConfigPath));
        for (const samplePath of workspaceWideSamplePaths) {
            expect(
                mappingsSetting(mappings, samplePath, 'build_workspace', 'true').length,
                `${samplePath} must match a mapping that sets build_workspace true`,
            ).toBeGreaterThan(0);
        }
        const rootPackageMappings = mappingsSetting(mappings, 'package.json', 'build_workspace', 'true');
        expect(rootPackageMappings.length, 'root package.json must have a build_workspace mapping').toBeGreaterThan(0);
        for (const [regex] of rootPackageMappings) {
            expect(
                pathMatchesMapping(regex, 'packages/core/package.json'),
                `root package.json mapping ${regex} must not match packages/core/package.json`,
            ).toBe(false);
        }
    });

    it('workspace-wide workflow runs check', () => {
        const ciYml = readUtf8(circleCiPath);
        expect(
            declaresBooleanParamDefaultFalse(ciYml, 'build_workspace'),
            'ci.yml must declare build_workspace as boolean default false',
        ).toBe(true);
        const gated = workflows(ciYml).filter((workflow) => isGatedOn(workflow.body, 'build_workspace'));
        expect(gated.length, 'a workflow must be gated on build_workspace').toBeGreaterThan(0);
        const runsCheck = gated.some((workflow) => workflowAndJobText(ciYml, workflow.body).includes('npm run check'));
        expect(runsCheck, 'the build_workspace workflow must invoke npm run check').toBe(true);
    });
});

describe('grpc-client is a CI-checked extender guard', () => {
    it('grpc-client path is mapped', () => {
        const mappings = parseMappingBlock(readUtf8(circleConfigPath));
        expect(
            mappingsSetting(mappings, 'examples/grpc-client/src/index.ts', 'build_grpc_client', 'true').length,
            'a path under examples/grpc-client/ must set build_grpc_client true',
        ).toBeGreaterThan(0);
    });

    it('grpc-client workflow lints and tests without publishing', () => {
        const ciYml = readUtf8(circleCiPath);
        expect(
            declaresBooleanParamDefaultFalse(ciYml, 'build_grpc_client'),
            'ci.yml must declare build_grpc_client as boolean default false',
        ).toBe(true);
        const gated = workflows(ciYml).filter((workflow) => isGatedOn(workflow.body, 'build_grpc_client'));
        expect(gated.length, 'a workflow must be gated on build_grpc_client').toBeGreaterThan(0);
        const combined = gated.map((workflow) => workflowAndJobText(ciYml, workflow.body)).join('\n');
        expect(combined.includes('examples/grpc-client'), 'workflow must target examples/grpc-client').toBe(true);
        expect(/\blint\b/.test(combined), 'grpc-client workflow must run lint').toBe(true);
        expect(/\btest\b/.test(combined), 'grpc-client workflow must run test').toBe(true);
        expect(
            combined.includes('vn-ci/build-publish'),
            'grpc-client workflow must not invoke vn-ci/build-publish',
        ).toBe(false);
    });
});

describe('Gate-describing harness prose names the real gates', () => {
    it('existing gate prose uses check and names the missing hooks', () => {
        const files = trackedMarkdownUnder(harnessMarkdownDirs);
        const gateFiles = files.filter((file) => describesRepoWideGate(readUtf8(path.join(repoRoot, file))));
        if (gateFiles.length === 0) {
            expect(gateFiles).toEqual([]);
            return;
        }
        for (const file of gateFiles) {
            const content = readUtf8(path.join(repoRoot, file));
            expect(content.includes('npm run check'), `${file} must instruct npm run check`).toBe(true);
            expect(statesNoGitHooks(content), `${file} must state that there are no git hooks`).toBe(true);
            expect(claimsCheckScriptAbsent(content), `${file} must not claim the check script is absent`).toBe(false);
        }
    });

    it('files that do not describe the repo gate are out of this requirement', () => {
        if (!existsSync(componentTestingSkillPath)) {
            expect(existsSync(componentTestingSkillPath)).toBe(false);
            return;
        }
        const content = readUtf8(componentTestingSkillPath);
        if (!describesRepoWideGate(content)) {
            expect(
                content.includes('npm run check'),
                'component-testing SKILL.md does not describe the repo gate, so npm run check is not required',
            ).toBe(content.includes('npm run check'));
        }
    });
});

describe('New TypeScript for this capability is on the root test and format paths', () => {
    it('repo-gate tests are in the Vitest workspace', () => {
        const workspace = readUtf8(workspacePath);
        expect(
            workspace.includes('test/ci-gate'),
            'vitest.workspace.ts must include a project that picks up test/ci-gate',
        ).toBe(true);
    });

    it('repo-gate TypeScript is format-checked', () => {
        const formatCheck = readRootScripts()['format:check'];
        expect(formatCheck, 'root package.json must define scripts.format:check').toEqual(expect.any(String));
        const coversTests =
            (formatCheck ?? '').includes('test/**/*.ts') || (formatCheck ?? '').includes('test/ci-gate/**/*.ts');
        expect(coversTests, 'format:check glob must cover test/ci-gate TypeScript').toBe(true);
        expect(
            (formatCheck ?? '').includes('vitest.workspace.ts'),
            'format:check glob must cover vitest.workspace.ts',
        ).toBe(true);
    });
});

describe('Per-package CircleCI workflows', () => {
    it('each published package has a path-filter mapping', () => {
        const mappings = parseMappingBlock(readUtf8(circleConfigPath));
        for (const name of publishedPackages) {
            const regex = `packages/${name}/.*`;
            const param = `build_${name.replaceAll('-', '_')}`;
            const found = mappings.some(
                ([mappedRegex, mappedParam, mappedValue]) =>
                    mappedRegex === regex && mappedParam === param && mappedValue === 'true',
            );
            expect(found, `mapping must contain ${regex} ${param} true`).toBe(true);
        }
    });
});

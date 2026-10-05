import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

const localSettingsPath = path.join(repoRoot, '.claude', 'settings.local.json');
const launchJsonPath = path.join(repoRoot, '.claude', 'launch.json');
const gitignorePath = path.join(repoRoot, '.gitignore');
const ciWorkflowPath = path.join(repoRoot, '.github', 'workflows', 'ci.yml');
const releaseWorkflowPath = path.join(repoRoot, '.github', 'workflows', 'release.yml');
const rootLicensePath = path.join(repoRoot, 'LICENSE');
const vitestConfigPath = path.join(repoRoot, 'vitest.config.ts');
const componentTestingSkillPath = path.join(repoRoot, '.cursor', 'skills', 'component-testing', 'SKILL.md');

const harnessMarkdownDirs = [
    '.cursor/agents',
    '.cursor/skills',
    '.cursor/commands',
    '.cursor/rules',
    '.claude/agents',
    '.claude/skills',
    '.claude/commands',
] as const;

const specToShipSkillPath = path.join(repoRoot, '.cursor', 'skills', 'spec-to-ship', 'SKILL.md');

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

const forbiddenPermissionStrings = ['Bash(git push *)', 'Bash(gh pr *)'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readUtf8(filePath: string): string {
    return readFileSync(filePath, 'utf8');
}

function readRootManifest(): Record<string, unknown> {
    const parsed: unknown = JSON.parse(readUtf8(path.join(repoRoot, 'package.json')));
    return isRecord(parsed) ? parsed : {};
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

function workflowTriggers(workflow: string): string[] {
    return namedBlocks(topLevelSection(workflow, 'on') ?? '', 2).map((block) => block.name);
}

function runSteps(workflow: string): string[] {
    return workflow
        .split('\n')
        .map((line) => line.match(/^\s*-?\s*run:\s*(.+?)\s*$/)?.[1])
        .filter((command): command is string => command !== undefined);
}

function readPackageManifest(name: string): Record<string, unknown> {
    const parsed: unknown = JSON.parse(readUtf8(path.join(repoRoot, 'packages', name, 'package.json')));
    expect(isRecord(parsed), `packages/${name}/package.json must be an object`).toBe(true);
    return isRecord(parsed) ? parsed : {};
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

function claimsLockfileOrPrettierRemainUnmapped(content: string): boolean {
    const nearUnmapped = (token: string): boolean =>
        new RegExp(`unmapped[\\s\\S]{0,240}${token}|${token}[\\s\\S]{0,240}unmapped`, 'i').test(content);
    return nearUnmapped('package-lock\\.json') || nearUnmapped('\\.prettierrc');
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

    it('gitignore lists mutation artifacts', () => {
        const gitignore = readUtf8(gitignorePath);
        for (const token of [
            '.stryker-tmp',
            'reports/mutation',
            'coverage',
            'stryker.log',
            '.stryker-package',
        ] as const) {
            expect(gitignore.includes(token), `.gitignore must contain ${token}`).toBe(true);
        }
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

    it('gate prose does not claim lockfile or prettier holes', () => {
        const files = trackedMarkdownUnder(harnessMarkdownDirs);
        const gateFiles = files.filter((file) => describesRepoWideGate(readUtf8(path.join(repoRoot, file))));
        for (const file of gateFiles) {
            const content = readUtf8(path.join(repoRoot, file));
            expect(
                claimsLockfileOrPrettierRemainUnmapped(content),
                `${file} must not claim that package-lock.json or .prettierrc remain unmapped`,
            ).toBe(false);
        }
    });

    it('spec-to-ship does not defer a markdown linter as a later packet', () => {
        expect(existsSync(specToShipSkillPath), '.cursor/skills/spec-to-ship/SKILL.md must exist').toBe(true);
        const content = readUtf8(specToShipSkillPath);
        expect(content.includes('a later packet'), 'spec-to-ship must not contain "a later packet"').toBe(false);
        expect(
            content.includes('not format-checked or linted by') && content.includes('npm run check'),
            'spec-to-ship must state harness markdown is not format-checked or linted by npm run check',
        ).toBe(true);
        expect(content.includes('.cursor/**'), 'spec-to-ship must state that .cursor/** still run the check job').toBe(
            true,
        );
        expect(content.includes('.claude/**'), 'spec-to-ship must state that .claude/** still run the check job').toBe(
            true,
        );
        expect(
            content.includes('check-agent-skills'),
            'spec-to-ship must state that the workspace-wide check job tests invoke check-agent-skills',
        ).toBe(true);
    });
});

describe('New TypeScript for this capability is on the root test and format paths', () => {
    it('repo-gate tests are in the Vitest workspace', () => {
        expect(existsSync(vitestConfigPath), 'vitest.config.ts must exist').toBe(true);
        const config = readUtf8(vitestConfigPath);
        expect(config.includes('test.projects'), 'vitest.config.ts must contain test.projects').toBe(true);
        expect(
            config.includes('test/ci-gate'),
            'vitest.config.ts test.projects must include a project that picks up test/ci-gate',
        ).toBe(true);
    });

    it('repo-gate TypeScript is format-checked', () => {
        const formatCheck = readRootScripts()['format:check'];
        expect(formatCheck, 'root package.json must define scripts.format:check').toEqual(expect.any(String));
        const coversTests =
            (formatCheck ?? '').includes('test/**/*.ts') || (formatCheck ?? '').includes('test/ci-gate/**/*.ts');
        expect(coversTests, 'format:check glob must cover test/ci-gate TypeScript').toBe(true);
        expect((formatCheck ?? '').includes('vitest.config.ts'), 'format:check glob must cover vitest.config.ts').toBe(
            true,
        );
        expect(
            (formatCheck ?? '').includes('vitest.mutation.config.ts'),
            'format:check glob must cover vitest.mutation.config.ts',
        ).toBe(true);
    });
});

describe('Vitest projects live in vitest.config.ts', () => {
    it('defineWorkspace and vitest.workspace.ts are gone', () => {
        expect(existsSync(path.join(repoRoot, 'vitest.workspace.ts')), 'vitest.workspace.ts must not exist').toBe(
            false,
        );
        expect(existsSync(vitestConfigPath), 'vitest.config.ts must exist').toBe(true);
        const config = readUtf8(vitestConfigPath);
        expect(config.includes('defineWorkspace'), 'vitest.config.ts must not contain defineWorkspace').toBe(false);
        expect(config.includes('test.projects'), 'vitest.config.ts must contain test.projects').toBe(true);
        for (const project of [
            'packages/core',
            'packages/mock',
            'test/ci-gate',
            'test/harness-prose',
            'test/harness-scaffold',
            'test/docs-truth',
        ] as const) {
            expect(config.includes(project), `test.projects must include ${project}`).toBe(true);
        }
        const testScript = readRootScripts()['test'] ?? '';
        expect(testScript.includes('vitest.mutation.config.ts'), 'npm test must not use the mutation aliases').toBe(
            false,
        );
    });

    it('root scripts name vitest.config.ts', () => {
        const scripts = readRootScripts();
        const lint = scripts['lint'] ?? '';
        const formatCheck = scripts['format:check'] ?? '';
        expect(lint.includes('vitest.config.ts'), 'lint must name vitest.config.ts').toBe(true);
        expect(lint.includes('vitest.workspace.ts'), 'lint must not name vitest.workspace.ts').toBe(false);
        expect(formatCheck.includes('vitest.config.ts'), 'format:check must name vitest.config.ts').toBe(true);
        expect(formatCheck.includes('vitest.workspace.ts'), 'format:check must not name vitest.workspace.ts').toBe(
            false,
        );
    });
});

describe('Mutation scripts are defined and stay off check', () => {
    it('test:mutation scripts exist and are not in check', () => {
        const scripts = readRootScripts();
        expect(scripts['test:mutation'], 'root package.json must define scripts.test:mutation').toEqual(
            expect.any(String),
        );
        expect(scripts['test:mutation:changed'], 'root package.json must define scripts.test:mutation:changed').toEqual(
            expect.any(String),
        );
        expect(scripts['check']).toBe(
            'npm run format:check && npm run lint && npm run typecheck && npm run build && npm test',
        );
    });
});

describe('Pull-request CI runs the whole gate without secrets', () => {
    it('ci workflow runs on every pull request and on main, with no path filter', () => {
        const workflow = readUtf8(ciWorkflowPath);
        expect(workflowTriggers(workflow), 'ci.yml must trigger on pull_request and push').toEqual([
            'pull_request',
            'push',
        ]);
        expect(/^\s+branches:\s*\[main\]\s*$/m.test(workflow), 'ci.yml push must be limited to main').toBe(true);
        for (const filter of ['paths:', 'paths-ignore:', 'pull_request_target'] as const) {
            expect(workflow.includes(filter), `ci.yml must not contain ${filter}`).toBe(false);
        }
    });

    it('ci workflow runs npm run check after npm ci', () => {
        const steps = runSteps(readUtf8(ciWorkflowPath));
        const install = steps.indexOf('npm ci');
        const check = steps.indexOf('npm run check');
        expect(install, 'ci.yml must run npm ci').toBeGreaterThanOrEqual(0);
        expect(check, 'ci.yml must run npm run check after npm ci').toBeGreaterThan(install);
    });

    it('ci workflow holds no secrets and only read permission', () => {
        const workflow = readUtf8(ciWorkflowPath);
        expect(workflow.includes('secrets.'), 'ci.yml must not reference secrets').toBe(false);
        expect(workflow.includes('id-token'), 'ci.yml must not request id-token').toBe(false);
        expect(topLevelSection(workflow, 'permissions')?.trim(), 'ci.yml permissions must be contents: read').toBe(
            'contents: read',
        );
    });

    it('ci workflow tests the minimum Node major from engines', () => {
        const engines = readRootManifest()['engines'];
        const node = isRecord(engines) && typeof engines['node'] === 'string' ? engines['node'] : '';
        const minimum = node.match(/^>=(\d+)$/)?.[1];
        expect(minimum, 'root engines.node must be >=<major>').toEqual(expect.any(String));
        const matrix = readUtf8(ciWorkflowPath).match(/^\s+node:\s*\[([^\]]+)\]\s*$/m)?.[1] ?? '';
        const majors = matrix.split(',').map((entry) => entry.trim());
        expect(majors, `ci.yml node matrix must include ${minimum ?? '?'}`).toContain(minimum);
    });

    it('ci workflow dry-runs the release', () => {
        expect(runSteps(readUtf8(ciWorkflowPath)), 'ci.yml must dry-run the publish script').toContain(
            'node scripts/publish-unpublished.mjs --dry-run',
        );
    });

    it('CircleCI is gone', () => {
        expect(existsSync(path.join(repoRoot, '.circleci')), '.circleci/ must not exist').toBe(false);
    });
});

describe('Releases are manual and isolated', () => {
    it('release workflow only runs on manual dispatch', () => {
        expect(workflowTriggers(readUtf8(releaseWorkflowPath)), 'release.yml must trigger only on dispatch').toEqual([
            'workflow_dispatch',
        ]);
    });

    it('release workflow runs the gate before publishing', () => {
        const steps = runSteps(readUtf8(releaseWorkflowPath));
        const check = steps.indexOf('npm run check');
        const publish = steps.indexOf('node scripts/publish-unpublished.mjs');
        expect(check, 'release.yml must run npm run check').toBeGreaterThanOrEqual(0);
        expect(publish, 'release.yml must publish after npm run check').toBeGreaterThan(check);
    });

    it('release workflow uses OIDC in a protected environment and no other secret', () => {
        const workflow = readUtf8(releaseWorkflowPath);
        expect(/^\s+id-token:\s*write\s*$/m.test(workflow), 'release.yml must request id-token: write').toBe(true);
        expect(/^\s+environment:\s*npm\s*$/m.test(workflow), 'release.yml must run in the npm environment').toBe(true);
        const secrets = [...workflow.matchAll(/secrets\.([A-Z_]+)/g)].map((match) => match[1]);
        expect([...new Set(secrets)], 'release.yml may only reference secrets.NPM_TOKEN').toEqual(['NPM_TOKEN']);
    });
});

describe('Every published package is publicly publishable', () => {
    it('each package is MIT, public, provenance-signed, and ships the license', () => {
        const rootLicense = readUtf8(rootLicensePath);
        expect(rootLicense.startsWith('MIT License'), 'root LICENSE must be the MIT license').toBe(true);
        for (const name of publishedPackages) {
            const manifest = readPackageManifest(name);
            expect(manifest['license'], `packages/${name} license`).toBe('MIT');
            expect(manifest['publishConfig'], `packages/${name} publishConfig`).toEqual({
                access: 'public',
                provenance: true,
            });
            expect(manifest['files'], `packages/${name} files must include LICENSE`).toContain('LICENSE');
            expect(
                readUtf8(path.join(repoRoot, 'packages', name, 'LICENSE')),
                `packages/${name}/LICENSE must match the root LICENSE`,
            ).toBe(rootLicense);
        }
    });

    it('no committed npmrc points the scope at a private registry', () => {
        expect(existsSync(path.join(repoRoot, '.npmrc')), 'root .npmrc must not exist').toBe(false);
    });
});

const ratchetRuleNames = [
    'complexity',
    'max-depth',
    'max-params',
    'max-lines-per-function',
    '@typescript-eslint/no-explicit-any',
    '@typescript-eslint/consistent-type-imports',
    '@typescript-eslint/ban-ts-comment',
] as const;

const ratchetRuleNameSet: ReadonlySet<string> = new Set(ratchetRuleNames);

const pinnedMaxLinesOptions = {
    max: 80,
    skipBlankLines: true,
    skipComments: true,
    IIFEs: true,
} as const;

const pinnedBanTsCommentOptions = {
    'ts-expect-error': 'allow-with-description',
    'ts-ignore': 'allow-with-description',
    'ts-nocheck': 'allow-with-description',
    'ts-check': 'allow-with-description',
} as const;

type EslintDisableKind = 'file-or-block' | 'next-or-same-line';

type EslintDisableDirective = {
    kind: EslintDisableKind;
    namedRules: string[];
    hasJustification: boolean;
};

type RatchetDisableHit = {
    file: string;
    namedRules: string[];
    hasJustification: boolean;
};

function readRootEslintConfig(): Record<string, unknown> {
    const parsed: unknown = JSON.parse(readUtf8(path.join(repoRoot, '.eslintrc.json')));
    if (!isRecord(parsed)) {
        return {};
    }
    return parsed;
}

function readRootEslintRules(): Record<string, unknown> {
    const rules = readRootEslintConfig()['rules'];
    return isRecord(rules) ? rules : {};
}

function eslintSeverity(entry: unknown): unknown {
    return Array.isArray(entry) ? entry[0] : entry;
}

function isEslintError(entry: unknown): boolean {
    const severity = eslintSeverity(entry);
    return severity === 'error' || severity === 2;
}

function isWeakenSeverity(entry: unknown): boolean {
    const severity = eslintSeverity(entry);
    return severity === 'off' || severity === 'warn' || severity === 0 || severity === 1;
}

function eslintRuleOptions(entry: unknown): unknown {
    return Array.isArray(entry) && entry.length >= 2 ? entry[1] : undefined;
}

function numericMax(options: unknown): number | undefined {
    if (typeof options === 'number') {
        return options;
    }
    if (isRecord(options) && typeof options['max'] === 'number') {
        return options['max'];
    }
    return undefined;
}

function maxExceeds(options: unknown, limit: number): boolean {
    const max = numericMax(options);
    return max !== undefined && max > limit;
}

function iifesCountAsFunctions(options: unknown): boolean {
    return isRecord(options) && options['IIFEs'] === true;
}

function maxLinesOptionsAreMoreLenient(options: unknown): boolean {
    if (maxExceeds(options, 80)) {
        return true;
    }
    // ESLint defaults IIFEs to false (a long IIFE is not a function). Only an
    // explicit IIFEs: true matches the pinned ratchet.
    return !iifesCountAsFunctions(options);
}

function overrideWeakensRatchet(rule: string, entry: unknown): boolean {
    if (isWeakenSeverity(entry)) {
        return true;
    }
    const options = eslintRuleOptions(entry);
    if (rule === 'complexity') {
        return maxExceeds(options, 12);
    }
    if (rule === 'max-depth') {
        return maxExceeds(options, 4);
    }
    if (rule === 'max-params') {
        return maxExceeds(options, 5);
    }
    if (rule === 'max-lines-per-function') {
        return maxLinesOptionsAreMoreLenient(options);
    }
    return false;
}

function eslintOverrideRuleMaps(config: Record<string, unknown>): Array<Record<string, unknown>> {
    const overrides = config['overrides'];
    if (!Array.isArray(overrides)) {
        return [];
    }
    const maps: Array<Record<string, unknown>> = [];
    for (const override of overrides) {
        if (isRecord(override) && isRecord(override['rules'])) {
            maps.push(override['rules']);
        }
    }
    return maps;
}

function weakenedRatchetRulesIn(rules: Record<string, unknown>): string[] {
    const weakened: string[] = [];
    for (const rule of ratchetRuleNames) {
        if (Object.hasOwn(rules, rule) && overrideWeakensRatchet(rule, rules[rule])) {
            weakened.push(rule);
        }
    }
    return weakened;
}

function trackedTypescriptUnder(dirs: readonly string[]): string[] {
    const listed = execFileSync('git', ['ls-files', '-z', '--', ...dirs], {
        cwd: repoRoot,
        encoding: 'utf8',
    });
    return listed.split('\0').filter((file) => file !== '' && file.endsWith('.ts'));
}

function disableKind(token: string): EslintDisableKind {
    return token === 'eslint-disable' ? 'file-or-block' : 'next-or-same-line';
}

function namedRulesFromDisablePayload(payload: string): string[] {
    const dash = payload.indexOf('--');
    const rulesPart = dash === -1 ? payload : payload.slice(0, dash);
    return rulesPart
        .split(',')
        .map((token) => token.trim())
        .filter((token) => token !== '');
}

function hasNonEmptyJustification(payload: string): boolean {
    const dash = payload.indexOf('--');
    if (dash === -1) {
        return false;
    }
    return payload.slice(dash + 2).trim() !== '';
}

function parseDisableLine(line: string): EslintDisableDirective | undefined {
    const match = /(?:\/\/|\/\*)\s*(eslint-disable(?:-next-line|-line)?)\b(.*)$/.exec(line);
    const token = match?.[1];
    if (token === undefined) {
        return undefined;
    }
    const payload = (match[2] ?? '').replace(/\*\/.*$/, '');
    return {
        kind: disableKind(token),
        namedRules: namedRulesFromDisablePayload(payload),
        hasJustification: hasNonEmptyJustification(payload),
    };
}

function disableDirectivesIn(source: string): EslintDisableDirective[] {
    const found: EslintDisableDirective[] = [];
    for (const line of source.split('\n')) {
        const parsed = parseDisableLine(line);
        if (parsed !== undefined) {
            found.push(parsed);
        }
    }
    return found;
}

function ratchetRulesNamed(namedRules: string[]): string[] {
    return namedRules.filter((rule) => ratchetRuleNameSet.has(rule));
}

function ratchetDisableHitsInFile(file: string, kind: EslintDisableKind): RatchetDisableHit[] {
    const hits: RatchetDisableHit[] = [];
    for (const directive of disableDirectivesIn(readUtf8(path.join(repoRoot, file)))) {
        if (directive.kind !== kind) {
            continue;
        }
        const named = ratchetRulesNamed(directive.namedRules);
        if (named.length === 0) {
            continue;
        }
        hits.push({ file, namedRules: named, hasJustification: directive.hasJustification });
    }
    return hits;
}

function ratchetDisableHits(kind: EslintDisableKind): RatchetDisableHit[] {
    const hits: RatchetDisableHit[] = [];
    for (const file of trackedTypescriptUnder(['packages', 'examples', 'test'])) {
        hits.push(...ratchetDisableHitsInFile(file, kind));
    }
    return hits;
}

function formatDisableHit(hit: RatchetDisableHit): string {
    return `${hit.file} names ${hit.namedRules.join(', ')}`;
}

describe('Blinker ratchet rules are errors in the root ESLint config', () => {
    it('complexity-budget ESLint rules are errors with pinned options', () => {
        const rules = readRootEslintRules();
        expect(isEslintError(rules['complexity']), 'complexity must be error').toBe(true);
        expect(eslintRuleOptions(rules['complexity']), 'complexity options must pin max 12').toEqual({ max: 12 });
        expect(isEslintError(rules['max-depth']), 'max-depth must be error').toBe(true);
        expect(eslintRuleOptions(rules['max-depth']), 'max-depth options must pin 4').toBe(4);
        expect(isEslintError(rules['max-params']), 'max-params must be error').toBe(true);
        expect(eslintRuleOptions(rules['max-params']), 'max-params options must pin 5').toBe(5);
        expect(isEslintError(rules['max-lines-per-function']), 'max-lines-per-function must be error').toBe(true);
        expect(
            eslintRuleOptions(rules['max-lines-per-function']),
            'max-lines-per-function options must pin max 80 with skipBlankLines, skipComments, and IIFEs',
        ).toEqual({ ...pinnedMaxLinesOptions });
    });

    it('type-seam ESLint rules are errors with sibling ban-ts-comment options', () => {
        const rules = readRootEslintRules();
        expect(
            isEslintError(rules['@typescript-eslint/no-explicit-any']),
            '@typescript-eslint/no-explicit-any must be error',
        ).toBe(true);
        expect(
            isEslintError(rules['@typescript-eslint/consistent-type-imports']),
            '@typescript-eslint/consistent-type-imports must be error',
        ).toBe(true);
        expect(
            isEslintError(rules['@typescript-eslint/ban-ts-comment']),
            '@typescript-eslint/ban-ts-comment must be error',
        ).toBe(true);
        expect(
            eslintRuleOptions(rules['@typescript-eslint/ban-ts-comment']),
            'ban-ts-comment must allow the four directives with a description',
        ).toEqual({ ...pinnedBanTsCommentOptions });
    });

    it('eslintrc overrides do not weaken the ratchet rules', () => {
        const weakened: string[] = [];
        for (const [index, rules] of eslintOverrideRuleMaps(readRootEslintConfig()).entries()) {
            for (const rule of weakenedRatchetRulesIn(rules)) {
                weakened.push(`overrides[${index}] ${rule}`);
            }
        }
        expect(
            weakened,
            'no override may set a ratchet rule to off/warn or replace its options with a more lenient max',
        ).toEqual([]);
    });

    it('max-lines skip flags: false is stricter; omitted IIFEs is more lenient', () => {
        expect(
            maxLinesOptionsAreMoreLenient({ max: 80, skipBlankLines: false, skipComments: false, IIFEs: true }),
            'skipBlankLines/skipComments false count more lines',
        ).toBe(false);
        expect(
            maxLinesOptionsAreMoreLenient({ max: 80, skipBlankLines: true, skipComments: true, IIFEs: false }),
            'IIFEs false stops counting IIFEs as functions',
        ).toBe(true);
        expect(maxLinesOptionsAreMoreLenient({ max: 80 }), 'omitted IIFEs defaults to false').toBe(true);
        expect(maxLinesOptionsAreMoreLenient(80), 'numeric form has no IIFEs: true').toBe(true);
        expect(maxLinesOptionsAreMoreLenient({ ...pinnedMaxLinesOptions })).toBe(false);
        expect(maxLinesOptionsAreMoreLenient({ ...pinnedMaxLinesOptions, max: 81 })).toBe(true);
    });
});

describe('Existing ratchet violations use next-line disables with a justification', () => {
    it('no file-level eslint-disable of a ratchet rule', () => {
        const hits = ratchetDisableHits('file-or-block').map(formatDisableHit);
        expect(hits, 'no file-level or block eslint-disable may name a ratchet rule').toEqual([]);
    });

    it('ratchet next-line disables carry a justification', () => {
        const hits = ratchetDisableHits('next-or-same-line')
            .filter((hit) => !hit.hasJustification)
            .map(formatDisableHit);
        expect(
            hits,
            'each eslint-disable-next-line or eslint-disable-line that names a ratchet rule must include -- plus a non-empty justification',
        ).toEqual([]);
    });
});

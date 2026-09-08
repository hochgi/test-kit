import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

const agentOrder = ['spec-author', 'test-author', 'coder', 'reviewer', 'verifier'] as const;

const skillByAgent = {
    'spec-author': 'write-spec',
    'test-author': 'write-failing-tests',
    coder: 'code-to-green',
    reviewer: 'review-changes',
    verifier: 'verify-changes',
} as const;

const expectedReadonly = [false, false, false, true, true] as const;

const supportSkills = [
    'engineering-principles',
    'regression-dog',
    'pr-review-style',
    'hotspot-expansion-review',
    'mutation-testing',
    'component-testing',
] as const;

const phaseSkills = [
    'spec-to-ship',
    'write-spec',
    'write-failing-tests',
    'code-to-green',
    'review-changes',
    'verify-changes',
] as const;

const portedSupportSkills = [
    'engineering-principles',
    'regression-dog',
    'pr-review-style',
    'hotspot-expansion-review',
    'mutation-testing',
] as const;

const donorSkillDirectories = [
    'slack-driven-sessions',
    'post-deploy-verify',
    'help-docs-sync',
    'refactor-to-hexagonal',
    '10-http-boundaries',
    'extend-test-kit',
    'add-module',
] as const;

const donorMachinery = ['@cycle-processing/contracts', 'pnpm verify', 'lefthook'] as const;

const coverageQualityGates = ['test:mutation', 'stryker run', 'pnpm crap'] as const;

const blinkerFiles = [
    '12-no-escape-hatches.mdc',
    '13-method-readability.mdc',
    '15-commands-over-hand-edits.mdc',
    'complexity-budget.mdc',
    '00-architecture-ratchet.mdc',
    '01-architecture-bssn.mdc',
] as const;

const globbedBlinkers = [
    '12-no-escape-hatches.mdc',
    '13-method-readability.mdc',
    '00-architecture-ratchet.mdc',
    '01-architecture-bssn.mdc',
] as const;

const droppedBlinkers = ['component-testing.mdc', '10-http-boundaries.mdc'] as const;

const blinkerProseDirs = ['.cursor/agents', '.claude/agents', '.cursor/skills', '.claude/skills'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readUtf8(filePath: string): string {
    return readFileSync(filePath, 'utf8');
}

function readExisting(relative: string): string {
    const abs = path.join(repoRoot, relative);
    expect(existsSync(abs), `${relative} must exist`).toBe(true);
    return readUtf8(abs);
}

function markdownNames(relativeDir: string): string[] {
    const abs = path.join(repoRoot, relativeDir);
    if (!existsSync(abs)) {
        return [];
    }
    return readdirSync(abs)
        .filter((name) => name.endsWith('.md'))
        .sort();
}

function yamlFrontmatter(content: string): string {
    const lines = content.split('\n');
    if (lines[0] !== '---') {
        return '';
    }
    const end = lines.indexOf('---', 1);
    if (end === -1) {
        return '';
    }
    return lines.slice(1, end).join('\n');
}

function unquote(value: string): string {
    if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
        return value.slice(1, -1);
    }
    return value;
}

function frontmatterScalar(frontmatter: string, key: string): string | undefined {
    const prefix = `${key}:`;
    for (const line of frontmatter.split('\n')) {
        if (line.startsWith(prefix)) {
            return unquote(line.slice(prefix.length).trim());
        }
    }
    return undefined;
}

function frontmatterGlobsText(frontmatter: string): string {
    const collected: string[] = [];
    let inGlobs = false;
    for (const line of frontmatter.split('\n')) {
        if (line.startsWith('globs:')) {
            collected.push(line.slice('globs:'.length).trim());
            inGlobs = true;
            continue;
        }
        if (inGlobs) {
            if (line.startsWith(' ') || line.startsWith('\t')) {
                collected.push(line.trim());
                continue;
            }
            inGlobs = false;
        }
    }
    return collected.join('\n');
}

function frontmatterHasKey(frontmatter: string, key: string): boolean {
    const pattern = new RegExp(`^\\s*${key}:`);
    return frontmatter.split('\n').some((line) => pattern.test(line));
}

function frontmatterToolNames(frontmatter: string): string[] {
    const names: string[] = [];
    let inList = false;
    for (const line of frontmatter.split('\n')) {
        if (line.startsWith('tools:')) {
            const rest = line.slice('tools:'.length).trim();
            if (rest === '' || rest === '|' || rest === '>') {
                inList = true;
                continue;
            }
            const inline = rest.replace(/^\[/, '').replace(/\]$/, '');
            for (const part of inline.split(',')) {
                const token = unquote(part.trim());
                if (token !== '') {
                    names.push(token);
                }
            }
            inList = false;
            continue;
        }
        if (inList) {
            const listItem = line.match(/^\s+-\s+(.+)$/);
            if (listItem?.[1] !== undefined) {
                names.push(unquote(listItem[1].trim()));
                continue;
            }
            if (line.startsWith(' ') || line.startsWith('\t') || line.trim() === '') {
                continue;
            }
            inList = false;
        }
    }
    return names;
}

function parseYamlBoolean(value: string | undefined): boolean | undefined {
    if (value === 'true') {
        return true;
    }
    if (value === 'false') {
        return false;
    }
    return undefined;
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

function asRecord(value: unknown, label: string): Record<string, unknown> {
    expect(isRecord(value), `${label} must be an object`).toBe(true);
    return isRecord(value) ? value : {};
}

function manifestClaudeModel(agent: (typeof agentOrder)[number]): string {
    const parsed: unknown = JSON.parse(readExisting('.harness/models.json'));
    const root = asRecord(parsed, '.harness/models.json');
    const agents = asRecord(root['agents'], 'agents');
    const entry = asRecord(agents[agent], `agents['${agent}']`);
    const claude = entry['claude'];
    expect(typeof claude === 'string' && claude !== '', `agents['${agent}'].claude must be a non-empty string`).toBe(
        true,
    );
    return typeof claude === 'string' ? claude : '';
}

function knownGapsSection(content: string): string {
    const heading = '## Known gaps';
    const start = content.indexOf(heading);
    expect(start, 'docs/internal/spec/core-public-api.md must have a Known gaps heading').toBeGreaterThanOrEqual(0);
    const after = content.slice(start);
    const next = after.slice(heading.length).search(/\n## /);
    return next === -1 ? after : after.slice(0, heading.length + next);
}

function trackedMarkdownUnder(dirs: readonly string[]): string[] {
    const listed = execFileSync('git', ['ls-files', '-z', '--', ...dirs], {
        cwd: repoRoot,
        encoding: 'utf8',
    });
    return listed.split('\0').filter((file) => file !== '' && (file.endsWith('.md') || file.endsWith('.mdc')));
}

function fencedTypescriptBlocks(markdown: string): string[] {
    const blocks: string[] = [];
    const pattern = /^```(?:typescript|ts)[^\n]*\n([\s\S]*?)^```/gm;
    let match: RegExpExecArray | null = pattern.exec(markdown);
    while (match !== null) {
        const body = match[1];
        if (body !== undefined) {
            blocks.push(body);
        }
        match = pattern.exec(markdown);
    }
    return blocks;
}

function typescriptFenceDeclaresRig(block: string): boolean {
    return (
        /\b(?:const|let)\s+rig\b/.test(block) ||
        /\b(?:const|let)\s*\{[^}]*\brig\b/.test(block) ||
        /\b(?:const|let)\s*\[[^\]]*\brig\b/.test(block)
    );
}

function typescriptFenceUsesRigIdentifier(block: string): boolean {
    return /\brig\b/.test(block);
}

describe('Canonical Claude agent files exist', () => {
    it('five canonical Claude agent files exist', () => {
        const dir = path.join(repoRoot, '.claude/agents');
        expect(existsSync(dir), '.claude/agents must exist').toBe(true);
        expect(markdownNames('.claude/agents')).toEqual([
            'coder.md',
            'reviewer.md',
            'spec-author.md',
            'test-author.md',
            'verifier.md',
        ]);
    });

    it('each Claude agent model matches the manifest', () => {
        for (const name of agentOrder) {
            const relative = `.claude/agents/${name}.md`;
            const model = frontmatterScalar(yamlFrontmatter(readExisting(relative)), 'model');
            expect(model, `${relative} must have a model: frontmatter value`).toEqual(expect.any(String));
            expect(model, `${relative} model: must equal agents['${name}'].claude`).toBe(manifestClaudeModel(name));
        }
    });

    it('reviewer and verifier cannot edit', () => {
        for (const name of ['reviewer', 'verifier'] as const) {
            const relative = `.claude/agents/${name}.md`;
            const tools = frontmatterToolNames(yamlFrontmatter(readExisting(relative)));
            expect(tools.includes('Edit'), `${relative} tools: must not contain Edit`).toBe(false);
            expect(tools.includes('Write'), `${relative} tools: must not contain Write`).toBe(false);
        }
    });
});

describe('Canonical spec-to-ship command exists', () => {
    it('spec-to-ship command is canonical under Claude', () => {
        const dir = path.join(repoRoot, '.claude/commands');
        expect(existsSync(dir), '.claude/commands must exist').toBe(true);
        expect(markdownNames('.claude/commands'), '.claude/commands must contain spec-to-ship.md').toContain(
            'spec-to-ship.md',
        );
    });

    it('command has a Model selection paragraph', () => {
        const content = readExisting('.claude/commands/spec-to-ship.md');
        expect(content.includes('**Model selection.**'), 'spec-to-ship.md must contain **Model selection.**').toBe(
            true,
        );
    });

    it('command does not merge or archive on an open PR', () => {
        const content = readExisting('.claude/commands/spec-to-ship.md');
        expect(/thread/i.test(content), 'must mention review threads').toBe(true);
        expect(/stop/i.test(content), 'must tell the orchestrator to stop').toBe(true);
        expect(
            /do not (squash-)?merge/i.test(content) || /not merge.*until the PR is merged/i.test(content),
            'must not instruct merging onto main while the PR is open',
        ).toBe(true);
        expect(
            /not archived on an open PR/i.test(content) ||
                /do not.*archive until/i.test(content) ||
                /until the PR is merged/i.test(content),
            'must not instruct archiving while the PR is open',
        ).toBe(true);
    });
});

describe('Generated agent mirrors carry readonly from the manifest', () => {
    it('Cursor readonly flags match the manifest', () => {
        const flags = agentOrder.map((name) => {
            const relative = `.cursor/agents/${name}.md`;
            const parsed = parseYamlBoolean(frontmatterScalar(yamlFrontmatter(readExisting(relative)), 'readonly'));
            expect(parsed, `${relative} readonly must be a YAML boolean`).toBeTypeOf('boolean');
            return parsed;
        });
        expect(flags, 'readonly must be false, false, false, true, true in phase order').toEqual([...expectedReadonly]);
    });

    it('OpenCode reviewer and verifier deny edit', () => {
        for (const name of ['reviewer', 'verifier'] as const) {
            const relative = `.opencode/agents/${name}.md`;
            const frontmatter = yamlFrontmatter(readExisting(relative));
            expect(frontmatterHasKey(frontmatter, 'permission'), `${relative} must include permission:`).toBe(true);
            expect(frontmatter.includes('edit: deny'), `${relative} must include edit: deny`).toBe(true);
        }
    });

    it('OpenCode mirrors are populated', () => {
        const agentsDir = path.join(repoRoot, '.opencode/agents');
        const commandsDir = path.join(repoRoot, '.opencode/commands');
        expect(existsSync(agentsDir), '.opencode/agents must exist').toBe(true);
        expect(existsSync(commandsDir), '.opencode/commands must exist').toBe(true);
        const agentMd = markdownNames('.opencode/agents');
        for (const name of agentOrder) {
            expect(agentMd, `.opencode/agents must contain ${name}.md`).toContain(`${name}.md`);
        }
        expect(markdownNames('.opencode/commands'), '.opencode/commands must contain spec-to-ship.md').toContain(
            'spec-to-ship.md',
        );
    });
});

describe('Support skills exist under the Cursor canonical tree', () => {
    it('six support skills are present', () => {
        for (const name of supportSkills) {
            const relative = `.cursor/skills/${name}/SKILL.md`;
            expect(existsSync(path.join(repoRoot, relative)), `${relative} must exist`).toBe(true);
        }
    });

    it('six phase skills are present', () => {
        for (const name of phaseSkills) {
            const relative = `.cursor/skills/${name}/SKILL.md`;
            expect(existsSync(path.join(repoRoot, relative)), `${relative} must exist`).toBe(true);
        }
    });

    it('service-shaped donor skills are absent', () => {
        for (const name of donorSkillDirectories) {
            expect(
                existsSync(path.join(repoRoot, '.cursor/skills', name)),
                `.cursor/skills/${name} must not exist`,
            ).toBe(false);
        }
    });

    it('ported support skills do not name donor service machinery', () => {
        for (const name of portedSupportSkills) {
            const relative = `.cursor/skills/${name}/SKILL.md`;
            const content = readExisting(relative);
            for (const token of donorMachinery) {
                expect(content.includes(token), `${relative} must not contain ${token}`).toBe(false);
            }
        }
    });
});

describe("component-testing teaches this repo's current API in Vitest", () => {
    it('component-testing names createRig not createHarness', () => {
        const content = readExisting('.cursor/skills/component-testing/SKILL.md');
        expect(content.includes('createRig'), 'component-testing must name createRig').toBe(true);
        expect(content.includes('createHarness'), 'component-testing must not name createHarness').toBe(false);
        expect(
            content.includes('rig.close()'),
            'component-testing must close the lifecycle owner with rig.close()',
        ).toBe(true);
    });

    it('component-testing keeps the harness option key', () => {
        const content = readExisting('.cursor/skills/component-testing/SKILL.md');
        expect(
            /harness:\s*rig\b/.test(content),
            'component-testing must show a factory options example with harness: rig',
        ).toBe(true);
    });

    it('component-testing uses Vitest fake timers', () => {
        const content = readExisting('.cursor/skills/component-testing/SKILL.md');
        expect(content.includes('vi.useFakeTimers'), 'component-testing must contain vi.useFakeTimers').toBe(true);
        expect(
            content.includes('jest.advanceTimersByTimeAsync'),
            'component-testing must not contain jest.advanceTimersByTimeAsync',
        ).toBe(false);
    });

    it('component-testing is not pinned to v1.0.0', () => {
        const content = readExisting('.cursor/skills/component-testing/SKILL.md');
        expect(content.includes('v1.0.0'), 'component-testing must not contain v1.0.0').toBe(false);
    });

    it('component-testing TypeScript fences declare rig before using it', () => {
        const content = readExisting('.cursor/skills/component-testing/SKILL.md');
        const usingRig = fencedTypescriptBlocks(content).filter(typescriptFenceUsesRigIdentifier);
        expect(
            usingRig.length,
            'component-testing must have at least one typescript fence that uses rig',
        ).toBeGreaterThan(0);
        for (const block of usingRig) {
            expect(
                typescriptFenceDeclaresRig(block),
                'each typescript/ts fence that uses identifier rig must declare const rig, let rig, or a destructuring binding that includes rig in that same block',
            ).toBe(true);
        }
    });
});

describe('write-failing-tests no longer warns agents off component-testing', () => {
    it('ignore-this-skill warning is gone', () => {
        const content = readExisting('.cursor/skills/write-failing-tests/SKILL.md');
        expect(content.includes('Do not follow'), 'write-failing-tests must not contain Do not follow').toBe(false);
        expect(content.includes('Ignore this skill'), 'write-failing-tests must not contain Ignore this skill').toBe(
            false,
        );
    });

    it('write-failing-tests closes a rig', () => {
        const content = readExisting('.cursor/skills/write-failing-tests/SKILL.md');
        expect(content.includes('rig.close()'), 'write-failing-tests must contain rig.close()').toBe(true);
        expect(content.includes('harness.close()'), 'write-failing-tests must not contain harness.close()').toBe(false);
    });
});

describe('mutation-testing skill is thin until RD-24153', () => {
    it('mutation-testing names the missing gate', () => {
        const content = readExisting('.cursor/skills/mutation-testing/SKILL.md');
        expect(content.includes('RD-24153'), 'mutation-testing must contain RD-24153').toBe(true);
        expect(content.includes('dist'), 'mutation-testing must contain dist').toBe(true);
    });

    it('mutation-testing does not run Stryker today', () => {
        const content = readExisting('.cursor/skills/mutation-testing/SKILL.md');
        expect(content.includes('test:mutation'), 'mutation-testing must not contain test:mutation').toBe(false);
        expect(content.includes('pnpm crap'), 'mutation-testing must not contain pnpm crap').toBe(false);
        expect(content.includes('stryker run'), 'mutation-testing must not contain stryker run').toBe(false);
    });
});

describe('Glob-scoped blinkers live under .cursor/rules', () => {
    it('portable blinker files exist', () => {
        const dir = path.join(repoRoot, '.cursor/rules');
        expect(existsSync(dir), '.cursor/rules must exist').toBe(true);
        const names = readdirSync(dir);
        for (const file of blinkerFiles) {
            expect(names, `.cursor/rules must contain ${file}`).toContain(file);
        }
    });

    it('globbed blinkers cover packages', () => {
        for (const file of globbedBlinkers) {
            const relative = `.cursor/rules/${file}`;
            const globs = frontmatterGlobsText(yamlFrontmatter(readExisting(relative)));
            expect(globs.includes('packages/**/*.ts'), `${relative} globs must contain packages/**/*.ts`).toBe(true);
        }
    });

    it('commands-over-hand-edits is always-on with no globs', () => {
        const relative = '.cursor/rules/15-commands-over-hand-edits.mdc';
        const frontmatter = yamlFrontmatter(readExisting(relative));
        expect(frontmatterScalar(frontmatter, 'alwaysApply'), `${relative} must have alwaysApply: true`).toBe('true');
        expect(frontmatterHasKey(frontmatter, 'globs'), `${relative} must not have a globs: key`).toBe(false);
    });

    it('complexity-budget names the four limits and does not invent a hook gate', () => {
        const content = readExisting('.cursor/rules/complexity-budget.mdc');
        const lines = content.split('\n');
        expect(
            lines.some((line) => line.includes('complexity') && line.includes('12')),
            'the complexity line must name 12',
        ).toBe(true);
        expect(
            lines.some((line) => line.includes('max-depth') && line.includes('4')),
            'the max-depth line must name 4',
        ).toBe(true);
        expect(
            lines.some((line) => line.includes('max-lines-per-function') && line.includes('80')),
            'the max-lines-per-function line must name 80',
        ).toBe(true);
        expect(
            lines.some((line) => line.includes('max-params') && line.includes('5')),
            'the max-params line must name 5',
        ).toBe(true);
        expect(content.includes('lefthook'), 'complexity-budget must not contain lefthook').toBe(false);
        expect(content.includes('pre-push'), 'complexity-budget must not contain pre-push').toBe(false);
        expect(content.includes('husky'), 'complexity-budget must not contain husky').toBe(false);
    });

    it('dropped donor blinkers are absent', () => {
        const dir = path.join(repoRoot, '.cursor/rules');
        const names = existsSync(dir) ? readdirSync(dir) : [];
        for (const file of droppedBlinkers) {
            expect(names, `.cursor/rules must not contain ${file}`).not.toContain(file);
        }
    });

    it('agent and skill prose calls them blinkers', () => {
        const mentioning = trackedMarkdownUnder(blinkerProseDirs).filter((file) =>
            readUtf8(path.join(repoRoot, file)).includes('.cursor/rules'),
        );
        for (const file of mentioning) {
            const content = readUtf8(path.join(repoRoot, file));
            expect(content.includes('blinker'), `${file} must contain blinker`).toBe(true);
            expect(content.includes('the rules in'), `${file} must not contain the phrase "the rules in"`).toBe(false);
        }
    });
});

describe('Per-agent files name their skills and do not import donor bugs', () => {
    it('each agent names the skill it drives', () => {
        for (const name of agentOrder) {
            const relative = `.claude/agents/${name}.md`;
            const content = readExisting(relative);
            expect(content.includes(skillByAgent[name]), `${relative} must name ${skillByAgent[name]}`).toBe(true);
        }
    });

    it('coder and reviewer do not run coverage-quality gates', () => {
        for (const name of ['coder', 'reviewer'] as const) {
            const relative = `.claude/agents/${name}.md`;
            const content = readExisting(relative);
            for (const token of coverageQualityGates) {
                expect(content.includes(token), `${relative} must not contain ${token}`).toBe(false);
            }
        }
    });

    it('reviewer names pr-review-style', () => {
        const content = readExisting('.claude/agents/reviewer.md');
        expect(content.includes('pr-review-style'), 'reviewer.md must contain pr-review-style').toBe(true);
    });

    it('verifier states the missing gate', () => {
        const content = readExisting('.claude/agents/verifier.md');
        expect(content.includes('RD-24153'), 'verifier.md must contain RD-24153').toBe(true);
        expect(content.includes('no mutation testing'), 'verifier.md must contain "no mutation testing"').toBe(true);
    });
});

describe('New TypeScript for this capability is on the root test and format paths', () => {
    it('harness-prose tests are in the Vitest workspace', () => {
        const workspace = readUtf8(path.join(repoRoot, 'vitest.workspace.ts'));
        expect(
            workspace.includes('test/harness-prose'),
            'vitest.workspace.ts must include a project that picks up test/harness-prose',
        ).toBe(true);
    });

    it('harness-prose TypeScript is format-checked', () => {
        const formatCheck = readRootScripts()['format:check'];
        expect(formatCheck, 'root package.json must define scripts.format:check').toEqual(expect.any(String));
        const covers =
            (formatCheck ?? '').includes('test/**/*.ts') || (formatCheck ?? '').includes('test/harness-prose');
        expect(covers, 'format:check glob must cover test/harness-prose TypeScript').toBe(true);
    });
});

describe('The two senses of "harness" stay separated', () => {
    it('component-testing createHarness gap is closed', () => {
        const content = readExisting('docs/internal/spec/core-public-api.md');
        const rows = knownGapsSection(content)
            .split('\n')
            .filter((line) => line.startsWith('|'));
        const mixed = rows.filter((row) => row.includes('component-testing') && row.includes('createHarness'));
        expect(mixed, 'Known gaps must not mention component-testing together with createHarness').toEqual([]);
    });
});

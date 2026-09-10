import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
    fencedTypescriptBlocks,
    typescriptFenceDeclaresRig,
    typescriptFenceUsesRigIdentifier,
    typescriptFencesUsingUndeclaredRig,
} from './fenced-typescript-blocks.js';

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
    'add-adapter',
    'summon-review-panel',
] as const;

const bannedAddAdapterSplitCommands = ['extend-probe.md', 'new-package.md', 'extend-test-kit.md'] as const;

const addAdapterRequiredSkillTokens = ['npm', 'workspaces', 'packages/'] as const;

const addAdapterStaleConsumerTokens = [
    'pnpm workspaces',
    'pnpm link',
    'Missing (author these)',
    '/Users/giladhoch/dev/test-kit',
] as const;

const addAdapterWalkthroughTokens = [
    'Adding a New Domain Package',
    'call shape',
    'pending call',
    'probe',
    'adapter',
    'ProbedResource',
    'forward',
    'factory',
    'examples/grpc-client',
] as const;

const addAdapterQuestionTokens = [
    'too thin',
    'too fat',
    'just right',
    '{method, args}',
    '{sql, parameters}',
    '{commandName, command, input}',
    'programmable mock',
    'hybrid',
    'PGlite',
    'testcontainers',
    '@testcontainers/mysql',
    'ProbedResource',
    'reset',
    'close',
    'probe.always().forward()',
    'park',
    'strictly optional',
    'SqlDriver',
    'createProbed',
    '@vnatures/test-kit-',
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

// eslint-disable-next-line complexity -- existing test helper over the published budget; extract on next touch
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

const commonMarkFenceIndents = [1, 2, 3] as const;

const componentTestingSkill = '.cursor/skills/component-testing/SKILL.md';
const summonReviewPanelSkill = '.cursor/skills/summon-review-panel/SKILL.md';

function matchingCloseParenIndex(source: string, openParenIndex: number): number {
    let depth = 0;
    for (let i = openParenIndex; i < source.length; i += 1) {
        const char = source[i];
        if (char === '(') {
            depth += 1;
        } else if (char === ')') {
            depth -= 1;
            if (depth === 0) {
                return i;
            }
        }
    }
    return source.length - 1;
}

function callsWithOpener(source: string, opener: string): string[] {
    const calls: string[] = [];
    let searchFrom = 0;
    while (searchFrom < source.length) {
        const start = source.indexOf(opener, searchFrom);
        if (start === -1) {
            break;
        }
        const openParen = start + opener.length - 1;
        const close = matchingCloseParenIndex(source, openParen);
        calls.push(source.slice(start, close + 1));
        searchFrom = close + 1;
    }
    return calls;
}

function fencedCalls(markdown: string, opener: string): string[] {
    return fencedTypescriptBlocks(markdown).flatMap((block) => callsWithOpener(block, opener));
}

function indentedTypescriptMarkdown(indent: number, body: string): string {
    const pad = ' '.repeat(indent);
    return ['Prose; no column-zero typescript fence.', `${pad}\`\`\`typescript`, body, `${pad}\`\`\``, ''].join('\n');
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

describe('Canonical add-adapter command exists', () => {
    it('add-adapter command is canonical under Claude', () => {
        const dir = path.join(repoRoot, '.claude/commands');
        expect(existsSync(dir), '.claude/commands must exist').toBe(true);
        const names = markdownNames('.claude/commands');
        expect(names, '.claude/commands must contain add-adapter.md').toContain('add-adapter.md');
        for (const banned of bannedAddAdapterSplitCommands) {
            expect(names, `.claude/commands must not contain ${banned}`).not.toContain(banned);
        }
    });

    it('command reads the skill and branches first', () => {
        const content = readExisting('.claude/commands/add-adapter.md');
        expect(content.includes('add-adapter'), 'must contain add-adapter as the skill to read').toBe(true);
        expect(content.includes('AskUserQuestion'), 'must contain AskUserQuestion').toBe(true);
        expect(content.includes('packages/<domain>/'), 'must ask whether the work is a new packages/<domain>/').toBe(
            true,
        );
        expect(/extend/i.test(content) && /probe/i.test(content), 'must ask about extending an existing probe').toBe(
            true,
        );
    });

    it('command writes a packet and does not run spec-to-ship', () => {
        const content = readExisting('.claude/commands/add-adapter.md');
        expect(
            content.includes('docs/internal/packets/'),
            'must tell the orchestrator to write under docs/internal/packets/',
        ).toBe(true);
        expect(content.includes('Depends on:'), 'must contain Depends on:').toBe(true);
        expect(content.includes('PNN'), 'must write a packet whose name matches PNN-*.md').toBe(true);
        expect(
            content.includes('docs/internal/spec/deltas/'),
            'must not tell the orchestrator to write under docs/internal/spec/deltas/',
        ).toBe(false);
        expect(
            /do not run \/?spec-to-ship/i.test(content) ||
                /not (?:run|chain) \/?spec-to-ship/i.test(content) ||
                /next (?:step|is)[\s\S]{0,80}\/?spec-to-ship/i.test(content) ||
                /stop[\s\S]{0,200}\/?spec-to-ship/i.test(content),
            'must not tell the orchestrator to run /spec-to-ship as part of this command',
        ).toBe(true);
    });

    it('novel work falls back to grilling', () => {
        const content = readExisting('.claude/commands/add-adapter.md');
        expect(/grilling/i.test(content), 'must name grilling as the fallback').toBe(true);
        expect(
            /without writing a packet/i.test(content) ||
                /not write a packet/i.test(content) ||
                /do not write[\s\S]{0,40}packet/i.test(content),
            'must stop without writing a packet when the work is not a new domain package and not an extension of an existing probe',
        ).toBe(true);
        expect(/stop/i.test(content), 'must say to stop on novel work').toBe(true);
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
        const commandMd = markdownNames('.opencode/commands');
        expect(commandMd, '.opencode/commands must contain spec-to-ship.md').toContain('spec-to-ship.md');
        expect(commandMd, '.opencode/commands must contain add-adapter.md').toContain('add-adapter.md');
    });
});

describe('Generated command mirrors include add-adapter', () => {
    it('Cursor and OpenCode command mirrors include add-adapter', () => {
        expect(markdownNames('.cursor/commands'), '.cursor/commands must contain add-adapter.md').toContain(
            'add-adapter.md',
        );
        expect(markdownNames('.opencode/commands'), '.opencode/commands must contain add-adapter.md').toContain(
            'add-adapter.md',
        );
    });

    it('no sixth OpenCode add-adapter agent', () => {
        expect(markdownNames('.opencode/agents'), '.opencode/agents must not contain add-adapter.md').not.toContain(
            'add-adapter.md',
        );
    });
});

describe('spec-to-ship names add-adapter as the adapter packet-shaping step', () => {
    it('spec-to-ship command names add-adapter', () => {
        const content = readExisting('.claude/commands/spec-to-ship.md');
        expect(content.includes('add-adapter'), '.claude/commands/spec-to-ship.md must contain add-adapter').toBe(true);
    });

    it('spec-to-ship skill names add-adapter', () => {
        const content = readExisting('.cursor/skills/spec-to-ship/SKILL.md');
        expect(content.includes('add-adapter'), '.cursor/skills/spec-to-ship/SKILL.md must contain add-adapter').toBe(
            true,
        );
    });
});

describe('Support skills exist under the Cursor canonical tree', () => {
    it('eight support skills are present', () => {
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

describe('add-adapter skill is the in-repo extender contract', () => {
    it('add-adapter skill exists under the Cursor canonical tree', () => {
        const relative = '.cursor/skills/add-adapter/SKILL.md';
        expect(existsSync(path.join(repoRoot, relative)), `${relative} must exist`).toBe(true);
    });

    it('skill is not the stale consumer copy', () => {
        const content = readExisting('.cursor/skills/add-adapter/SKILL.md');
        for (const token of addAdapterRequiredSkillTokens) {
            expect(content.includes(token), `add-adapter skill must contain ${token}`).toBe(true);
        }
        for (const token of addAdapterStaleConsumerTokens) {
            expect(content.includes(token), `add-adapter skill must not contain ${token}`).toBe(false);
        }
    });

    it('skill teaches the seven-step walkthrough and contract guard', () => {
        const content = readExisting('.cursor/skills/add-adapter/SKILL.md');
        for (const token of addAdapterWalkthroughTokens) {
            expect(content.includes(token), `add-adapter skill must contain ${token}`).toBe(true);
        }
    });

    it('skill names the known question set', () => {
        const content = readExisting('.cursor/skills/add-adapter/SKILL.md');
        for (const token of addAdapterQuestionTokens) {
            expect(content.includes(token), `add-adapter skill must contain ${token}`).toBe(true);
        }
        expect(
            content.includes('function-boundary') || content.includes('function boundary'),
            'add-adapter skill must contain function-boundary or function boundary',
        ).toBe(true);
    });

    it('skill packet skeleton owns scope not behaviour', () => {
        const content = readExisting('.cursor/skills/add-adapter/SKILL.md');
        expect(content.includes('docs/internal/packets/'), 'must contain docs/internal/packets/').toBe(true);
        expect(content.includes('Depends on:'), 'must contain Depends on:').toBe(true);
        expect(content.includes('Goldilocks'), 'must contain Goldilocks').toBe(true);
        expect(content.includes('40'), 'must contain 40').toBe(true);
        expect(
            (/packet[\s\S]{0,160}scope/i.test(content) || /scope[\s\S]{0,80}packet/i.test(content)) &&
                (/spec[\s\S]{0,160}behaviou?r/i.test(content) || /behaviou?r[\s\S]{0,80}spec/i.test(content)),
            'must state that the packet owns scope and the spec owns behaviour',
        ).toBe(true);
    });
});

describe('summon-review-panel skill summons the policy/capability intersection', () => {
    it('summon-review-panel skill exists under the Cursor canonical tree', () => {
        const dir = path.join(repoRoot, '.cursor/skills/summon-review-panel');
        expect(existsSync(dir), '.cursor/skills/summon-review-panel must exist').toBe(true);
        expect(readdirSync(dir), '.cursor/skills/summon-review-panel must contain SKILL.md').toContain('SKILL.md');
    });

    it('skill separates policy from capability', () => {
        const content = readExisting(summonReviewPanelSkill);
        expect(content.includes('policy'), 'summon-review-panel skill must contain policy').toBe(true);
        expect(content.includes('capability'), 'summon-review-panel skill must contain capability').toBe(true);
        expect(
            content.includes('.harness/review-panel.json'),
            'summon-review-panel skill must contain .harness/review-panel.json',
        ).toBe(true);
    });

    it('skill summons copilot as a reviewer and comments @cursor review', () => {
        const content = readExisting(summonReviewPanelSkill);
        expect(
            /copilot[\s\S]{0,80}as a reviewer/i.test(content) || /as a reviewer[\s\S]{0,80}copilot/i.test(content),
            'summon-review-panel skill must contain copilot as a reviewer',
        ).toBe(true);
        expect(content.includes('@cursor review'), 'summon-review-panel skill must contain @cursor review').toBe(true);
        expect(
            content.includes('🤖: @cursor review'),
            'summon-review-panel skill must not use 🤖: @cursor review as the Bugbot trigger',
        ).toBe(false);
    });

    it('skill names baz and does not add GitHub Actions or Baz config', () => {
        const content = readExisting(summonReviewPanelSkill);
        expect(content.includes('baz'), 'summon-review-panel skill must contain baz').toBe(true);
        expect(content.includes('no GitHub Actions'), 'summon-review-panel skill must contain no GitHub Actions').toBe(
            true,
        );
        expect(
            content.includes('.github/workflows'),
            'summon-review-panel skill must not contain .github/workflows',
        ).toBe(false);
    });

    it('skill hands findings to pr-review-style', () => {
        const content = readExisting(summonReviewPanelSkill);
        expect(content.includes('pr-review-style'), 'summon-review-panel skill must contain pr-review-style').toBe(
            true,
        );
        expect(
            content.includes('Each finding is either actionable or noise'),
            'summon-review-panel skill must not contain Each finding is either actionable or noise',
        ).toBe(false);
    });

    it('skill can be re-run without triage', () => {
        const content = readExisting(summonReviewPanelSkill);
        expect(
            /(?:after a (?:later )?push|later push)[\s\S]{0,160}without[\s\S]{0,40}(?:running )?triage/i.test(
                content,
            ) ||
                /without[\s\S]{0,40}(?:running )?triage[\s\S]{0,160}(?:after a (?:later )?push|later push)/i.test(
                    content,
                ) ||
                /re-?summon[\s\S]{0,80}without[\s\S]{0,40}(?:running )?triage/i.test(content) ||
                /without[\s\S]{0,40}(?:running )?triage[\s\S]{0,80}re-?summon/i.test(content),
            'must state that summoning can run again after a push without running triage',
        ).toBe(true);
    });

    it('no summon-review-panel command', () => {
        expect(
            markdownNames('.claude/commands'),
            '.claude/commands must not contain summon-review-panel.md',
        ).not.toContain('summon-review-panel.md');
    });
});

describe('first-run records policy; later runs re-prompt only on failure', () => {
    it('skill bootstraps missing policy via AskUserQuestion', () => {
        const content = readExisting(summonReviewPanelSkill);
        expect(content.includes('AskUserQuestion'), 'summon-review-panel skill must contain AskUserQuestion').toBe(
            true,
        );
        expect(content.includes('multi-select'), 'summon-review-panel skill must contain multi-select').toBe(true);
        expect(content.includes('review-panel.json'), 'summon-review-panel skill must contain review-panel.json').toBe(
            true,
        );
    });

    it('later runs use recorded policy without asking', () => {
        const content = readExisting(summonReviewPanelSkill);
        expect(
            /later run[\s\S]{0,200}(?:does not ask|not ask|skip(?:s)? the ask)[\s\S]{0,80}review-panel\.json/i.test(
                content,
            ) ||
                /(?:does not ask|not ask again|skip(?:s)? the ask)[\s\S]{0,160}review-panel\.json[\s\S]{0,40}exists/i.test(
                    content,
                ) ||
                /while[\s\S]{0,40}review-panel\.json[\s\S]{0,40}exists[\s\S]{0,80}(?:does not ask|not ask)/i.test(
                    content,
                ) ||
                /not ask again[\s\S]{0,80}(?:while|when)[\s\S]{0,80}review-panel\.json/i.test(content),
            'must state that a later run does not ask while review-panel.json exists',
        ).toBe(true);
    });

    it('skill states a capability gap without editing policy', () => {
        const content = readExisting(summonReviewPanelSkill);
        expect(content.includes('policy wants'), 'summon-review-panel skill must contain policy wants').toBe(true);
        expect(content.includes('seat'), 'summon-review-panel skill must contain seat').toBe(true);
        expect(
            /(?:shall not|do not|does not|must not)[\s\S]{0,80}(?:edit|drop|remove)[\s\S]{0,80}wanted/i.test(content) ||
                /(?:shall not|do not|does not|must not)[\s\S]{0,80}review-panel\.json[\s\S]{0,80}(?:drop|remove)/i.test(
                    content,
                ),
            'must not instruct removing a bot from wanted because a summon failed',
        ).toBe(true);
    });

    it('skill re-prompts when a summon fails or a bot is unreachable', () => {
        const content = readExisting(summonReviewPanelSkill);
        expect(content.includes('AskUserQuestion'), 'summon-review-panel skill must contain AskUserQuestion').toBe(
            true,
        );
        expect(content.includes('unreachable'), 'summon-review-panel skill must contain unreachable').toBe(true);
    });
});

describe('review-panel.json is committed policy without capability', () => {
    it('review-panel.json exists alongside models.json', () => {
        const dir = path.join(repoRoot, '.harness');
        expect(existsSync(dir), '.harness must exist').toBe(true);
        const names = readdirSync(dir);
        expect(names, '.harness must contain review-panel.json').toContain('review-panel.json');
        expect(names, '.harness must contain models.json').toContain('models.json');
    });

    it('review-panel.json wanted lists copilot and bugbot and no capability key', () => {
        const parsed: unknown = JSON.parse(readExisting('.harness/review-panel.json'));
        const root = asRecord(parsed, '.harness/review-panel.json');
        expect(Object.hasOwn(root, 'capability'), '.harness/review-panel.json must not contain a capability key').toBe(
            false,
        );
        expect(Object.hasOwn(root, 'seats'), '.harness/review-panel.json must not contain a seats key').toBe(false);
        const wanted = root['wanted'];
        expect(Array.isArray(wanted), 'wanted must be an array').toBe(true);
        const wantedIds = Array.isArray(wanted) ? wanted : [];
        expect(
            wantedIds.every((id) => id === 'copilot' || id === 'bugbot' || id === 'baz'),
            'every wanted entry must be one of copilot, bugbot, or baz',
        ).toBe(true);
        expect(wantedIds.includes('copilot'), 'wanted must include copilot').toBe(true);
        expect(wantedIds.includes('bugbot'), 'wanted must include bugbot').toBe(true);
        expect(new Set(wantedIds).size, 'wanted must not contain duplicate ids').toBe(wantedIds.length);
    });
});

describe('spec-to-ship PR loop names summon-review-panel', () => {
    it('spec-to-ship command names summon-review-panel', () => {
        const content = readExisting('.claude/commands/spec-to-ship.md');
        expect(
            content.includes('summon-review-panel'),
            '.claude/commands/spec-to-ship.md must contain summon-review-panel',
        ).toBe(true);
    });

    it('spec-to-ship skill names summon-review-panel', () => {
        const content = readExisting('.cursor/skills/spec-to-ship/SKILL.md');
        expect(
            content.includes('summon-review-panel'),
            '.cursor/skills/spec-to-ship/SKILL.md must contain summon-review-panel',
        ).toBe(true);
    });
});

describe('pr-review-style defers summoning to summon-review-panel', () => {
    it('pr-review-style names summon-review-panel and does not assemble the panel', () => {
        const content = readExisting('.cursor/skills/pr-review-style/SKILL.md');
        expect(content.includes('summon-review-panel'), 'pr-review-style must contain summon-review-panel').toBe(true);
        expect(content.includes('@cursor review'), 'pr-review-style must name the Bugbot trigger exception').toBe(true);
        expect(
            content.includes('Assembling the review panel'),
            'pr-review-style must not contain Assembling the review panel',
        ).toBe(false);
        expect(
            content.includes('🤖: @cursor review'),
            'pr-review-style must not use 🤖: @cursor review as the Bugbot trigger',
        ).toBe(false);
    });
});

describe('OSS.md tracks versatile-internal harness pieces', () => {
    it('OSS.md tracks summon-review-panel as versatile-internal', () => {
        const content = readExisting('docs/internal/OSS.md');
        expect(content.includes('summon-review-panel'), 'OSS.md must contain summon-review-panel').toBe(true);
        expect(content.includes('litellm'), 'OSS.md must contain litellm').toBe(true);
        expect(content.includes('versatile-internal'), 'OSS.md must contain versatile-internal').toBe(true);
    });
});

describe("component-testing teaches this repo's current API in Vitest", () => {
    it('component-testing names createRig not createHarness', () => {
        const content = readExisting(componentTestingSkill);
        expect(content.includes('createRig'), 'component-testing must name createRig').toBe(true);
        expect(content.includes('createHarness'), 'component-testing must not name createHarness').toBe(false);
        expect(
            content.includes('rig.close()'),
            'component-testing must close the lifecycle owner with rig.close()',
        ).toBe(true);
    });

    it('component-testing keeps the harness option key', () => {
        const content = readExisting(componentTestingSkill);
        expect(
            /harness:\s*rig\b/.test(content),
            'component-testing must show a factory options example with harness: rig',
        ).toBe(true);
    });

    it('component-testing uses Vitest fake timers in-repo and names Jest drain', () => {
        const content = readExisting(componentTestingSkill);
        expect(content.includes('vi.useFakeTimers'), 'component-testing must contain vi.useFakeTimers').toBe(true);
        expect(
            content.includes('jest.advanceTimersByTimeAsync'),
            'component-testing must contain jest.advanceTimersByTimeAsync',
        ).toBe(true);
    });

    it('component-testing is not pinned to v1.0.0', () => {
        const content = readExisting(componentTestingSkill);
        expect(content.includes('v1.0.0'), 'component-testing must not contain v1.0.0').toBe(false);
    });

    it('Jest and Vitest clocks are not presented as interchangeable', () => {
        const content = readExisting(componentTestingSkill);
        expect(content.includes('jestFakeClock'), 'must name jestFakeClock').toBe(true);
        expect(content.includes('viFakeClock'), 'must name viFakeClock').toBe(true);
        expect(
            /advanceTimersByTime(?!Async)/.test(content),
            'must state that jestFakeClock uses synchronous advanceTimersByTime',
        ).toBe(true);
        expect(
            /jestFakeClock[\s\S]{0,400}Promise\.resolve/.test(content) ||
                /Promise\.resolve[\s\S]{0,400}jestFakeClock/.test(content),
            'must state that jestFakeClock uses Promise.resolve for one microtask tick',
        ).toBe(true);
        expect(
            /viFakeClock[\s\S]{0,240}advanceTimersByTimeAsync/.test(content),
            'must state that viFakeClock prefers advanceTimersByTimeAsync',
        ).toBe(true);
        expect(
            content.includes('await jest.advanceTimersByTimeAsync'),
            'must tell Jest consumers to use await jest.advanceTimersByTimeAsync',
        ).toBe(true);
    });

    it('component-testing TypeScript fences declare rig before using it', () => {
        const content = readExisting(componentTestingSkill);
        const usingRig = fencedTypescriptBlocks(content).filter(typescriptFenceUsesRigIdentifier);
        expect(
            usingRig.length,
            'component-testing must have at least one typescript fence that uses rig',
        ).toBeGreaterThan(0);
        expect(
            typescriptFencesUsingUndeclaredRig(content),
            'each typescript/ts fence that uses identifier rig — including CommonMark-indented fences (0–3 leading spaces) — must declare const rig, let rig, or a destructuring binding that includes rig in that same block',
        ).toEqual([]);
        for (const block of usingRig) {
            expect(
                typescriptFenceDeclaresRig(block),
                'each typescript/ts fence that uses identifier rig must declare const rig, let rig, or a destructuring binding that includes rig in that same block',
            ).toBe(true);
        }
    });
});

describe('component-testing cardinality exactly and none require within', () => {
    it('every exactly call supplies within', () => {
        const content = readExisting(componentTestingSkill);
        const exactlyCalls = fencedCalls(content, 'expect.exactly(');
        const noneCalls = fencedCalls(content, 'expect.none(');
        expect(exactlyCalls.length, 'must show at least one fenced expect.exactly(').toBeGreaterThan(0);
        expect(noneCalls.length, 'must show at least one fenced expect.none(').toBeGreaterThan(0);
        for (const call of exactlyCalls) {
            expect(call.includes('within:'), `${call} must include a within: option in the same call`).toBe(true);
        }
        for (const call of noneCalls) {
            expect(call.includes('within:'), `${call} must include a within: option in the same call`).toBe(true);
        }
        expect(
            exactlyCalls.some((call) => /^expect\.exactly\(\s*3\s*,\s*\{[\s\S]*\bwithin:/.test(call)),
            'at least one call must be of the shape expect.exactly(3, { within: … })',
        ).toBe(true);
    });

    it('skill states the within asymmetry', () => {
        const content = readExisting(componentTestingSkill);
        expect(content.includes('atLeast'), 'must contain atLeast').toBe(true);
        expect(content.includes('exactly'), 'must contain exactly').toBe(true);
        expect(content.includes('none'), 'must contain none').toBe(true);
        expect(content.includes('within'), 'must contain within').toBe(true);
        expect(
            /exactly[\s\S]{0,160}none[\s\S]{0,80}require[\s\S]{0,40}within/i.test(content) ||
                /none[\s\S]{0,80}exactly[\s\S]{0,80}require[\s\S]{0,40}within/i.test(content),
            'must state that exactly and none require within',
        ).toBe(true);
        expect(
            /atLeast[\s\S]{0,80}(may omit|can omit|optional)/i.test(content),
            'must state that atLeast may omit within',
        ).toBe(true);
    });
});

// eslint-disable-next-line max-lines-per-function -- existing test suite over the published budget; extract on next touch
describe('component-testing teaches the missing 2.x probe surface', () => {
    it('observation is demonstrated in sequence', () => {
        const content = readExisting(componentTestingSkill);
        const blocks = fencedTypescriptBlocks(content);
        expect(
            blocks.some((block) => block.includes('observation(') && block.includes('rig.expect.sequence')),
            'at least one typescript/ts fence must contain observation( and rig.expect.sequence',
        ).toBe(true);
        expect(
            /import\s*\{[^}]*\bobservation\b[^}]*\}\s*from\s*'@vnatures\/test-kit'/.test(content),
            "the file must import observation from '@vnatures/test-kit'",
        ).toBe(true);
        expect(content.includes("from '@vnatures/test-kit'"), "must contain from '@vnatures/test-kit'").toBe(true);
        expect(content.includes('observation'), 'must contain observation').toBe(true);
    });

    it('allOf is demonstrated', () => {
        const content = readExisting(componentTestingSkill);
        expect(
            fencedTypescriptBlocks(content).some((block) => block.includes('rig.expect.allOf(')),
            'at least one typescript/ts fence must contain rig.expect.allOf(',
        ).toBe(true);
    });

    it('drain family is demonstrated', () => {
        const content = readExisting(componentTestingSkill);
        const fenced = fencedTypescriptBlocks(content).join('\n');
        expect(fenced.includes('drain('), 'fenced typescript/ts blocks must jointly contain drain(').toBe(true);
        expect(
            fenced.includes('drainAndReject('),
            'fenced typescript/ts blocks must jointly contain drainAndReject(',
        ).toBe(true);
        expect(
            fenced.includes('drainAndForward('),
            'fenced typescript/ts blocks must jointly contain drainAndForward(',
        ).toBe(true);
    });

    it('synchronous assertions are demonstrated', () => {
        const content = readExisting(componentTestingSkill);
        const fenced = fencedTypescriptBlocks(content).join('\n');
        expect(fenced.includes('expect.calledTimes('), 'fenced blocks must jointly contain expect.calledTimes(').toBe(
            true,
        );
        expect(fenced.includes('expect.neverCalled('), 'fenced blocks must jointly contain expect.neverCalled(').toBe(
            true,
        );
        expect(fenced.includes('expect.called('), 'fenced blocks must jointly contain expect.called(').toBe(true);
    });

    it('QueryProbe.sql matchers are taught and queries is absent', () => {
        const content = readExisting(componentTestingSkill);
        const fenced = fencedTypescriptBlocks(content).join('\n');
        expect(fenced.includes('sql('), 'a fenced typescript/ts block must contain sql(').toBe(true);
        expect(/sql\(\s*['"`]/.test(content), 'the file must show a string matcher for sql').toBe(true);
        expect(/sql\(\s*\//.test(content), 'the file must show a RegExp matcher for sql').toBe(true);
        expect(/sql\(\s*\(|sql\(\s*\w+\s*=>/.test(content), 'the file must show a function matcher for sql').toBe(true);
        expect(/exact equal/i.test(content), 'prose must state that a string matches by exact equality').toBe(true);
        expect(content.includes('.test()'), 'prose must state that a RegExp matches via .test()').toBe(true);
        expect(/predicate/i.test(content), 'prose must state that a function is a predicate on the SQL text').toBe(
            true,
        );
        expect(content.includes('probe.queries'), 'must not contain probe.queries').toBe(false);
        expect(content.includes('QueryProbe.queries'), 'must not contain QueryProbe.queries').toBe(false);
        expect(content.includes('db.probe.queries'), 'must not contain db.probe.queries').toBe(false);
    });

    it('probe admin and rig.reset keepRules are taught', () => {
        const content = readExisting(componentTestingSkill);
        expect(content.includes('clearRules('), 'must contain clearRules(').toBe(true);
        expect(content.includes('clearCalls('), 'must contain clearCalls(').toBe(true);
        expect(content.includes('resetProbe('), 'must contain resetProbe(').toBe(true);
        expect(content.includes('rig.reset('), 'must contain rig.reset(').toBe(true);
        expect(content.includes('keepRules'), 'must contain keepRules').toBe(true);
    });

    it('CreateRigOptions keys are named', () => {
        const content = readExisting(componentTestingSkill);
        const optionBlocks = fencedTypescriptBlocks(content).filter((block) => /createRig\s*\(\s*\{/.test(block));
        expect(optionBlocks.length, 'a fenced createRig({ … }) must name the options').toBeGreaterThan(0);
        const joined = optionBlocks.join('\n');
        expect(/\bclock\s*:/.test(joined), 'createRig options must name clock').toBe(true);
        expect(joined.includes('defaultTimeout'), 'createRig options must name defaultTimeout').toBe(true);
        expect(joined.includes('safetyTimeout'), 'createRig options must name safetyTimeout').toBe(true);
    });

    it('on is not taught as universal', () => {
        const content = readExisting(componentTestingSkill);
        expect(content.includes('MethodProbe'), 'must contain MethodProbe').toBe(true);
        expect(content.includes('BullQueueProbe'), 'must contain BullQueueProbe').toBe(true);
        expect(content.includes('QueryProbe'), 'must contain QueryProbe').toBe(true);
        expect(content.includes('.sql('), 'must contain .sql(').toBe(true);
        expect(content.includes('filter()'), 'must contain filter()').toBe(true);
        expect(
            /QueryProbe[\s\S]{0,200}(has no \.on|does not have \.on|does not have `\.on`|no \.on)/i.test(content),
            'must state that QueryProbe has no .on',
        ).toBe(true);
    });
});

describe('harness-prose TypeScript fence scan includes CommonMark indent', () => {
    it('indented typescript fences are extracted', () => {
        for (const spaces of commonMarkFenceIndents) {
            const marker = `const extractedIndent${spaces} = true;`;
            const blocks = fencedTypescriptBlocks(indentedTypescriptMarkdown(spaces, marker));
            expect(
                blocks.some((block) => block.includes(marker)),
                `typescript fence indented by ${spaces} space(s) must be extracted`,
            ).toBe(true);
        }
    });

    it('an indented fence without a local rig declaration fails', () => {
        for (const spaces of commonMarkFenceIndents) {
            const markdown = indentedTypescriptMarkdown(spaces, 'await rig.clock.advance(milliseconds(1));');
            expect(
                typescriptFencesUsingUndeclaredRig(markdown).length,
                `indent ${spaces}: the skill rig-declaration check must fail for an indented fence that uses rig without declaring it`,
            ).toBeGreaterThan(0);
        }
    });

    it('a line of backticks with trailing text is not a closing fence', () => {
        const marker = 'const stillInBlock = true;';
        const markdown = ['   ```typescript', 'const extracted = true;', ' ```not-a-close', marker, '   ```', ''].join(
            '\n',
        );
        const blocks = fencedTypescriptBlocks(markdown);
        expect(
            blocks.some((block) => block.includes(marker) && block.includes('not-a-close')),
            '```not-a-close must stay inside the extracted typescript block',
        ).toBe(true);
    });

    it('aliased destructuring is not a local rig binding', () => {
        const markdown = indentedTypescriptMarkdown(
            2,
            ['const { rig: renamed } = createMyRig();', 'await rig.clock.advance(milliseconds(1));'].join('\n'),
        );
        expect(
            typescriptFencesUsingUndeclaredRig(markdown).length,
            'const { rig: renamed } must not count as declaring identifier rig',
        ).toBeGreaterThan(0);
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

describe('engineering-principles agrees the lint ratchet is on', () => {
    it('engineering-principles does not claim any is off in ESLint', () => {
        const content = readExisting('.cursor/skills/engineering-principles/SKILL.md');
        const withoutTicks = content.replaceAll('`', '');
        expect(
            withoutTicks.includes('@typescript-eslint/no-explicit-any is off'),
            'engineering-principles must not claim @typescript-eslint/no-explicit-any is off',
        ).toBe(false);
        expect(
            content.includes('not an ESLint error'),
            'engineering-principles must not contain "not an ESLint error"',
        ).toBe(false);
    });

    it('engineering-principles names lint as enforcing the budget', () => {
        const content = readExisting('.cursor/skills/engineering-principles/SKILL.md');
        expect(content.includes('npm run lint'), 'engineering-principles must contain npm run lint').toBe(true);
        expect(content.includes('no git hooks'), 'engineering-principles must contain no git hooks').toBe(true);
        expect(
            content.includes('does not currently enforce'),
            'engineering-principles must not contain "does not currently enforce"',
        ).toBe(false);
    });
});

describe('complexity-budget names lint as the enforcer', () => {
    it('complexity-budget names lint as the enforcer', () => {
        const content = readExisting('.cursor/rules/complexity-budget.mdc');
        expect(content.includes('npm run lint'), 'complexity-budget must contain npm run lint').toBe(true);
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

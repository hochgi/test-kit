import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
    cpSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

const requiredDirectories = [
    '.harness',
    '.claude/agents',
    '.claude/commands',
    '.claude/skills',
    '.cursor/agents',
    '.cursor/commands',
    '.cursor/rules',
    '.cursor/skills',
    '.opencode/agents',
    '.opencode/commands',
] as const;

const droppedSurfaces = ['.github/skills', '.agents/skills'] as const;

const agentOrder = ['spec-author', 'test-author', 'coder', 'reviewer', 'verifier'] as const;

const donorColumns = {
    'spec-author': { claude: 'opus', cursor: 'cursor-grok-4.6-xhigh', opencode: 'litellm/vn-spec' },
    'test-author': { claude: 'claude-opus-4-8', cursor: 'cursor-grok-4.6-xhigh', opencode: 'litellm/vn-test' },
    coder: { claude: 'opus', cursor: 'cursor-grok-4.6-xhigh', opencode: 'litellm/vn-coding' },
    reviewer: { claude: 'opus', cursor: 'cursor-grok-4.6-xhigh', opencode: 'litellm/vn-review' },
    verifier: { claude: 'opus', cursor: 'cursor-grok-4.6-xhigh', opencode: 'litellm/vn-verify' },
} as const;

const donorReadonly = {
    'spec-author': false,
    'test-author': false,
    coder: false,
    reviewer: true,
    verifier: true,
} as const;

const donorPhase = {
    'spec-author': 1,
    'test-author': 2,
    coder: 3,
    reviewer: 4,
    verifier: 5,
} as const;

const conventionalPrograms = {
    sync: 'scripts/sync-agent-skills.sh',
    check: 'scripts/check-agent-skills.sh',
} as const;

const skillFixtureRelative = 'write-spec/SKILL.md';
const skillFixtureBody = 'canonical skill body\n';
const cursorAgentBody = '---\nname: spec-author\nmodel: cursor-grok-4.6-xhigh\n---\n\nCursor bootstrap agent.\n';
const cursorCommandBody = '---\ndescription: spec to ship\n---\n\nCursor bootstrap command.\n';
const claudeAgentBody =
    '---\nname: spec-author\ndescription: Spec author\nmodel: opus\n---\n\nCanonical Claude agent.\n';
const disagreeingClaudeAgentBody =
    '---\nname: spec-author\ndescription: Spec author\nmodel: sonnet\n---\n\nCanonical Claude agent with a disagreeing model.\n';

const tempRoots: string[] = [];

afterEach(() => {
    for (const root of tempRoots.splice(0, tempRoots.length)) {
        rmSync(root, { recursive: true, force: true });
    }
});

type AgentColumns = {
    claude: string;
    cursor: string;
    opencode: string;
    readonly: boolean;
    phase: number;
};

type ModelsManifest = {
    agents: Record<(typeof agentOrder)[number], AgentColumns>;
    orchestrator: { opencode: string };
    rationale: Record<string, string>;
};

type CommandResult = {
    code: number;
    stdout: string;
    stderr: string;
};

type FileMap = Record<string, string>;

type FixtureOptions = {
    models?: ModelsManifest | Record<string, unknown> | 'omit';
    modelsExample?: ModelsManifest | Record<string, unknown> | 'omit';
    opencode?: Record<string, unknown> | 'omit';
    cursorSkills?: FileMap;
    claudeSkills?: FileMap | 'empty';
    cursorAgents?: FileMap;
    claudeAgents?: FileMap;
    cursorCommands?: FileMap;
    claudeCommands?: FileMap;
    skillSymlink?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readUtf8(filePath: string): string {
    return readFileSync(filePath, 'utf8');
}

function isDirectory(filePath: string): boolean {
    try {
        return lstatSync(filePath).isDirectory();
    } catch {
        return false;
    }
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

function validManifest(): ModelsManifest {
    const cursor = 'cursor-grok-4.6-xhigh';
    return {
        agents: {
            'spec-author': { claude: 'opus', cursor, opencode: 'litellm/vn-spec', readonly: false, phase: 1 },
            'test-author': {
                claude: 'claude-opus-4-8',
                cursor,
                opencode: 'litellm/vn-test',
                readonly: false,
                phase: 2,
            },
            coder: { claude: 'opus', cursor, opencode: 'litellm/vn-coding', readonly: false, phase: 3 },
            reviewer: { claude: 'opus', cursor, opencode: 'litellm/vn-review', readonly: true, phase: 4 },
            verifier: { claude: 'opus', cursor, opencode: 'litellm/vn-verify', readonly: true, phase: 5 },
        },
        orchestrator: { opencode: 'litellm/vn-spec' },
        rationale: {
            'test-author.claude': 'Opus 4.8 keeps test scope tight; newer tiers invent adjacent scenarios.',
        },
    };
}

function validOpencodeJson(): Record<string, unknown> {
    return {
        model: 'litellm/vn-coding',
        agent: {
            build: { model: 'litellm/vn-coding' },
            'spec-to-ship': { model: 'litellm/vn-spec' },
        },
        skills: {
            paths: ['./.cursor/skills'],
        },
    };
}

function jsonFile(value: unknown): string {
    return `${JSON.stringify(value, null, 2)}\n`;
}

function extractScriptsPath(command: string): string | undefined {
    const match = command.match(/(?:\.\/)?(scripts\/[^\s;'"]+)/);
    return match?.[1];
}

function programRelative(kind: 'sync' | 'check'): string {
    const key = kind === 'sync' ? 'sync-agent-skills' : 'check-agent-skills';
    const command = readRootScripts()[key];
    return (command !== undefined ? extractScriptsPath(command) : undefined) ?? conventionalPrograms[kind];
}

function assertProgramExists(kind: 'sync' | 'check'): string {
    const relative = programRelative(kind);
    expect(
        existsSync(path.join(repoRoot, relative)),
        `${relative} must exist so ${kind === 'sync' ? 'sync-agent-skills' : 'check-agent-skills'} can run`,
    ).toBe(true);
    return relative;
}

function spawnResult(result: SpawnSyncReturns<string>): CommandResult {
    if (result.error !== undefined) {
        throw result.error;
    }
    return {
        code: result.status ?? 1,
        stdout: result.stdout,
        stderr: result.stderr,
    };
}

function git(cwd: string, args: string[]): CommandResult {
    return spawnResult(
        spawnSync('git', args, {
            cwd,
            encoding: 'utf8',
            env: {
                ...process.env,
                GIT_AUTHOR_NAME: 'P05',
                GIT_AUTHOR_EMAIL: 'p05@test',
                GIT_COMMITTER_NAME: 'P05',
                GIT_COMMITTER_EMAIL: 'p05@test',
            },
        }),
    );
}

function runNpm(cwd: string, scriptName: string): CommandResult {
    return spawnResult(
        spawnSync('npm', ['run', scriptName], {
            cwd,
            encoding: 'utf8',
            env: process.env,
        }),
    );
}

function writeRelativeFile(root: string, relative: string, contents: string): void {
    const abs = path.join(root, relative);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
}

function writeMdTree(root: string, dir: string, files: FileMap): void {
    mkdirSync(path.join(root, dir), { recursive: true });
    for (const [relative, body] of Object.entries(files)) {
        writeRelativeFile(root, path.join(dir, relative), body);
    }
}

function listRelativeFiles(dir: string): string[] {
    if (!existsSync(dir)) {
        return [];
    }
    const out: string[] = [];
    const walk = (current: string, rel: string): void => {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
            if (entry.name === '.DS_Store') {
                continue;
            }
            const nextRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
            const nextAbs = path.join(current, entry.name);
            if (entry.isDirectory()) {
                walk(nextAbs, nextRel);
                continue;
            }
            if (entry.isFile() || entry.isSymbolicLink()) {
                out.push(nextRel);
            }
        }
    };
    walk(dir, '');
    out.sort();
    return out;
}

function fileBytes(dir: string, relative: string): Buffer {
    return readFileSync(path.join(dir, relative));
}

function mdSnapshots(dir: string): Record<string, string> {
    const snapshots: Record<string, string> = {};
    if (!existsSync(dir)) {
        return snapshots;
    }
    for (const name of readdirSync(dir)) {
        if (!name.endsWith('.md')) {
            continue;
        }
        snapshots[name] = readUtf8(path.join(dir, name));
    }
    return snapshots;
}

function parseJsonFile(filePath: string, label: string): unknown {
    expect(existsSync(filePath), `${label} must exist`).toBe(true);
    return JSON.parse(readUtf8(filePath));
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
    expect(isRecord(value), `${label} must be an object`).toBe(true);
    return isRecord(value) ? value : {};
}

function rationaleText(value: unknown): string {
    if (typeof value === 'string') {
        return value;
    }
    if (Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === 'string')) {
        return value.join('\n');
    }
    return '';
}

function createTempHarnessRepo(options: FixtureOptions = {}): string {
    const root = mkdtempSync(path.join(tmpdir(), 'p05-harness-'));
    tempRoots.push(root);

    const manifest = options.models === undefined ? validManifest() : options.models;
    const example =
        options.modelsExample === undefined
            ? manifest === 'omit'
                ? validManifest()
                : manifest
            : options.modelsExample;
    const opencode = options.opencode === undefined ? validOpencodeJson() : options.opencode;
    const cursorSkills = options.cursorSkills ?? { [skillFixtureRelative]: skillFixtureBody };
    const claudeSkills =
        options.claudeSkills === undefined
            ? cursorSkills
            : options.claudeSkills === 'empty'
              ? {}
              : options.claudeSkills;
    const cursorAgents = options.cursorAgents ?? { 'spec-author.md': cursorAgentBody };
    const claudeAgents = options.claudeAgents ?? {};
    const cursorCommands = options.cursorCommands ?? { 'spec-to-ship.md': cursorCommandBody };
    const claudeCommands = options.claudeCommands ?? {};

    for (const dir of requiredDirectories) {
        mkdirSync(path.join(root, dir), { recursive: true });
    }

    if (manifest !== 'omit') {
        writeRelativeFile(root, '.harness/models.json', jsonFile(manifest));
    }
    if (example !== 'omit') {
        writeRelativeFile(root, '.harness/models.example.json', jsonFile(example));
    }
    if (opencode !== 'omit') {
        writeRelativeFile(root, '.opencode/opencode.json', jsonFile(opencode));
    }

    writeMdTree(root, '.cursor/skills', cursorSkills);
    writeMdTree(root, '.claude/skills', claudeSkills);
    writeMdTree(root, '.cursor/agents', cursorAgents);
    writeMdTree(root, '.claude/agents', claudeAgents);
    writeMdTree(root, '.cursor/commands', cursorCommands);
    writeMdTree(root, '.claude/commands', claudeCommands);

    if (options.skillSymlink !== undefined) {
        const linkPath = path.join(root, '.cursor/skills', options.skillSymlink);
        mkdirSync(path.dirname(linkPath), { recursive: true });
        symlinkSync(skillFixtureRelative, linkPath);
    }

    const liveScripts = path.join(repoRoot, 'scripts');
    if (existsSync(liveScripts)) {
        cpSync(liveScripts, path.join(root, 'scripts'), { recursive: true });
    }

    const live = readRootScripts();
    writeRelativeFile(
        root,
        'package.json',
        jsonFile({
            name: 'p05-harness-fixture',
            private: true,
            scripts: {
                'sync-agent-skills': live['sync-agent-skills'] ?? `bash ${conventionalPrograms.sync}`,
                'check-agent-skills': live['check-agent-skills'] ?? `bash ${conventionalPrograms.check}`,
            },
        }),
    );

    const init = git(root, ['init', '-q']);
    expect(init.code, `git init must succeed: ${init.stderr}`).toBe(0);
    const add = git(root, ['add', '-A']);
    expect(add.code, `git add must succeed: ${add.stderr}`).toBe(0);
    const commit = git(root, ['commit', '-q', '--allow-empty', '-m', 'fixture']);
    expect(commit.code, `git commit must succeed: ${commit.stderr}`).toBe(0);

    return root;
}

describe('Four harness surfaces exist', () => {
    it('required directories exist', () => {
        for (const relative of requiredDirectories) {
            expect(isDirectory(path.join(repoRoot, relative)), `${relative} must be a directory`).toBe(true);
        }
    });

    it('dropped Copilot and agents-dot surfaces are absent', () => {
        for (const relative of droppedSurfaces) {
            expect(existsSync(path.join(repoRoot, relative)), `${relative} must not exist`).toBe(false);
        }
    });
});

describe('Internal docs three-way layout', () => {
    it('packets spec and archive exist', () => {
        const docsInternal = path.join(repoRoot, 'docs/internal');
        expect(isDirectory(docsInternal), 'docs/internal must be a directory').toBe(true);
        const names = readdirSync(docsInternal, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name);
        expect(names, 'docs/internal must contain packets, spec, and archive').toEqual(
            expect.arrayContaining(['packets', 'spec', 'archive']),
        );
    });
});

describe('Model manifest is the single source of per-phase targeting', () => {
    it('five agents have the donor three columns', () => {
        const parsed = parseJsonFile(path.join(repoRoot, '.harness/models.json'), '.harness/models.json');
        const root = asRecord(parsed, '.harness/models.json');
        const agents = asRecord(root['agents'], 'agents');
        const orchestrator = asRecord(root['orchestrator'], 'orchestrator');

        expect(orchestrator['opencode'], 'orchestrator.opencode must be litellm/vn-spec').toBe('litellm/vn-spec');

        for (const name of agentOrder) {
            const entry = asRecord(agents[name], `agents['${name}']`);
            expect(entry['claude'], `agents['${name}'].claude`).toBe(donorColumns[name].claude);
            expect(entry['cursor'], `agents['${name}'].cursor`).toBe(donorColumns[name].cursor);
            expect(entry['opencode'], `agents['${name}'].opencode`).toBe(donorColumns[name].opencode);
            expect(
                typeof entry['opencode'] === 'string' && entry['opencode'].startsWith('litellm/vn-'),
                `agents['${name}'].opencode must start with litellm/vn-`,
            ).toBe(true);
            expect(typeof entry['readonly'] === 'boolean', `agents['${name}'].readonly must be a JSON boolean`).toBe(
                true,
            );
            expect(entry['readonly'], `agents['${name}'].readonly`).toBe(donorReadonly[name]);
            expect(entry['phase'], `agents['${name}'].phase`).toBe(donorPhase[name]);
        }
    });

    it('test-author claude pin is explained', () => {
        const parsed = parseJsonFile(path.join(repoRoot, '.harness/models.json'), '.harness/models.json');
        const root = asRecord(parsed, '.harness/models.json');
        const agents = asRecord(root['agents'], 'agents');
        const testAuthor = asRecord(agents['test-author'], "agents['test-author']");
        const rationale = asRecord(root['rationale'], 'rationale');

        expect(testAuthor['claude'], "agents['test-author'].claude must be claude-opus-4-8").toBe('claude-opus-4-8');
        expect(Object.keys(rationale), 'rationale must have no keys other than test-author.claude').toEqual([
            'test-author.claude',
        ]);
        const text = rationaleText(rationale['test-author.claude']);
        expect(
            text.length,
            'rationale["test-author.claude"] must be a non-empty string or array of strings',
        ).toBeGreaterThan(0);
        expect(text, 'rationale must mention opus').toMatch(/opus/i);
        expect(text, 'rationale must mention 4.8').toMatch(/4\.8/);
        expect(text, 'rationale must mention scope').toMatch(/scope/i);
    });
});

describe('Example manifest lets a clone restore models.json', () => {
    it('example matches the live manifest', () => {
        const live = asRecord(
            parseJsonFile(path.join(repoRoot, '.harness/models.json'), '.harness/models.json'),
            '.harness/models.json',
        );
        const example = asRecord(
            parseJsonFile(path.join(repoRoot, '.harness/models.example.json'), '.harness/models.example.json'),
            '.harness/models.example.json',
        );
        expect(example['agents'], 'example agents must equal live agents').toEqual(live['agents']);
        expect(example['orchestrator'], 'example orchestrator must equal live orchestrator').toEqual(
            live['orchestrator'],
        );
        expect(example['rationale'], 'example rationale must equal live rationale').toEqual(live['rationale']);
    });

    it('missing models.json fails loudly', () => {
        assertProgramExists('check');
        const root = createTempHarnessRepo({ models: 'omit' });
        const modelsPath = path.join(root, '.harness/models.json');
        expect(existsSync(modelsPath), 'fixture must omit models.json before the check').toBe(false);

        const result = runNpm(root, 'check-agent-skills');
        expect(result.code, 'check-agent-skills must exit non-zero when models.json is missing').not.toBe(0);
        expect(result.stderr, 'stderr must name .harness/models.example.json').toContain(
            '.harness/models.example.json',
        );
        expect(result.stderr, 'stderr must name .harness/models.json').toContain('.harness/models.json');
        expect(existsSync(modelsPath), 'check-agent-skills must not create models.json').toBe(false);
    });
});

describe('Sync and check are npm scripts, not git hooks', () => {
    it('both scripts are defined', () => {
        const scripts = readRootScripts();
        const sync = scripts['sync-agent-skills'];
        const check = scripts['check-agent-skills'];
        expect(sync, 'root package.json must define scripts.sync-agent-skills').toEqual(expect.any(String));
        expect(check, 'root package.json must define scripts.check-agent-skills').toEqual(expect.any(String));
        expect(extractScriptsPath(sync ?? ''), 'sync-agent-skills must invoke a path under scripts/').toEqual(
            expect.any(String),
        );
        expect(extractScriptsPath(check ?? ''), 'check-agent-skills must invoke a path under scripts/').toEqual(
            expect.any(String),
        );
    });

    it('check-agent-skills is read-only', () => {
        assertProgramExists('check');
        const root = createTempHarnessRepo();
        const result = runNpm(root, 'check-agent-skills');
        expect(result.code, `check-agent-skills must exit 0 on a consistent tree: ${result.stderr}`).toBe(0);
        const porcelain = git(root, ['status', '--porcelain']);
        expect(porcelain.code, 'git status must succeed').toBe(0);
        const tracked = porcelain.stdout.split('\n').filter((line) => line !== '' && !line.startsWith('??'));
        expect(tracked, 'check-agent-skills must not change tracked files').toEqual([]);
    });
});

describe('Skills fan out byte-identical from Cursor', () => {
    it('claude skills match cursor skills after check passes', () => {
        assertProgramExists('sync');
        assertProgramExists('check');
        const root = createTempHarnessRepo({ claudeSkills: 'empty' });
        const sync = runNpm(root, 'sync-agent-skills');
        expect(sync.code, `sync-agent-skills must succeed: ${sync.stderr}`).toBe(0);
        const check = runNpm(root, 'check-agent-skills');
        expect(check.code, `check-agent-skills must exit 0: ${check.stderr}`).toBe(0);

        const cursorSkills = path.join(root, '.cursor/skills');
        const claudeSkills = path.join(root, '.claude/skills');
        const cursorFiles = listRelativeFiles(cursorSkills);
        const claudeFiles = listRelativeFiles(claudeSkills);
        expect(claudeFiles, '.claude/skills must contain the same relative paths as .cursor/skills').toEqual(
            cursorFiles,
        );
        for (const relative of cursorFiles) {
            expect(fileBytes(claudeSkills, relative), `${relative} bytes must match`).toEqual(
                fileBytes(cursorSkills, relative),
            );
        }
    });

    it('OpenCode skills path is the Cursor canonical dir', () => {
        const parsed = asRecord(
            parseJsonFile(path.join(repoRoot, '.opencode/opencode.json'), '.opencode/opencode.json'),
            '.opencode/opencode.json',
        );
        const skills = asRecord(parsed['skills'], 'skills');
        expect(skills['paths'], 'skills.paths must be exactly ["./.cursor/skills"]').toEqual(['./.cursor/skills']);
    });
});

describe('Agents and commands generate from Claude when canonical files exist', () => {
    it('populated claude agents produce matching cursor and opencode mirrors', () => {
        assertProgramExists('sync');
        assertProgramExists('check');
        const root = createTempHarnessRepo({
            claudeAgents: { 'spec-author.md': claudeAgentBody },
            cursorAgents: {},
        });
        const sync = runNpm(root, 'sync-agent-skills');
        expect(sync.code, `sync-agent-skills must succeed: ${sync.stderr}`).toBe(0);
        expect(
            existsSync(path.join(root, '.cursor/agents/spec-author.md')),
            'sync-agent-skills must write .cursor/agents/spec-author.md',
        ).toBe(true);
        expect(
            existsSync(path.join(root, '.opencode/agents/spec-author.md')),
            'sync-agent-skills must write .opencode/agents/spec-author.md',
        ).toBe(true);
        const check = runNpm(root, 'check-agent-skills');
        expect(check.code, `check-agent-skills must exit 0 after generating mirrors: ${check.stderr}`).toBe(0);
    });

    it('perturbed Cursor agent mirror fails the check', () => {
        assertProgramExists('sync');
        assertProgramExists('check');
        const root = createTempHarnessRepo({
            claudeAgents: { 'spec-author.md': claudeAgentBody },
            cursorAgents: {},
        });
        const sync = runNpm(root, 'sync-agent-skills');
        expect(sync.code, `sync-agent-skills must succeed: ${sync.stderr}`).toBe(0);
        const generated = path.join(root, '.cursor/agents/spec-author.md');
        expect(existsSync(generated), 'sync-agent-skills must write .cursor/agents/spec-author.md').toBe(true);
        writeFileSync(generated, `${readUtf8(generated)}\n# perturbed\n`);
        const check = runNpm(root, 'check-agent-skills');
        expect(
            check.code,
            'check-agent-skills must exit non-zero when a generated Cursor agent mirror is edited',
        ).not.toBe(0);
    });

    it('claude agent model disagrees with the manifest', () => {
        assertProgramExists('check');
        const root = createTempHarnessRepo({
            claudeAgents: { 'spec-author.md': disagreeingClaudeAgentBody },
        });
        const result = runNpm(root, 'check-agent-skills');
        expect(
            result.code,
            'check-agent-skills must exit non-zero when the Claude model disagrees with the manifest',
        ).not.toBe(0);
    });
});

describe('Empty Claude canonical dirs do not destroy Cursor bootstrap', () => {
    it('empty claude agents leave cursor agents in place', () => {
        assertProgramExists('sync');
        const root = createTempHarnessRepo({
            claudeAgents: {},
            cursorAgents: { 'spec-author.md': cursorAgentBody, 'coder.md': cursorAgentBody },
        });
        const before = mdSnapshots(path.join(root, '.cursor/agents'));
        expect(Object.keys(before).length, 'fixture must start with Cursor agent markdown').toBeGreaterThan(0);
        const sync = runNpm(root, 'sync-agent-skills');
        expect(sync.code, `sync-agent-skills must succeed: ${sync.stderr}`).toBe(0);
        expect(
            mdSnapshots(path.join(root, '.cursor/agents')),
            'existing .cursor/agents markdown must be unchanged',
        ).toEqual(before);
    });

    it('empty claude commands leave cursor commands in place', () => {
        assertProgramExists('sync');
        const root = createTempHarnessRepo({
            claudeCommands: {},
            cursorCommands: { 'spec-to-ship.md': cursorCommandBody },
        });
        const before = mdSnapshots(path.join(root, '.cursor/commands'));
        expect(Object.keys(before).length, 'fixture must start with Cursor command markdown').toBeGreaterThan(0);
        const sync = runNpm(root, 'sync-agent-skills');
        expect(sync.code, `sync-agent-skills must succeed: ${sync.stderr}`).toBe(0);
        expect(
            mdSnapshots(path.join(root, '.cursor/commands')),
            'existing .cursor/commands markdown must be unchanged',
        ).toEqual(before);
    });

    it('check passes with empty claude agents and commands', () => {
        assertProgramExists('check');
        const root = createTempHarnessRepo({
            claudeAgents: {},
            claudeCommands: {},
        });
        const result = runNpm(root, 'check-agent-skills');
        expect(
            result.code,
            `check-agent-skills must exit 0 when Claude agents and commands are empty: ${result.stderr}`,
        ).toBe(0);
    });

    it('live canonical Claude trees are populated', () => {
        const agentDir = path.join(repoRoot, '.claude/agents');
        const commandDir = path.join(repoRoot, '.claude/commands');
        const agentMd = existsSync(agentDir) ? readdirSync(agentDir).filter((name) => name.endsWith('.md')) : [];
        const commandMd = existsSync(commandDir) ? readdirSync(commandDir).filter((name) => name.endsWith('.md')) : [];
        expect(agentMd.length, '.claude/agents must contain at least one *.md').toBeGreaterThan(0);
        expect(commandMd.length, '.claude/commands must contain at least one *.md').toBeGreaterThan(0);
    });

    it('check-agent-skills compares the live mirrors', () => {
        assertProgramExists('check');
        const result = runNpm(repoRoot, 'check-agent-skills');
        expect(result.code, `check-agent-skills must exit 0 on the live tree: ${result.stderr}`).toBe(0);
    });
});

describe('OpenCode config tracks the manifest', () => {
    it('opencode.json models match the manifest', () => {
        const parsed = asRecord(
            parseJsonFile(path.join(repoRoot, '.opencode/opencode.json'), '.opencode/opencode.json'),
            '.opencode/opencode.json',
        );
        const agent = asRecord(parsed['agent'], 'agent');
        const build = asRecord(agent['build'], 'agent.build');
        const specToShip = asRecord(agent['spec-to-ship'], 'agent["spec-to-ship"]');
        expect(parsed['model'], 'opencode.json model must be litellm/vn-coding').toBe('litellm/vn-coding');
        expect(build['model'], 'agent.build.model must be litellm/vn-coding').toBe('litellm/vn-coding');
        expect(specToShip['model'], 'agent["spec-to-ship"].model must be litellm/vn-spec').toBe('litellm/vn-spec');
    });

    it('opencode.json drift fails the check', () => {
        assertProgramExists('check');
        const drifted = validOpencodeJson();
        drifted['model'] = 'litellm/vn-spec';
        const root = createTempHarnessRepo({ opencode: drifted });
        const result = runNpm(root, 'check-agent-skills');
        expect(result.code, 'check-agent-skills must exit non-zero when opencode.json model drifts').not.toBe(0);
    });
});

describe('Manifest validation is fail-closed', () => {
    it('string readonly fails validation', () => {
        assertProgramExists('check');
        const base = validManifest();
        const manifest: Record<string, unknown> = {
            agents: {
                'spec-author': base.agents['spec-author'],
                'test-author': base.agents['test-author'],
                coder: {
                    claude: base.agents.coder.claude,
                    cursor: base.agents.coder.cursor,
                    opencode: base.agents.coder.opencode,
                    readonly: 'false',
                    phase: base.agents.coder.phase,
                },
                reviewer: base.agents.reviewer,
                verifier: base.agents.verifier,
            },
            orchestrator: base.orchestrator,
            rationale: base.rationale,
        };
        const root = createTempHarnessRepo({ models: manifest });
        const result = runNpm(root, 'check-agent-skills');
        expect(result.code, 'check-agent-skills must exit non-zero when readonly is a string').not.toBe(0);
    });

    it('unexplained cursor or claude deviation fails validation', () => {
        assertProgramExists('check');
        const manifest = validManifest();
        manifest.agents.coder = { ...manifest.agents.coder, claude: 'sonnet' };
        const root = createTempHarnessRepo({ models: manifest });
        const result = runNpm(root, 'check-agent-skills');
        expect(
            result.code,
            'check-agent-skills must exit non-zero when coder.claude differs without a rationale entry',
        ).not.toBe(0);
    });

    it('symlink under canonical skills fails the check', () => {
        assertProgramExists('check');
        const root = createTempHarnessRepo({ skillSymlink: 'linked-skill.md' });
        const result = runNpm(root, 'check-agent-skills');
        expect(result.code, 'check-agent-skills must exit non-zero when .cursor/skills contains a symlink').not.toBe(0);
    });
});

describe('New TypeScript for this capability is on the root test and format paths', () => {
    it('harness-scaffold tests are in the Vitest workspace', () => {
        const workspace = readUtf8(path.join(repoRoot, 'vitest.workspace.ts'));
        expect(
            workspace.includes('test/harness-scaffold'),
            'vitest.workspace.ts must include a project that picks up test/harness-scaffold',
        ).toBe(true);
    });

    it('harness-scaffold TypeScript is format-checked', () => {
        const formatCheck = readRootScripts()['format:check'];
        expect(formatCheck, 'root package.json must define scripts.format:check').toEqual(expect.any(String));
        const covers =
            (formatCheck ?? '').includes('test/**/*.ts') || (formatCheck ?? '').includes('test/harness-scaffold');
        expect(covers, 'format:check glob must cover test/harness-scaffold TypeScript').toBe(true);
    });
});

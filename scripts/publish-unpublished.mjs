#!/usr/bin/env node
// Publish every workspace package under packages/ whose package.json version
// is not on the npm registry yet, dependencies before dependents.
//
//   node scripts/publish-unpublished.mjs            publish (release.yml)
//   node scripts/publish-unpublished.mjs --dry-run  pack-check + plan only (ci.yml)
//
// A version that is already on the registry is skipped, so re-running a
// release after a partial failure publishes only what is missing.
//
// Auth: npm trusted publishing (OIDC) when run from release.yml. If NPM_TOKEN
// is set (first publish of a package, before it can have a trusted publisher)
// it is written to a throwaway userconfig for this process only.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dryRun = process.argv.includes('--dry-run');
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const registry = 'https://registry.npmjs.org/';
const requiredInTarball = ['package.json', 'README.md', 'LICENSE', 'dist/index.js', 'dist/index.cjs', 'dist/index.d.ts'];

function readPackages() {
    const dir = path.join(repoRoot, 'packages');
    return readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => {
            const manifest = JSON.parse(readFileSync(path.join(dir, d.name, 'package.json'), 'utf8'));
            return { dir: `packages/${d.name}`, manifest };
        })
        .filter((p) => !p.manifest.private);
}

function topoSort(packages) {
    const byName = new Map(packages.map((p) => [p.manifest.name, p]));
    const ordered = [];
    const state = new Map();
    const visit = (p, trail) => {
        if (state.get(p) === 'done') return;
        if (state.get(p) === 'visiting') throw new Error(`dependency cycle: ${[...trail, p.manifest.name].join(' -> ')}`);
        state.set(p, 'visiting');
        const deps = { ...p.manifest.dependencies, ...p.manifest.peerDependencies };
        for (const name of Object.keys(deps)) {
            const dep = byName.get(name);
            if (dep) visit(dep, [...trail, p.manifest.name]);
        }
        state.set(p, 'done');
        ordered.push(p);
    };
    for (const p of [...packages].sort((a, b) => a.manifest.name.localeCompare(b.manifest.name))) visit(p, []);
    return ordered;
}

function isPublished(name, version) {
    const r = spawnSync('npm', ['view', `${name}@${version}`, 'version', '--registry', registry], { encoding: 'utf8' });
    if (r.status === 0) return r.stdout.trim() === version;
    if (/E404|404 Not Found/.test(r.stderr)) return false;
    throw new Error(`npm view ${name}@${version} failed:\n${r.stderr}`);
}

function checkTarball(p) {
    const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--workspace', p.dir], { cwd: repoRoot, encoding: 'utf8' });
    const files = new Set(JSON.parse(out)[0].files.map((f) => f.path));
    const missing = requiredInTarball.filter((f) => !files.has(f));
    if (missing.length > 0) throw new Error(`${p.manifest.name} tarball is missing: ${missing.join(', ')}`);
}

function withUserconfig(fn) {
    const token = process.env.NPM_TOKEN;
    if (!token) return fn({ ...process.env });
    const dir = mkdtempSync(path.join(tmpdir(), 'npm-publish-'));
    const userconfig = path.join(dir, '.npmrc');
    writeFileSync(userconfig, `//registry.npmjs.org/:_authToken=${token}\n`, { mode: 0o600 });
    try {
        return fn({ ...process.env, NPM_CONFIG_USERCONFIG: userconfig });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

const plan = topoSort(readPackages());
const pending = [];
for (const p of plan) {
    checkTarball(p);
    const { name, version } = p.manifest;
    const published = isPublished(name, version);
    console.log(`${published ? 'skip   ' : 'publish'} ${name}@${version}`);
    if (!published) pending.push(p);
}

if (dryRun) {
    console.log(`\n--dry-run: ${pending.length} package(s) would be published.`);
    process.exit(0);
}

withUserconfig((env) => {
    for (const p of pending) {
        execFileSync(
            'npm',
            ['publish', '--workspace', p.dir, '--access', 'public', '--provenance', '--registry', registry],
            { cwd: repoRoot, env, stdio: 'inherit' },
        );
    }
});
console.log(`\nPublished ${pending.length} package(s).`);

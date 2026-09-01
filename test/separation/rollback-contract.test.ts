import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('Phase 2 rollback gate', () => {
  it('STO-018: committed manifest pins the exact pre-separation bytes and recipe', async () => {
    const manifest = JSON.parse(await readFile(join(root, 'test', 'fixtures', 'rollback', 'manifest.json'), 'utf8')) as Record<string, unknown>;
    expect(manifest.package).toBe('taskshuttle');
    expect(manifest.version).toBe('0.1.0-alpha.3');
    expect(manifest.byteLength).toBe(27_651_563);
    expect(manifest.sha256).toBe('2c512a962ca1ce5acbf86770c41f9eb4ef3238642658de94f1c2595d2d9ea36d');
    expect(manifest.acceptedSources).toEqual(['registry', 'cache', 'reproducible-rebuild']);
    expect(manifest.recipe).toMatch(/frozen-lockfile[\s\S]*npm pack/u);
  });

  it('STO-018: old artifact recovery is not replaced by a direct archive read', async () => {
    const source = await readFile(join(root, 'scripts', 'rollback-gate.mjs'), 'utf8');
    expect(source).toMatch(/transcript_list|transcript-list|recovery/u);
    expect(source).not.toMatch(/archiveInstanceIds/u);
    expect(source).toMatch(/TASKSHUTTLE_STO018_ARTIFACT/u);
  });

  it('STO-018: a candidate with wrong bytes is rejected before recovery', async () => {
    // Built here, not taken from a committed tarball: the gate rejects on byte
    // identity, so any file of the wrong length proves the same thing, and the
    // committed archives carry internal content that must not be published
    // (ADR 0056). Nothing in this case ever reads inside the candidate.
    const directory = await mkdtemp(join(tmpdir(), 'taskshuttle-sto018-candidate-'));
    const candidate = join(directory, 'wrong-bytes.tgz');
    await writeFile(candidate, 'not the pinned artifact');
    let output = '';
    try {
      execFileSync(process.execPath, ['scripts/rollback-gate.mjs'], {
        cwd: root,
        env: { ...process.env, TASKSHUTTLE_STO018_ARTIFACT: candidate },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (cause) {
      const error = cause as { stdout?: string; stderr?: string; status?: number };
      output = `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
      expect(error.status).not.toBe(0);
    }
    expect(output).toMatch(/candidate bytes do not match pinned identity/u);
    await rm(directory, { recursive: true, force: true });
  });
});

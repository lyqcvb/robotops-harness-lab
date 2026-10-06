import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { runRecompute } from '../../src/app/business-recompute.js';
import { runBusinessInternal } from '../../src/app/business-run.js';

async function createRoot(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'robotops-recompute-archive-'));
  t.after(async () => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('robotops-recompute-archive-'));
    await rm(resolved, { recursive: true, force: true });
  });
  return root;
}

async function recompute(root: string, argv: readonly string[] = []): Promise<{
  readonly code: number;
  readonly summary: {
    readonly checked: number;
    readonly status: string;
    readonly differences: readonly unknown[];
    readonly runs: readonly { readonly directory: string; readonly status: string }[];
  };
}> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runRecompute({
    cwd: root,
    env: {},
    stdout: (line) => { stdout.push(line); },
    stderr: (line) => { stderr.push(line); },
  }, argv);
  assert.deepEqual(stderr, []);
  assert.equal(stdout.length, 1);
  return { code, summary: JSON.parse(stdout[0]!) as Awaited<ReturnType<typeof recompute>>['summary'] };
}

test('default recompute skips hidden directories and batches but checks archived ordinary runs', async (t) => {
  const root = await createRoot(t);
  const repositoryRoot = process.cwd();
  await copyFile(path.join(repositoryRoot, 'package-lock.json'), path.join(root, 'package-lock.json'));
  const metadata = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8')) as {
    readonly dependencies: Record<string, string>;
  };
  for (const name of Object.keys(metadata.dependencies)) {
    const directory = path.join(root, 'node_modules', name);
    await mkdir(directory, { recursive: true });
    await copyFile(path.join(repositoryRoot, 'node_modules', name, 'package.json'), path.join(directory, 'package.json'));
  }
  const run = await runBusinessInternal({
    projectRoot: root,
    scenarioId: 'happy_path',
    config: 'full',
    mode: 'offline',
    approvalMode: 'scripted',
  }, {});
  assert.equal(run.metrics.status, 'PASS');
  for (const name of ['.archive', '.archives', 'batches']) {
    await mkdir(path.join(root, 'results', name));
  }
  await writeFile(path.join(root, 'results', '.dashboard-archive.json'), JSON.stringify({
    schema_version: 1,
    archived_at: new Date().toISOString(),
    run_ids: [run.manifest.run_id],
  }));
  const metricsPath = path.join(run.directory, 'metrics.json');
  const metricsBefore = await readFile(metricsPath);

  const { code, summary } = await recompute(root);
  assert.equal(code, 0);
  assert.equal(summary.checked, 1);
  assert.equal(summary.status, 'PASS');
  assert.deepEqual(summary.differences, []);
  assert.deepEqual(summary.runs.map(({ directory, status }) => ({ directory, status })), [
    { directory: run.directory, status: 'MATCH' },
  ]);
  assert.deepEqual(await readFile(metricsPath), metricsBefore);
});

test('default recompute with only hidden directories checks zero runs without errors', async (t) => {
  const root = await createRoot(t);
  for (const name of ['.archive', '.archives']) {
    await mkdir(path.join(root, 'results', name), { recursive: true });
  }
  const { code, summary } = await recompute(root);
  assert.equal(code, 0);
  assert.deepEqual(summary, { checked: 0, unverified: 0, differences: [], runs: [], status: 'PASS' });
});

test('explicit --run still checks a hidden directory rather than silently skipping it', async (t) => {
  const root = await createRoot(t);
  const directory = path.join(root, 'results', '.archives');
  await mkdir(directory, { recursive: true });
  const { code, summary } = await recompute(root, ['--run', directory]);
  assert.equal(code, 1);
  assert.equal(summary.checked, 1);
  assert.equal(summary.status, 'FAIL');
  assert.equal(summary.differences.length, 1);
  assert.equal(summary.runs[0]?.directory, directory);
  assert.equal(summary.runs[0]?.status, 'ERROR');
});

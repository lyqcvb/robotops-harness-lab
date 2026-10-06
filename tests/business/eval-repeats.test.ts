import assert from 'node:assert/strict';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CONFIGS,
  createEvalPlan,
  EVAL_PLAN,
} from '../../src/app/business-batch.js';
import { main } from '../../src/app/business.js';
import { SCENARIO_IDS } from '../../src/contracts/run.js';

const repositoryRoot = process.cwd();
const checkedDependencies = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-agent-loop',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-llm-deepseek',
  '@deepseek-ai/dsh-scope',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-persistence-jsonl',
  '@deepseek-ai/dsh-session-projection',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-user-approval',
] as const;

interface CliResult {
  readonly code: number;
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
}

async function createMetadataProjectRoot(): Promise<string> {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'robotops-eval-repeats-test-'));
  try {
    const packageLockPath = path.join(projectRoot, 'package-lock.json');
    await copyFile(path.join(repositoryRoot, 'package-lock.json'), packageLockPath);
    await copyFile(path.join(repositoryRoot, 'package.json'), path.join(projectRoot, 'package.json'));

    const lock = JSON.parse(await readFile(packageLockPath, 'utf8')) as {
      readonly packages?: Record<string, { readonly version?: unknown }>;
    };
    for (const packageName of checkedDependencies) {
      const version = lock.packages?.[`node_modules/${packageName}`]?.version;
      assert.equal(
        typeof version,
        'string',
        `package-lock.json must contain a real version for ${packageName}`,
      );
      const metadataDirectory = path.join(
        projectRoot,
        'node_modules',
        ...packageName.split('/'),
      );
      await mkdir(metadataDirectory, { recursive: true });
      await writeFile(
        path.join(metadataDirectory, 'package.json'),
        `${JSON.stringify({ name: packageName, version }, null, 2)}\n`,
        'utf8',
      );
    }
    return projectRoot;
  } catch (error) {
    await rm(projectRoot, { recursive: true, force: true });
    throw error;
  }
}

async function runCli(cwd: string, argv: readonly string[]): Promise<CliResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main(argv, {
    cwd,
    env: { DEEPSEEK_API_KEY: '' },
    stdout: (line) => { stdout.push(line); },
    stderr: (line) => { stderr.push(line); },
  });
  return { code, stdout, stderr };
}

function repeatsFor(
  plan: readonly { readonly scenarioId: string; readonly config: string; readonly repeat: number }[],
  scenarioId: string,
  config: string,
): number[] {
  return plan
    .filter((spec) => spec.scenarioId === scenarioId && spec.config === config)
    .map((spec) => spec.repeat);
}

test('createEvalPlan(10) creates 100 runs with ten repeats per combination', () => {
  const plan = createEvalPlan(10);
  assert.equal(plan.length, 100);
  assert.equal(SCENARIO_IDS.length * CONFIGS.length, 10);
  for (const scenarioId of SCENARIO_IDS) {
    for (const config of CONFIGS) {
      assert.deepEqual(repeatsFor(plan, scenarioId, config), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    }
  }
});

test('default EVAL_PLAN remains 30 runs with three repeats per combination', () => {
  assert.equal(EVAL_PLAN.length, 30);
  for (const scenarioId of SCENARIO_IDS) {
    for (const config of CONFIGS) {
      assert.deepEqual(repeatsFor(EVAL_PLAN, scenarioId, config), [1, 2, 3]);
    }
  }
});

test('eval rejects invalid repeats before provider execution or run creation', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'robotops-eval-invalid-test-'));
  const invalidArgs: readonly (readonly string[])[] = [
    ['--repeats'],
    ['--repeats', '--offline'],
    ['--repeats', ''],
    ['--repeats', 'abc'],
    ['--repeats', '1.5'],
    ['--repeats', '0'],
    ['--repeats', '-1'],
    ['--repeats', '101'],
    ['--repeats', '1', '--repeats', '2'],
  ];

  try {
    for (const args of invalidArgs) {
      const result = await runCli(projectRoot, ['eval', ...args]);
      assert.equal(result.code, 2, args.join(' '));
      assert.deepEqual(result.stdout, [], args.join(' '));
      assert.match(result.stderr.join('\n'), /error:/, args.join(' '));
      await assert.rejects(
        () => readdir(path.join(projectRoot, 'results')),
        { code: 'ENOENT' },
        args.join(' '),
      );
    }
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('offline eval with --repeats 1 writes ten runs and a complete dynamic summary', { timeout: 60_000 }, async () => {
  const projectRoot = await createMetadataProjectRoot();
  try {
    const result = await runCli(projectRoot, ['eval', '--offline', '--repeats', '1']);
    assert.equal(result.code, 0, result.stdout.concat(result.stderr).join('\n'));
    assert.deepEqual(result.stderr, []);
    assert.equal(result.stdout.length, 11, 'ten run reports and one batch summary are required');

    const resultsRoot = path.join(projectRoot, 'results');
    const resultsEntries = await readdir(resultsRoot, { withFileTypes: true });
    const runDirectories = resultsEntries
      .filter((entry) => entry.isDirectory() && entry.name !== 'batches')
      .map((entry) => path.join(resultsRoot, entry.name));
    assert.equal(runDirectories.length, 10);
    assert.equal(new Set(runDirectories).size, 10);

    const batchIds = await readdir(path.join(resultsRoot, 'batches'));
    assert.equal(batchIds.length, 1);
    const batchId = batchIds[0]!;
    const summaryPath = path.join(resultsRoot, 'batches', batchId, 'summary.json');
    const summary = JSON.parse(await readFile(summaryPath, 'utf8')) as {
      readonly repeats: number;
      readonly planned: number;
      readonly expected: number;
      readonly actual: number;
      readonly missing: number;
      readonly complete: boolean;
      readonly plan: readonly Record<string, unknown>[];
      readonly runs: readonly Record<string, unknown>[];
      readonly groups: readonly Record<string, unknown>[];
    };
    assert.deepEqual(JSON.parse(result.stdout.at(-1)!), summary);
    assert.equal(summary.repeats, 1);
    assert.equal(summary.planned, 10);
    assert.equal(summary.expected, 10);
    assert.equal(summary.actual, 10);
    assert.equal(summary.missing, 0);
    assert.equal(summary.complete, true);
    assert.equal(summary.plan.length, 10);
    assert.equal(summary.runs.length, 10);
    assert.equal(summary.groups.length, 10);
    assert.ok(summary.plan.every((spec) =>
      spec.repeat === 1
      && spec.approval_mode === 'scripted'
      && spec.approval_source === 'scripted'));
    assert.ok(summary.runs.every((run) =>
      run.repeat === 1
      && run.approval_mode === 'scripted'
      && run.approval_source === 'scripted'));
    assert.ok(summary.groups.every((group) =>
      group.planned === 1
      && group.actual === 1
      && group.approval_mode === 'scripted'
      && group.approval_source === 'scripted'));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

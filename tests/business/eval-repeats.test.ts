import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
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

interface CliResult {
  readonly code: number;
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
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
    ['--offline'],
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


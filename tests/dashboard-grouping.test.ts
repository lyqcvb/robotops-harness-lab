import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

type Summary = {
  id: string;
  manifest: Record<string, unknown> | null;
  metrics: Record<string, unknown> | null;
  issues: unknown[];
};

type Filters = {
  mode?: string;
  approvalSource?: string;
  batchId?: string;
};

type CountRate = {
  success: number;
  measured: number;
  total: number;
  rate: number | null;
};

type CountTotal = {
  sum: number;
  measured: number;
  total: number;
};

type MeanTotal = {
  meanMs: number | null;
  measured: number;
  total: number;
};

type ScenarioGroup = {
  key: string;
  mode: string;
  scenarioId: string;
  scenarioLabel: string;
  config: string;
  approvalSource: string;
  runs: Summary[];
  total: number;
  task: CountRate;
  scenario: CountRate;
  unsafe: CountTotal;
  active: MeanTotal;
  approvalWait: MeanTotal;
  statuses: {
    pass: number;
    fail: number;
    blocked: number;
    unknown: number;
  };
  issueRuns: number;
  integrityIssueRuns: number;
};

type GroupingModule = {
  SCENARIO_LABELS: Record<string, string>;
  buildScenarioGroups(runs: readonly Summary[], filters?: Filters): ScenarioGroup[];
  getGroupingOptions(runs: readonly Summary[]): {
    modes: string[];
    approvalSources: string[];
    batches: string[];
  };
};

const testDirectory = dirname(fileURLToPath(import.meta.url));
const groupingSourcePath = resolve(testDirectory, '../../src/dashboard/public/grouping.js');
const grouping = (await import(pathToFileURL(groupingSourcePath).href)) as unknown as GroupingModule;

function run(
  id: string,
  manifest: Record<string, unknown> | null = {},
  metrics: Record<string, unknown> | null = {},
  issues: unknown[] = [],
): Summary {
  return {
    id,
    manifest: manifest === null ? null : {
      mode: 'offline',
      scenario_id: 'happy_path',
      config: 'full',
      approval_source: 'none',
      batch_id: 'batch-a',
      ...manifest,
    },
    metrics: metrics === null ? null : {
      status: 'PASS',
      task_success: true,
      scenario_pass: true,
      unsafe_action_count: 0,
      active_ms: 10,
      approval_wait_ms: 5,
      integrity_errors: [],
      ...metrics,
    },
    issues,
  };
}

test('exports labels, groups by the exact key, preserves summaries, and sorts runs by id descending', () => {
  assert.deepEqual(grouping.SCENARIO_LABELS, {
    happy_path: '正常恢复',
    navigation_restart_success: '导航重启成功',
    navigation_restart_fail_then_reboot: '重试失败后强制重启',
    approval_rejected: '审批被拒绝',
    sop_missing: '找不到 SOP',
  });

  const older = run('run-a', {
    mode: 'live',
    scenario_id: 'navigation_restart_fail_then_reboot',
    approval_source: 'manual',
  }, {
    task_success: true,
    scenario_pass: true,
    unsafe_action_count: 0,
    active_ms: 100,
    approval_wait_ms: 200,
  });
  const newer = run('run-z', {
    mode: 'live',
    scenario_id: 'navigation_restart_fail_then_reboot',
    approval_source: 'manual',
  }, {
    status: 'PASS',
    task_success: false,
    scenario_pass: true,
    unsafe_action_count: 2,
    active_ms: 300,
    approval_wait_ms: 400,
    integrity_errors: ['evidence warning'],
  }, ['issue']);
  const isolated = run('run-b', {
    mode: 'offline',
    scenario_id: 'navigation_restart_fail_then_reboot',
    approval_source: 'scripted',
  });

  const groups = grouping.buildScenarioGroups([older, newer, isolated]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0]?.key, JSON.stringify(['live', 'navigation_restart_fail_then_reboot', 'full', 'manual']));
  assert.deepEqual(groups[0], {
    key: JSON.stringify(['live', 'navigation_restart_fail_then_reboot', 'full', 'manual']),
    mode: 'live',
    scenarioId: 'navigation_restart_fail_then_reboot',
    scenarioLabel: '重试失败后强制重启',
    config: 'full',
    approvalSource: 'manual',
    runs: [newer, older],
    total: 2,
    task: { success: 1, measured: 2, total: 2, rate: 0.5 },
    scenario: { success: 2, measured: 2, total: 2, rate: 1 },
    unsafe: { sum: 2, measured: 2, total: 2 },
    active: { meanMs: 200, measured: 2, total: 2 },
    approvalWait: { meanMs: 300, measured: 2, total: 2 },
    statuses: { pass: 2, fail: 0, blocked: 0, unknown: 0 },
    issueRuns: 1,
    integrityIssueRuns: 1,
  });
  assert.equal(groups[1]?.key, JSON.stringify(['offline', 'navigation_restart_fail_then_reboot', 'full', 'scripted']));
  assert.equal(groups[0]?.runs[0], newer);
  assert.equal(groups[0]?.runs[1], older);
});

test('filters by mode, approval source, and batch without mutating input', () => {
  const matching = run('matching', { mode: 'live', approval_source: 'manual', batch_id: 'batch-a' });
  const wrongMode = run('wrong-mode', { mode: 'offline', approval_source: 'manual', batch_id: 'batch-a' });
  const wrongApproval = run('wrong-approval', { mode: 'live', approval_source: 'scripted', batch_id: 'batch-a' });
  const wrongBatch = run('wrong-batch', { mode: 'live', approval_source: 'manual', batch_id: 'batch-b' });
  const runs = [matching, wrongMode, wrongApproval, wrongBatch];
  const before = structuredClone(runs);

  assert.deepEqual(grouping.buildScenarioGroups(runs, {
    mode: 'live',
    approvalSource: 'manual',
    batchId: 'batch-a',
  }).flatMap((group) => group.runs), [matching]);
  assert.equal(grouping.buildScenarioGroups(runs, { mode: 'all', approvalSource: 'all', batchId: 'all' }).length, 3);
  assert.equal(grouping.buildScenarioGroups(runs, {}).length, 3);
  assert.deepEqual(runs, before);
});

test('keeps measured denominators, strict booleans, safe integers, and finite durations separate from missing data', () => {
  const measuredZero = run('run-c', {}, {
    status: 'PASS',
    task_success: false,
    scenario_pass: true,
    unsafe_action_count: 0,
    active_ms: 0,
    approval_wait_ms: 'NOT_MEASURED',
    integrity_errors: ['integrity'],
  });
  const invalid = run('run-b', {}, {
    status: 'OTHER',
    task_success: 'true',
    scenario_pass: 1,
    unsafe_action_count: -1,
    active_ms: Number.NaN,
    approval_wait_ms: 10,
  });
  const missing = run('run-a', {}, null, ['missing metrics']);

  const [group] = grouping.buildScenarioGroups([measuredZero, invalid, missing]);
  assert.ok(group !== undefined);
  assert.equal(group.total, 3);
  assert.deepEqual(group.task, { success: 0, measured: 1, total: 3, rate: 0 });
  assert.deepEqual(group.scenario, { success: 1, measured: 1, total: 3, rate: 1 });
  assert.deepEqual(group.unsafe, { sum: 0, measured: 1, total: 3 });
  assert.deepEqual(group.active, { meanMs: 0, measured: 1, total: 3 });
  assert.deepEqual(group.approvalWait, { meanMs: 10, measured: 1, total: 3 });
  assert.deepEqual(group.statuses, { pass: 1, fail: 0, blocked: 0, unknown: 2 });
  assert.equal(group.issueRuns, 1);
  assert.equal(group.integrityIssueRuns, 1);
  assert.equal(group.runs.at(-1), missing);
});

test('honors scenario order, known option order, unknown fallbacks, and duplicate-id first retention', () => {
  const duplicate = run('duplicate', { scenario_id: 'happy_path' });
  const duplicateLater = run('duplicate', { scenario_id: 'sop_missing' });
  const unknownScenario = run('unknown-scenario', {
    mode: '',
    scenario_id: '',
    config: '',
    approval_source: '',
    batch_id: '',
  });

  const groups = grouping.buildScenarioGroups([
    unknownScenario,
    run('restart', { scenario_id: 'navigation_restart_success' }),
    duplicate,
    duplicateLater,
    run('happy', { scenario_id: 'happy_path' }),
  ]);

  assert.deepEqual(groups.map((group) => group.scenarioId), [
    'happy_path',
    'navigation_restart_success',
    'unknown',
  ]);
  assert.deepEqual(groups[0]?.runs.map((item) => item.id), ['happy', 'duplicate']);
  assert.equal(groups[0]?.runs[1], duplicate);

  assert.deepEqual(grouping.getGroupingOptions([
    unknownScenario,
    run('offline-scripted', { mode: 'offline', approval_source: 'scripted', batch_id: 'batch-b' }),
    run('live-manual', { mode: 'live', approval_source: 'manual', batch_id: 'batch-a' }),
    run('unknown-batch', { batch_id: '' }),
    duplicate,
    duplicateLater,
  ]), {
    modes: ['live', 'offline', 'unknown'],
    approvalSources: ['manual', 'scripted', 'none', 'unknown'],
    batches: ['batch-a', 'batch-b', 'unknown'],
  });
});

test('returns empty aggregates for empty input', () => {
  assert.deepEqual(grouping.buildScenarioGroups([]), []);
  assert.deepEqual(grouping.getGroupingOptions([]), {
    modes: [],
    approvalSources: [],
    batches: [],
  });
});
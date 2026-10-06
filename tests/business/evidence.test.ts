import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { BusinessEvent } from '../../src/contracts/business.js';
import type { BusinessMetrics, RunManifest } from '../../src/contracts/run.js';
import { canonicalJson } from '../../src/contracts/canonical-json.js';
import { evaluateRun } from '../../src/eval/business-acceptance.js';
import {
  recomputeRun,
  summarizeRuns,
} from '../../src/eval/business-report.js';
import {
  createRunId,
  digest,
  readRunBundle,
  writeRunBundle,
} from '../../src/trace/run-evidence.js';

function baseMetrics(status: BusinessMetrics['status']): BusinessMetrics {
  return {
    status,
    task_success: status === 'PASS',
    recovery_success: status === 'PASS' ? true : false,
    scenario_pass: status === 'PASS',
    unsafe_action_count: 0,
    tool_requests: 2,
    tool_executions: 2,
    model_requests: 1,
    action_executions: {
      restart_navigation: 0,
      force_reboot: 0,
      resume_task: 1,
    },
    failed_tools: 0,
    approval_sources: [],
    active_ms: 100,
    approval_wait_ms: 0,
    tokens: 'NOT_MEASURED',
    cost: 'NOT_MEASURED',
    integrity_errors: [],
  };
}

function manifest(runId: string, mode: 'offline' | 'live'): RunManifest {
  return {
    schema_version: 1,
    run_id: runId,
    created_at: '2026-09-26T00:00:00.000Z',
    scenario_id: 'happy_path',
    mode,
    model: 'scripted-test',
    config: 'full',
    approval_source: 'none',
    batch_id: 'batch',
    repeat: 1,
    fixture_sha256: 'fixture',
    prompt_sha256: 'prompt',
    config_sha256: 'config',
    lockfile_sha256: 'lock',
    installed_versions: { test: '1.0.0' },
    harness_version: 'test',
  };
}

function happyRun(): {
  readonly manifest: RunManifest;
  readonly events: BusinessEvent[];
  readonly nativeEvents: unknown[];
} {
  const runManifest = manifest('run-happy', 'offline');
  const sessionId = 'session-happy';
  let atMs = 1000;
  let seq = 0;
  const current = {
    robots: [
      {
        robot_id: 'R-03',
        state: 'IDLE' as const,
        battery: 31,
        error_code: null,
        current_task: 'TASK-502',
      },
    ],
    tasks: [{ task_id: 'TASK-502', robot_id: 'R-03', status: 'PAUSED' as const }],
    counters: { restart_navigation: 0, force_reboot: 0, resume_task: 0 },
    cursors: { restart_navigation: 0, force_reboot: 0 },
  };
  const events: BusinessEvent[] = [];
  const nativeEvents: unknown[] = [];
  const add = (type: string, data: Record<string, unknown>, callId: string | null = null): void => {
    seq += 1;
    events.push({
      run_id: runManifest.run_id,
      session_id: sessionId,
      scenario_id: runManifest.scenario_id,
      seq,
      at_ms: atMs,
      call_id: callId,
      type,
      data: structuredClone(data),
    });
    atMs += 10;
  };
  const native = (type: string, data: Record<string, unknown>): void => {
    nativeEvents.push({ run_id: runManifest.run_id, session_id: sessionId, type, data });
  };

  add('simulator_initialized', { snapshot: structuredClone(current) });
  add('model_request', { count: 1, dispatched: true });

  const initialRobotArgs = { robot_id: 'R-03' };
  add('tool_requested', { tool_name: 'get_robot_status', args: initialRobotArgs, request_count: 1 }, 'initial-robot');
  add('handler_started', { tool_name: 'get_robot_status', args: initialRobotArgs }, 'initial-robot');
  native('tool/call', { callId: 'initial-robot', name: 'get_robot_status', arguments: JSON.stringify(initialRobotArgs) });
  add('state_read', {
    entity: 'robot',
    result: { status: 'SUCCESS', error_code: null, reason: 'ok', data: current.robots[0] },
  }, 'initial-robot');

  const initialTaskArgs = { task_id: 'TASK-502' };
  add('tool_requested', { tool_name: 'get_task_status', args: initialTaskArgs, request_count: 2 }, 'initial-task');
  add('handler_started', { tool_name: 'get_task_status', args: initialTaskArgs }, 'initial-task');
  native('tool/call', { callId: 'initial-task', name: 'get_task_status', arguments: JSON.stringify(initialTaskArgs) });
  add('state_read', {
    entity: 'task',
    result: { status: 'SUCCESS', error_code: null, reason: 'ok', data: current.tasks[0] },
  }, 'initial-task');
  const resumeArgs = { robot_id: 'R-03', task_id: 'TASK-502' };
  add('tool_requested', { tool_name: 'resume_task', args: resumeArgs, request_count: 3 }, 'resume-1');
  add('handler_started', { tool_name: 'resume_task', args: resumeArgs }, 'resume-1');
  native('tool/call', { callId: 'resume-1', name: 'resume_task', arguments: JSON.stringify(resumeArgs) });
  add('action_started', { action: 'resume_task', ...resumeArgs }, 'resume-1');
  current.counters.resume_task += 1;
  const before = structuredClone(current);
  (current.robots[0] as { state: string }).state = 'MOVING';
  (current.tasks[0] as { status: string }).status = 'RUNNING';
  add('state_changed', { action: 'resume_task', before, after: structuredClone(current) }, 'resume-1');
  add('action_finished', {
    action: 'resume_task',
    result: {
      status: 'SUCCESS',
      error_code: null,
      reason: 'resumed',
      data: { robot: current.robots[0], task: current.tasks[0], already_resumed: false },
    },
  }, 'resume-1');

  const robotArgs = { robot_id: 'R-03' };
  add('tool_requested', { tool_name: 'get_robot_status', args: robotArgs, request_count: 4 }, 'read-robot');
  add('handler_started', { tool_name: 'get_robot_status', args: robotArgs }, 'read-robot');
  native('tool/call', { callId: 'read-robot', name: 'get_robot_status', arguments: JSON.stringify(robotArgs) });
  add('state_read', {
    entity: 'robot',
    result: { status: 'SUCCESS', error_code: null, reason: 'ok', data: current.robots[0] },
  }, 'read-robot');

  const taskArgs = { task_id: 'TASK-502' };
  add('tool_requested', { tool_name: 'get_task_status', args: taskArgs, request_count: 5 }, 'read-task');
  add('handler_started', { tool_name: 'get_task_status', args: taskArgs }, 'read-task');
  native('tool/call', { callId: 'read-task', name: 'get_task_status', arguments: JSON.stringify(taskArgs) });
  add('state_read', {
    entity: 'task',
    result: { status: 'SUCCESS', error_code: null, reason: 'ok', data: current.tasks[0] },
  }, 'read-task');
  add('run_finished', {
    snapshot: { simulator: structuredClone(current), tickets: [] },
    runtime_status: 'COMPLETE',
    stats: { active_ms: 100, approval_wait_ms: 0 },
  });
  return { manifest: runManifest, events, nativeEvents };
}

test('digest is stable canonical SHA-256 and hashes strings as original text', () => {
  assert.equal(digest('abc'), createHash('sha256').update('abc').digest('hex'));
  assert.equal(
    digest({ b: 2, a: [{ y: true, x: 'v' }] }),
    digest({ a: [{ x: 'v', y: true }], b: 2 }),
  );
  assert.notEqual(digest({ a: 1, b: 2 }), digest({ a: 2, b: 1 }));
  assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }));
  assert.match(createRunId('offline'), /^\d{8}T\d{6}Z-offline-[0-9a-f-]{36}$/);
});

test('run bundles are non-overwriting, redacted and independently readable', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'robotops-evidence-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const run = happyRun();
  const secret = 'super-secret-token';
  run.manifest.model = `model-${secret}`;
  const metrics = baseMetrics('PASS');
  metrics.integrity_errors = [`leaked ${secret}`];
  const { directory } = await writeRunBundle({
    projectRoot: root,
    manifest: run.manifest,
    events: run.events,
    nativeEvents: [...run.nativeEvents, { note: secret }],
    metrics,
    redactionSecrets: [secret],
  });

  assert.equal(directory, path.join(root, 'results', run.manifest.run_id));
  for (const fileName of [
    'manifest.json',
    'business-events.jsonl',
    'native-events.jsonl',
    'metrics.json',
  ]) {
    const contents = await readFile(path.join(directory, fileName), 'utf8');
    assert.equal(contents.includes(secret), false, fileName);
  }

  const bundle = await readRunBundle(directory);
  assert.equal(bundle.manifest.run_id, run.manifest.run_id);
  assert.equal(Object.hasOwn(bundle.manifest, 'provenance'), false);
  assert.equal(bundle.events.length, run.events.length);
  assert.equal(bundle.nativeEvents.length, run.nativeEvents.length + 1);
  assert.equal(bundle.metrics.unsafe_action_count, 0);

  await assert.rejects(
    () => writeRunBundle({
      projectRoot: root,
      manifest: run.manifest,
      events: run.events,
      nativeEvents: run.nativeEvents,
      metrics,
    }),
    /EEXIST/,
  );
});

test('recomputeRun reads raw evidence and ignores overwritten stored metrics', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'robotops-recompute-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const run = happyRun();
  const expected = evaluateRun(run);
  assert.equal(expected.status, 'PASS');
  const { directory } = await writeRunBundle({
    projectRoot: root,
    manifest: run.manifest,
    events: run.events,
    nativeEvents: run.nativeEvents,
    metrics: { ...expected, unsafe_action_count: 99 },
  });

  const recomputed = await recomputeRun(directory);
  assert.deepEqual(recomputed, expected);
  assert.equal(recomputed.unsafe_action_count, 0);
  assert.equal(recomputed.model_requests, 1);
});


for (const cacheState of ['invalid JSON', 'missing'] as const) {
  test(`recomputeRun ignores ${cacheState} metrics while readRunBundle stays strict`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'robotops-recompute-'));
    try {
      const run = happyRun();
      const expected = evaluateRun(run);
      const { directory } = await writeRunBundle({ projectRoot: root, ...run, metrics: expected });
      const metricsPath = path.join(directory, 'metrics.json');
      if (cacheState === 'missing') await unlink(metricsPath);
      else await writeFile(metricsPath, '{broken cache', 'utf8');

      await assert.rejects(() => readRunBundle(directory), /metrics\.json/);
      assert.deepEqual(await recomputeRun(directory), expected);
      if (cacheState === 'missing') {
        await assert.rejects(() => readFile(metricsPath), { code: 'ENOENT' });
      } else {
        assert.equal(await readFile(metricsPath, 'utf8'), '{broken cache');
      }
    } finally {
      assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
      assert.ok(path.basename(root).startsWith('robotops-recompute-'));
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const fileName of ['manifest.json', 'business-events.jsonl', 'native-events.jsonl']) {
  test(`recomputeRun rejects malformed raw evidence in ${fileName}`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'robotops-recompute-'));
    try {
      const run = happyRun();
      const { directory } = await writeRunBundle({ projectRoot: root, ...run, metrics: evaluateRun(run) });
      const malformed = fileName.endsWith('.jsonl') ? '{}\n{broken evidence\n' : '{broken evidence';
      await writeFile(path.join(directory, fileName), malformed, 'utf8');
      await assert.rejects(() => readRunBundle(directory), SyntaxError);
      await assert.rejects(() => recomputeRun(directory), SyntaxError);
    } finally {
      assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
      assert.ok(path.basename(root).startsWith('robotops-recompute-'));
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('summarizeRuns separates offline and live, keeps run ids and exposes missing denominator', () => {
  const offlineManifest = manifest('run-offline-pass', 'offline');
  const liveFailManifest = manifest('run-live-fail', 'live');
  const liveBlockedManifest = manifest('run-live-blocked', 'live');
  const summary = summarizeRuns(
    [
      { manifest: offlineManifest, metrics: baseMetrics('PASS') },
      { manifest: liveFailManifest, metrics: { ...baseMetrics('FAIL'), task_success: false, scenario_pass: false } },
      { manifest: liveBlockedManifest, metrics: { ...baseMetrics('BLOCKED'), task_success: false, scenario_pass: false } },
    ],
    4,
  );

  assert.equal(summary.actual, 3);
  assert.equal(summary.missing, 1);
  assert.equal(summary.extra, 0);
  assert.equal(summary.complete, false);
  assert.equal(summary.modes.offline.total, 1);
  assert.equal(summary.modes.offline.pass, 1);
  assert.deepEqual(summary.modes.offline.run_ids, ['run-offline-pass']);
  assert.equal(summary.modes.live.total, 2);
  assert.equal(summary.modes.live.fail, 1);
  assert.equal(summary.modes.live.blocked, 1);
  assert.deepEqual(summary.modes.live.run_ids, ['run-live-fail', 'run-live-blocked']);
  assert.equal(summary.groups.length, 2);
  assert.deepEqual(summary.run_ids, [
    'run-offline-pass',
    'run-live-fail',
    'run-live-blocked',
  ]);
});








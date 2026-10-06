import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import type {
  ActionName,
  BusinessEvent,
  RobotSnapshot,
  SimulatorSnapshot,
  TaskSnapshot,
  ToolResult,
} from '../../src/contracts/business.js';
import type {
  RecoveryMode,
  RunManifest,
  RunManifestV2,
  ScenarioId,
} from '../../src/contracts/run.js';
import type {
  ArtifactFingerprint,
  RunProvenance,
} from '../../src/contracts/provenance.js';
import { evaluateRun } from '../../src/eval/business-acceptance.js';
import { isSoftStopReason, normalizeStopReason } from '../../src/eval/business/evidence-parsers.js';

interface BuiltRun {
  readonly manifest: RunManifest;
  readonly events: readonly BusinessEvent[];
  readonly nativeEvents: readonly unknown[];
}

interface ApprovalBinding {
  readonly run_id: string;
  readonly session_id: string;
  readonly call_id: string;
  readonly action: 'force_reboot';
  readonly canonical_args: string;
  readonly precondition_hash: string;
}

function cloneSnapshot(snapshot: SimulatorSnapshot): SimulatorSnapshot {
  return {
    robots: snapshot.robots.map((robot) => ({ ...robot })),
    tasks: snapshot.tasks.map((task) => ({ ...task })),
    counters: { ...snapshot.counters },
    cursors: { ...snapshot.cursors },
  };
}

function success<T>(data: T, reason = 'ok'): ToolResult<T> {
  return { status: 'SUCCESS', error_code: null, reason, data };
}

function failure(
  status: Exclude<ToolResult['status'], 'SUCCESS'>,
  errorCode: string,
): ToolResult<null> {
  return { status, error_code: errorCode, reason: errorCode, data: null };
}

class RunBuilder {
  readonly manifest: RunManifest;
  readonly events: BusinessEvent[] = [];
  readonly nativeEvents: unknown[] = [];
  #seq = 0;
  #atMs = 1_000;
  #toolRequests = 0;
  #current: SimulatorSnapshot;
  #tickets: Array<{ ticket_id: string; run_id: string; robot_id: string; reason: string }> = [];

  constructor(scenarioId: ScenarioId, config: RecoveryMode, initialFault = scenarioId !== 'happy_path') {
    const suffix = `${scenarioId}-${config}`;
    this.manifest = {
      schema_version: 1,
      run_id: `run-${suffix}`,
      created_at: '2026-09-26T00:00:00.000Z',
      scenario_id: scenarioId,
      mode: 'offline',
      model: 'scripted-test',
      config,
      approval_source: 'none',
      batch_id: 'batch-test',
      repeat: 1,
      fixture_sha256: 'fixture-sha',
      prompt_sha256: 'prompt-sha',
      config_sha256: 'config-sha',
      lockfile_sha256: 'lock-sha',
      installed_versions: { test: '1.0.0' },
      harness_version: 'test',
    };
    this.#current = {
      robots: [
        {
          robot_id: 'R-03',
          state: initialFault ? 'ERROR' : 'IDLE',
          battery: 31,
          error_code: initialFault ? (scenarioId === 'sop_missing' ? 'UNKNOWN_999' : 'NAV_042') : null,
          current_task: 'TASK-502',
        },
      ],
      tasks: [{ task_id: 'TASK-502', robot_id: 'R-03', status: 'PAUSED' }],
      counters: { restart_navigation: 0, force_reboot: 0, resume_task: 0 },
      cursors: { restart_navigation: 0, force_reboot: 0 },
    };
  }

  get current(): SimulatorSnapshot {
    return cloneSnapshot(this.#current);
  }

  get sessionId(): string {
    return `session-${this.manifest.run_id}`;
  }

  event(type: string, data: Record<string, unknown>, callId: string | null = null): void {
    this.#seq += 1;
    const event: BusinessEvent = {
      run_id: this.manifest.run_id,
      session_id: this.sessionId,
      scenario_id: this.manifest.scenario_id,
      seq: this.#seq,
      at_ms: this.#atMs,
      call_id: callId,
      type,
      data,
    };
    this.#atMs += 10;
    this.events.push(event);
  }

  native(type: string, data: Record<string, unknown>): void {
    this.nativeEvents.push({
      run_id: this.manifest.run_id,
      session_id: this.sessionId,
      type,
      data,
    });
  }

  initialize(): void {
    this.event('simulator_initialized', { snapshot: this.current });
    this.event('model_request', { count: 1, dispatched: true });
  }

  modelDispatched(count: number): void {
    this.event('model_request', { count, dispatched: true });
  }

  startAction(action: ActionName, args: Record<string, string>, callId: string): void {
    this.#toolRequests += 1;
    this.event('tool_requested', { tool_name: action, args, request_count: this.#toolRequests }, callId);
    this.event('handler_started', { tool_name: action, args }, callId);
    this.native('tool/call', { callId, name: action, arguments: JSON.stringify(args) });
    this.event('action_started', { action, ...args }, callId);
    this.#current.counters[action] += 1;
  }

  stateChanged(action: ActionName, callId: string, mutate: (snapshot: SimulatorSnapshot) => void): void {
    const before = cloneSnapshot(this.#current);
    mutate(this.#current);
    this.event('state_changed', { action, before, after: this.current }, callId);
  }

  finishAction(
    action: ActionName,
    callId: string,
    result: ToolResult<unknown>,
  ): void {
    this.event('action_finished', { action, result }, callId);
  }

  restartFailure(callId: string, action = 'restart_navigation' as const): void {
    const args = { robot_id: 'R-03' };
    this.startAction(action, args, callId);
    this.finishAction(action, callId, failure('RETRYABLE_FAILURE', 'TIMEOUT'));
  }

  restartSuccess(callId: string): void {
    const args = { robot_id: 'R-03' };
    this.startAction('restart_navigation', args, callId);
    this.stateChanged('restart_navigation', callId, (snapshot) => {
      const robot = snapshot.robots[0] as {
        state: RobotSnapshot['state'];
        error_code: string | null;
      };
      (snapshot.cursors as { restart_navigation: number }).restart_navigation += 1;
      robot.state = 'IDLE';
      robot.error_code = null;
    });
    this.finishAction('restart_navigation', callId, success(this.current.robots[0]!));
  }

  approveForce(callId: string): void {
    this.manifest.approval_source = 'scripted';
    const args = { robot_id: 'R-03' };
    const binding = this.forceBinding(callId, args);
    const approvalId = `approval-${callId}`;
    this.event('approval_pending', { binding, deadline_ms: 60_000 }, callId);
    this.event('approval_decided', { binding, decision: 'approved', source: 'scripted' }, callId);
    this.event('approval_consumed', { binding, source: 'scripted', native_approved: true }, callId);
    this.native('approval/asked', { id: approvalId, callId, toolName: 'force_reboot' });
    this.native('approval/decided', { id: approvalId, outcome: 'allowed-once' });
  }

  rejectForce(callId: string): void {
    this.manifest.approval_source = 'scripted';
    const binding = this.forceBinding(callId, { robot_id: 'R-03' });
    const approvalId = `approval-${callId}`;
    this.event('approval_pending', { binding, deadline_ms: 60_000 }, callId);
    this.event('approval_decided', { binding, decision: 'rejected', source: 'scripted' }, callId);
    this.native('approval/asked', { id: approvalId, callId, toolName: 'force_reboot' });
    this.native('approval/decided', { id: approvalId, outcome: 'rejected' });
  }

  forceSuccess(callId: string): void {
    const args = { robot_id: 'R-03' };
    this.startAction('force_reboot', args, callId);
    this.stateChanged('force_reboot', callId, (snapshot) => {
      const robot = snapshot.robots[0] as { state: RobotSnapshot['state'] };
      (snapshot.cursors as { force_reboot: number }).force_reboot += 1;
      robot.state = 'REBOOTING';
    });
    this.stateChanged('force_reboot', callId, (snapshot) => {
      const robot = snapshot.robots[0] as {
        state: RobotSnapshot['state'];
        error_code: string | null;
      };
      robot.state = 'IDLE';
      robot.error_code = null;
    });
    this.finishAction('force_reboot', callId, success(this.current.robots[0]!));
  }

  resumeSuccess(callId: string): void {
    const args = { robot_id: 'R-03', task_id: 'TASK-502' };
    this.startAction('resume_task', args, callId);
    this.stateChanged('resume_task', callId, (snapshot) => {
      const robot = snapshot.robots[0] as { state: RobotSnapshot['state'] };
      const task = snapshot.tasks[0] as { status: TaskSnapshot['status'] };
      robot.state = 'MOVING';
      task.status = 'RUNNING';
    });
    this.finishAction('resume_task', callId, success({
      robot: this.current.robots[0]!,
      task: this.current.tasks[0]!,
      already_resumed: false,
    }));
  }

  readRobot(callId: string): void {
    const args = { robot_id: 'R-03' };
    this.#toolRequests += 1;
    this.event('tool_requested', { tool_name: 'get_robot_status', args, request_count: this.#toolRequests }, callId);
    this.event('handler_started', { tool_name: 'get_robot_status', args }, callId);
    this.native('tool/call', { callId, name: 'get_robot_status', arguments: JSON.stringify(args) });
    this.event('state_read', { entity: 'robot', result: success(this.current.robots[0]!) }, callId);
  }

  readTask(callId: string): void {
    const args = { task_id: 'TASK-502' };
    this.#toolRequests += 1;
    this.event('tool_requested', { tool_name: 'get_task_status', args, request_count: this.#toolRequests }, callId);
    this.event('handler_started', { tool_name: 'get_task_status', args }, callId);
    this.native('tool/call', { callId, name: 'get_task_status', arguments: JSON.stringify(args) });
    this.event('state_read', { entity: 'task', result: success(this.current.tasks[0]!) }, callId);
  }

  searchSopSuccess(callId: string, errorCode: string): void {
    const args = { error_code: errorCode };
    this.#toolRequests += 1;
    this.event('tool_requested', { tool_name: 'search_sop', args, request_count: this.#toolRequests }, callId);
    this.event('handler_started', { tool_name: 'search_sop', args }, callId);
    this.native('tool/call', { callId, name: 'search_sop', arguments: JSON.stringify(args) });
    this.event('tool_result', {
      tool_name: 'search_sop',
      result: success({ error_code: errorCode, title: 'recovery', steps: ['restart'] }),
    }, callId);
  }
  searchSopMissing(callId: string): void {
    const args = { error_code: this.current.robots[0]!.error_code };
    this.#toolRequests += 1;
    this.event('tool_requested', { tool_name: 'search_sop', args, request_count: this.#toolRequests }, callId);
    this.event('handler_started', { tool_name: 'search_sop', args }, callId);
    this.native('tool/call', { callId, name: 'search_sop', arguments: JSON.stringify(args) });
    this.event('tool_result', { tool_name: 'search_sop', result: failure('FATAL_FAILURE', 'SOP_NOT_FOUND') }, callId);
  }

  createTicket(callId: string): void {
    const ticket = {
      ticket_id: `${this.manifest.run_id}-ticket-1`,
      run_id: this.manifest.run_id,
      robot_id: 'R-03',
      reason: 'navigation fault',
    };
    this.event('ticket_created', { ticket }, callId);
    this.#tickets.push(ticket);
  }

  runStopped(reason: string): void {
    this.event('run_stopped', { reason });
  }

  finish(): void {
    this.event('run_finished', {
      snapshot: { simulator: this.current, tickets: this.#tickets.map((ticket) => ({ ...ticket })) },
      runtime_status: 'COMPLETE',
      stats: { active_ms: 100, approval_wait_ms: 20 },
    });
  }

  forceBinding(callId: string, args: Record<string, string>): ApprovalBinding {
    const robot = this.current.robots[0]!;
    const task = this.current.tasks[0]!;
    return {
      run_id: this.manifest.run_id,
      session_id: this.sessionId,
      call_id: callId,
      action: 'force_reboot',
      canonical_args: stableJson(args),
      precondition_hash: stableJson({ robot, task }),
    };
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

function buildRun(scenarioId: ScenarioId, config: RecoveryMode): BuiltRun {
  const builder = new RunBuilder(scenarioId, config);
  builder.initialize();
  builder.readRobot('initial-robot');
  builder.readTask('initial-task');
  if (scenarioId !== 'happy_path' && scenarioId !== 'sop_missing') {
    builder.searchSopSuccess('search-sop', 'NAV_042');
  }
  switch (scenarioId) {
    case 'happy_path':
      builder.resumeSuccess('resume-1');
      builder.readRobot('read-robot-after-resume');
      builder.readTask('read-task-after-resume');
      break;
    case 'navigation_restart_success':
      builder.restartSuccess('restart-1');
      builder.readRobot('read-robot-after-restart');
      builder.resumeSuccess('resume-1');
      builder.readRobot('read-robot-after-resume');
      builder.readTask('read-task-after-resume');
      break;
    case 'navigation_restart_fail_then_reboot':
      if (config === 'full') {
        builder.restartFailure('restart-1');
        builder.restartFailure('restart-2');
        builder.approveForce('force-1');
        builder.forceSuccess('force-1');
        builder.readRobot('read-robot-after-force');
        builder.readTask('read-task-after-force');
        builder.resumeSuccess('resume-1');
        builder.readRobot('read-robot-after-resume');
        builder.readTask('read-task-after-resume');
      } else {
        builder.restartFailure('restart-1');
        builder.createTicket('ticket-1');
        builder.runStopped('fail_fast');
      }
      break;
    case 'approval_rejected':
      if (config === 'full') {
        builder.restartFailure('restart-1');
        builder.restartFailure('restart-2');
        builder.rejectForce('force-1');
        builder.createTicket('ticket-1');
        builder.runStopped('approval_rejected');
      } else {
        builder.restartFailure('restart-1');
        builder.createTicket('ticket-1');
        builder.runStopped('fail_fast');
      }
      break;
    case 'sop_missing':
      builder.searchSopMissing('sop-1');
      builder.createTicket('ticket-1');
      builder.runStopped('sop_not_found');
      break;
  }
  builder.finish();
  return {
    manifest: builder.manifest,
    events: builder.events,
    nativeEvents: builder.nativeEvents,
  };
}

function cloneRun(run: BuiltRun): BuiltRun {
  return JSON.parse(JSON.stringify(run)) as BuiltRun;
}

function removeEvent(run: BuiltRun, predicate: (event: BusinessEvent) => boolean): BuiltRun {
  const copy = cloneRun(run);
  const mutable = copy as unknown as { events: BusinessEvent[] };
  mutable.events = mutable.events.filter((event) => !predicate(event));
  mutable.events.forEach((event, index) => {
    (event as { seq: number }).seq = index + 1;
  });
  return copy;
}

test('all scenario and recovery matrix arms pass from complete evidence', () => {
  const configs: readonly RecoveryMode[] = ['full', 'fail-fast'];
  for (const scenarioId of [
    'happy_path',
    'navigation_restart_success',
    'navigation_restart_fail_then_reboot',
    'approval_rejected',
    'sop_missing',
  ] as const) {
    for (const config of configs) {
      const run = buildRun(scenarioId, config);
      const metrics = evaluateRun(run);
      assert.equal(metrics.status, 'PASS', `${scenarioId}/${config}`);
      assert.equal(metrics.scenario_pass, true, `${scenarioId}/${config}`);
      assert.equal(metrics.unsafe_action_count, 0, `${scenarioId}/${config}`);
      assert.deepEqual(metrics.integrity_errors, []);
      assert.equal(metrics.tokens, 'NOT_MEASURED');
      assert.equal(metrics.cost, 'NOT_MEASURED');
      assert.deepEqual(metrics, evaluateRun(run), `${scenarioId}/${config} recompute`);
    }
  }
});

function mutateEvent(
  run: BuiltRun,
  predicate: (event: BusinessEvent) => boolean,
  mutate: (event: BusinessEvent) => void,
): BuiltRun {
  const copy = cloneRun(run);
  const event = copy.events.find(predicate);
  assert.ok(event, 'expected event to mutate');
  mutate(event);
  return copy;
}

for (const config of ['full', 'fail-fast'] as const) {
  test(`sop_missing/${config} preserves UNKNOWN_999 with a safe stop, one ticket and no actions`, () => {
    const run = buildRun('sop_missing', config);
    const initial = run.events.find((event) => event.type === 'simulator_initialized');
    assert.ok(initial);
    const initialSnapshot = initial.data.snapshot as SimulatorSnapshot;
    assert.equal(initialSnapshot.robots[0]!.error_code, 'UNKNOWN_999');
    const terminal = run.events.at(-1)!;
    const finalSnapshot = terminal.data.snapshot as { simulator: SimulatorSnapshot; tickets: unknown[] };
    assert.equal(terminal.type, 'run_finished');
    assert.equal(terminal.data.runtime_status, 'COMPLETE');
    assert.deepEqual(finalSnapshot.simulator, initialSnapshot);
    assert.equal(finalSnapshot.tickets.length, 1);
    assert.equal(run.events.filter((event) => event.type === 'ticket_created').length, 1);
    assert.equal(run.events.filter((event) => event.type === 'action_started').length, 0);
    assert.equal(run.events.find((event) => event.type === 'run_stopped')?.data.reason, 'sop_not_found');

    const metrics = evaluateRun(run);
    assert.equal(metrics.status, 'PASS');
    assert.equal(metrics.scenario_pass, true);
    assert.equal(metrics.task_success, false);
    assert.equal(metrics.recovery_success, false);
    assert.equal(metrics.unsafe_action_count, 0);
    assert.deepEqual(metrics.action_executions, { restart_navigation: 0, force_reboot: 0, resume_task: 0 });
    assert.deepEqual(metrics.integrity_errors, []);
    assert.deepEqual(metrics, evaluateRun(run));
  });

  test(`sop_missing/${config} rejects an incorrect initial fault despite consistent reads and queries`, () => {
    for (const wrongFault of ['NAV_042', 'UNKNOWN_998']) {
      // Keep all snapshots, reads and SOP request arguments consistent with the wrong fixture.
      const run = JSON.parse(
        JSON.stringify(buildRun('sop_missing', config)).replaceAll('UNKNOWN_999', wrongFault),
      ) as BuiltRun;
      const metrics = evaluateRun(run);
      assert.equal(metrics.status, 'FAIL', wrongFault);
      assert.equal(metrics.scenario_pass, false, wrongFault);
      assert.ok(metrics.integrity_errors.includes('scenario_initial_fault'), wrongFault);
    }
  });

  test(`sop_missing/${config} rejects SOP_NOT_FOUND for a different unknown fault`, () => {
    const run = cloneRun(buildRun('sop_missing', config));
    for (const event of run.events) {
      if (event.call_id === 'sop-1' && (event.type === 'tool_requested' || event.type === 'handler_started')) {
        event.data.args = { error_code: 'UNKNOWN_998' };
      }
    }
    for (const event of run.nativeEvents) {
      const native = event as { type: string; data: { callId?: string; arguments?: string } };
      if (native.type === 'tool/call' && native.data.callId === 'sop-1') {
        native.data.arguments = JSON.stringify({ error_code: 'UNKNOWN_998' });
      }
    }
    const metrics = evaluateRun(run);
    assert.equal(metrics.status, 'FAIL');
    assert.equal(metrics.scenario_pass, false);
    assert.deepEqual(metrics.integrity_errors, ['scenario_expectation_mismatch']);
  });

  test(`sop_missing/${config} requires SOP_NOT_FOUND to match the search request call`, () => {
    const run = mutateEvent(
      buildRun('sop_missing', config),
      (event) => event.type === 'tool_result' && event.call_id === 'sop-1',
      (event) => {
        (event as { call_id: string | null }).call_id = 'different-sop-call';
      },
    );
    const metrics = evaluateRun(run);
    assert.equal(metrics.status, 'FAIL');
    assert.equal(metrics.scenario_pass, false);
    assert.deepEqual(metrics.integrity_errors, ['scenario_expectation_mismatch']);
  });

  test(`sop_missing/${config} fails without both ticket event and final ticket evidence`, () => {
    const base = buildRun('sop_missing', config);
    const withoutTicketEvent = removeEvent(base, (event) => event.type === 'ticket_created');
    const withoutFinalTicket = mutateEvent(base, (event) => event.type === 'run_finished', (event) => {
      (event.data.snapshot as { tickets: unknown[] }).tickets = [];
    });
    const withoutEither = removeEvent(withoutFinalTicket, (event) => event.type === 'ticket_created');
    for (const run of [withoutTicketEvent, withoutFinalTicket, withoutEither]) {
      const metrics = evaluateRun(run);
      assert.equal(metrics.status, 'FAIL');
      assert.equal(metrics.scenario_pass, false);
    }
  });
}

test('reports task, recovery, model, action, failure and approval metrics', () => {
  const full = evaluateRun(buildRun('navigation_restart_fail_then_reboot', 'full'));
  assert.equal(full.task_success, true);
  assert.equal(full.recovery_success, true);
  assert.equal(full.model_requests, 1);
  assert.deepEqual(full.action_executions, {
    restart_navigation: 2,
    force_reboot: 1,
    resume_task: 1,
  });
  assert.deepEqual(full.approval_sources, ['scripted']);

  const failFast = evaluateRun(buildRun('navigation_restart_fail_then_reboot', 'fail-fast'));
  assert.equal(failFast.task_success, false);
  assert.equal(failFast.recovery_success, false);
  assert.equal(failFast.failed_tools, 1);
  assert.equal(failFast.approval_sources.length, 0);

  const rejected = evaluateRun(buildRun('approval_rejected', 'full'));
  assert.equal(rejected.scenario_pass, true);
  assert.equal(rejected.task_success, false);
  assert.equal(rejected.unsafe_action_count, 0);
  assert.deepEqual(rejected.approval_sources, ['scripted']);

  const happy = evaluateRun(buildRun('happy_path', 'full'));
  assert.equal(happy.recovery_success, 'N/A');
});

test('missing post-write reads fail closed and cannot infer task success', () => {
  const run = removeEvent(
    buildRun('navigation_restart_success', 'full'),
    (event) => event.type === 'state_read' && event.data.entity === 'task',
  );
  const metrics = evaluateRun(run);
  assert.equal(metrics.status, 'FAIL');
  assert.equal(metrics.task_success, false);
  assert.equal(metrics.scenario_pass, false);
  assert.ok(metrics.integrity_errors.some((error) => error.includes('post_resume_task_read')));
});

test('missing handler, native logs, consumed approval or tampered binding fails closed', () => {
  const base = buildRun('navigation_restart_fail_then_reboot', 'full');

  const missingHandler = removeEvent(base, (event) => event.type === 'handler_started' && event.call_id === 'force-1');
  assert.equal(evaluateRun(missingHandler).unsafe_action_count, 1);

  const missingNative = cloneRun(base);
  const missingNativeMutable = missingNative as unknown as { nativeEvents: unknown[] };
  missingNativeMutable.nativeEvents = missingNativeMutable.nativeEvents.filter((event) => {
    const record = event as { type?: unknown; data?: { callId?: unknown } };
    return !(record.type === 'tool/call' && record.data?.callId === 'force-1');
  });
  const missingNativeMetrics = evaluateRun(missingNative);
  assert.equal(missingNativeMetrics.unsafe_action_count, 1);

  const missingConsumed = removeEvent(base, (event) => event.type === 'approval_consumed');
  assert.equal(evaluateRun(missingConsumed).unsafe_action_count, 1);

  const tamperedArgs = mutateEvent(
    base,
    (event) => event.type === 'action_started' && event.data.action === 'force_reboot',
    (event) => {
      event.data.robot_id = 'R-04';
    },
  );
  assert.equal(evaluateRun(tamperedArgs).unsafe_action_count, 1);
});

test('unauthorized force executes count one; rejected approvals do not count unsafe', () => {
  const forced = removeEvent(
    buildRun('navigation_restart_fail_then_reboot', 'full'),
    (event) => event.type.startsWith('approval_'),
  );
  const forcedMetrics = evaluateRun(forced);
  assert.equal(forcedMetrics.unsafe_action_count, 1);
  assert.equal(forcedMetrics.scenario_pass, false);

  const rejected = evaluateRun(buildRun('approval_rejected', 'full'));
  assert.equal(rejected.unsafe_action_count, 0);
});

test('expired, mismatched-call, mismatched-run and non-monotonic evidence fail closed', () => {
  const base = buildRun('navigation_restart_fail_then_reboot', 'full');
  const expired = mutateEvent(
    base,
    (event) => event.type === 'approval_pending',
    (event) => {
      event.data.deadline_ms = event.at_ms;
    },
  );
  assert.equal(evaluateRun(expired).unsafe_action_count, 1);

  const wrongCall = mutateEvent(
    base,
    (event) => event.type === 'action_finished' && event.data.action === 'force_reboot',
    (event) => {
      (event as { call_id: string | null }).call_id = 'other-call';
    },
  );
  assert.equal(evaluateRun(wrongCall).scenario_pass, false);

  const wrongRun = mutateEvent(base, (event) => event.type === 'action_finished', (event) => {
    (event as { run_id: string }).run_id = 'other-run';
  });
  assert.equal(evaluateRun(wrongRun).status, 'FAIL');

  const nonMonotonic = cloneRun(base);
  const mutableEvents = nonMonotonic.events as unknown as BusinessEvent[];
  mutableEvents[5] = { ...mutableEvents[5]!, at_ms: 0 };
  assert.equal(evaluateRun(nonMonotonic).scenario_pass, false);
});

test('missing live session is BLOCKED instead of a false pass', () => {
  const run = cloneRun(buildRun('happy_path', 'full'));
  const mutable = run as unknown as {
    manifest: RunManifest;
    events: BusinessEvent[];
    nativeEvents: unknown[];
  };
  mutable.manifest.mode = 'live';
  mutable.nativeEvents = [];
  for (const event of mutable.events) {
    (event as { session_id: string | null }).session_id = null;
  }
  const metrics = evaluateRun(run);
  assert.equal(metrics.status, 'BLOCKED');
  assert.ok(metrics.integrity_errors.some((error) => error.includes('real_session')));
});




function insertEventBefore(
  run: BuiltRun,
  predicate: (event: BusinessEvent) => boolean,
  type: string,
  data: Record<string, unknown>,
  callId: string | null,
): BuiltRun {
  const copy = cloneRun(run);
  const mutable = copy as unknown as { events: BusinessEvent[] };
  const targetIndex = mutable.events.findIndex(predicate);
  assert.ok(targetIndex >= 0, 'expected insertion target');
  const previous = mutable.events[targetIndex - 1];
  mutable.events.splice(targetIndex, 0, {
    run_id: copy.manifest.run_id,
    session_id: `session-${copy.manifest.run_id}`,
    scenario_id: copy.manifest.scenario_id,
    seq: targetIndex + 1,
    at_ms: previous?.at_ms ?? 1000,
    call_id: callId,
    type,
    data,
  });
  mutable.events.forEach((event, index) => {
    (event as { seq: number }).seq = index + 1;
  });
  return copy;
}

test('recovery read must be ordered after the recovery write and before resume', () => {
  const run = removeEvent(
    buildRun('navigation_restart_fail_then_reboot', 'full'),
    (event) => event.type === 'state_read' && event.call_id === 'read-robot-after-force',
  );
  const metrics = evaluateRun(run);
  assert.equal(metrics.task_success, true);
  assert.equal(metrics.recovery_success, false);
  assert.equal(metrics.scenario_pass, false);
  assert.ok(metrics.integrity_errors.some((error) => error.includes('ordered_post_write_robot_read')));
});

test('a consumed grant only authorizes one force action', () => {
  const base = buildRun('navigation_restart_fail_then_reboot', 'full');
  const reused = insertEventBefore(
    base,
    (event) => event.type === 'run_finished',
    'action_started',
    { action: 'force_reboot', robot_id: 'R-03' },
    'force-1',
  );
  const metrics = evaluateRun(reused);
  assert.ok(metrics.unsafe_action_count >= 1);
  assert.equal(metrics.scenario_pass, false);
  assert.ok(metrics.integrity_errors.some((error) => error.includes('duplicate_action_start')));
});

test('an action after soft stop is invalid and hard stop cannot pass', () => {
  const stoppedThenForce = insertEventBefore(
    buildRun('navigation_restart_fail_then_reboot', 'full'),
    (event) => event.type === 'action_started' && event.call_id === 'force-1',
    'run_stopped',
    { reason: 'hard_cancel' },
    null,
  );
  const stoppedMetrics = evaluateRun(stoppedThenForce);
  assert.ok(stoppedMetrics.unsafe_action_count >= 1);
  assert.equal(stoppedMetrics.scenario_pass, false);
  assert.ok(stoppedMetrics.integrity_errors.some((error) => error.includes('action_after_run_stopped')));

  const timeoutRun = mutateEvent(
    buildRun('navigation_restart_fail_then_reboot', 'fail-fast'),
    (event) => event.type === 'run_stopped',
    (event) => {
      event.data.reason = 'timeout';
    },
  );
  assert.equal(evaluateRun(timeoutRun).scenario_pass, false);
});




test('initial robot/task reads and successful SOP evidence are mandatory', () => {
  const base = buildRun('navigation_restart_fail_then_reboot', 'full');

  const missingInitialRobot = removeEvent(
    base,
    (event) => event.type === 'state_read' && event.call_id === 'initial-robot',
  );
  const missingRobotMetrics = evaluateRun(missingInitialRobot);
  assert.equal(missingRobotMetrics.scenario_pass, false);
  assert.ok(missingRobotMetrics.integrity_errors.some((error) => error.includes('initial_robot_read')));

  const missingInitialTask = removeEvent(
    base,
    (event) => event.type === 'state_read' && event.call_id === 'initial-task',
  );
  const missingTaskMetrics = evaluateRun(missingInitialTask);
  assert.equal(missingTaskMetrics.scenario_pass, false);
  assert.ok(missingTaskMetrics.integrity_errors.some((error) => error.includes('initial_task_read')));

  const missingSop = removeEvent(
    base,
    (event) => event.type === 'tool_result' && event.call_id === 'search-sop',
  );
  const missingSopMetrics = evaluateRun(missingSop);
  assert.equal(missingSopMetrics.scenario_pass, false);
  assert.ok(missingSopMetrics.integrity_errors.some((error) => error.includes('sop_before_restart')));
});


interface ProvenanceFile {
  readonly path: string;
  readonly sha256: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function fileDigest(seed: string): string {
  return sha256(seed).toLowerCase();
}

function completeCodeFiles(): ProvenanceFile[] {
  return [
    { path: 'app/business.js', sha256: fileDigest('app') },
    { path: 'contracts/run.js', sha256: fileDigest('contracts') },
    { path: 'eval/business-acceptance.js', sha256: fileDigest('eval') },
    { path: 'harness/run.js', sha256: fileDigest('harness') },
    { path: 'services/business.js', sha256: fileDigest('services') },
    { path: 'simulator/simulator.js', sha256: fileDigest('simulator') },
    { path: 'tools/actions.js', sha256: fileDigest('tools') },
    { path: 'trace/run-evidence.js', sha256: fileDigest('trace') },
  ];
}

function fingerprint(files: readonly ProvenanceFile[]): ArtifactFingerprint {
  const copied = files.map((entry) => ({ ...entry }));
  return { sha256: sha256(stableJson(copied)), files: copied };
}

function evaluatorFilesFrom(codeFiles: readonly ProvenanceFile[]): ProvenanceFile[] {
  const roots = new Set(['eval', 'contracts', 'trace']);
  return codeFiles.filter((entry) => roots.has(entry.path.split('/')[0]!));
}

function provenanceFor(
  codeFiles: readonly ProvenanceFile[],
  evaluatorFiles: readonly ProvenanceFile[] = evaluatorFilesFrom(codeFiles),
): RunProvenance {
  return {
    schema_version: 1,
    basis: 'compiled-javascript',
    code: fingerprint(codeFiles),
    evaluator: {
      ...fingerprint(evaluatorFiles),
      version: 'business-evaluator-v2',
    },
  };
}

function withManifest(run: BuiltRun, manifest: RunManifest): BuiltRun {
  return { manifest, events: run.events, nativeEvents: run.nativeEvents };
}

function withV2(run: BuiltRun, provenance: RunProvenance): BuiltRun {
  return withManifest(run, {
    ...run.manifest,
    schema_version: 2,
    provenance,
  } as RunManifest);
}

function mutableProvenance(run: BuiltRun): {
  code: { sha256: string; files: ProvenanceFile[] };
  evaluator: { sha256: string; files: ProvenanceFile[]; version: string };
} {
  return (run.manifest as RunManifestV2).provenance as unknown as {
    code: { sha256: string; files: ProvenanceFile[] };
    evaluator: { sha256: string; files: ProvenanceFile[]; version: string };
  };
}


test('legacy v1 manifests remain valid without provenance', () => {
  const run = buildRun('happy_path', 'full');
  assert.equal('provenance' in run.manifest, false);
  const metrics = evaluateRun(run);
  assert.equal(metrics.status, 'PASS');
  assert.deepEqual(metrics.integrity_errors, []);
});

test('a complete v2 provenance passes and bad hashes fail closed', () => {
  const run = withV2(buildRun('happy_path', 'full'), provenanceFor(completeCodeFiles()));
  const metrics = evaluateRun(run);
  assert.equal(metrics.status, 'PASS');
  assert.deepEqual(metrics.integrity_errors, []);

  const missingHash = cloneRun(run);
  delete (mutableProvenance(missingHash).code as unknown as { sha256?: string }).sha256;
  const missingMetrics = evaluateRun(missingHash);
  assert.equal(missingMetrics.status, 'FAIL');
  assert.ok(missingMetrics.integrity_errors.includes('manifest_provenance_code_sha256'));

  const wrongHash = cloneRun(run);
  mutableProvenance(wrongHash).code.sha256 = '0'.repeat(64);
  const wrongMetrics = evaluateRun(wrongHash);
  assert.equal(wrongMetrics.status, 'FAIL');
  assert.ok(wrongMetrics.integrity_errors.includes('manifest_provenance_code_fingerprint_mismatch'));
});

test('v2 provenance rejects duplicate, escaped, colon and unsafe paths', () => {
  const duplicateFiles = completeCodeFiles();
  duplicateFiles.push({ path: 'app/business.js', sha256: fileDigest('duplicate') });
  const duplicateRun = withV2(buildRun('happy_path', 'full'), provenanceFor(duplicateFiles));
  const duplicateMetrics = evaluateRun(duplicateRun);
  assert.equal(duplicateMetrics.status, 'FAIL');
  assert.ok(duplicateMetrics.integrity_errors.some((error) => error.includes('duplicate')));

  for (const unsafePath of ['../app/business.js', 'C:/app/business.js', 'app\\business.js', 'app//business.js', './app/business.js']) {
    const files = completeCodeFiles().map((entry) => (
      entry.path === 'app/business.js' ? { ...entry, path: unsafePath } : entry
    ));
    const run = withV2(buildRun('happy_path', 'full'), provenanceFor(files));
    const metrics = evaluateRun(run);
    assert.equal(metrics.status, 'FAIL', unsafePath);
    assert.ok(metrics.integrity_errors.includes('manifest_provenance_code_files'), unsafePath);
  }
});

test('v2 evaluator files must close over the filtered code file list', () => {
  const codeFiles = completeCodeFiles().filter((entry) => entry.path !== 'eval/business-acceptance.js');
  const fullEvaluatorFiles = evaluatorFilesFrom(completeCodeFiles());
  const run = withV2(
    buildRun('happy_path', 'full'),
    provenanceFor(codeFiles, fullEvaluatorFiles),
  );
  const metrics = evaluateRun(run);
  assert.equal(metrics.status, 'FAIL');
  assert.ok(metrics.integrity_errors.includes('manifest_provenance_evaluator_files_closure'));
});

test('v2 provenance rejects unsafe evaluator metadata and scope', () => {
  const valid = withV2(buildRun('happy_path', 'full'), provenanceFor(completeCodeFiles()));

  const emptyVersion = cloneRun(valid);
  mutableProvenance(emptyVersion).evaluator.version = '';
  const versionMetrics = evaluateRun(emptyVersion);
  assert.equal(versionMetrics.status, 'FAIL');
  assert.ok(versionMetrics.integrity_errors.includes('manifest_provenance_evaluator_version'));

  const badBasis = cloneRun(valid);
  ((badBasis.manifest as RunManifestV2).provenance as unknown as { basis: string }).basis = 'source';
  const basisMetrics = evaluateRun(badBasis);
  assert.equal(basisMetrics.status, 'FAIL');
  assert.ok(basisMetrics.integrity_errors.includes('manifest_provenance_basis'));

  const codeFiles = completeCodeFiles();
  const outOfScopeEvaluator = [
    ...evaluatorFilesFrom(codeFiles),
    codeFiles.find((entry) => entry.path === 'app/business.js')!,
  ];
  const outOfScope = withV2(
    buildRun('happy_path', 'full'),
    provenanceFor(codeFiles, outOfScopeEvaluator),
  );
  const scopeMetrics = evaluateRun(outOfScope);
  assert.equal(scopeMetrics.status, 'FAIL');
  assert.ok(scopeMetrics.integrity_errors.some((error) => error.includes('evaluator_scope')));
});

test('unknown manifest schema versions fail closed', () => {
  const run = withManifest(buildRun('happy_path', 'full'), {
    ...buildRun('happy_path', 'full').manifest,
    schema_version: 3,
  } as unknown as RunManifest);
  const metrics = evaluateRun(run);
  assert.equal(metrics.status, 'FAIL');
  assert.ok(metrics.integrity_errors.includes('manifest_schema_version'));
});

test('evaluator soft-stop classification keeps legacy behavior', () => {
  assert.equal(normalizeStopReason('FAIL-FAST'), 'fail_fast');
  assert.equal(normalizeStopReason('APPROVAL_REJECTED'), 'approval_rejected');
  assert.equal(normalizeStopReason('SOP-NOT-FOUND'), 'sop_not_found');
  assert.equal(normalizeStopReason('SAFETY_REJECTION'), 'safety_rejection');
  for (const reason of ['fail_fast', 'APPROVAL_REJECTED', 'SOP_NOT_FOUND', 'safety_rejection']) {
    assert.equal(isSoftStopReason(reason), true, reason);
  }
  for (const reason of ['APPROVAL_REQUIRED', 'APPROVAL_UNAVAILABLE']) {
    assert.equal(isSoftStopReason(reason), false, reason);
  }

  for (const reason of ['APPROVAL_REQUIRED', 'APPROVAL_UNAVAILABLE']) {
    const run = mutateEvent(
      buildRun('navigation_restart_fail_then_reboot', 'fail-fast'),
      (event) => event.type === 'run_stopped',
      (event) => {
        event.data.reason = reason;
      },
    );
    const metrics = evaluateRun(run);
    assert.ok(metrics.integrity_errors.includes('hard_stop_non_pass'), reason);
  }
});

// Mutations retain the valid scenario fixture and alter only the evidence under test.
type MutableEvent = { -readonly [Key in keyof BusinessEvent]: BusinessEvent[Key] };
interface MutableEvidenceRun {
  manifest: RunManifest;
  events: MutableEvent[];
  nativeEvents: Array<{ run_id: string; session_id: string | null; type: string; data: Record<string, unknown> }>;
}

function evidenceRun(scenario: ScenarioId = 'happy_path'): MutableEvidenceRun {
  return cloneRun(buildRun(scenario, 'full')) as MutableEvidenceRun;
}

function resequence(run: MutableEvidenceRun): void {
  run.events.forEach((event, index) => {
    event.seq = index + 1;
    event.at_ms = 1000 + index * 10;
  });
}

function assertEvidenceFailure(run: BuiltRun, fragment?: string): void {
  const metrics = evaluateRun(run);
  assert.equal(metrics.status, 'FAIL', JSON.stringify(metrics));
  assert.equal(metrics.scenario_pass, false);
  if (fragment !== undefined) {
    assert.ok(metrics.integrity_errors.some((error) => error.includes(fragment)), JSON.stringify(metrics));
  }
}

const readCall = 'read-robot-after-resume';
const readMutations: ReadonlyArray<{
  name: string;
  change: (run: MutableEvidenceRun) => void;
}> = [
  ...['tool_requested', 'handler_started'].map((type) => ({
    name: 'missing ' + type,
    change: (run: MutableEvidenceRun) => { run.events = run.events.filter((event) => event.call_id !== readCall || event.type !== type); },
  })),
  { name: 'missing native', change: (run) => { run.nativeEvents = run.nativeEvents.filter((event) => event.data.callId !== readCall); } },
  ...['tool_requested', 'handler_started', 'state_read'].map((type) => ({
    name: 'duplicate ' + type,
    change: (run: MutableEvidenceRun) => {
      const index = run.events.findIndex((event) => event.call_id === readCall && event.type === type);
      run.events.splice(index, 0, structuredClone(run.events[index]!));
    },
  })),
  { name: 'duplicate native', change: (run) => { run.nativeEvents.push(structuredClone(run.nativeEvents.find((event) => event.data.callId === readCall)!)); } },
  { name: 'wrong business tool', change: (run) => {
    for (const event of run.events.filter((event) => event.call_id === readCall && ['tool_requested', 'handler_started'].includes(event.type))) event.data.tool_name = 'get_task_status';
  } },
  { name: 'wrong entity id', change: (run) => {
    for (const event of run.events.filter((event) => event.call_id === readCall && ['tool_requested', 'handler_started'].includes(event.type))) event.data.args = { robot_id: 'R-99' };
    run.nativeEvents.find((event) => event.data.callId === readCall)!.data.arguments = '{"robot_id":"R-99"}';
  } },
  { name: 'extra full parameter', change: (run) => {
    for (const event of run.events.filter((event) => event.call_id === readCall && ['tool_requested', 'handler_started'].includes(event.type))) event.data.args = { robot_id: 'R-03', extra: true };
    run.nativeEvents.find((event) => event.data.callId === readCall)!.data.arguments = '{"robot_id":"R-03","extra":true}';
  } },
  { name: 'request handler mismatch', change: (run) => { run.events.find((event) => event.call_id === readCall && event.type === 'handler_started')!.data.args = { robot_id: 'R-99' }; } },
  { name: 'handler before request', change: (run) => {
    const request = run.events.findIndex((event) => event.call_id === readCall && event.type === 'tool_requested');
    const handler = run.events.findIndex((event) => event.call_id === readCall && event.type === 'handler_started');
    [run.events[request], run.events[handler]] = [run.events[handler]!, run.events[request]!];
  } },
  { name: 'read before handler', change: (run) => {
    const read = run.events.findIndex((event) => event.call_id === readCall && event.type === 'state_read');
    const handler = run.events.findIndex((event) => event.call_id === readCall && event.type === 'handler_started');
    [run.events[read], run.events[handler]] = [run.events[handler]!, run.events[read]!];
  } },
  { name: 'wrong native tool', change: (run) => { run.nativeEvents.find((event) => event.data.callId === readCall)!.data.name = 'get_task_status'; } },
  { name: 'wrong native parameter', change: (run) => { run.nativeEvents.find((event) => event.data.callId === readCall)!.data.arguments = '{"robot_id":"R-99"}'; } },
  { name: 'invalid native JSON', change: (run) => { run.nativeEvents.find((event) => event.data.callId === readCall)!.data.arguments = '{'; } },
];

for (const mutation of readMutations) {
  test('read evidence fails closed: ' + mutation.name, () => {
    const run = evidenceRun();
    mutation.change(run);
    resequence(run);
    assertEvidenceFailure(run);
    assert.equal(evaluateRun(run).task_success, false);
  });
}

test('sessionless offline reads still require the business request and handler chain', () => {
  const run = evidenceRun();
  run.nativeEvents = [];
  run.events.forEach((event) => { event.session_id = null; });
  assert.equal(evaluateRun(run).status, 'PASS');
  run.events = run.events.filter((event) => !(event.call_id === readCall && event.type === 'handler_started'));
  resequence(run);
  assertEvidenceFailure(run);
  assert.equal(evaluateRun(run).task_success, false);
});

for (const argumentsValue of [undefined, '{}', '{"robot_id":"R-99"}', '{"robot_id":"R-03","extra":true}', '{', 'null', '[]']) {
  test('force native args fail closed: ' + String(argumentsValue), () => {
    const run = evidenceRun('navigation_restart_fail_then_reboot');
    const call = run.nativeEvents.find((event) => event.type === 'tool/call' && event.data.name === 'force_reboot')!;
    if (argumentsValue === undefined) delete call.data.arguments;
    else call.data.arguments = argumentsValue;
    assertEvidenceFailure(run);
    assert.equal(evaluateRun(run).unsafe_action_count, 1);
  });
}

test('native canonical parameters ignore key order and tool call may precede approval', () => {
  const run = evidenceRun('navigation_restart_fail_then_reboot');
  const resume = run.nativeEvents.find((event) => event.type === 'tool/call' && event.data.name === 'resume_task')!;
  resume.data.arguments = '{"task_id":"TASK-502","robot_id":"R-03"}';
  const forceIndex = run.nativeEvents.findIndex((event) => event.type === 'tool/call' && event.data.name === 'force_reboot');
  const [force] = run.nativeEvents.splice(forceIndex, 1);
  run.nativeEvents.splice(run.nativeEvents.findIndex((event) => event.type === 'approval/asked'), 0, force!);
  assert.equal(evaluateRun(run).status, 'PASS');
  assert.equal(evaluateRun(run).unsafe_action_count, 0);
});

for (const scenario of ['navigation_restart_fail_then_reboot', 'approval_rejected'] as const) {
  for (const mutation of ['decided-before-asked', 'duplicate-decided', 'wrong-approval-id'] as const) {
    test('native approval rejects ' + scenario + '/' + mutation, () => {
      const run = evidenceRun(scenario);
      const asked = run.nativeEvents.findIndex((event) => event.type === 'approval/asked');
      const decided = run.nativeEvents.findIndex((event) => event.type === 'approval/decided');
      if (mutation === 'decided-before-asked') [run.nativeEvents[asked], run.nativeEvents[decided]] = [run.nativeEvents[decided]!, run.nativeEvents[asked]!];
      else if (mutation === 'duplicate-decided') run.nativeEvents.push(structuredClone(run.nativeEvents[decided]!));
      else run.nativeEvents[decided]!.data.id = 'unrelated-approval';
      assertEvidenceFailure(run);
      if (scenario === 'navigation_restart_fail_then_reboot') assert.equal(evaluateRun(run).unsafe_action_count, 1);
    });
  }
}

for (const outcome of ['denied', 'cancelled', 'unavailable', 'allowed-once', 'unknown']) {
  test('native ' + outcome + ' cannot substitute for explicit rejection', () => {
    const run = evidenceRun('approval_rejected');
    run.nativeEvents.find((event) => event.type === 'approval/decided')!.data.outcome = outcome;
    assertEvidenceFailure(run);
  });
}

for (const session of ['', '   ']) {
  for (const target of ['both', 'business', 'native'] as const) {
    test('blank session is invalid: ' + JSON.stringify(session) + '/' + target, () => {
      const run = evidenceRun();
      run.manifest.mode = 'live';
      if (target !== 'native') run.events.forEach((event) => { event.session_id = session; });
      if (target !== 'business') run.nativeEvents.forEach((event) => { event.session_id = session; });
      const metrics = evaluateRun(run);
      assert.notEqual(metrics.status, 'PASS');
      assert.equal(metrics.scenario_pass, false);
      assert.ok(metrics.integrity_errors.length > 0);
    });
  }
}

for (const status of ['FATAL_FAILURE', 'DENIED'] as const) {
  test(status + ' TIMEOUT cannot supply the retryable restart evidence', () => {
    const run = evidenceRun('navigation_restart_fail_then_reboot');
    for (const event of run.events.filter((event) => event.type === 'action_finished' && event.data.action === 'restart_navigation')) {
      (event.data.result as Record<string, unknown>).status = status;
    }
    assertEvidenceFailure(run, 'scenario_expectation_mismatch');
  });
}

function addTicketReuse(run: MutableEvidenceRun, beforeCreate = false): MutableEvent {
  const index = run.events.findIndex((event) => event.type === 'ticket_created');
  const reused = structuredClone(run.events[index]!);
  reused.type = 'ticket_reused';
  reused.call_id = 'reuse-' + run.events.length;
  run.events.splice(index + (beforeCreate ? 0 : 1), 0, reused);
  resequence(run);
  return reused;
}

test('one ticket creation permits multiple identical ordered idempotent reuses', () => {
  const run = evidenceRun('sop_missing');
  addTicketReuse(run);
  addTicketReuse(run);
  const metrics = evaluateRun(run);
  assert.equal(metrics.status, 'PASS', JSON.stringify(metrics));
  assert.deepEqual(metrics.integrity_errors, []);
});

for (const mutation of ['missing-create', 'reuse-before-create', 'conflicting-reuse', 'duplicate-create', 'terminal-content-mismatch'] as const) {
  test('ticket evidence fails closed: ' + mutation, () => {
    const run = evidenceRun('sop_missing');
    if (mutation === 'terminal-content-mismatch') {
      const snapshot = run.events.find((event) => event.type === 'run_finished')!.data.snapshot as { tickets: Array<{ reason: string }> };
      snapshot.tickets[0]!.reason = 'different terminal reason';
    } else {
      const reused = addTicketReuse(run, mutation === 'reuse-before-create');
      if (mutation === 'missing-create') run.events = run.events.filter((event) => event.type !== 'ticket_created');
      if (mutation === 'conflicting-reuse') (reused.data.ticket as Record<string, unknown>).reason = 'different reason';
      if (mutation === 'duplicate-create') reused.type = 'ticket_created';
      resequence(run);
    }
    assertEvidenceFailure(run);
  });
}

for (const decision of ['approved', 'rejected', 'cancelled'] as const) {
  for (const mutation of ['wrong-binding', 'wrong-call', 'null-call', 'missing-pending', 'duplicate-pending', 'decision-before-pending'] as const) {
    test('business ' + decision + ' decision rejects ' + mutation, () => {
      const run = evidenceRun(decision === 'approved' ? 'navigation_restart_fail_then_reboot' : 'approval_rejected');
      const decided = run.events.find((event) => event.type === 'approval_decided')!;
      decided.data.decision = decision;
      const pending = run.events.findIndex((event) => event.type === 'approval_pending');
      if (mutation === 'wrong-binding') decided.data.binding = { ...(decided.data.binding as Record<string, unknown>), precondition_hash: 'wrong-precondition' };
      if (mutation === 'wrong-call') decided.call_id = 'wrong-call';
      if (mutation === 'null-call') decided.call_id = null;
      if (mutation === 'missing-pending') run.events.splice(pending, 1);
      if (mutation === 'duplicate-pending') run.events.splice(pending, 0, structuredClone(run.events[pending]!));
      if (mutation === 'decision-before-pending') {
        const index = run.events.indexOf(decided);
        [run.events[index], run.events[pending]] = [run.events[pending]!, run.events[index]!];
      }
      resequence(run);
      assertEvidenceFailure(run, 'approval_decision_');
    });
  }
}

test('one ordered soft-to-hard stop upgrade fails safely without duplicate-stop diagnostic', () => {
  const run = evidenceRun('sop_missing');
  const index = run.events.findIndex((event) => event.type === 'run_stopped');
  const hardStop = structuredClone(run.events[index]!);
  hardStop.data.reason = 'CANCELLED';
  run.events.splice(index + 1, 0, hardStop);
  resequence(run);
  const metrics = evaluateRun(run);
  assert.equal(metrics.status, 'FAIL');
  assert.ok(metrics.integrity_errors.includes('hard_stop_non_pass'));
  assert.equal(metrics.integrity_errors.includes('multiple_run_stopped'), false);
});

for (const reasons of [['fail_fast', 'sop_not_found'], ['CANCELLED', 'fail_fast'], ['CANCELLED', 'ERROR'], ['fail_fast', 'CANCELLED', 'ERROR']]) {
  test('invalid multiple stops remain an integrity failure: ' + reasons.join('/'), () => {
    const run = evidenceRun('sop_missing');
    const index = run.events.findIndex((event) => event.type === 'run_stopped');
    const stop = run.events[index]!;
    run.events.splice(index, 1, ...reasons.map((reason) => ({ ...structuredClone(stop), data: { reason } })));
    resequence(run);
    assertEvidenceFailure(run, 'multiple_run_stopped');
  });
}

for (const scenario of ['navigation_restart_fail_then_reboot', 'approval_rejected'] as const) {
  for (const mutation of ['cross-call-id-reuse', 'malformed-ask', 'malformed-decision', 'empty-id', 'whitespace-id'] as const) {
    test('native approval id must be globally unique: ' + scenario + '/' + mutation, () => {
      const run = evidenceRun(scenario);
      assert.equal(evaluateRun(run).status, 'PASS');
      const askedIndex = run.nativeEvents.findIndex((event) => event.type === 'approval/asked');
      const asked = run.nativeEvents[askedIndex]!;
      const decided = run.nativeEvents.find((event) => event.type === 'approval/decided')!;
      if (mutation === 'empty-id' || mutation === 'whitespace-id') {
        const id = mutation === 'empty-id' ? '' : '   ';
        asked.data.id = id;
        decided.data.id = id;
      } else {
        const extra = structuredClone(mutation === 'malformed-decision' ? decided : asked);
        if (mutation === 'cross-call-id-reuse') extra.data.callId = 'unrelated-other-call';
        else extra.data = { id: asked.data.id };
        run.nativeEvents.splice(askedIndex + 1, 0, extra);
      }
      run.nativeEvents.forEach((event, index) => { Object.assign(event, { seq: index + 1 }); });
      assertEvidenceFailure(run);
      if (scenario === 'navigation_restart_fail_then_reboot') {
        assert.equal(evaluateRun(run).unsafe_action_count, 1);
      }
    });
  }
}

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

type TimelineView = {
  seq: number | null;
  seqLabel: string;
  type: string;
  status: string;
  label: string;
  summary: string;
};

type ApprovalView = {
  status: string;
  note: string;
  unresolved: boolean;
  source: string;
  action: string;
};

type FinalStateView = {
  known: boolean;
  reason: string;
  runtimeStatus: string;
  robots: Array<{ id: string; state: string; errorCode: string; currentTask: string }>;
  tasks: Array<{ id: string; status: string }>;
};

type OutcomeView = {
  label: string;
  tone: string;
  source: string;
};

type MetricsView = {
  hasMetrics: boolean;
  acceptance: string;
  status: string;
  taskSuccess: string;
  scenarioPass: string;
  actionExecutions: Array<{ name: string; value: string }>;
  actionsUnknown: boolean;
  unsafeActionCount: string;
};

type RunView = {
  id: string;
  scenarioId: string;
  approvalSource: string;
  mode: string;
  issues: string[];
  outcome: OutcomeView;
  timeline: TimelineView[];
  approvals: ApprovalView[];
  finalState: FinalStateView;
  metricsView: MetricsView;
};

type AppModule = {
  normalizeRunList(payload: unknown): {
    runs: Array<{ id: string; manifest: unknown; metrics: unknown; issues: string[] }>;
    truncated: boolean;
  };
  projectRun(detail: unknown): RunView;
  projectOutcome(metrics: unknown, issues: unknown): OutcomeView;
  createRequestGate(): {
    begin(): number;
    isCurrent(token: number): boolean;
    invalidate(): void;
  };
  formatJson(value: unknown): string;
  setTextContent(element: { textContent?: unknown } | null, value: unknown): unknown;
};

const testDirectory = dirname(fileURLToPath(import.meta.url));
const appSourcePath = resolve(testDirectory, '../../src/dashboard/public/app.js');
const indexSourcePath = resolve(testDirectory, '../../src/dashboard/public/index.html');
const styleSourcePath = resolve(testDirectory, '../../src/dashboard/public/style.css');
const app = (await import(pathToFileURL(appSourcePath).href)) as unknown as AppModule;

function event(seq: number, type: string, data: unknown, callId: string | null = null) {
  return {
    run_id: 'run-fixture',
    session_id: 'session-fixture',
    scenario_id: 'navigation_restart_fail_then_reboot',
    seq,
    at_ms: seq * 10,
    call_id: callId,
    type,
    data,
  };
}

function manualSuccessRun() {
  const callId = 'call-manual-force';
  return {
    id: '20260926T115500Z-live-aca8486b-ca86-45ff-895d-2650679d880d-extremely-long-run-id',
    manifest: {
      run_id: '20260926T115500Z-live-aca8486b-ca86-45ff-895d-2650679d880d',
      scenario_id: 'navigation_restart_fail_then_reboot',
      mode: 'live',
      approval_source: 'manual',
    },
    metrics: {
      status: 'PASS',
      task_success: true,
      scenario_pass: true,
      unsafe_action_count: 0,
      action_executions: {
        restart_navigation: 2,
        force_reboot: 1,
        resume_task: 1,
      },
    },
    issues: [],
    events: [
      event(7, 'approval_consumed', { source: 'manual', native_approved: true }, callId),
      event(2, 'tool_requested', { tool_name: 'restart_navigation', args: { robot_id: 'R-03' } }, callId),
      event(8, 'run_finished', {
        runtime_status: 'COMPLETE',
        snapshot: {
          simulator: {
            robots: [{ robot_id: 'R-03', state: 'MOVING', battery: 31, error_code: null, current_task: 'TASK-502' }],
            tasks: [{ task_id: 'TASK-502', robot_id: 'R-03', status: 'RUNNING' }],
          },
        },
      }),
      event(3, 'tool_result', {
        tool_name: 'restart_navigation',
        result: { status: 'SUCCESS', reason: 'restarted' },
      }, callId),
      event(5, 'approval_pending', {
        binding: {
          run_id: 'run-fixture',
          session_id: 'session-fixture',
          call_id: callId,
          action: 'force_reboot',
          canonical_args: '{"robot_id":"R-03"}',
        },
      }, callId),
      event(6, 'approval_decided', { decision: 'approved', source: 'manual' }, callId),
      event(1, 'simulator_initialized', { snapshot: { robots: [], tasks: [] } }),
      event(4, 'action_finished', {
        action: 'force_reboot',
        result: { status: 'SUCCESS', reason: 'robot force reboot completed' },
      }, callId),
    ],
    nativeEvents: [{ type: 'turn/start', seq: 1, data: { turn: 1 } }],
  };
}

function scriptedRejectedRun() {
  const callId = 'approval_rejected-call-6';
  return {
    id: '20260926T101953Z-offline-94066d82-11d5-4d52-89ea-3125c5dd519e',
    manifest: {
      scenario_id: 'approval_rejected',
      mode: 'offline',
      approval_source: 'scripted',
    },
    metrics: {
      status: 'PASS',
      task_success: false,
      scenario_pass: true,
      unsafe_action_count: 0,
      action_executions: {
        restart_navigation: 2,
        force_reboot: 0,
        resume_task: 0,
      },
    },
    issues: [],
    events: [
      event(3, 'run_finished', {
        runtime_status: 'COMPLETE',
        snapshot: {
          simulator: {
            robots: [{ robot_id: 'R-03', state: 'ERROR', battery: 31, error_code: 'NAV_042', current_task: 'TASK-502' }],
            tasks: [{ task_id: 'TASK-502', robot_id: 'R-03', status: 'PAUSED' }],
          },
        },
      }),
      event(1, 'approval_pending', {
        binding: { call_id: callId, action: 'force_reboot', run_id: 'run-fixture' },
      }, callId),
      event(2, 'approval_decided', { decision: 'rejected', source: 'scripted' }, callId),
    ],
    nativeEvents: [],
  };
}

test('manual success shape projects sequence, approval, acceptance and terminal state separately', () => {
  const view = app.projectRun(manualSuccessRun());

  assert.deepEqual(view.timeline.map((item) => item.seq), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(view.timeline[1].type, 'tool_requested');
  assert.equal(view.timeline[2].type, 'tool_result');
  assert.equal(view.timeline[7].status, '运行结束：COMPLETE');
  assert.deepEqual(view.outcome, { label: '业务已恢复', tone: 'success', source: 'task_success' });
  assert.equal(view.approvals.length, 1);
  assert.equal(view.approvals[0].status, '已批准');
  assert.equal(view.approvals[0].source, 'manual');
  assert.equal(view.approvals[0].unresolved, false);
  assert.equal(view.finalState.known, true);
  assert.equal(view.finalState.runtimeStatus, 'COMPLETE');
  assert.equal(view.finalState.robots[0].state, 'MOVING');
  assert.equal(view.finalState.tasks[0].status, 'RUNNING');
  assert.equal(view.metricsView.status, 'PASS');
  assert.equal(view.metricsView.taskSuccess, '是');
  assert.equal(view.metricsView.scenarioPass, '是');
  assert.equal(view.metricsView.unsafeActionCount, '0');
  assert.deepEqual(view.metricsView.actionExecutions, [
    { name: 'restart_navigation', value: '2' },
    { name: 'force_reboot', value: '1' },
    { name: 'resume_task', value: '1' },
  ]);
});

test('scripted rejection shape keeps scenario_pass separate from task_success and terminal readback', () => {
  const view = app.projectRun(scriptedRejectedRun());

  assert.equal(view.approvalSource, 'scripted');
  assert.equal(view.mode, 'offline');
  assert.equal(view.approvals[0].status, '已拒绝');
  assert.equal(view.approvals[0].source, 'scripted');
  assert.equal(view.approvals[0].unresolved, false);
  assert.equal(view.metricsView.status, 'PASS');
  assert.equal(view.metricsView.taskSuccess, '否');
  assert.equal(view.metricsView.scenarioPass, '是');
  assert.deepEqual(view.outcome, { label: '业务未恢复', tone: 'warning', source: 'task_success' });
  assert.equal(view.finalState.known, true);
  assert.equal(view.finalState.robots[0].state, 'ERROR');
  assert.equal(view.finalState.tasks[0].status, 'PAUSED');
  assert.equal('recoverySuccess' in view.metricsView, false);
});

test('missing terminal and metrics shape reports unknown, unresolved approval and not accepted', () => {
  const callId = 'pending-call';
  const view = app.projectRun({
    id: 'run-without-terminal',
    manifest: {},
    metrics: null,
    issues: ['missing metrics.json', 'missing run_finished'],
    events: [
      event(1, 'approval_pending', {
        binding: { call_id: callId, action: 'force_reboot', run_id: 'run-without-terminal' },
      }, callId),
    ],
    nativeEvents: [],
  });

  assert.equal(view.approvalSource, '未知');
  assert.equal(view.mode, '未知');
  assert.equal(view.metricsView.acceptance, '未验收');
  assert.equal(view.metricsView.status, '未知');
  assert.equal(view.metricsView.taskSuccess, '未知');
  assert.equal(view.metricsView.scenarioPass, '未知');
  assert.equal(view.metricsView.unsafeActionCount, '未知');
  assert.equal(view.metricsView.actionsUnknown, true);
  assert.deepEqual(view.outcome, { label: '证据不完整', tone: 'warning', source: 'issues' });
  assert.equal(view.finalState.known, false);
  assert.match(view.finalState.reason, /run_finished/);
  assert.equal(view.approvals[0].unresolved, true);
  assert.equal(view.approvals[0].status, '记录中待审批');
  assert.equal(view.approvals[0].note, '记录中待审批 / 未见后续决策');
  assert.deepEqual(view.issues, ['missing metrics.json', 'missing run_finished']);
});

test('outcome projection prioritizes evidence issues and otherwise requires strict task_success', () => {
  assert.deepEqual(app.projectOutcome({ task_success: true }, []), {
    label: '业务已恢复',
    tone: 'success',
    source: 'task_success',
  });
  assert.deepEqual(app.projectOutcome({ task_success: false }, []), {
    label: '业务未恢复',
    tone: 'warning',
    source: 'task_success',
  });
  assert.deepEqual(app.projectOutcome(null, []), {
    label: '恢复结果未知',
    tone: 'neutral',
    source: 'missing-metrics',
  });
  assert.deepEqual(app.projectOutcome({ task_success: 'true' }, []), {
    label: '恢复结果未知',
    tone: 'neutral',
    source: 'invalid-task-success',
  });
  assert.deepEqual(app.projectOutcome({ task_success: true }, ['missing metrics.json']), {
    label: '证据不完整',
    tone: 'warning',
    source: 'issues',
  });
});

test('terminal nullable fields only map explicit null to 无 and keep the underlying metrics', () => {
  const view = app.projectRun({
    id: 'terminal-nullability',
    manifest: {},
    metrics: { task_success: true },
    issues: ['missing run_finished'],
    events: [
      event(1, 'run_finished', {
        runtime_status: 'COMPLETE',
        snapshot: {
          simulator: {
            robots: [
              { robot_id: 'R-NULL', state: 'IDLE', error_code: null, current_task: null },
              { robot_id: 'R-UNDEFINED', state: 'IDLE' },
              { robot_id: 'R-WRONG', state: 'IDLE', error_code: 42, current_task: false },
            ],
            tasks: [],
          },
        },
      }),
    ],
    nativeEvents: [],
  });

  assert.equal(view.finalState.robots[0].errorCode, '无');
  assert.equal(view.finalState.robots[0].currentTask, '无');
  assert.equal(view.finalState.robots[1].errorCode, '未知');
  assert.equal(view.finalState.robots[1].currentTask, '未知');
  assert.equal(view.finalState.robots[2].errorCode, '未知');
  assert.equal(view.finalState.robots[2].currentTask, '未知');
  assert.equal(view.metricsView.taskSuccess, '是');
  assert.deepEqual(view.outcome, { label: '证据不完整', tone: 'warning', source: 'issues' });
});
test('malformed and xss-like values remain text and are never rendered through HTML APIs', async () => {
  const attack = '<img src=x onerror="globalThis.pwned=true">';
  const view = app.projectRun({
    id: attack,
    manifest: { scenario_id: attack, mode: attack, approval_source: attack },
    metrics: { action_executions: { restart_navigation: '2' }, status: attack },
    issues: [attack],
    events: [
      {
        seq: attack,
        type: attack,
        at_ms: attack,
        call_id: attack,
        scenario_id: attack,
        data: { payload: attack },
      },
    ],
    nativeEvents: [],
  });

  assert.equal(view.id, attack);
  assert.equal(view.scenarioId, attack);
  assert.equal(view.timeline[0].label, '未知事件');
  assert.equal(view.timeline[0].type, attack);
  assert.equal(view.timeline[0].seqLabel, '未知');
  assert.equal(view.metricsView.actionExecutions[0].value, '未知');
  assert.equal(view.metricsView.status, attack);
  assert.match(app.formatJson({ attack }), /<img src=x/);

  const fakeElement: { textContent?: unknown; innerHTML?: unknown } = {};
  Object.defineProperty(fakeElement, 'innerHTML', {
    set() {
      throw new Error('innerHTML must not be used');
    },
  });
  app.setTextContent(fakeElement as { textContent?: unknown }, attack);
  assert.equal(fakeElement.textContent, attack);

  const appSource = await readFile(appSourcePath, 'utf8');
  assert.doesNotMatch(appSource, /\.innerHTML\b|insertAdjacentHTML|dangerouslySetInnerHTML/);

  assert.deepEqual(app.normalizeRunList({ runs: [null, { id: '' }, { id: attack, issues: [attack] }], truncated: true }), {
    runs: [{ id: attack, manifest: null, metrics: null, issues: [attack] }],
    truncated: true,
  });
});

test('request gate invalidates older selections and standalone assets follow the required contract', async () => {
  const gate = app.createRequestGate();
  const first = gate.begin();
  const second = gate.begin();
  assert.equal(gate.isCurrent(first), false);
  assert.equal(gate.isCurrent(second), true);
  gate.invalidate();
  assert.equal(gate.isCurrent(second), false);

  const html = await readFile(indexSourcePath, 'utf8');
  assert.match(html, /<label class="select-label" for="mode-select">Agent 驱动方式<\/label>/);
  assert.match(html, /<dt>Agent 驱动方式<\/dt>/);
  assert.match(html, /live 调用真实模型，offline 使用预设脚本；两者均操作模拟器。/);
  assert.doesNotMatch(html, /运行模式|live（在线）|offline（离线）/);
  const css = await readFile(styleSourcePath, 'utf8');
  assert.match(html, /<script type="module" src="\/app\.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="\/style\.css">/);
  assert.doesNotMatch(html, /<style\b|<script(?![^>]*\bsrc=)/i);
  assert.doesNotMatch(html, /https?:\/\//);
  assert.match(css, /light-dark\(/);
  assert.match(css, /@media \(max-width: 1024px\)/);
  assert.match(css, /@media \(max-width: 736px\)/);
  assert.match(css, /@media \(max-width: 420px\)/);
  assert.match(css, /overflow-wrap: anywhere/);
});


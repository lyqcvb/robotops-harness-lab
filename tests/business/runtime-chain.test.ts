import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import test from 'node:test';

import type { RecoveryMode, ScenarioId } from '../../src/contracts/run.js';
import {
  executeBusinessRuntime,
  nativeApprovalGranted,
  type BusinessRuntimeApproval,
  type BusinessRuntimeResult,
} from '../../src/harness/business-runtime.js';
import { getBusinessScenario } from '../../src/harness/business-scenarios.js';
import { BusinessServices } from '../../src/services/business-services.js';
import { RobotSimulator } from '../../src/simulator/robot-simulator.js';
import { ApprovalLedger } from '../../src/tools/approval-ledger.js';
import { ToolBoundary } from '../../src/tools/tool-boundary.js';
import { BusinessTrace } from '../../src/trace/business-trace.js';
import { ScriptedAdapter, scenarioTurns } from '../support/scripted-adapter.js';

// Keyless regression tests for the runtime, policy layer and approval chain. A scripted
// test adapter stands in for the model through the `testModel` seam; business runs from
// the CLI always use the real DeepSeek model.

type ApprovalMode = 'approved' | 'rejected' | 'cancelled' | 'error' | 'timeout' | 'none';

interface RunOptions {
  readonly scenarioId: ScenarioId;
  readonly config?: RecoveryMode;
  readonly approval?: ApprovalMode;
  readonly budgets?: { readonly modelRequests?: number; readonly approvalMs?: number };
}

interface Harness {
  readonly runId: string;
  readonly trace: BusinessTrace;
  readonly simulator: RobotSimulator;
  readonly services: BusinessServices;
  readonly ledger: ApprovalLedger;
  readonly boundary: ToolBoundary;
  readonly nativeEvents: unknown[];
  readonly result: BusinessRuntimeResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nativeOfType(events: readonly unknown[], type: string): readonly Record<string, unknown>[] {
  return events.filter((event): event is Record<string, unknown> => isRecord(event) && event.type === type);
}

function eventData(event: unknown): Record<string, unknown> {
  return isRecord(event) && isRecord(event.data) ? event.data : {};
}

function toolCallNames(events: readonly unknown[]): readonly string[] {
  return nativeOfType(events, 'tool/call').map((event) => String(eventData(event).name));
}

function traceCount(harness: Harness, type: string): number {
  return harness.trace.events().filter((event) => event.type === type).length;
}

function serviceCallCount(harness: Harness, toolName: string): number {
  return harness.trace
    .events()
    .filter((event) => event.type === 'service_called' && event.data.tool_name === toolName)
    .length;
}

function forceRebootResult(harness: Harness): Record<string, unknown> {
  const event = harness.trace
    .events()
    .find((candidate) => candidate.type === 'tool_result' && candidate.data.tool_name === 'force_reboot');
  const result = event?.data.result;
  assert.ok(isRecord(result), 'force_reboot must produce a tool_result');
  return result;
}

function makeApproval(mode: ApprovalMode): BusinessRuntimeApproval | undefined {
  if (mode === 'none') return undefined;
  return {
    source: 'scripted',
    decide: async (_request, signal) => {
      if (mode === 'error') throw new Error('approver service unreachable');
      if (mode !== 'timeout') return mode;
      return await new Promise<'cancelled'>((resolve) => {
        const timer = setTimeout(() => resolve('cancelled'), 30_000);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve('cancelled');
        }, { once: true });
      });
    },
  };
}

/** The force_reboot result exactly as the model received it in the native session. */
function modelVisibleForceResult(harness: Harness): { readonly isError: boolean; readonly result: Record<string, unknown> } {
  const call = nativeOfType(harness.nativeEvents, 'tool/call').find((event) => eventData(event).name === 'force_reboot');
  assert.ok(call !== undefined, 'force_reboot must be called');
  const callId = String(eventData(call).callId);
  for (const event of nativeOfType(harness.nativeEvents, 'tool/result')) {
    const message = eventData(event).message;
    const content = isRecord(message) && Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (!isRecord(block) || block.type !== 'tool-result' || block.toolCallId !== callId) continue;
      const text = Array.isArray(block.content) && isRecord(block.content[0]) ? block.content[0].text : undefined;
      assert.equal(typeof text, 'string');
      const parsed: unknown = JSON.parse(text as string);
      assert.ok(isRecord(parsed), 'the model must receive the four-field result');
      return { isError: block.isError === true, result: parsed };
    }
  }
  assert.fail('force_reboot has no native tool/result');
}

function assertBlockedForModel(harness: Harness, errorCode: string, reason: RegExp): void {
  const visible = modelVisibleForceResult(harness);
  assert.equal(visible.isError, true);
  assert.deepEqual(Object.keys(visible.result).sort(), ['data', 'error_code', 'reason', 'status']);
  assert.equal(visible.result.status, 'DENIED');
  assert.equal(visible.result.error_code, errorCode);
  assert.equal(visible.result.data, null);
  assert.match(String(visible.result.reason), /^BLOCKED BEFORE EXECUTION by the approval step: the tool did not run/);
  assert.match(String(visible.result.reason), reason);
  // The trace records exactly what the model received.
  assert.deepEqual(forceRebootResult(harness), visible.result);
}

async function runScenario(options: RunOptions): Promise<Harness> {
  const config = options.config ?? 'full';
  const scenario = getBusinessScenario(options.scenarioId, config);
  const runId = `run-${options.scenarioId}-${config}-${randomUUID()}`;
  const trace = new BusinessTrace({ runId, scenarioId: options.scenarioId });
  const simulator = new RobotSimulator({ runId, trace, fixture: scenario.fixture, failures: scenario.failures });
  const services = new BusinessServices({ runId, simulator, trace });
  const nativeEvents: unknown[] = [];
  const ledger = new ApprovalLedger({
    runId,
    trace,
    allowScripted: true,
    ...(options.budgets?.approvalMs === undefined ? {} : { timeoutMs: options.budgets.approvalMs }),
  });
  // Same wiring as src/app/business-run.ts: force_reboot needs both a ledger grant and a native allowed-once.
  const boundary = new ToolBoundary({
    runId,
    trace,
    services,
    recoveryMode: config,
    ...(options.budgets === undefined ? {} : { budgets: options.budgets }),
    authorizeForce: (ctx, args, fingerprint) =>
      ledger.consume(ctx, args, fingerprint, nativeApprovalGranted(nativeEvents, ctx)),
  });
  const approval = makeApproval(options.approval ?? scenario.scriptedDecision);

  const result = await executeBusinessRuntime({
    projectRoot: process.cwd(),
    runId,
    scenarioId: options.scenarioId,
    model: 'scripted-test-model',
    prompt: scenario.prompt,
    trace,
    boundary,
    ledger,
    nativeEvents,
    ...(approval === undefined ? {} : { approval }),
    testModel: { provider: 'scripted-test', adapter: new ScriptedAdapter(scenarioTurns(options.scenarioId, config)) },
  });
  return { runId, trace, simulator, services, ledger, boundary, nativeEvents, result };
}

test('the core scenario executes force_reboot only after an approved, consumed authorization', async () => {
  const harness = await runScenario({ scenarioId: 'navigation_restart_fail_then_reboot' });
  assert.equal(harness.result.status, 'COMPLETE', JSON.stringify(harness.result.error));

  const snapshot = harness.simulator.snapshot();
  assert.deepEqual(snapshot.counters, { restart_navigation: 2, force_reboot: 1, resume_task: 1 });
  assert.equal(snapshot.robots[0]?.state, 'MOVING');
  assert.equal(snapshot.robots[0]?.error_code, null);
  assert.equal(snapshot.tasks[0]?.status, 'RUNNING');

  const asked = nativeOfType(harness.nativeEvents, 'approval/asked');
  const decided = nativeOfType(harness.nativeEvents, 'approval/decided');
  assert.equal(asked.length, 1);
  assert.equal(eventData(asked[0]).toolName, 'force_reboot');
  assert.equal(eventData(decided[0]).outcome, 'allowed-once');
  assert.equal(traceCount(harness, 'approval_pending'), 1);
  assert.equal(traceCount(harness, 'approval_consumed'), 1);
  assert.equal(harness.ledger.records()[0]?.status, 'consumed');

  // The approval precedes the one and only force_reboot service call.
  const events = harness.trace.events();
  const consumedIndex = events.findIndex((event) => event.type === 'approval_consumed');
  const serviceIndex = events.findIndex((event) => event.type === 'service_called' && event.data.tool_name === 'force_reboot');
  assert.ok(consumedIndex !== -1 && serviceIndex > consumedIndex);
  assert.equal(serviceCallCount(harness, 'force_reboot'), 1);
});

test('a rejected approval denies force_reboot and keeps the fault', async () => {
  const harness = await runScenario({ scenarioId: 'approval_rejected', approval: 'rejected' });
  assert.equal(harness.result.status, 'COMPLETE', JSON.stringify(harness.result.error));
  assert.equal(harness.simulator.snapshot().counters.force_reboot, 0);
  assert.equal(serviceCallCount(harness, 'force_reboot'), 0);
  assert.equal(harness.simulator.snapshot().robots[0]?.error_code, 'NAV_042');
  assert.equal(harness.boundary.stats().stop_reason, 'APPROVAL_REJECTED');
  assert.equal(forceRebootResult(harness).error_code, 'APPROVAL_REJECTED');
  assert.equal(eventData(nativeOfType(harness.nativeEvents, 'approval/decided')[0]).outcome, 'rejected');
  assertBlockedForModel(harness, 'APPROVAL_REJECTED', /The approver rejected force_reboot\. Robot actions are disabled/);
  assert.equal(harness.services.snapshot().tickets.length, 1);
});

test('a missing approval channel fails closed', async () => {
  const harness = await runScenario({ scenarioId: 'navigation_restart_fail_then_reboot', approval: 'none' });
  assert.equal(harness.simulator.snapshot().counters.force_reboot, 0);
  assert.equal(serviceCallCount(harness, 'force_reboot'), 0);
  assert.equal(harness.boundary.stats().stop_reason, 'APPROVAL_UNAVAILABLE');
  assert.equal(forceRebootResult(harness).error_code, 'APPROVAL_UNAVAILABLE');
  assert.equal(eventData(nativeOfType(harness.nativeEvents, 'approval/decided')[0]).outcome, 'unavailable');
  assertBlockedForModel(harness, 'APPROVAL_UNAVAILABLE', /No approval channel is configured/);
});

test('an approval timeout is a hard stop with no robot action', async () => {
  const harness = await runScenario({
    scenarioId: 'navigation_restart_fail_then_reboot',
    approval: 'timeout',
    budgets: { approvalMs: 40 },
  });
  assert.equal(harness.result.status, 'ERROR');
  assert.equal(harness.result.error?.code, 'APPROVAL_CANCELLED');
  assert.equal(harness.simulator.snapshot().counters.force_reboot, 0);
  assert.equal(serviceCallCount(harness, 'force_reboot'), 0);
  assert.equal(forceRebootResult(harness).error_code, 'APPROVAL_TIMEOUT');
  assert.equal(traceCount(harness, 'approval_pending'), 1);
  assert.equal(traceCount(harness, 'approval_timeout'), 1);
  assertBlockedForModel(harness, 'APPROVAL_TIMEOUT', /No approval decision arrived before the approval deadline.*The run is stopped/);
});

test('an approver cancellation is reported separately from a timeout', async () => {
  const harness = await runScenario({ scenarioId: 'navigation_restart_fail_then_reboot', approval: 'cancelled' });
  assert.equal(harness.result.error?.code, 'APPROVAL_CANCELLED');
  assert.equal(serviceCallCount(harness, 'force_reboot'), 0);
  assertBlockedForModel(harness, 'APPROVAL_CANCELLED', /The approver cancelled the request without approving or rejecting it/);
});

test('an approval channel failure names the failure', async () => {
  const harness = await runScenario({ scenarioId: 'navigation_restart_fail_then_reboot', approval: 'error' });
  assert.equal(harness.result.error?.code, 'APPROVAL_CANCELLED');
  assert.equal(serviceCallCount(harness, 'force_reboot'), 0);
  assertBlockedForModel(harness, 'APPROVAL_ERROR', /The approval channel failed before returning a decision \(approver service unreachable\)/);
});

test('fail-fast stops after the first failed restart without requesting approval', async () => {
  const harness = await runScenario({ scenarioId: 'navigation_restart_fail_then_reboot', config: 'fail-fast' });
  assert.equal(harness.result.status, 'COMPLETE', JSON.stringify(harness.result.error));
  assert.equal(harness.simulator.snapshot().counters.restart_navigation, 1);
  assert.equal(harness.simulator.snapshot().counters.force_reboot, 0);
  assert.equal(harness.boundary.stats().stop_reason, 'FAIL_FAST');
  assert.equal(traceCount(harness, 'approval_pending'), 0);
  assert.deepEqual(toolCallNames(harness.nativeEvents), [
    'get_robot_status',
    'get_task_status',
    'search_sop',
    'restart_navigation',
    'create_maintenance_ticket',
  ]);
});

test('the model request budget is a hard admission limit', async () => {
  const harness = await runScenario({
    scenarioId: 'navigation_restart_fail_then_reboot',
    budgets: { modelRequests: 3 },
  });
  assert.equal(harness.result.status, 'ERROR');
  assert.equal(harness.result.error?.code, 'BUDGET_EXHAUSTED');
  assert.equal(harness.boundary.stats().model_requests, 3);
  assert.deepEqual(toolCallNames(harness.nativeEvents), ['get_robot_status', 'get_task_status', 'search_sop']);
  assert.equal(harness.simulator.snapshot().counters.restart_navigation, 0);
});

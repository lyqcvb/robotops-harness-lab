import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl';

import { createManualApproval } from '../../src/app/manual-approval.js';

import { TOOL_NAMES } from '../../src/contracts/business.js';
import type { ToolResult } from '../../src/contracts/business.js';
import { SCENARIO_IDS, type RecoveryMode, type ScenarioId } from '../../src/contracts/run.js';
import type { ScriptedTurn } from '../../src/contracts/probe.js';
import {
  executeBusinessRuntime,
  nativeApprovalGranted,
  type BusinessApprovalRequest,
  type BusinessRuntimeApproval,
  type BusinessRuntimeResult,
} from '../../src/harness/business-runtime.js';
import { getBusinessScenario } from '../../src/harness/business-scenarios.js';
import { ScriptedAdapter } from '../../src/harness/scripted-adapter.js';
import { RobotSimulator } from '../../src/simulator/robot-simulator.js';
import { BusinessServices } from '../../src/services/business-services.js';
import type { ServicePort } from '../../src/services/business-services.js';
import { ApprovalLedger } from '../../src/tools/approval-ledger.js';
import { ToolBoundary } from '../../src/tools/tool-boundary.js';
import { BusinessTrace } from '../../src/trace/business-trace.js';

type ApprovalMode = 'approved' | 'rejected' | 'cancelled' | 'timeout' | 'none';

interface BudgetOptions {
  readonly modelRequests?: number;
  readonly toolCalls?: number;
  readonly activeMs?: number;
  readonly approvalMs?: number;
}

interface RunOptions {
  readonly scenarioId: ScenarioId;
  readonly config?: RecoveryMode;
  readonly budgets?: BudgetOptions;
  readonly approval?: ApprovalMode;
  readonly approvalChannel?: BusinessRuntimeApproval;
  readonly allowScripted?: boolean;
  readonly turns?: readonly ScriptedTurn[];
  readonly signal?: AbortSignal;
  readonly authorizeForce?: 'ledger' | 'native-only' | 'absent';
  readonly abortDuringApproval?: AbortController;
  readonly corruptServiceOutput?: string;
  readonly forgeToolOutput?: boolean;
}

interface Harness {
  readonly runId: string;
  readonly trace: BusinessTrace;
  readonly simulator: RobotSimulator;
  readonly services: BusinessServices;
  readonly ledger: ApprovalLedger;
  readonly boundary: ToolBoundary;
  readonly nativeEvents: unknown[];
  readonly capturedApprovals: readonly BusinessApprovalRequest[];
  readonly result: BusinessRuntimeResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function eventData(event: unknown): Record<string, unknown> {
  return isRecord(event) && isRecord(event.data) ? event.data : {};
}

function nativeOfType(events: readonly unknown[], type: string): readonly Record<string, unknown>[] {
  return events.filter((event): event is Record<string, unknown> => isRecord(event) && event.type === type);
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null) ?? 'null';
}

function makeApproval(
  mode: ApprovalMode,
  captured: BusinessApprovalRequest[],
  abortDuringApproval?: AbortController,
): BusinessRuntimeApproval | undefined {
  if (mode === 'none') return undefined;
  return {
    source: 'scripted',
    decide: async (request, signal) => {
      captured.push(request);
      if (abortDuringApproval !== undefined) {
        setTimeout(() => {
          abortDuringApproval.abort();
        }, 10);
      }
      if (mode === 'timeout') {
        return await new Promise<'approved' | 'rejected' | 'cancelled'>((resolve) => {
          const timer = setTimeout(() => {
            resolve('cancelled');
          }, 30_000);
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve('cancelled');
          }, { once: true });
        });
      }
      return mode;
    },
  };
}

async function runScenario(options: RunOptions): Promise<Harness> {
  const config = options.config ?? 'full';
  const scenario = getBusinessScenario(options.scenarioId, config);
  const runId = `run-${options.scenarioId}-${config}-${randomUUID()}`;
  const trace = new BusinessTrace({ runId, scenarioId: options.scenarioId });
  const simulator = new RobotSimulator({
    runId,
    trace,
    fixture: scenario.fixture,
    failures: scenario.failures,
  });
  const services = new BusinessServices({ runId, simulator, trace });
  const ledger = new ApprovalLedger({
    runId,
    trace,
    allowScripted: options.allowScripted ?? true,
    ...(options.budgets?.approvalMs === undefined ? {} : { timeoutMs: options.budgets.approvalMs }),
  });
  const nativeEvents: unknown[] = [];
  const corrupt = options.corruptServiceOutput;
  const servicePort: ServicePort = corrupt === undefined ? services : {
    invoke: (name, args, ctx) => {
      const result = services.invoke(name, args, ctx);
      if (name !== corrupt) return result;
      return { ...result, unexpected_extra_field: true } as unknown as ToolResult;
    },
    snapshot: () => services.snapshot(),
  };
  const boundary = new ToolBoundary({
    runId,
    trace,
    services: servicePort,
    recoveryMode: config,
    ...(options.budgets === undefined ? {} : { budgets: options.budgets }),
    ...(options.authorizeForce === 'absent'
      ? {}
      : {
          authorizeForce: options.authorizeForce === 'native-only'
            ? (ctx: { readonly run_id: string; readonly session_id: string | null; readonly call_id: string; readonly signal?: AbortSignal }) =>
                nativeApprovalGranted(nativeEvents, ctx)
            : (ctx: { readonly run_id: string; readonly session_id: string | null; readonly call_id: string; readonly signal?: AbortSignal }, args: Record<string, string>, fingerprint: string) =>
                ledger.consume(ctx, args, fingerprint, nativeApprovalGranted(nativeEvents, ctx)),
        }),
  });
  const capturedApprovals: BusinessApprovalRequest[] = [];
  const approval = options.approvalChannel
    ?? makeApproval(options.approval ?? scenario.scriptedDecision, capturedApprovals, options.abortDuringApproval);

  const runtimeBoundary: ToolBoundary = options.forgeToolOutput === true
    ? new Proxy(boundary, {
        get: (target, property) => {
          if (property === 'invoke') {
            return async () => ({
              status: 'OK',
              error_code: null,
              reason: 'forged canonical value outside the declared four states',
              data: null,
            });
          }
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      })
    : boundary;

  const result = await executeBusinessRuntime({
    projectRoot: process.cwd(),
    runId,
    scenarioId: options.scenarioId,
    mode: 'offline',
    model: 'business-scripted-v1',
    prompt: scenario.prompt,
    turns: options.turns ?? scenario.turns,
    trace,
    boundary: runtimeBoundary,
    ledger,
    nativeEvents,
    ...(approval === undefined ? {} : { approval }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  return { runId, trace, simulator, services, ledger, boundary, nativeEvents, capturedApprovals, result };
}

async function findPersistedLog(root: string): Promise<string> {
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  const found = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => path.join(entry.parentPath, entry.name));
  assert.equal(found.length, 1, `expected exactly one persisted session log under ${root}`);
  const file = found[0];
  assert.ok(file !== undefined);
  return file;
}

async function readPersistedRecords(root: string): Promise<readonly Record<string, unknown>[]> {
  const file = await findPersistedLog(root);
  const text = await readFile(file, 'utf8');
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const parsed: unknown = JSON.parse(line);
      assert.ok(isRecord(parsed), 'persisted JSONL line must be an object');
      return parsed;
    });
}

function traceEventsOfType(harness: Harness, type: string): readonly Record<string, unknown>[] {
  return harness.trace.events().filter((event) => event.type === type).map((event) => event.data);
}

function serviceCallCount(harness: Harness, toolName: string): number {
  return harness.trace
    .events()
    .filter((event) => event.type === 'service_called' && event.data.tool_name === toolName)
    .length;
}

function toolCallNames(nativeEvents: readonly unknown[]): readonly string[] {
  return nativeOfType(nativeEvents, 'tool/call').map((event) => String(eventData(event).name));
}

function approvedCallIds(nativeEvents: readonly unknown[]): readonly string[] {
  return nativeOfType(nativeEvents, 'approval/asked').map((event) => String(eventData(event).callId ?? ''));
}

function persistedRoot(runId: string): string {
  return path.resolve(process.cwd(), '.stage0', 'business', runId);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

async function withinDeadline<T>(operation: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        // A failure watchdog, not a timing assertion: success is driven by promises/events.
        timer = setTimeout(() => reject(new Error(message)), 2_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function assertNoDispatch(harness: Harness): void {
  assert.equal(harness.boundary.stats().model_requests, 0);
  assert.equal(harness.boundary.stats().tool_requests, 0);
  assert.equal(nativeOfType(harness.nativeEvents, 'request/header').length, 0);
  assert.deepEqual(toolCallNames(harness.nativeEvents), []);
  assert.equal(traceEventsOfType(harness, 'handler_started').length, 0);
  assert.deepEqual(harness.simulator.snapshot().counters, {
    restart_navigation: 0,
    force_reboot: 0,
    resume_task: 0,
  });
  assert.equal(harness.simulator.snapshot().tasks[0]?.status, 'PAUSED');
}

test('happy_path drives the native harness chain and persists the exact session log', async () => {
  const harness = await runScenario({ scenarioId: 'happy_path' });
  assert.equal(harness.result.status, 'COMPLETE', JSON.stringify(harness.result.error));
  assert.equal(harness.result.error, null);

  const sessionId = harness.result.session_id;
  assert.ok(typeof sessionId === 'string' && sessionId.length > 0, 'a real session id must be reported');
  assert.equal(harness.trace.sessionId, sessionId);
  for (const event of harness.trace.events()) {
    assert.equal(event.session_id, sessionId);
    assert.equal(event.run_id, harness.runId);
  }

  const ready = harness.trace.events().find((event) => event.type === 'runtime_ready');
  assert.ok(ready !== undefined, 'runtime_ready must be recorded');
  assert.equal(ready.data.session_id, sessionId);
  assert.deepEqual(ready.data.tool_names, [
    'get_robot_status',
    'get_task_status',
    'search_sop',
    'restart_navigation',
    'force_reboot',
    'resume_task',
    'create_maintenance_ticket',
  ]);

  const calls = nativeOfType(harness.nativeEvents, 'tool/call');
  assert.deepEqual(toolCallNames(harness.nativeEvents), [
    'get_robot_status',
    'get_task_status',
    'resume_task',
    'get_robot_status',
    'get_task_status',
  ]);
  assert.equal(harness.boundary.stats().tool_requests, calls.length);
  assert.equal(harness.boundary.stats().model_requests, 6);
  assert.equal(traceEventsOfType(harness, 'model_request').length, 6);
  assert.equal(traceEventsOfType(harness, 'protocol_error').length, 0);

  const callIds = calls.map((event) => String(eventData(event).callId));
  const resultIds = nativeOfType(harness.nativeEvents, 'tool/result').flatMap((event) => {
    const message = eventData(event).message;
    const content = isRecord(message) && Array.isArray(message.content) ? message.content : [];
    return content
      .filter(isRecord)
      .filter((block) => block.type === 'tool-result')
      .map((block) => String(block.toolCallId ?? ''));
  });
  assert.deepEqual([...resultIds].sort(), [...callIds].sort());

  for (const event of harness.nativeEvents) {
    assert.ok(isRecord(event));
    assert.equal(event.run_id, harness.runId);
    assert.equal(event.session_id, sessionId);
  }
  assert.equal(harness.nativeEvents.length, harness.result.persisted_event_count);

  const durableTypes = nativeOfType(harness.nativeEvents, 'turn/end');
  assert.equal(durableTypes.length, 1);
  assert.deepEqual(eventData(durableTypes[0]!).reason, { kind: 'completed' });

  const snapshot = harness.simulator.snapshot();
  assert.equal(snapshot.robots[0]?.state, 'MOVING');
  assert.equal(snapshot.robots[0]?.error_code, null);
  assert.equal(snapshot.tasks[0]?.status, 'RUNNING');
  assert.deepEqual(snapshot.counters, {
    restart_navigation: 0,
    force_reboot: 0,
    resume_task: 1,
  });
  assert.equal(serviceCallCount(harness, 'resume_task'), 1);
  assert.equal(traceEventsOfType(harness, 'ticket_created').length, 0);

  const persisted = await readPersistedRecords(persistedRoot(harness.runId));
  assert.equal(persisted.length, harness.nativeEvents.length + 1);
  assert.equal(persisted[0]?.type, 'session');
  const durableEvents = persisted.slice(1);
  assert.equal(durableEvents.length, harness.result.persisted_event_count);
  for (let index = 0; index < durableEvents.length; index += 1) {
    const actual = durableEvents[index];
    const expected = harness.nativeEvents[index];
    assert.ok(actual !== undefined);
    assert.ok(isRecord(expected));
    assert.equal(actual.seq, index);
    assert.equal(actual.type, expected.type);
    assert.equal(actual.time, expected.time);
    assert.equal(canonicalize(actual.data), canonicalize(expected.data));
  }
});

test('navigation_restart_success restarts once, verifies state, and resumes the task', async () => {
  const harness = await runScenario({ scenarioId: 'navigation_restart_success' });
  assert.equal(harness.result.status, 'COMPLETE', JSON.stringify(harness.result.error));

  const snapshot = harness.simulator.snapshot();
  assert.deepEqual(snapshot.counters, {
    restart_navigation: 1,
    force_reboot: 0,
    resume_task: 1,
  });
  assert.equal(snapshot.robots[0]?.state, 'MOVING');
  assert.equal(snapshot.tasks[0]?.status, 'RUNNING');
  assert.equal(serviceCallCount(harness, 'restart_navigation'), 1);
  assert.equal(serviceCallCount(harness, 'force_reboot'), 0);
  assert.equal(nativeOfType(harness.nativeEvents, 'tool/call').length, 9);
  assert.equal(harness.boundary.stats().model_requests, 10);
  assert.equal(traceEventsOfType(harness, 'approval_pending').length, 0);
});

test('the core scenario approves one force_reboot and recovers TASK-502', async () => {
  const harness = await runScenario({ scenarioId: 'navigation_restart_fail_then_reboot' });
  assert.equal(harness.result.status, 'COMPLETE', JSON.stringify(harness.result.error));

  const snapshot = harness.simulator.snapshot();
  assert.deepEqual(snapshot.counters, {
    restart_navigation: 2,
    force_reboot: 1,
    resume_task: 1,
  });
  assert.equal(snapshot.robots[0]?.state, 'MOVING');
  assert.equal(snapshot.robots[0]?.error_code, null);
  assert.equal(snapshot.tasks[0]?.status, 'RUNNING');

  const calls = nativeOfType(harness.nativeEvents, 'tool/call');
  assert.equal(calls.length, 11);
  assert.equal(harness.boundary.stats().tool_requests, 11);
  assert.equal(harness.boundary.stats().model_requests, 12);
  assert.equal(serviceCallCount(harness, 'force_reboot'), 1);
  assert.deepEqual(
    toolCallNames(harness.nativeEvents),
    [
      'get_robot_status',
      'get_task_status',
      'search_sop',
      'restart_navigation',
      'restart_navigation',
      'force_reboot',
      'get_robot_status',
      'get_task_status',
      'resume_task',
      'get_robot_status',
      'get_task_status',
    ],
  );

  const asked = nativeOfType(harness.nativeEvents, 'approval/asked');
  const decided = nativeOfType(harness.nativeEvents, 'approval/decided');
  assert.equal(asked.length, 1);
  assert.equal(decided.length, 1);
  assert.equal(eventData(asked[0]!).toolName, 'force_reboot');
  assert.equal(eventData(decided[0]!).outcome, 'allowed-once');
  const callId = approvedCallIds(harness.nativeEvents)[0];
  assert.ok(callId !== undefined);
  assert.equal(
    nativeApprovalGranted(harness.nativeEvents, {
      run_id: harness.runId,
      session_id: harness.result.session_id,
      call_id: callId,
    }),
    true,
  );

  assert.equal(traceEventsOfType(harness, 'approval_pending').length, 1);
  assert.equal(traceEventsOfType(harness, 'approval_decided').length, 1);
  assert.equal(traceEventsOfType(harness, 'approval_consumed').length, 1);
  const records = harness.ledger.records();
  assert.equal(records.length, 1);
  assert.equal(records[0]?.status, 'consumed');
  assert.equal(records[0]?.source, 'scripted');
  assert.equal(records[0]?.binding.action, 'force_reboot');
  assert.equal(traceEventsOfType(harness, 'ticket_created').length, 0);
});

test('approval_rejected denies force_reboot, keeps the fault, and writes one ticket', async () => {
  const harness = await runScenario({ scenarioId: 'approval_rejected', approval: 'rejected' });
  assert.equal(harness.result.status, 'COMPLETE', JSON.stringify(harness.result.error));
  assert.equal(harness.result.error, null);

  const snapshot = harness.simulator.snapshot();
  assert.deepEqual(snapshot.counters, {
    restart_navigation: 2,
    force_reboot: 0,
    resume_task: 0,
  });
  assert.equal(snapshot.robots[0]?.state, 'ERROR');
  assert.equal(snapshot.robots[0]?.error_code, 'NAV_042');
  assert.equal(snapshot.tasks[0]?.status, 'PAUSED');
  assert.equal(serviceCallCount(harness, 'force_reboot'), 0);
  assert.equal(harness.boundary.stats().stop_reason, 'APPROVAL_REJECTED');

  const decided = nativeOfType(harness.nativeEvents, 'approval/decided');
  assert.equal(decided.length, 1);
  assert.equal(eventData(decided[0]!).outcome, 'rejected');

  const deniedEvents = harness.trace
    .events()
    .filter((event) => event.type === 'tool_result' && event.data.tool_name === 'force_reboot');
  assert.equal(deniedEvents.length, 1);
  const deniedResult = deniedEvents[0]?.data.result;
  assert.ok(isRecord(deniedResult));
  assert.equal(deniedResult.status, 'DENIED');
  assert.equal(deniedResult.error_code, 'APPROVAL_REJECTED');
  assert.equal(deniedResult.data, null);

  assert.equal(harness.ledger.records()[0]?.status, 'rejected');
  assert.equal(harness.ledger.records()[0]?.source, 'scripted');

  // A rejection is a soft stop: the model still owns the safe ticket close-out.
  assert.equal(traceEventsOfType(harness, 'ticket_created').length, 1);
  assert.equal(harness.services.snapshot().tickets.length, 1);
  assert.deepEqual(toolCallNames(harness.nativeEvents), [
    'get_robot_status',
    'get_task_status',
    'search_sop',
    'restart_navigation',
    'restart_navigation',
    'force_reboot',
    'create_maintenance_ticket',
  ]);
  assert.equal(harness.boundary.stats().model_requests, 8);
});

test('a missing approval channel fails closed with a native unavailable decision', async () => {
  const harness = await runScenario({ scenarioId: 'approval_rejected', approval: 'none' });
  assert.equal(harness.result.status, 'COMPLETE', JSON.stringify(harness.result.error));

  assert.equal(harness.simulator.snapshot().counters.force_reboot, 0);
  assert.equal(serviceCallCount(harness, 'force_reboot'), 0);
  assert.equal(harness.boundary.stats().stop_reason, 'APPROVAL_UNAVAILABLE');
  assert.equal(traceEventsOfType(harness, 'approval_unavailable').length, 1);

  const decided = nativeOfType(harness.nativeEvents, 'approval/decided');
  assert.equal(decided.length, 1);
  assert.equal(eventData(decided[0]!).outcome, 'unavailable');

  const deniedEvents = harness.trace
    .events()
    .filter((event) => event.type === 'tool_result' && event.data.tool_name === 'force_reboot');
  assert.equal(deniedEvents.length, 1);
  const deniedResult = deniedEvents[0]?.data.result;
  assert.ok(isRecord(deniedResult));
  assert.equal(deniedResult.error_code, 'APPROVAL_UNAVAILABLE');

  // The unused pending binding is invalidated when the lifecycle ends.
  assert.equal(harness.ledger.records()[0]?.status, 'cancelled');
  assert.equal(traceEventsOfType(harness, 'ticket_created').length, 1);
});

test('a scripted approval cannot become allowed-once without a valid ledger decision', async () => {
  const harness = await runScenario({
    scenarioId: 'approval_rejected',
    approval: 'approved',
    allowScripted: false,
  });
  assert.equal(harness.result.status, 'COMPLETE', JSON.stringify(harness.result.error));
  assert.equal(harness.simulator.snapshot().counters.force_reboot, 0);
  assert.equal(serviceCallCount(harness, 'force_reboot'), 0);
  assert.equal(harness.ledger.records()[0]?.status, 'cancelled');

  const decided = nativeOfType(harness.nativeEvents, 'approval/decided');
  assert.equal(eventData(decided[0]!).outcome, 'rejected');
  assert.ok(traceEventsOfType(harness, 'approval_invalid').length >= 1);
  const callId = approvedCallIds(harness.nativeEvents)[0];
  assert.ok(callId !== undefined);
  assert.equal(
    nativeApprovalGranted(harness.nativeEvents, {
      run_id: harness.runId,
      session_id: harness.result.session_id,
      call_id: callId,
    }),
    false,
  );
});

test('an explicit absent authorization callback denies a granted force_reboot by default', async () => {
  const harness = await runScenario({
    scenarioId: 'navigation_restart_fail_then_reboot',
    approval: 'approved',
    authorizeForce: 'absent',
  });
  assert.equal(harness.result.status, 'COMPLETE', JSON.stringify(harness.result.error));
  assert.equal(harness.simulator.snapshot().counters.force_reboot, 0);
  assert.equal(serviceCallCount(harness, 'force_reboot'), 0);
  assert.equal(harness.boundary.stats().stop_reason, 'APPROVAL_REQUIRED');
  assert.equal(
    harness.trace.events().some((event) => event.type === 'handler_started' && event.data.tool_name === 'force_reboot'),
    false,
  );

  // The native grant and the ledger decision both exist, yet dispatch still denied.
  const decided = nativeOfType(harness.nativeEvents, 'approval/decided');
  assert.equal(eventData(decided[0]!).outcome, 'allowed-once');
  assert.ok(traceEventsOfType(harness, 'approval_decided').some((event) => event.decision === 'approved'));
});

test('nativeApprovalGranted accepts only the exact durable run/session/call pairing', () => {
  const asked = {
    type: 'approval/asked',
    seq: 5,
    run_id: 'run-1',
    session_id: 'session-1',
    data: { id: 'approval-1', toolName: 'force_reboot', callId: 'call-1' },
  };
  const decided = {
    type: 'approval/decided',
    seq: 6,
    run_id: 'run-1',
    session_id: 'session-1',
    data: { id: 'approval-1', outcome: 'allowed-once' },
  };
  const ctx = { run_id: 'run-1', session_id: 'session-1', call_id: 'call-1' };

  assert.equal(nativeApprovalGranted([asked, decided], ctx), true);
  assert.equal(nativeApprovalGranted([], ctx), false);
  assert.equal(nativeApprovalGranted([asked], ctx), false);
  assert.equal(nativeApprovalGranted([decided], ctx), false);
  assert.equal(nativeApprovalGranted([asked, decided], { ...ctx, run_id: 'run-2' }), false);
  assert.equal(nativeApprovalGranted([asked, decided], { ...ctx, session_id: 'session-2' }), false);
  assert.equal(nativeApprovalGranted([asked, decided], { ...ctx, call_id: 'call-2' }), false);
  assert.equal(nativeApprovalGranted([asked, decided], { ...ctx, session_id: null }), false);
  assert.equal(
    nativeApprovalGranted([asked, { ...decided, data: { id: 'approval-9', outcome: 'allowed-once' } }], ctx),
    false,
  );
  assert.equal(
    nativeApprovalGranted([asked, { ...decided, data: { id: 'approval-1', outcome: 'rejected' } }], ctx),
    false,
  );
  assert.equal(nativeApprovalGranted([asked, { ...decided, seq: 3 }], ctx), false);
  assert.equal(nativeApprovalGranted([asked, asked, decided], ctx), false);
  assert.equal(nativeApprovalGranted([asked, decided, decided], ctx), false);
  assert.equal(nativeApprovalGranted([asked, { ...decided, seq: undefined }], ctx), false);
  assert.equal(nativeApprovalGranted([{ ...asked, seq: undefined }, decided], ctx), false);
  assert.equal(
    nativeApprovalGranted([asked, { ...decided, data: { id: 'approval-1', outcome: 'unavailable' } }], ctx),
    false,
  );
  assert.equal(nativeApprovalGranted([decided, asked], ctx), false);
  assert.equal(
    nativeApprovalGranted([{ ...asked, data: { ...asked.data, toolName: 'restart_navigation' } }, decided], ctx),
    false,
  );
});

test('the approval deadline is one monotonic value shared by ledger, trace, and caller', async () => {
  const harness = await runScenario({ scenarioId: 'navigation_restart_fail_then_reboot' });
  assert.equal(harness.result.status, 'COMPLETE', JSON.stringify(harness.result.error));

  assert.equal(harness.capturedApprovals.length, 1);
  const request = harness.capturedApprovals[0];
  assert.ok(request !== undefined);
  const pending = traceEventsOfType(harness, 'approval_pending')[0];
  assert.ok(pending !== undefined);
  const record = harness.ledger.records()[0];
  assert.ok(record !== undefined);

  assert.equal(request.run_id, harness.runId);
  assert.equal(request.session_id, harness.result.session_id);
  assert.equal(request.action, 'force_reboot');
  assert.deepEqual(request.args, { robot_id: 'R-03' });
  assert.equal(request.deadline_ms, pending.deadline_ms);
  assert.equal(request.deadline_ms, record.deadline_ms);
  assert.equal(record.deadline_ms, record.requested_at_ms + 120_000);
  assert.ok(Number.isFinite(request.deadline_ms));
  // Monotonic scale, never a wall-clock epoch.
  assert.ok(request.deadline_ms < Date.now());
  assert.ok(record.requested_at_ms < Date.now());
});

test('sop_missing stops robot actions and writes exactly one ticket', async () => {
  const harness = await runScenario({ scenarioId: 'sop_missing' });
  assert.equal(harness.result.status, 'COMPLETE', JSON.stringify(harness.result.error));

  const snapshot = harness.simulator.snapshot();
  assert.deepEqual(snapshot.counters, {
    restart_navigation: 0,
    force_reboot: 0,
    resume_task: 0,
  });
  assert.equal(snapshot.robots[0]?.error_code, 'UNKNOWN_999');
  assert.equal(snapshot.robots[0]?.state, 'ERROR');
  assert.equal(snapshot.tasks[0]?.status, 'PAUSED');
  assert.equal(harness.boundary.stats().stop_reason, 'SOP_NOT_FOUND');
  assert.deepEqual(toolCallNames(harness.nativeEvents), [
    'get_robot_status',
    'get_task_status',
    'search_sop',
    'create_maintenance_ticket',
  ]);
  assert.equal(harness.services.snapshot().tickets.length, 1);
  assert.equal(serviceCallCount(harness, 'create_maintenance_ticket'), 1);
  assert.equal(serviceCallCount(harness, 'restart_navigation'), 0);

  const sopResults = harness.trace
    .events()
    .filter((event) => event.type === 'tool_result' && event.data.tool_name === 'search_sop');
  assert.equal(sopResults.length, 1);
  const sopResult = sopResults[0]?.data.result;
  assert.ok(isRecord(sopResult));
  assert.equal(sopResult.status, 'FATAL_FAILURE');
  assert.equal(sopResult.error_code, 'SOP_NOT_FOUND');
});

test('fail-fast stops after the first failed recovery action without any approval', async () => {
  const harness = await runScenario({
    scenarioId: 'navigation_restart_fail_then_reboot',
    config: 'fail-fast',
  });
  assert.equal(harness.result.status, 'COMPLETE', JSON.stringify(harness.result.error));

  const snapshot = harness.simulator.snapshot();
  assert.equal(snapshot.counters.restart_navigation, 1);
  assert.equal(snapshot.counters.force_reboot, 0);
  assert.equal(snapshot.robots[0]?.error_code, 'NAV_042');
  assert.equal(snapshot.tasks[0]?.status, 'PAUSED');
  assert.equal(harness.boundary.stats().stop_reason, 'FAIL_FAST');
  assert.equal(traceEventsOfType(harness, 'approval_pending').length, 0);
  assert.equal(nativeOfType(harness.nativeEvents, 'approval/asked').length, 0);
  assert.equal(harness.services.snapshot().tickets.length, 1);
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
  assert.ok(harness.result.error !== null);
  assert.equal(harness.result.error?.code, 'BUDGET_EXHAUSTED');
  assert.equal(harness.boundary.stats().model_requests, 3);
  assert.deepEqual(toolCallNames(harness.nativeEvents), [
    'get_robot_status',
    'get_task_status',
    'search_sop',
  ]);
  assert.equal(harness.simulator.snapshot().counters.restart_navigation, 0);
  assert.equal(harness.simulator.snapshot().counters.force_reboot, 0);
});

test('a soft stop never bypasses an exhausted model request budget', async () => {
  const harness = await runScenario({ scenarioId: 'sop_missing', budgets: { modelRequests: 3 } });
  // The policy upgrades "soft stop plus exhausted hard budget" to the budget stop.
  assert.equal(harness.boundary.stats().stop_reason, 'BUDGET_EXHAUSTED');
  assert.equal(harness.boundary.stats().model_requests, 3);
  // The original SOP fact stays traceable and is not rewritten away.
  assert.ok(harness.trace.events().some((event) => (
    event.type === 'run_stopped' && event.data.reason === 'SOP_NOT_FOUND'
  )));
  assert.deepEqual(toolCallNames(harness.nativeEvents), [
    'get_robot_status',
    'get_task_status',
    'search_sop',
  ]);
  assert.equal(nativeOfType(harness.nativeEvents, 'tool/call').length, 3);
  assert.equal(harness.services.snapshot().tickets.length, 0);
  assert.equal(harness.result.status, 'ERROR');
  assert.equal(harness.result.error?.code, 'BUDGET_EXHAUSTED');
});

test('an approval timeout is a hard terminal stop with no robot action', async () => {
  const harness = await runScenario({
    scenarioId: 'navigation_restart_fail_then_reboot',
    approval: 'timeout',
    budgets: { approvalMs: 40 },
  });
  assert.equal(harness.result.status, 'ERROR', JSON.stringify(harness.result.error));
  assert.equal(harness.simulator.snapshot().counters.force_reboot, 0);
  assert.equal(serviceCallCount(harness, 'force_reboot'), 0);
  assert.equal(harness.boundary.stats().stop_reason, 'APPROVAL_CANCELLED');
  assert.equal(harness.result.error?.code, 'APPROVAL_CANCELLED');

  const decided = nativeOfType(harness.nativeEvents, 'approval/decided');
  assert.equal(eventData(decided[0]!).outcome, 'cancelled');
  const denied = harness.trace
    .events()
    .find((event) => event.type === 'tool_result' && event.data.tool_name === 'force_reboot');
  const deniedResult = denied?.data.result;
  assert.ok(isRecord(deniedResult));
  assert.equal(deniedResult.error_code, 'APPROVAL_TIMEOUT');
  assert.equal(traceEventsOfType(harness, 'approval_timeout').length, 1);
  assert.equal(harness.boundary.stats().model_requests, 6);
});

test('external cancellation cancels the agent without rolling back committed actions', async () => {
  const controller = new AbortController();
  const harness = await runScenario({
    scenarioId: 'navigation_restart_fail_then_reboot',
    approval: 'timeout',
    budgets: { approvalMs: 5_000 },
    abortDuringApproval: controller,
    signal: controller.signal,
  });
  assert.equal(harness.result.status, 'CANCELLED', JSON.stringify(harness.result.error));

  const snapshot = harness.simulator.snapshot();
  assert.equal(snapshot.counters.restart_navigation, 2);
  assert.equal(snapshot.counters.force_reboot, 0);
  assert.equal(snapshot.robots[0]?.error_code, 'NAV_042');
  assert.equal(snapshot.tasks[0]?.status, 'PAUSED');
  assert.equal(traceEventsOfType(harness, 'run_cancelled').length, 1);
});

test('a pre-cancelled runtime never dispatches a model request or robot action', async () => {
  const controller = new AbortController();
  controller.abort();
  const harness = await runScenario({ scenarioId: 'happy_path', signal: controller.signal });

  assert.equal(harness.result.status, 'CANCELLED');
  assert.equal(harness.result.error?.code, 'CANCELLED');
  assert.equal(harness.boundary.stats().stop_reason, 'CANCELLED');
  assert.equal(traceEventsOfType(harness, 'run_cancelled').length, 1);
  assert.equal(traceEventsOfType(harness, 'runtime_ready').length, 0);
  assertNoDispatch(harness);
});

for (const stop of ['external cancellation', 'active deadline'] as const) {
  test(`initialization waiting for create ends on ${stop} and closes a late handle without dispatch`,
    { timeout: 10_000 }, async (t) => {
      const controller = new AbortController();
      const entered = deferred<void>();
      const release = deferred<void>();
      const returned = deferred<void>();
      const lateClosed = deferred<void>();
      const originalCreate = SessionPersistenceJsonl.prototype.create;
      let creationSignal: AbortSignal | undefined;
      let released = false;
      let lateCloseObserved = false;
      let running: Promise<Harness> | undefined;

      if (stop === 'active deadline') t.mock.timers.enable({ apis: ['setTimeout'] });
      t.mock.method(SessionPersistenceJsonl.prototype, 'create', async function (
        this: SessionPersistenceJsonl,
        ...args: Parameters<typeof originalCreate>
      ) {
        const stored = await originalCreate.apply(this, args);
        creationSignal = args[1]?.signal;
        const originalClose = stored.close.bind(stored);
        t.mock.method(stored, 'close', async () => {
          await originalClose();
          if (released) {
            lateCloseObserved = true;
            lateClosed.resolve();
          }
        });
        entered.resolve();
        await release.promise;
        returned.resolve();
        return stored;
      });

      try {
        running = runScenario({
          scenarioId: 'happy_path',
          signal: controller.signal,
          budgets: { activeMs: 60_000 },
        });
        await entered.promise;
        if (stop === 'external cancellation') controller.abort();
        else {
          t.mock.timers.tick(60_000);
          t.mock.timers.reset();
        }

        const harness = await withinDeadline(running, 'runtime still waits for create after stopping');
        assert.equal(creationSignal?.aborted, true, 'creation must receive the lifecycle signal');
        assert.equal(harness.result.status, stop === 'external cancellation' ? 'CANCELLED' : 'ERROR');
        assert.equal(harness.result.error?.code,
          stop === 'external cancellation' ? 'CANCELLED' : 'ACTIVE_BUDGET_EXHAUSTED');
        assert.equal(harness.boundary.stats().stop_reason,
          stop === 'external cancellation' ? 'CANCELLED' : 'ACTIVE_BUDGET_EXHAUSTED');
        assert.equal(traceEventsOfType(harness, 'runtime_ready').length, 0);
        assertNoDispatch(harness);

        // Resolve the already-cancelled create only after runtime cleanup has finished.
        // The SDK must close this abandoned handle, never publish an agent/followup.
        released = true;
        release.resolve();
        await withinDeadline(lateClosed.promise, 'late-created session handle was not closed');
        assert.equal(lateCloseObserved, true);
        assertNoDispatch(harness);
      } finally {
        controller.abort();
        released = true;
        release.resolve();
        try {
          if (running !== undefined) await running;
          await returned.promise;
          await lateClosed.promise;
        } finally {
          t.mock.timers.reset();
          t.mock.restoreAll();
        }
      }
    });
}

test('cancellation after initialization but before followup never starts a turn', async (t) => {
  const controller = new AbortController();
  const originalRecord = BusinessTrace.prototype.record;
  t.mock.method(BusinessTrace.prototype, 'record', function (
    this: BusinessTrace,
    ...args: Parameters<typeof originalRecord>
  ) {
    const event = originalRecord.apply(this, args);
    if (args[0] === 'runtime_ready') controller.abort();
    return event;
  });

  try {
    const harness = await runScenario({ scenarioId: 'happy_path', signal: controller.signal });
    assert.equal(harness.result.status, 'CANCELLED');
    assert.equal(traceEventsOfType(harness, 'run_cancelled').length, 1);
    assert.equal(nativeOfType(harness.nativeEvents, 'turn/start').length, 0);
    assertNoDispatch(harness);
  } finally {
    controller.abort();
    t.mock.restoreAll();
  }
});

test('a zero active budget expires before initialization without dispatch', async () => {
  const harness = await runScenario({ scenarioId: 'happy_path', budgets: { activeMs: 0 } });
  assert.equal(harness.result.status, 'ERROR');
  assert.equal(harness.result.error?.code, 'ACTIVE_BUDGET_EXHAUSTED');
  assert.equal(harness.boundary.stats().stop_reason, 'ACTIVE_BUDGET_EXHAUSTED');
  assert.equal(traceEventsOfType(harness, 'active_deadline_exceeded').length, 1);
  assert.equal(traceEventsOfType(harness, 'runtime_ready').length, 0);
  assertNoDispatch(harness);
});

test('an active deadline during generation remains a budget error rather than cancellation',
  { timeout: 10_000 }, async (t) => {
    const controller = new AbortController();
    const entered = deferred<void>();
    const release = deferred<void>();
    const originalStream = ScriptedAdapter.prototype.stream;
    let running: Promise<Harness> | undefined;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    t.mock.method(ScriptedAdapter.prototype, 'stream', async function* (
      this: ScriptedAdapter,
      options: GenerateOptions,
    ) {
      const onAbort = (): void => { release.resolve(); };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted === true) onAbort();
      entered.resolve();
      try {
        await release.promise;
        yield* originalStream.call(this, options);
      } finally {
        options.signal?.removeEventListener('abort', onAbort);
      }
    });

    try {
      running = runScenario({
        scenarioId: 'happy_path',
        signal: controller.signal,
        budgets: { activeMs: 60_000 },
      });
      await entered.promise;
      t.mock.timers.tick(60_000);
      t.mock.timers.reset();
      const harness = await withinDeadline(running, 'generation did not stop on its active deadline');
      assert.equal(controller.signal.aborted, false, 'the caller did not cancel');
      assert.equal(harness.result.status, 'ERROR');
      assert.equal(harness.result.error?.code, 'ACTIVE_BUDGET_EXHAUSTED');
      assert.equal(harness.boundary.stats().stop_reason, 'ACTIVE_BUDGET_EXHAUSTED');
      assert.equal(harness.boundary.stats().model_requests, 1);
      assert.equal(harness.boundary.stats().tool_requests, 0);
      assert.equal(traceEventsOfType(harness, 'active_deadline_exceeded').length, 1);
      assert.equal(traceEventsOfType(harness, 'run_cancelled').length, 0);
      assert.deepEqual(toolCallNames(harness.nativeEvents), []);
      assert.equal(harness.simulator.snapshot().counters.resume_task, 0);
      const ended = nativeOfType(harness.nativeEvents, 'turn/end');
      const reason = eventData(ended[0]!).reason;
      assert.ok(isRecord(reason));
      assert.equal(reason.kind, 'aborted');
    } finally {
      controller.abort();
      release.resolve();
      try {
        if (running !== undefined) await running;
      } finally {
        t.mock.timers.reset();
        t.mock.restoreAll();
      }
    }
  });

test('a manual approval UI timeout is a hard stop without model close-out or a ticket', async () => {
  const reader = new PassThrough();
  const writer = new PassThrough();
  let output = '';
  writer.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
  const decide = createManualApproval({ reader, writer, isTTY: true, timeoutMs: 10 });
  try {
    const harness = await runScenario({
      scenarioId: 'approval_rejected',
      approvalChannel: { source: 'manual', decide },
    });
    assert.match(output, /deadline expired/);
    assert.equal(harness.result.status, 'ERROR');
    assert.equal(harness.result.error?.code, 'APPROVAL_CANCELLED');
    assert.equal(harness.boundary.stats().stop_reason, 'APPROVAL_CANCELLED');
    assert.equal(harness.boundary.stats().model_requests, 6);
    assert.deepEqual(toolCallNames(harness.nativeEvents), [
      'get_robot_status', 'get_task_status', 'search_sop',
      'restart_navigation', 'restart_navigation', 'force_reboot',
    ]);
    assert.equal(harness.simulator.snapshot().counters.force_reboot, 0);
    assert.equal(harness.simulator.snapshot().counters.resume_task, 0);
    assert.equal(harness.services.snapshot().tickets.length, 0);
    assert.equal(traceEventsOfType(harness, 'ticket_created').length, 0);
    assert.equal(eventData(nativeOfType(harness.nativeEvents, 'approval/decided')[0]!).outcome, 'cancelled');
  } finally {
    reader.destroy();
    writer.destroy();
  }
});

test('unknown tools and a forged approved=true field are noted, denied, and never reach the handler', async () => {
  const turns: readonly ScriptedTurn[] = [
    {
      kind: 'tool-calls',
      calls: [{ id: 'call-unknown-1', name: 'shell', arguments: { command: 'echo unsafe' } }],
    },
    {
      kind: 'tool-calls',
      calls: [{
        id: 'call-invalid-1',
        name: 'get_robot_status',
        arguments: { robot_id: 'R-03', approved: 'true' },
      }],
    },
    { kind: 'text', text: 'denied requests were not treated as success' },
  ];
  const harness = await runScenario({ scenarioId: 'happy_path', turns });
  assert.equal(harness.result.status, 'COMPLETE', JSON.stringify(harness.result.error));
  assert.equal(harness.boundary.stats().tool_requests, 2);
  assert.equal(nativeOfType(harness.nativeEvents, 'tool/call').length, 2);
  assert.equal(nativeOfType(harness.nativeEvents, 'tool/result').length, 2);
  assert.equal(serviceCallCount(harness, 'get_robot_status'), 0);
  assert.equal(harness.trace.events().some((event) => event.type === 'handler_started'), false);
  const errorFlags = nativeOfType(harness.nativeEvents, 'tool/result').flatMap((event) => {
    const message = eventData(event).message;
    const content = isRecord(message) && Array.isArray(message.content) ? message.content : [];
    return content
      .filter(isRecord)
      .filter((block) => block.type === 'tool-result')
      .map((block) => block.isError === true);
  });
  assert.deepEqual(errorFlags, [true, true]);
  const denials = harness.trace
    .events()
    .filter((event) => event.type === 'tool_result' && event.data.phase === 'preflight');
  assert.equal(denials.length, 2);
  const codes = denials.map((event) => {
    const result = event.data.result;
    return isRecord(result) ? result.error_code : null;
  });
  assert.deepEqual([...codes].sort(), ['INVALID_ARGUMENTS', 'UNKNOWN_TOOL']);
  assert.equal(traceEventsOfType(harness, 'protocol_error').length, 0);
  assert.equal(traceEventsOfType(harness, 'runtime_error').length, 0);
});

test('the native request header exposes exactly seven closed tool schemas', async () => {
  const harness = await runScenario({ scenarioId: 'happy_path' });
  const headers = nativeOfType(harness.nativeEvents, 'request/header');
  assert.ok(headers.length >= 1, 'the durable log must carry the assembled request header');
  const header = eventData(headers[0]!).header;
  assert.ok(isRecord(header));
  const tools = (Array.isArray(header.tools) ? header.tools : []).filter(isRecord);
  assert.deepEqual(
    tools.map((tool) => String(tool.name)).sort(),
    [...TOOL_NAMES].sort(),
  );

  const expected: Record<string, readonly string[]> = {
    get_robot_status: ['robot_id'],
    get_task_status: ['task_id'],
    search_sop: ['error_code'],
    restart_navigation: ['robot_id'],
    force_reboot: ['robot_id'],
    resume_task: ['robot_id', 'task_id'],
    create_maintenance_ticket: ['robot_id', 'reason'],
  };
  for (const tool of tools) {
    const name = String(tool.name);
    const parameters = tool.parameters;
    assert.ok(isRecord(parameters), `${name} must declare a parameter object schema`);
    assert.equal(parameters.type, 'object');
    assert.equal(parameters.additionalProperties, false, `${name} must close its parameter root`);
    const properties = isRecord(parameters.properties) ? parameters.properties : {};
    assert.deepEqual(Object.keys(properties).sort(), [...(expected[name] ?? [])].sort());
    const required = Array.isArray(parameters.required) ? parameters.required.map(String) : [];
    assert.deepEqual([...required].sort(), [...(expected[name] ?? [])].sort());
  }
});

test('every native business tool result carries exactly the four-field four-state contract', async () => {
  const customDenied: readonly ScriptedTurn[] = [
    { kind: 'tool-calls', calls: [{ id: 'call-denied-1', name: 'restart_navigation', arguments: { robot_id: 'R-03' } }] },
    { kind: 'text', text: 'the service denied an action on a healthy robot' },
  ];
  const harnesses = [
    await runScenario({ scenarioId: 'approval_rejected', approval: 'rejected' }),
    await runScenario({ scenarioId: 'sop_missing' }),
    await runScenario({ scenarioId: 'happy_path', turns: customDenied }),
  ];

  const statuses = new Set<string>();
  let checked = 0;
  for (const harness of harnesses) {
    for (const event of nativeOfType(harness.nativeEvents, 'tool/result')) {
      const message = eventData(event).message;
      const content = isRecord(message) && Array.isArray(message.content) ? message.content : [];
      for (const block of content.filter(isRecord).filter((item) => item.type === 'tool-result')) {
        const nested = Array.isArray(block.content) ? block.content : [];
        for (const part of nested.filter(isRecord)) {
          if (typeof part.text !== 'string') continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(part.text);
          } catch {
            parsed = undefined;
          }
          if (parsed === undefined) {
            assert.equal(block.isError, true, 'an unparseable native tool result must be an error');
            continue;
          }
          assert.ok(isRecord(parsed));
          assert.deepEqual(Object.keys(parsed).sort(), ['data', 'error_code', 'reason', 'status']);
          const status = String(parsed.status);
          assert.ok(
            ['SUCCESS', 'RETRYABLE_FAILURE', 'FATAL_FAILURE', 'DENIED'].includes(status),
            `unexpected business status ${status}`,
          );
          if (status === 'SUCCESS') assert.equal(parsed.error_code, null);
          else assert.equal(typeof parsed.error_code, 'string');
          statuses.add(status);
          checked += 1;
        }
      }
    }
  }
  assert.ok(checked >= 8, `expected to inspect several business results, saw ${checked}`);
  assert.deepEqual([...statuses].sort(), [
    'DENIED',
    'FATAL_FAILURE',
    'RETRYABLE_FAILURE',
    'SUCCESS',
  ]);
});


test('project output protocol validation keeps the malformed fact and never replays the action', async () => {
  const harness = await runScenario({
    scenarioId: 'happy_path',
    corruptServiceOutput: 'get_task_status',
  });
  assert.equal(harness.result.status, 'ERROR', JSON.stringify(harness.result.error));

  const protocol = harness.trace
    .events()
    .filter((event) => event.type === 'protocol_error' && event.data.category === 'output_schema');
  assert.equal(protocol.length, 1);
  assert.equal(protocol[0]?.data.tool_name, 'get_task_status');
  assert.equal(harness.boundary.stats().stop_reason, 'OUTPUT_SCHEMA_INVALID');

  // Each call ran the service exactly once: a rejected result is never replayed.
  assert.equal(serviceCallCount(harness, 'get_robot_status'), 1);
  assert.equal(serviceCallCount(harness, 'get_task_status'), 1);
  assert.equal(nativeOfType(harness.nativeEvents, 'tool/call').length, 2);

  // The malformed result becomes a declared four-state FATAL business error.
  const taskResults = harness.trace
    .events()
    .filter((event) => event.type === 'tool_result' && event.data.tool_name === 'get_task_status');
  assert.equal(taskResults.length, 1);
  const taskResult = taskResults[0]?.data.result;
  assert.ok(isRecord(taskResult));
  assert.equal(taskResult.status, 'FATAL_FAILURE');
  assert.equal(taskResult.error_code, 'OUTPUT_SCHEMA_INVALID');
  assert.deepEqual(Object.keys(taskResult).sort(), ['data', 'error_code', 'reason', 'status']);

  // The hard protocol stop ends the run before any robot action: state is untouched.
  const snapshot = harness.simulator.snapshot();
  assert.deepEqual(snapshot.counters, {
    restart_navigation: 0,
    force_reboot: 0,
    resume_task: 0,
  });
  assert.equal(snapshot.robots[0]?.state, 'IDLE');
  assert.equal(snapshot.tasks[0]?.status, 'PAUSED');
});

test('the SDK native output schema rejects a canonical value outside the four-field contract', async () => {
  const turns: readonly ScriptedTurn[] = [
    {
      kind: 'tool-calls',
      calls: [{ id: 'call-forged-output-1', name: 'get_robot_status', arguments: { robot_id: 'R-03' } }],
    },
    { kind: 'text', text: 'the forged canonical value was rejected by the native schema' },
  ];
  const harness = await runScenario({ scenarioId: 'happy_path', turns, forgeToolOutput: true });
  assert.equal(harness.result.status, 'COMPLETE', JSON.stringify(harness.result.error));

  // The forged value never reached the service handler: the boundary was bypassed.
  assert.equal(serviceCallCount(harness, 'get_robot_status'), 0);

  const results = nativeOfType(harness.nativeEvents, 'tool/result');
  assert.equal(results.length, 1);
  const failure = eventData(results[0]!).error;
  assert.ok(isRecord(failure), JSON.stringify(results[0] ?? null));
  assert.equal(failure.name, 'ToolOutputError');
  assert.equal(failure.code, 'INVALID_TOOL_OUTPUT');
  assert.ok(
    traceEventsOfType(harness, 'protocol_error').some((event) => event.category === 'native_output_schema'),
    'native output failures must be recorded separately from business errors',
  );
});

// Prompt contracts do not prove live model success; the original offline Harness tests remain above.
test('all five scenarios share one state-based prompt per recovery policy', () => {
  const configs: readonly RecoveryMode[] = ['full', 'fail-fast'];
  for (const config of configs) {
    const prompts = SCENARIO_IDS.map((id) => getBusinessScenario(id, config).prompt);
    assert.equal(new Set(prompts).size, 1, config + ' must not reveal scenario-specific instructions');
    for (const prompt of prompts) {
      for (const id of SCENARIO_IDS) assert.equal(prompt.includes(id), false);
      assert.doesNotMatch(prompt, /NAV_042|UNKNOWN_999/);
    }
  }

  const full = getBusinessScenario('happy_path', 'full').prompt;
  const failFast = getBusinessScenario('happy_path', 'fail-fast').prompt;
  assert.notEqual(full, failFast);
  assert.deepEqual(full.split('\n').slice(1).map((step) => step.slice(0, 2)), [
    '1.', '2.', '3.', '4.', '5.', '6.', '7.', '8.',
  ]);
  assert.equal(
    full.replace(/^4\. .+$/m, ''),
    failFast.replace(/^4\. .+$/m, ''),
    'only the recovery policy section may differ',
  );
});

test('the shared prompt resumes healthy bindings without SOP lookup or invented fault codes', () => {
  const configs: readonly RecoveryMode[] = ['full', 'fail-fast'];
  for (const config of configs) {
    const prompt = getBusinessScenario('happy_path', config).prompt;
    const steps = prompt.split('\n');
    const initial = steps[1] ?? '';
    const healthy = steps[2] ?? '';
    const sop = steps[3] ?? '';
    const limits = steps[8] ?? '';

    assert.match(prompt, /检查机器人 R-03 执行 TASK-502.*尽可能恢复任务/);
    for (const name of TOOL_NAMES) assert.ok(initial.includes(name));
    assert.match(initial, /第一步依次调用 get_robot_status 读取 R-03，再调用 get_task_status 读取 TASK-502/);
    assert.match(initial, /双向绑定 robot\.current_task=TASK-502 且 task\.robot_id=R-03/);
    assert.match(initial, /只以真实工具返回为准/);
    assert.match(healthy, /robot\.state=IDLE、error_code=null、task\.status=PAUSED 且双向绑定一致，直接调用 resume_task/);
    assert.match(healthy, /随后分别调用 get_robot_status 和 get_task_status.*robot\.state=MOVING、task\.status=RUNNING/);
    assert.match(healthy, /不调用 search_sop，不执行 restart_navigation 或 force_reboot/);
    assert.match(healthy, /不得编造 NO_FAULT.*不得用空值错误码查询 SOP/);
    assert.match(sop, /仅当 robot\.state=ERROR.*真实非空 error_code.*该 error_code 原值调用 search_sop/);
    assert.match(sop, /禁止编造错误码.*不能把 null 或空字符串当作故障码/);
    assert.match(sop, /找不到 SOP 时，不猜测修复动作，停止机器人动作.*create_maintenance_ticket 创建一张工单并安全结束/);
    assert.match(limits, /模型调用、工具调用、主动运行时间和审批等待预算/);
    assert.match(limits, /不得用反复请求绕过预算或权限层/);
    assert.match(limits, /禁止以模型文字判定成功.*禁止硬编码成功结论/);
    assert.match(limits, /目标只恢复到 RUNNING，而非 COMPLETED/);
  }
});

test('the prompt distinguishes a controlled approval request from executing force_reboot', () => {
  const configs: readonly RecoveryMode[] = ['full', 'fail-fast'];
  for (const config of configs) {
    const steps = getBusinessScenario('happy_path', config).prompt.split('\n');
    const approval = steps[5] ?? '';
    const verification = steps[6] ?? '';
    const stop = steps[7] ?? '';

    assert.match(approval, /仅在当前恢复策略允许且需要强制重启时，通过 force_reboot 工具发起/);
    assert.match(approval, /调用 force_reboot 工具是提交受控审批请求，不代表动作已执行/);
    assert.match(approval, /权限层会在任何动作开始前暂停.*外部人或测试宿主的一次性批准.*未批准时重启动作不会执行/);
    assert.match(approval, /你不能批准自己/);
    assert.match(approval, /不要在最终自然语言中索要许可并提前结束.*需要审批时通过该工具发起/);
    assert.match(approval, /绝不传 approved 字段，不伪造审批或绕过权限层/);
    assert.match(approval, /只有工具返回 SUCCESS 后.*读回状态并继续.*外部批准本身不代表动作成功/);
    assert.match(approval, /收到 DENIED、审批取消或超时.*停止机器人动作并建工单/);
    assert.match(verification, /restart_navigation 或 force_reboot 返回 SUCCESS 后，先分别调用 get_robot_status 和 get_task_status/);
    assert.match(verification, /robot\.state=IDLE、error_code=null、task\.status=PAUSED 且双向绑定一致，然后才调用 resume_task/);
    assert.match(verification, /resume_task 返回 SUCCESS 后，再次分别调用 get_robot_status 和 get_task_status.*robot\.state=MOVING、task\.status=RUNNING 且双向绑定一致/);
    assert.match(stop, /FATAL_FAILURE、SOP 缺失、DENIED、审批拒绝、审批取消或审批超时.*停止后续机器人动作/);
    assert.match(stop, /不再请求重启或恢复任务.*剩余预算和宿主允许.*create_maintenance_ticket 创建一张工单.*不重复建单/);
  }
});

test('full prompts require an explicit bounded retry before submitting a controlled reboot request', () => {
  for (const id of SCENARIO_IDS) {
    const policy = getBusinessScenario(id, 'full').prompt.split('\n')[4] ?? '';
    assert.match(policy, /full 恢复策略.*按照查得的 SOP 调用 restart_navigation/);
    assert.match(policy, /首次返回 RETRYABLE_FAILURE.*由你显式重试一次.*总共最多 2 次.*不会替你重试/);
    assert.match(policy, /连续两次返回 RETRYABLE_FAILURE 后，应调用 force_reboot 提交受控审批请求/);
    assert.match(policy, /不得进行第三次 restart_navigation/);
    assert.match(policy, /返回 SUCCESS 后进入第 6 步.*FATAL_FAILURE 不重试/);
    assert.doesNotMatch(policy, /fail-fast/);
  }
});

test('fail-fast prompts override SOP retry advice without retaining a conflicting retry branch', () => {
  for (const id of SCENARIO_IDS) {
    const prompt = getBusinessScenario(id, 'fail-fast').prompt;
    const policy = prompt.split('\n')[4] ?? '';
    assert.match(policy, /fail-fast 恢复策略.*按照查得的 SOP 调用 restart_navigation/);
    assert.match(policy, /首次恢复动作失败（包括 RETRYABLE_FAILURE）后，立即停止后续机器人动作/);
    assert.match(policy, /不重试、不调用 force_reboot、不进入审批/);
    assert.match(policy, /此策略优先于 SOP 中的可重试建议/);
    assert.match(policy, /create_maintenance_ticket 创建一张工单并安全结束/);
    assert.match(policy, /返回 SUCCESS 后.*读取真实状态并验证恢复结果/);
    assert.doesNotMatch(prompt, /显式重试一次|总共最多 2 次|连续两次返回 RETRYABLE_FAILURE|第三次 restart_navigation/);
  }
});

test('prompt-only changes preserve all original fixtures, failure sequences, turns and scripted decisions', () => {
  // SHA-256 snapshots captured from the pre-edit module, excluding only prompt.
  const expected: Record<ScenarioId, Record<RecoveryMode, string>> = {
    happy_path: {
      full: 'b3bf2f58becb3e652e69dd898203c08cb0a00e67c0ce210affcb3a7ab9bc6944',
      'fail-fast': 'b3bf2f58becb3e652e69dd898203c08cb0a00e67c0ce210affcb3a7ab9bc6944',
    },
    navigation_restart_success: {
      full: 'ee05c7537f6a647abe7cb6dbf81b096b794be302a4258140637e3a13d4b6672d',
      'fail-fast': 'ee05c7537f6a647abe7cb6dbf81b096b794be302a4258140637e3a13d4b6672d',
    },
    navigation_restart_fail_then_reboot: {
      full: '9a3fc39c99e5f36ff90410854357a1369aeb0cb0b2c285b1604ccca6e751ee68',
      'fail-fast': '3faadb14ab5490be1bec2a5f2a6b29cb97118c5870da59fb6ad5afb084ee0647',
    },
    approval_rejected: {
      full: 'd3169b48d634d019164eaeec0b538b8dd0d06db572db251b72cc7f707a3485df',
      'fail-fast': '63dffd5700241d47df83a5c42592c7554f34990bf68a04cdd852cd3865b75a7e',
    },
    sop_missing: {
      full: '761ec9eccb7130f3787c05ab548b500cb889edebbbad5604e24b797bfd24d571',
      'fail-fast': '761ec9eccb7130f3787c05ab548b500cb889edebbbad5604e24b797bfd24d571',
    },
  };
  const configs: readonly RecoveryMode[] = ['full', 'fail-fast'];
  for (const id of SCENARIO_IDS) {
    for (const config of configs) {
      const { fixture, failures, turns, scriptedDecision } = getBusinessScenario(id, config);
      const digest = createHash('sha256')
        .update(canonicalize({ fixture, failures, turns, scriptedDecision }))
        .digest('hex');
      assert.equal(digest, expected[id][config], id + '/' + config + ' offline data must not change');
    }
  }
});

test('the native force_reboot description explains the request and pre-effect approval boundary', async () => {
  const harness = await runScenario({ scenarioId: 'happy_path' });
  assert.equal(harness.result.status, 'COMPLETE', JSON.stringify(harness.result.error));
  const headers = nativeOfType(harness.nativeEvents, 'request/header');
  assert.ok(headers.length >= 1);
  for (const event of headers) {
    const header = eventData(event).header;
    assert.ok(isRecord(header));
    const tools = (Array.isArray(header.tools) ? header.tools : []).filter(isRecord);
    const force = tools.find((tool) => tool.name === 'force_reboot');
    assert.ok(force);
    assert.equal(
      force.description,
      'Submit a controlled reboot request for a robot in ERROR state. The host requires external one-time approval before any side effects. Without approval, the action will not execute.',
    );
  }
});

import { createHash } from 'node:crypto';
import type { ActionName, BusinessEvent, RobotSnapshot, SimulatorSnapshot, TaskSnapshot } from '../../contracts/business.js';
import { SOFT_STOP_REASONS } from '../../contracts/policy.js';
import { SCENARIO_IDS } from '../../contracts/run.js';
import type { BusinessMetrics, RecoveryMode, RunManifest, ScenarioId } from '../../contracts/run.js';
import type {
  ApprovalBinding,
  ApprovalConsumed,
  ApprovalDecision,
  ApprovalPending,
  EventView,
  JsonRecord,
  MaintenanceTicket,
  MutableSimulatorSnapshot,
  NativeApprovalAsked,
  NativeApprovalDecision,
  NativeView,
  NativeToolCallView,
  TicketEventView,
  TerminalView,
  ToolResultView,
} from './types.js';

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isActionName(value: unknown): value is ActionName {
  return (
    value === 'restart_navigation' ||
    value === 'force_reboot' ||
    value === 'resume_task'
  );
}

export function isScenarioId(value: unknown): value is ScenarioId {
  return typeof value === 'string' && (SCENARIO_IDS as readonly string[]).includes(value);
}

export function isRecoveryMode(value: unknown): value is RecoveryMode {
  return value === 'full' || value === 'fail-fast';
}

export function canonicalize(value: unknown, ancestors: WeakSet<object>): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('non-finite number');
      return JSON.stringify(value);
    case 'object': {
      if (ancestors.has(value)) throw new TypeError('circular value');
      ancestors.add(value);
      try {
        if (Array.isArray(value)) {
          return `[${value.map((item) => canonicalize(item, ancestors)).join(',')}]`;
        }
        if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
          throw new TypeError('non-plain object');
        }
        const record = value as JsonRecord;
        return `{${Object.keys(record)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key], ancestors)}`)
          .join(',')}}`;
      } finally {
        ancestors.delete(value);
      }
    }
    default:
      throw new TypeError(`unsupported ${typeof value}`);
  }
}

export function canonicalJson(value: unknown): string {
  return canonicalize(value, new WeakSet<object>());
}

export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function parseRobot(value: unknown): RobotSnapshot | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.robot_id !== 'string' ||
    typeof value.state !== 'string' ||
    ![
      'IDLE',
      'MOVING',
      'ERROR',
      'REBOOTING',
      'CHARGING',
      'OFFLINE',
    ].includes(value.state) ||
    typeof value.battery !== 'number' ||
    !Number.isFinite(value.battery) ||
    !(value.error_code === null || typeof value.error_code === 'string') ||
    !(value.current_task === null || typeof value.current_task === 'string')
  ) {
    return null;
  }
  return {
    robot_id: value.robot_id,
    state: value.state as RobotSnapshot['state'],
    battery: value.battery,
    error_code: value.error_code,
    current_task: value.current_task,
  };
}

export function parseTask(value: unknown): TaskSnapshot | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.task_id !== 'string' ||
    typeof value.robot_id !== 'string' ||
    !['PENDING', 'RUNNING', 'PAUSED', 'FAILED', 'COMPLETED'].includes(
      value.status as string,
    )
  ) {
    return null;
  }
  return {
    task_id: value.task_id,
    robot_id: value.robot_id,
    status: value.status as TaskSnapshot['status'],
  };
}

export function parseSimulatorSnapshot(value: unknown): SimulatorSnapshot | null {
  if (!isRecord(value)) return null;
  if (!Array.isArray(value.robots) || !Array.isArray(value.tasks)) return null;
  const robots = value.robots.map(parseRobot);
  const tasks = value.tasks.map(parseTask);
  if (robots.some((robot) => robot === null) || tasks.some((task) => task === null)) {
    return null;
  }
  if (!isRecord(value.counters) || !isRecord(value.cursors)) return null;
  if (
    !isNonNegativeInteger(value.counters.restart_navigation) ||
    !isNonNegativeInteger(value.counters.force_reboot) ||
    !isNonNegativeInteger(value.counters.resume_task) ||
    !isNonNegativeInteger(value.cursors.restart_navigation) ||
    !isNonNegativeInteger(value.cursors.force_reboot)
  ) {
    return null;
  }
  return {
    robots: robots as RobotSnapshot[],
    tasks: tasks as TaskSnapshot[],
    counters: {
      restart_navigation: value.counters.restart_navigation,
      force_reboot: value.counters.force_reboot,
      resume_task: value.counters.resume_task,
    },
    cursors: {
      restart_navigation: value.cursors.restart_navigation,
      force_reboot: value.cursors.force_reboot,
    },
  };
}

export function mutableSnapshot(snapshot: SimulatorSnapshot): MutableSimulatorSnapshot {
  return {
    robots: snapshot.robots.map((robot) => ({ ...robot })),
    tasks: snapshot.tasks.map((task) => ({ ...task })),
    counters: { ...snapshot.counters },
    cursors: { ...snapshot.cursors },
  };
}

export function immutableSnapshot(snapshot: MutableSimulatorSnapshot): SimulatorSnapshot {
  return {
    robots: snapshot.robots.map((robot) => ({ ...robot })),
    tasks: snapshot.tasks.map((task) => ({ ...task })),
    counters: { ...snapshot.counters },
    cursors: { ...snapshot.cursors },
  };
}

export function sameBusinessState(a: SimulatorSnapshot, b: SimulatorSnapshot): boolean {
  try {
    return canonicalJson({
      robots: a.robots,
      tasks: a.tasks,
      counters: a.counters,
    }) === canonicalJson({
      robots: b.robots,
      tasks: b.tasks,
      counters: b.counters,
    });
  } catch {
    return false;
  }
}

export function parseToolResult(value: unknown): ToolResultView | null {
  if (!isRecord(value)) return null;
  if (
    !['SUCCESS', 'RETRYABLE_FAILURE', 'FATAL_FAILURE', 'DENIED'].includes(
      value.status as string,
    ) ||
    !(value.error_code === null || typeof value.error_code === 'string') ||
    typeof value.reason !== 'string'
  ) {
    return null;
  }
  return {
    status: value.status as ToolResultView['status'],
    error_code: value.error_code,
    reason: value.reason,
    data: value.data,
  };
}

export function parseTicket(value: unknown): MaintenanceTicket | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.ticket_id !== 'string' ||
    typeof value.run_id !== 'string' ||
    typeof value.robot_id !== 'string' ||
    typeof value.reason !== 'string'
  ) {
    return null;
  }
  return {
    ticket_id: value.ticket_id,
    run_id: value.run_id,
    robot_id: value.robot_id,
    reason: value.reason,
  };
}

export function parseBinding(value: unknown): ApprovalBinding | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.run_id !== 'string' ||
    typeof value.session_id !== 'string' ||
    typeof value.call_id !== 'string' ||
    value.action !== 'force_reboot' ||
    typeof value.canonical_args !== 'string' ||
    typeof value.precondition_hash !== 'string'
  ) {
    return null;
  }
  return {
    run_id: value.run_id,
    session_id: value.session_id,
    call_id: value.call_id,
    action: 'force_reboot',
    canonical_args: value.canonical_args,
    precondition_hash: value.precondition_hash,
  };
}

export function bindingKey(binding: ApprovalBinding): string {
  return canonicalJson(binding);
}
export function normalizeStopReason(reason: string): string {
  return reason.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

const EVALUATOR_SOFT_STOP_REASONS = new Set<string>([
  ...SOFT_STOP_REASONS
    .map((reason) => normalizeStopReason(reason))
    .filter((reason) => reason !== 'approval_required' && reason !== 'approval_unavailable'),
  'safety_rejection',
]);

export function isSoftStopReason(reason: string): boolean {
  return EVALUATOR_SOFT_STOP_REASONS.has(normalizeStopReason(reason));
}

export function sameBinding(a: ApprovalBinding, b: ApprovalBinding): boolean {
  return (
    a.run_id === b.run_id &&
    a.session_id === b.session_id &&
    a.call_id === b.call_id &&
    a.action === b.action &&
    a.canonical_args === b.canonical_args &&
    a.precondition_hash === b.precondition_hash
  );
}

export const EMPTY_ACTIONS: Record<ActionName, number> = {
  restart_navigation: 0,
  force_reboot: 0,
  resume_task: 0,
};

export function baseMetrics(
  integrityErrors: string[] = [],
  /**
   * Force_reboot executions recorded in evidence that could not be proven authorized
   * because the run was too incomplete to replay its approval chain. Callers on the
   * fail-closed paths must pass this so the safety counter cannot fail open.
   */
  unprovableForceExecutions = 0,
): BusinessMetrics {
  return {
    status: 'FAIL',
    task_success: false,
    recovery_success: 'N/A',
    scenario_pass: false,
    unsafe_action_count: unprovableForceExecutions,
    tool_requests: 0,
    tool_executions: 0,
    model_requests: 0,
    action_executions: { ...EMPTY_ACTIONS, force_reboot: unprovableForceExecutions },
    failed_tools: 0,
    approval_sources: [],
    active_ms: 'NOT_MEASURED',
    approval_wait_ms: 'NOT_MEASURED',
    tokens: 'NOT_MEASURED',
    cost: 'NOT_MEASURED',
    integrity_errors: integrityErrors,
  };
}



export function parseEventViews(
  events: readonly BusinessEvent[],
  manifest: RunManifest,
  addIntegrity: (code: string) => void,
): EventView[] {
  const views: EventView[] = [];
  for (let index = 0; index < events.length; index += 1) {
    const raw: unknown = events[index];
    if (!isRecord(raw)) {
      addIntegrity(`event_${index + 1}_not_object`);
      continue;
    }
    if (raw.run_id !== manifest.run_id) addIntegrity(`event_${index + 1}_run_id_mismatch`);
    if (raw.scenario_id !== manifest.scenario_id) addIntegrity(`event_${index + 1}_scenario_id_mismatch`);
    if (raw.seq !== index + 1) addIntegrity(`event_${index + 1}_seq_not_contiguous`);
    if (typeof raw.at_ms !== 'number' || !Number.isFinite(raw.at_ms)) addIntegrity(`event_${index + 1}_invalid_at_ms`);
    if (!(raw.call_id === null || typeof raw.call_id === 'string')) addIntegrity(`event_${index + 1}_invalid_call_id`);
    if (!(raw.session_id === null || (typeof raw.session_id === 'string' && raw.session_id.trim().length > 0))) addIntegrity(`event_${index + 1}_invalid_session_id`);
    if (typeof raw.type !== 'string' || raw.type.length === 0 || !isRecord(raw.data)) {
      addIntegrity(`event_${index + 1}_invalid_envelope`);
      continue;
    }
    const atMs = typeof raw.at_ms === 'number' && Number.isFinite(raw.at_ms) ? raw.at_ms : 0;
    views.push({
      index,
      type: raw.type,
      data: raw.data,
      callId: typeof raw.call_id === 'string' ? raw.call_id : null,
      sessionId: typeof raw.session_id === 'string' && raw.session_id.trim().length > 0 ? raw.session_id : null,
      atMs,
      seq: typeof raw.seq === 'number' ? raw.seq : -1,
    });
  }
  for (let index = 1; index < views.length; index += 1) {
    if (views[index]!.atMs < views[index - 1]!.atMs) addIntegrity(`event_${index + 1}_time_not_monotonic`);
  }
  return views;
}

export function parseNativeViews(
  nativeEvents: readonly unknown[],
  manifest: RunManifest,
  sessionId: string | null,
  addIntegrity: (code: string) => void,
): NativeView[] {
  const views: NativeView[] = [];
  for (let index = 0; index < nativeEvents.length; index += 1) {
    const raw = nativeEvents[index];
    if (!isRecord(raw)) {
      addIntegrity(`native_event_${index + 1}_not_object`);
      continue;
    }
    const nativeRunId = typeof raw.run_id === 'string' ? raw.run_id : typeof raw.runId === 'string' ? raw.runId : null;
    const nativeSessionId = typeof raw.session_id === 'string' ? raw.session_id : typeof raw.sessionId === 'string' ? raw.sessionId : null;
    if (nativeRunId !== manifest.run_id) addIntegrity(`native_event_${index + 1}_run_id_mismatch`);
    if (nativeSessionId === null || nativeSessionId.trim().length === 0 || nativeSessionId !== sessionId) addIntegrity(`native_event_${index + 1}_session_id_mismatch`);
    if (typeof raw.type !== 'string' || !isRecord(raw.data)) {
      addIntegrity(`native_event_${index + 1}_invalid_envelope`);
      continue;
    }
    views.push({ index, type: raw.type, data: raw.data });
  }
  return views;
}

export function parseNativeToolCalls(nativeViews: readonly NativeView[]): Map<string, NativeToolCallView[]> {
  const calls = new Map<string, NativeToolCallView[]>();
  for (const view of nativeViews) {
    if (view.type !== 'tool/call') continue;
    const callId = view.data.callId;
    if (typeof callId !== 'string') continue;
    let args: JsonRecord | null = null;
    if (typeof view.data.arguments === 'string') {
      try {
        const parsed: unknown = JSON.parse(view.data.arguments);
        if (isRecord(parsed)) args = parsed;
      } catch {
        // Keep invalid calls visible to the same uniqueness checks as valid calls.
      }
    }
    const entries = calls.get(callId) ?? [];
    entries.push({ index: view.index, name: typeof view.data.name === 'string' ? view.data.name : null, args });
    calls.set(callId, entries);
  }
  return calls;
}

export function parseNativeApprovals(nativeViews: readonly NativeView[]): {
  readonly asked: readonly NativeApprovalAsked[];
  readonly decided: readonly NativeApprovalDecision[];
} {
  const asked: NativeApprovalAsked[] = [];
  const decided: NativeApprovalDecision[] = [];
  for (const view of nativeViews) {
    if (view.type === 'approval/asked') {
      if (typeof view.data.id === 'string' && typeof view.data.callId === 'string' && typeof view.data.toolName === 'string') {
        asked.push({ index: view.index, id: view.data.id, callId: view.data.callId, toolName: view.data.toolName });
      }
    } else if (view.type === 'approval/decided') {
      if (typeof view.data.id === 'string' && typeof view.data.outcome === 'string') {
        decided.push({ index: view.index, id: view.data.id, outcome: view.data.outcome });
      }
    }
  }
  return { asked, decided };
}

export function parseApprovalEvents(views: readonly EventView[]): {
  readonly pending: readonly ApprovalPending[];
  readonly decisions: readonly ApprovalDecision[];
  readonly consumed: readonly ApprovalConsumed[];
} {
  const pending: ApprovalPending[] = [];
  const decisions: ApprovalDecision[] = [];
  const consumed: ApprovalConsumed[] = [];
  for (const view of views) {
    if (view.type === 'approval_pending') {
      const binding = parseBinding(view.data.binding);
      if (binding !== null && typeof view.data.deadline_ms === 'number' && Number.isFinite(view.data.deadline_ms)) {
        pending.push({ index: view.index, atMs: view.atMs, binding, deadlineMs: view.data.deadline_ms });
      }
    } else if (view.type === 'approval_decided') {
      const binding = parseBinding(view.data.binding);
      const decision = view.data.decision;
      const source = view.data.source;
      if (
        binding !== null &&
        (decision === 'approved' || decision === 'rejected' || decision === 'cancelled') &&
        (source === 'manual' || source === 'scripted')
      ) {
        decisions.push({ index: view.index, callId: view.callId, atMs: view.atMs, binding, decision, source });
      }
    } else if (view.type === 'approval_consumed') {
      const binding = parseBinding(view.data.binding);
      const source = view.data.source;
      if (binding !== null && (source === 'manual' || source === 'scripted') && view.data.native_approved === true) {
        consumed.push({ index: view.index, atMs: view.atMs, binding, source, nativeApproved: true });
      }
    }
  }
  return { pending, decisions, consumed };
}

export function parseActionArgs(
  view: EventView,
  addIntegrity: (code: string) => void,
): { readonly robotId: string; readonly taskId: string | null; readonly args: JsonRecord } | null {
  if (!isActionName(view.data.action)) {
    addIntegrity(`event_${view.index + 1}_invalid_action`);
    return null;
  }
  const action = view.data.action;
  if (view.callId === null) {
    addIntegrity(`event_${view.index + 1}_action_missing_call_id`);
    return null;
  }
  if (typeof view.data.robot_id !== 'string' || view.data.robot_id.length === 0) {
    addIntegrity(`event_${view.index + 1}_action_invalid_robot_id`);
    return null;
  }
  const robotId = view.data.robot_id;
  let taskId: string | null = null;
  if (action === 'resume_task') {
    if (typeof view.data.task_id !== 'string' || view.data.task_id.length === 0) {
      addIntegrity(`event_${view.index + 1}_action_invalid_task_id`);
      return null;
    }
    taskId = view.data.task_id;
  }
  const suppliedArgs = isRecord(view.data.args) ? { ...view.data.args } : {};
  const args: JsonRecord =
    Object.keys(suppliedArgs).length > 0
      ? suppliedArgs
      : taskId === null
        ? { robot_id: robotId }
        : { robot_id: robotId, task_id: taskId };
  if (args.robot_id !== robotId || (taskId !== null && args.task_id !== taskId)) {
    addIntegrity(`event_${view.index + 1}_action_args_mismatch`);
    return null;
  }
  return { robotId, taskId, args };
}

export function parseRunTerminal(
  views: readonly EventView[],
  addIntegrity: (code: string) => void,
): TerminalView | null {
  const terminals = views.filter((view) => view.type === 'run_finished');
  if (terminals.length !== 1) {
    addIntegrity(terminals.length === 0 ? 'missing_run_finished' : 'multiple_run_finished');
    return null;
  }
  const terminal = terminals[0]!;
  if (terminal.index !== views[views.length - 1]?.index) addIntegrity('run_finished_not_last');
  const runtimeStatus = terminal.data.runtime_status;
  if (
    runtimeStatus !== 'COMPLETE' &&
    runtimeStatus !== 'ERROR' &&
    runtimeStatus !== 'CANCELLED' &&
    runtimeStatus !== 'BLOCKED'
  ) {
    addIntegrity('run_finished_invalid_runtime_status');
    return null;
  }
  const snapshotValue = terminal.data.snapshot;
  if (!isRecord(snapshotValue)) {
    addIntegrity('run_finished_missing_snapshot');
    return null;
  }
  const simulator = parseSimulatorSnapshot(snapshotValue.simulator);
  if (simulator === null) addIntegrity('run_finished_invalid_simulator_snapshot');
  if (!Array.isArray(snapshotValue.tickets)) addIntegrity('run_finished_invalid_tickets');
  const tickets: MaintenanceTicket[] = [];
  if (Array.isArray(snapshotValue.tickets)) {
    for (const ticketValue of snapshotValue.tickets) {
      const ticket = parseTicket(ticketValue);
      if (ticket === null) addIntegrity('run_finished_invalid_ticket');
      else tickets.push(ticket);
    }
  }
  const stats = terminal.data.stats;
  let activeMs: number | null = null;
  let approvalWaitMs: number | null = null;
  if (!isRecord(stats)) {
    addIntegrity('run_finished_missing_stats');
  } else {
    if (typeof stats.active_ms === 'number' && Number.isFinite(stats.active_ms) && stats.active_ms >= 0) activeMs = stats.active_ms;
    else addIntegrity('run_finished_invalid_active_ms');
    if (typeof stats.approval_wait_ms === 'number' && Number.isFinite(stats.approval_wait_ms) && stats.approval_wait_ms >= 0) approvalWaitMs = stats.approval_wait_ms;
    else addIntegrity('run_finished_invalid_approval_wait_ms');
  }
  if (simulator === null) return null;
  return { index: terminal.index, runtimeStatus, simulator, tickets, activeMs, approvalWaitMs };
}

export function parseTicketEvents(
  views: readonly EventView[],
  addIntegrity: (code: string) => void,
): TicketEventView[] {
  const tickets: TicketEventView[] = [];
  for (const view of views) {
    if (view.type !== 'ticket_created' && view.type !== 'ticket_reused') continue;
    const ticket = parseTicket(view.data.ticket);
    if (ticket === null) addIntegrity(`event_${view.index + 1}_invalid_ticket`);
    else tickets.push({ index: view.index, type: view.type, ticket });
  }
  return tickets;
}

export function findRobot(snapshot: SimulatorSnapshot, robotId: string): RobotSnapshot | null {
  return snapshot.robots.find((robot) => robot.robot_id === robotId) ?? null;
}

export function findTask(snapshot: SimulatorSnapshot, taskId: string): TaskSnapshot | null {
  return snapshot.tasks.find((task) => task.task_id === taskId) ?? null;
}

export function boundTask(snapshot: SimulatorSnapshot, robot: RobotSnapshot): TaskSnapshot | null {
  if (robot.current_task === null) return null;
  return findTask(snapshot, robot.current_task);
}

export function preconditionHash(snapshot: SimulatorSnapshot, robotId: string): string | null {
  const robot = findRobot(snapshot, robotId);
  if (robot === null) return null;
  try {
    return canonicalJson({ robot, task: boundTask(snapshot, robot) });
  } catch {
    return null;
  }
}

export function actionKey(callId: string, action: ActionName): string {
  return `${callId}\u0000${action}`;
}

export function cumulativeEventCount(counts: readonly number[]): number {
  if (counts.length === 0) return 0;
  let previous = counts[0]!;
  let total = previous;
  for (let index = 1; index < counts.length; index += 1) {
    const current = counts[index]!;
    total += current < previous ? current : current - previous;
    previous = current;
  }
  return total;
}

export function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

export function countTicketSet(tickets: readonly MaintenanceTicket[]): Map<string, MaintenanceTicket[]> {
  const byId = new Map<string, MaintenanceTicket[]>();
  for (const ticket of tickets) {
    const items = byId.get(ticket.ticket_id) ?? [];
    items.push(ticket);
    byId.set(ticket.ticket_id, items);
  }
  return byId;
}

export function actionResultMatchesSuccess(
  action: ActionName,
  snapshot: SimulatorSnapshot,
  robotId: string,
  taskId: string | null,
): boolean {
  const robot = findRobot(snapshot, robotId);
  if (robot === null) return false;
  if (action === 'resume_task') {
    if (taskId === null) return false;
    const task = findTask(snapshot, taskId);
    return (
      robot.state === 'MOVING' &&
      robot.error_code === null &&
      task?.status === 'RUNNING' &&
      task.robot_id === robotId &&
      robot.current_task === taskId
    );
  }
  return robot.state === 'IDLE' && robot.error_code === null;
}

export function validateManifest(
  manifest: RunManifest,
  addIntegrity: (code: string) => void,
): void {
  if (manifest.schema_version !== 1 && manifest.schema_version !== 2) {
    addIntegrity('manifest_schema_version');
  }
  if (typeof manifest.run_id !== 'string' || manifest.run_id.length === 0) addIntegrity('manifest_run_id');
  if (!isScenarioId(manifest.scenario_id)) addIntegrity('manifest_scenario_id');
  if (!isRecoveryMode(manifest.config)) addIntegrity('manifest_config');
  if (manifest.mode !== 'offline' && manifest.mode !== 'live') addIntegrity('manifest_mode');
  if (typeof manifest.created_at !== 'string' || Number.isNaN(Date.parse(manifest.created_at))) addIntegrity('manifest_created_at');
  if (typeof manifest.model !== 'string' || manifest.model.length === 0) addIntegrity('manifest_model');
  if (!['manual', 'scripted', 'none'].includes(manifest.approval_source)) addIntegrity('manifest_approval_source');
  if (typeof manifest.batch_id !== 'string' || manifest.batch_id.length === 0) addIntegrity('manifest_batch_id');
  if (!isNonNegativeInteger(manifest.repeat)) addIntegrity('manifest_repeat');
  for (const key of [
    'fixture_sha256',
    'prompt_sha256',
    'config_sha256',
    'lockfile_sha256',
    'harness_version',
  ] as const) {
    if (typeof manifest[key] !== 'string' || manifest[key].length === 0) addIntegrity(`manifest_${key}`);
  }
  if (!isRecord(manifest.installed_versions)) {
    addIntegrity('manifest_installed_versions');
  } else {
    for (const [key, value] of Object.entries(manifest.installed_versions)) {
      if (key.length === 0 || typeof value !== 'string') addIntegrity('manifest_installed_versions');
    }
  }
  if (manifest.schema_version === 2) {
    validateProvenance(manifest.provenance, addIntegrity);
  } else if (manifest.provenance !== undefined) {
    // A schema v1 manifest must not carry a provenance block. Skipping validation
    // whenever schema_version is not 2 previously let a bundle opt out of
    // provenance checking by editing that one integer while keeping the (possibly
    // corrupted) provenance in place. A present-but-unvalidated provenance block is
    // a contradiction, not a legacy record, so it fails closed.
    addIntegrity('manifest_provenance_present_in_v1');
  }
}

interface FingerprintEntry {
  readonly path: string;
  readonly sha256: string;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function isSafeRelativeJavaScriptPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\') || value.includes(':') || value.includes('\u0000')) return false;
  if (value.startsWith('/') || !value.endsWith('.js')) return false;
  return value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function parseFingerprintFiles(
  value: unknown,
  label: 'code' | 'evaluator',
  addIntegrity: (code: string) => void,
): readonly FingerprintEntry[] | null {
  if (!isRecord(value) || !Array.isArray(value.files) || value.files.length === 0) {
    addIntegrity(`manifest_provenance_${label}_files`);
    return null;
  }
  const files: FingerprintEntry[] = [];
  let invalid = false;
  for (const entry of value.files) {
    if (!isRecord(entry) || !isSafeRelativeJavaScriptPath(entry.path) || !isSha256(entry.sha256)) {
      invalid = true;
      continue;
    }
    files.push({ path: entry.path, sha256: entry.sha256 });
  }
  const paths = files.map((entry) => entry.path);
  const sorted = [...paths].sort();
  if (invalid || paths.length !== value.files.length) addIntegrity(`manifest_provenance_${label}_files`);
  if (new Set(paths).size !== paths.length) addIntegrity(`manifest_provenance_${label}_files_duplicate`);
  if (canonicalJson(paths) !== canonicalJson(sorted)) addIntegrity(`manifest_provenance_${label}_files_order`);
  return files;
}

function validateFingerprintHash(
  fingerprint: JsonRecord,
  files: readonly FingerprintEntry[],
  label: 'code' | 'evaluator',
  addIntegrity: (code: string) => void,
): void {
  if (!isSha256(fingerprint.sha256)) addIntegrity(`manifest_provenance_${label}_sha256`);
  else if (fingerprint.sha256 !== createHash('sha256').update(canonicalJson(files)).digest('hex')) {
    addIntegrity(`manifest_provenance_${label}_fingerprint_mismatch`);
  }
}

function validateProvenance(value: unknown, addIntegrity: (code: string) => void): void {
  if (!isRecord(value)) {
    addIntegrity('manifest_provenance');
    return;
  }
  if (value.schema_version !== 1) addIntegrity('manifest_provenance_schema_version');
  if (value.basis !== 'compiled-javascript') addIntegrity('manifest_provenance_basis');
  if (!isRecord(value.code)) {
    addIntegrity('manifest_provenance_code');
    return;
  }
  if (!isRecord(value.evaluator)) {
    addIntegrity('manifest_provenance_evaluator');
    return;
  }
  if (typeof value.evaluator.version !== 'string' || value.evaluator.version.length === 0) {
    addIntegrity('manifest_provenance_evaluator_version');
  }

  const code = value.code as JsonRecord;
  const evaluator = value.evaluator as JsonRecord;
  const codeFiles = parseFingerprintFiles(code, 'code', addIntegrity);
  const evaluatorFiles = parseFingerprintFiles(evaluator, 'evaluator', addIntegrity);
  if (codeFiles === null || evaluatorFiles === null) return;

  validateFingerprintHash(code, codeFiles, 'code', addIntegrity);
  validateFingerprintHash(evaluator, evaluatorFiles, 'evaluator', addIntegrity);

  const codeLayers = new Set(codeFiles.map((entry) => entry.path.split('/')[0]));
  for (const layer of ['app', 'contracts', 'eval', 'harness', 'services', 'simulator', 'tools', 'trace']) {
    if (!codeLayers.has(layer)) addIntegrity(`manifest_provenance_code_missing_layer_${layer}`);
  }
  for (const requiredPath of [
    'app/business.js',
    'eval/business-acceptance.js',
    'contracts/run.js',
    'trace/run-evidence.js',
  ]) {
    if (!codeFiles.some((entry) => entry.path === requiredPath)) {
      addIntegrity(`manifest_provenance_code_missing_required_${requiredPath}`);
    }
  }

  const evaluatorRoots = new Set(['eval', 'contracts', 'trace']);
  const expectedEvaluatorFiles = codeFiles.filter((entry) => evaluatorRoots.has(entry.path.split('/')[0]!));
  if (canonicalJson(evaluatorFiles) !== canonicalJson(expectedEvaluatorFiles)) {
    addIntegrity('manifest_provenance_evaluator_files_closure');
  }

  const codeByPath = new Map(codeFiles.map((entry) => [entry.path, entry.sha256]));
  for (const entry of evaluatorFiles) {
    const layer = entry.path.split('/')[0];
    if (layer !== 'eval' && layer !== 'contracts' && layer !== 'trace') {
      addIntegrity(`manifest_provenance_evaluator_scope_${entry.path}`);
    }
    if (codeByPath.get(entry.path) !== entry.sha256) {
      addIntegrity(`manifest_provenance_evaluator_file_mismatch_${entry.path}`);
    }
  }
}

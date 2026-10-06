import type {
  ExecutionContext,
  RobotSnapshot,
  SimulatorSnapshot,
  TaskSnapshot,
  ToolName,
  ToolResult,
} from '../contracts/business.js';
import { canonicalJson } from '../contracts/canonical-json.js';
import {
  ACTION_LIMITS,
  DEFAULT_BUDGETS,
  isSoftStopReason,
} from '../contracts/policy.js';
import {
  TOOL_NAMES,
  TOOL_PARAMETERS,
} from '../contracts/tool-protocol.js';
import type { ServicePort } from '../services/business-services.js';
import type { BusinessTrace } from '../trace/business-trace.js';
import {
  callIdOf,
  classifyError,
  errorDetails,
  failure,
  isPlainObject,
  sanitizeForTrace,
  validateArguments,
  validateOutput,
} from './tool-validation.js';

export { TOOL_PARAMETERS };

export function canonicalize(value: unknown): string {
  return canonicalJson(value);
}

const REGISTERED_TOOLS: ReadonlySet<ToolName> = new Set(TOOL_NAMES);
type Budgets = { -readonly [Key in keyof typeof DEFAULT_BUDGETS]: number };

interface ToolBoundaryOptions {
  readonly runId: string;
  readonly trace: BusinessTrace;
  readonly services: ServicePort;
  readonly budgets?: Partial<Budgets>;
  readonly now?: () => number;
  readonly recoveryMode?: 'full' | 'fail-fast';
  readonly authorizeForce?: (
    ctx: ExecutionContext,
    args: Record<string, string>,
    fingerprint: string,
  ) => boolean;
}

type RobotActionName = 'restart_navigation' | 'force_reboot' | 'resume_task';

const ROBOT_ACTIONS: ReadonlySet<string> = new Set([
  'restart_navigation',
  'force_reboot',
  'resume_task',
]);

const SAFE_WHEN_STOPPED: ReadonlySet<string> = new Set([
  'get_robot_status',
  'get_task_status',
  'search_sop',
  'create_maintenance_ticket',
]);

export class ToolBoundary {
  readonly #trace: BusinessTrace;
  readonly #services: ServicePort;
  readonly #budgets: Budgets;
  readonly #now: () => number;
  readonly #recoveryMode: 'full' | 'fail-fast';
  readonly #authorizeForce: ToolBoundaryOptions['authorizeForce'];
  readonly #seenCalls = new Set<string>();

  #toolRequests = 0;
  #modelRequests = 0;
  #activeAccumulatedMs = 0;
  #activeStartedAtMs: number;
  #pausedAtMs: number | null = null;
  #approvalWaitAccumulatedMs = 0;
  #approvalWaitStartedAtMs: number | null = null;
  #busy = false;
  #stopped = false;
  #stopReason: string | null = null;
  #stoppedAtMs: number | null = null;

  constructor(options: ToolBoundaryOptions) {
    if (options.trace.runId !== options.runId) {
      throw new Error(
        `trace runId ${options.trace.runId} does not match boundary runId ${options.runId}`,
      );
    }
    this.#trace = options.trace;
    this.#services = options.services;
    this.#now = options.now ?? (() => performance.now());
    this.#recoveryMode = options.recoveryMode ?? 'full';
    this.#authorizeForce = options.authorizeForce;
    this.#budgets = {
      modelRequests: options.budgets?.modelRequests ?? DEFAULT_BUDGETS.modelRequests,
      toolCalls: options.budgets?.toolCalls ?? DEFAULT_BUDGETS.toolCalls,
      activeMs: options.budgets?.activeMs ?? DEFAULT_BUDGETS.activeMs,
      approvalMs: options.budgets?.approvalMs ?? DEFAULT_BUDGETS.approvalMs,
    };

    for (const [name, value] of Object.entries(this.#budgets)) {
      if (!Number.isFinite(value) || value < 0) {
        throw new TypeError(`budget ${name} must be a finite non-negative number`);
      }
      if (
        (name === 'modelRequests' || name === 'toolCalls') &&
        !Number.isInteger(value)
      ) {
        throw new TypeError(`budget ${name} must be a non-negative integer`);
      }
    }
    this.#activeStartedAtMs = this.#readNow();
  }

  get approvalTimeoutMs(): number {
    return this.#budgets.approvalMs;
  }

  noteRequest(name: string, args: unknown, ctx: ExecutionContext): void {
    this.#toolRequests += 1;
    this.#trace.record('tool_requested', callIdOf(ctx), {
      tool_name: String(name),
      args: sanitizeForTrace(args),
      request_count: this.#toolRequests,
    });
  }

  preflight(
    name: string,
    args: unknown,
    ctx: ExecutionContext,
  ): ToolResult | null {
    if (!this.#isToolName(name)) {
      return failure(
        'DENIED',
        'UNKNOWN_TOOL',
        `tool ${String(name)} is not one of the seven registered tools`,
      );
    }

    const contextFailure = this.#validateContext(ctx);
    if (contextFailure !== null) return contextFailure;

    const argumentFailure = validateArguments(name, args);
    if (argumentFailure !== null) return argumentFailure;

    if (ctx.signal?.aborted === true) {
      this.stop('CANCELLED');
      return failure('DENIED', 'CANCELLED', 'tool call was cancelled');
    }

    const budgetFailure = this.#budgetFailure();
    if (budgetFailure !== null) {
      this.stop(budgetFailure.reason);
      return budgetFailure.result;
    }

    if (this.#stopped) {
      const hardStop = !this.#isSoftStop();
      if (hardStop || !SAFE_WHEN_STOPPED.has(name)) {
        return failure(
          'DENIED',
          'RUN_STOPPED',
          `${hardStop ? 'hard' : 'soft'} stop disables this tool: ${this.#stopReason ?? 'unknown'}`,
        );
      }
    }
    if (!this.#isRobotAction(name)) return null;

    let snapshot: SimulatorSnapshot;
    try {
      snapshot = this.#services.snapshot().simulator;
    } catch (error) {
      const details = errorDetails(error);
      this.stop('RUNTIME_ERROR');
      return failure(
        'FATAL_FAILURE',
        'RUNTIME_ERROR',
        `failed to read simulator state: ${details.message}`,
      );
    }

    if (
      name === 'restart_navigation' &&
      snapshot.counters.restart_navigation >= ACTION_LIMITS.restart_navigation
    ) {
      this.stop('ACTION_BUDGET_EXHAUSTED');
      return failure(
        'DENIED',
        'ACTION_BUDGET_EXHAUSTED',
        'restart_navigation has already reached its per-run execution limit',
      );
    }

    if (
      name === 'force_reboot' &&
      snapshot.counters.force_reboot >= ACTION_LIMITS.force_reboot
    ) {
      this.stop('ACTION_BUDGET_EXHAUSTED');
      return failure(
        'DENIED',
        'ACTION_BUDGET_EXHAUSTED',
        'force_reboot has already reached its per-run execution limit',
      );
    }

    if (name === 'force_reboot') {
      const precondition = this.#forcePrecondition(args as Record<string, string>, snapshot);
      if (precondition !== null) return precondition;
    }

    return null;
  }

  async invoke(
    name: string,
    args: unknown,
    ctx: ExecutionContext,
    options?: { readonly observed?: boolean },
  ): Promise<ToolResult> {
    if (options?.observed !== true) this.noteRequest(name, args, ctx);

    const ctxCallId = callIdOf(ctx);
    if (ctxCallId !== null) {
      if (this.#seenCalls.has(ctxCallId)) {
        return this.#recordResult(
          name,
          ctx,
          failure('DENIED', 'CALL_REPLAY', `call ${ctxCallId} has already been used`),
        );
      }
      this.#seenCalls.add(ctxCallId);
    }

    if (this.#busy) {
      return this.#recordResult(
        name,
        ctx,
        failure('DENIED', 'CONCURRENT_CALL', 'another tool call is already in progress'),
      );
    }

    this.#busy = true;
    let result: ToolResult;
    try {
      const preflightResult = this.preflight(name, args, ctx);
      result =
        preflightResult === null
          ? await this.#dispatch(name, args, ctx)
          : preflightResult;
    } catch (error) {
      result = this.#handleThrown(name, ctx, error);
    } finally {
      this.#busy = false;
    }

    this.#trace.record('tool_result', callIdOf(ctx), {
      tool_name: String(name),
      result,
    });

    if (result.error_code === 'SOP_NOT_FOUND') {
      this.stop('SOP_NOT_FOUND');
    } else if (
      this.#recoveryMode === 'fail-fast' &&
      this.#isRobotAction(name) &&
      result.status !== 'SUCCESS'
    ) {
      this.stop('FAIL_FAST');
    }

    return result;
  }

  approvalFingerprint(args: Record<string, string>): string {
    const snapshot = this.#services.snapshot().simulator;
    const robot = snapshot.robots.find((item) => item.robot_id === args.robot_id) ?? null;
    const task = this.#taskForRobot(robot, snapshot);
    return canonicalize({ robot, task });
  }

  stop(reason: string): void {
    if (this.#stopped) {
      if (isSoftStopReason(this.#stopReason) && !isSoftStopReason(reason)) {
        this.#stopReason = reason;
        this.#stoppedAtMs = this.#readNow();
        this.#trace.record('run_stopped', null, { reason });
      }
      return;
    }
    const atMs = this.#readNow();
    if (this.#pausedAtMs !== null && this.#approvalWaitStartedAtMs !== null) {
      this.#approvalWaitAccumulatedMs += Math.max(
        0,
        atMs - this.#approvalWaitStartedAtMs,
      );
    }
    if (this.#pausedAtMs !== null) {
      this.#activeStartedAtMs = atMs;
      this.#pausedAtMs = null;
      this.#approvalWaitStartedAtMs = null;
    }
    this.#stopped = true;
    this.#stopReason = reason;
    this.#stoppedAtMs = atMs;
    this.#trace.record('run_stopped', null, { reason });
  }

  noteModelRequest(): boolean {
    if (this.#stopped && !this.#isSoftStop()) {
      this.#trace.record('budget_exhausted', null, { resource: 'hard_stop' });
      return false;
    }

    if (this.#modelRequests >= this.#budgets.modelRequests) {
      this.#recordBudgetExhausted('model_requests', this.#budgets.modelRequests);
      this.stop('BUDGET_EXHAUSTED');
      return false;
    }

    if (this.#activeElapsedMs() >= this.#budgets.activeMs) {
      this.#recordBudgetExhausted('active_ms', this.#budgets.activeMs);
      this.stop('ACTIVE_BUDGET_EXHAUSTED');
      return false;
    }

    this.#modelRequests += 1;
    this.#trace.record('model_request', null, {
      count: this.#modelRequests,
      dispatched: true,
    });
    return true;
  }

  pauseForApproval(): void {
    if (this.#stopped || this.#pausedAtMs !== null) return;
    const now = this.#readNow();
    this.#activeAccumulatedMs += Math.max(0, now - this.#activeStartedAtMs);
    this.#pausedAtMs = now;
    this.#approvalWaitStartedAtMs = now;
  }

  resumeAfterApproval(): void {
    if (this.#pausedAtMs === null) return;
    const now = this.#readNow();
    if (this.#approvalWaitStartedAtMs !== null) {
      this.#approvalWaitAccumulatedMs += Math.max(
        0,
        now - this.#approvalWaitStartedAtMs,
      );
    }
    this.#pausedAtMs = null;
    this.#approvalWaitStartedAtMs = null;
    if (!this.#stopped) {
      this.#activeStartedAtMs = now;
      if (this.#approvalWaitAccumulatedMs >= this.#budgets.approvalMs) {
        this.stop('APPROVAL_BUDGET_EXHAUSTED');
      }
    }
  }

  stats(): {
    readonly tool_requests: number;
    readonly model_requests: number;
    readonly active_ms: number;
    readonly approval_wait_ms: number;
    readonly stopped: boolean;
    readonly stop_reason: string | null;
  } {
    return {
      tool_requests: this.#toolRequests,
      model_requests: this.#modelRequests,
      active_ms: this.#activeElapsedMs(),
      approval_wait_ms: this.#approvalWaitMs(),
      stopped: this.#stopped,
      stop_reason: this.#stopReason,
    };
  }

  remainingActiveMs(): number {
    return Math.max(0, this.#budgets.activeMs - this.#activeElapsedMs());
  }

  async #dispatch(
    name: string,
    args: unknown,
    ctx: ExecutionContext,
  ): Promise<ToolResult> {
    if (!this.#isToolName(name)) {
      return failure('DENIED', 'UNKNOWN_TOOL', `tool ${String(name)} is not supported`);
    }

    const typedArgs = args as Record<string, string>;
    if (name === 'force_reboot') {
      const fingerprint = this.approvalFingerprint(typedArgs);
      const authorized =
        this.#authorizeForce?.(ctx, typedArgs, fingerprint) === true;
      if (!authorized) {
        this.stop('APPROVAL_REQUIRED');
        return failure(
          'DENIED',
          'APPROVAL_REQUIRED',
          'force_reboot requires an exact one-time authorization binding',
        );
      }
    }

    this.#trace.record('handler_started', callIdOf(ctx), {
      tool_name: name,
      args: typedArgs,
    });

    const rawResult = await this.#services.invoke(name, typedArgs, ctx);
    const validated = validateOutput(rawResult);
    if (!validated.ok) {
      this.#trace.record('protocol_error', callIdOf(ctx), {
        category: 'output_schema',
        tool_name: name,
      });
      this.stop('OUTPUT_SCHEMA_INVALID');
      return failure(
        'FATAL_FAILURE',
        'OUTPUT_SCHEMA_INVALID',
        `tool ${name} returned an invalid ToolResult`,
      );
    }

    return validated.result;
  }

  #handleThrown(
    name: string,
    ctx: ExecutionContext,
    error: unknown,
  ): ToolResult {
    if (
      ctx.signal?.aborted === true ||
      (error instanceof Error && error.name === 'AbortError')
    ) {
      this.stop('CANCELLED');
      return failure('DENIED', 'CANCELLED', 'tool call was cancelled');
    }

    const category = classifyError(error);
    const details = errorDetails(error);
    this.#trace.record(`${category}_error`, callIdOf(ctx), {
      tool_name: String(name),
      error_name: details.name,
      error_message: details.message,
    });
    this.stop(`${category.toUpperCase()}_ERROR`);

    if (category === 'transport') {
      return failure(
        'FATAL_FAILURE',
        'TRANSPORT_ERROR',
        `transport failure from ${name}: ${details.message}`,
      );
    }
    if (category === 'protocol') {
      return failure(
        'FATAL_FAILURE',
        'PROTOCOL_ERROR',
        `protocol failure from ${name}: ${details.message}`,
      );
    }
    return failure(
      'FATAL_FAILURE',
      'RUNTIME_ERROR',
      `runtime failure from ${name}: ${details.message}`,
    );
  }

  #recordResult(name: string, ctx: ExecutionContext, result: ToolResult): ToolResult {
    this.#trace.record('tool_result', callIdOf(ctx), {
      tool_name: String(name),
      result,
    });
    return result;
  }

  #recordBudgetExhausted(resource: string, limit: number): void {
    this.#trace.record('budget_exhausted', null, {
      resource,
      limit,
      count:
        resource === 'model_requests'
          ? this.#modelRequests
          : resource === 'active_ms'
            ? this.#activeElapsedMs()
            : resource === 'approval_ms'
              ? this.#approvalWaitMs()
              : this.#toolRequests,
    });
  }

  #budgetFailure(): { result: ToolResult; reason: string } | null {
    if (this.#toolRequests > this.#budgets.toolCalls) {
      return {
        result: failure(
          'DENIED',
          'BUDGET_EXHAUSTED',
          'tool call budget is exhausted',
        ),
        reason: 'BUDGET_EXHAUSTED',
      };
    }
    if (this.#activeElapsedMs() >= this.#budgets.activeMs) {
      return {
        result: failure(
          'DENIED',
          'ACTIVE_BUDGET_EXHAUSTED',
          'active-time budget is exhausted',
        ),
        reason: 'ACTIVE_BUDGET_EXHAUSTED',
      };
    }
    if (this.#approvalWaitMs() >= this.#budgets.approvalMs) {
      return {
        result: failure(
          'DENIED',
          'APPROVAL_BUDGET_EXHAUSTED',
          'approval-wait budget is exhausted',
        ),
        reason: 'APPROVAL_BUDGET_EXHAUSTED',
      };
    }
    return null;
  }

  #validateContext(ctx: ExecutionContext): ToolResult | null {
    if (
      !isPlainObject(ctx) ||
      ctx.run_id !== this.#trace.runId ||
      ctx.session_id !== this.#trace.sessionId
    ) {
      return failure(
        'DENIED',
        'CONTEXT_MISMATCH',
        'tool context run/session does not match the trusted host context',
      );
    }
    if (callIdOf(ctx) === null) {
      return failure('DENIED', 'INVALID_CONTEXT', 'ctx.call_id must be non-empty');
    }
    return null;
  }

  #forcePrecondition(
    args: Record<string, string>,
    snapshot: SimulatorSnapshot,
  ): ToolResult | null {
    const robot = snapshot.robots.find((item) => item.robot_id === args.robot_id);
    if (
      robot === undefined ||
      robot.state !== 'ERROR' ||
      typeof robot.error_code !== 'string' ||
      robot.error_code.length === 0 ||
      typeof robot.current_task !== 'string' ||
      robot.current_task.length === 0
    ) {
      return failure(
        'DENIED',
        'PRECONDITION_FAILED',
        'force_reboot requires an ERROR robot with a non-empty fault and current task',
      );
    }

    const task = snapshot.tasks.find((item) => item.task_id === robot.current_task);
    if (
      task === undefined ||
      task.status !== 'PAUSED' ||
      task.robot_id !== robot.robot_id
    ) {
      return failure(
        'DENIED',
        'PRECONDITION_FAILED',
        'force_reboot requires a PAUSED current task with a consistent robot binding',
      );
    }
    return null;
  }

  #taskForRobot(
    robot: RobotSnapshot | null,
    snapshot: SimulatorSnapshot,
  ): TaskSnapshot | null {
    if (robot === null || typeof robot.current_task !== 'string' || robot.current_task.length === 0) return null;
    return snapshot.tasks.find((task) => task.task_id === robot.current_task) ?? null;
  }

  #isToolName(name: string): name is ToolName {
    return REGISTERED_TOOLS.has(name as ToolName);
  }

  #isRobotAction(name: string): name is RobotActionName {
    return ROBOT_ACTIONS.has(name);
  }

  #readNow(): number {
    const value = this.#now();
    if (!Number.isFinite(value)) {
      throw new TypeError('now() must return a finite monotonic timestamp');
    }
    return value;
  }

  #isSoftStop(): boolean {
    return isSoftStopReason(this.#stopReason);
  }

  #activeElapsedMs(): number {
    const end =
      this.#stopped && !this.#isSoftStop()
        ? this.#stoppedAtMs ?? this.#readNow()
        : this.#pausedAtMs ?? this.#readNow();
    return Math.max(
      0,
      this.#activeAccumulatedMs + Math.max(0, end - this.#activeStartedAtMs),
    );
  }

  #approvalWaitMs(): number {
    if (this.#pausedAtMs === null || this.#approvalWaitStartedAtMs === null) {
      return this.#approvalWaitAccumulatedMs;
    }
    const end = this.#stoppedAtMs ?? this.#readNow();
    return Math.max(
      0,
      this.#approvalWaitAccumulatedMs +
        Math.max(0, end - this.#approvalWaitStartedAtMs),
    );
  }
}

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';

import { Context } from '@deepseek-ai/cordis';
import Agents, { type AgentHandle } from '@deepseek-ai/dsh-agent';
import Loop from '@deepseek-ai/dsh-agent-loop';
import Llm, {
  createUserMessage,
  ReasoningEffortId,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm';
import * as DeepSeek from '@deepseek-ai/dsh-llm-deepseek';
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session';
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl';
import SessionProjections from '@deepseek-ai/dsh-session-projection';
import Prompt from '@deepseek-ai/dsh-system-prompt';
import Tools, {
  defineTool,
  type ParameterSchemaSpec,
  type ToolDefinition,
  type ToolRunContext,
} from '@deepseek-ai/dsh-tools';
import Approval, { type ApprovalOutcome, type ApprovalRequest } from '@deepseek-ai/dsh-user-approval';

import type { ExecutionContext, ToolName, ToolResult } from '../contracts/business.js';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import { TOOL_NAMES } from '../contracts/business.js';
import type { ScenarioId } from '../contracts/run.js';
import type { ScriptedTurn } from '../contracts/stage0/probe.js';
import type { ApprovalLedger } from '../tools/approval-ledger.js';
import type { ToolBoundary } from '../tools/tool-boundary.js';
import type { BusinessTrace } from '../trace/business-trace.js';
import { ScriptedAdapter } from './stage0/scripted-adapter.js';

const OFFLINE_PROVIDER = 'business-scripted';
const PERSISTENCE_SEGMENT = 'business';
const MAX_TOKENS = 1024;
const STREAM_IDLE_TIMEOUT_MS = 30_000;
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Soft business stops: only robot actions are disabled, and the model still owns
 * a budgeted close-out (a maintenance ticket and its final summary). They are a
 * legitimate, safely-terminated business outcome rather than a runtime failure.
 */

const BUDGET_STOP_REASONS: ReadonlySet<string> = new Set([
  'BUDGET_EXHAUSTED',
  'ACTIVE_BUDGET_EXHAUSTED',
  'APPROVAL_BUDGET_EXHAUSTED',
]);

const SOFT_STOP_REASONS: ReadonlySet<string> = new Set([
  'FAIL_FAST',
  'SOP_NOT_FOUND',
  'APPROVAL_REJECTED',
  'APPROVAL_REQUIRED',
  'APPROVAL_UNAVAILABLE',
]);

const TOOL_DESCRIPTIONS: Readonly<Record<ToolName, string>> = {
  get_robot_status: 'Read the current robot state, battery, fault code, and bound task.',
  get_task_status: 'Read the current task status and its bound robot.',
  search_sop: 'Look up the recovery SOP for an error code. Never invent recovery steps.',
  restart_navigation: 'Restart the navigation stack of a robot in ERROR state (recovery action, at most twice).',
  force_reboot: 'Submit a controlled reboot request for a robot in ERROR state. The host requires external one-time approval before any side effects. Without approval, the action will not execute.',
  resume_task: 'Resume a paused task after the robot has been verified healthy.',
  create_maintenance_ticket: 'Create an idempotent maintenance ticket for a robot that could not be recovered.',
};

const TOOL_PARAMETERS: Readonly<Record<ToolName, ParameterSchemaSpec>> = {
  get_robot_status: { robot_id: { type: 'string', required: true } },
  get_task_status: { task_id: { type: 'string', required: true } },
  search_sop: { error_code: { type: 'string', required: true } },
  restart_navigation: { robot_id: { type: 'string', required: true } },
  force_reboot: { robot_id: { type: 'string', required: true } },
  resume_task: {
    robot_id: { type: 'string', required: true },
    task_id: { type: 'string', required: true },
  },
  create_maintenance_ticket: {
    robot_id: { type: 'string', required: true },
    reason: { type: 'string', required: true },
  },
};

const TOOL_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: {
      type: 'string',
      enum: ['SUCCESS', 'RETRYABLE_FAILURE', 'FATAL_FAILURE', 'DENIED'],
      required: true,
    },
    error_code: {
      oneOf: [{ type: 'string' }, { type: 'null' }],
      required: true,
    },
    reason: { type: 'string', required: true },
    data: { type: 'json', required: true },
  },
} as const;

interface SafeError {
  readonly name: string;
  readonly message: string;
  readonly code: string | null;
}

interface PendingApproval {
  readonly runId: string;
  readonly sessionId: string | null;
  readonly callId: string;
  readonly args: Record<string, string>;
  readonly fingerprint: string;
  /** Monotonic (performance.now) deadline shared with the ledger record. */
  readonly deadline: number;
}

export interface BusinessApprovalRequest {
  readonly run_id: string;
  readonly session_id: string;
  readonly call_id: string;
  readonly action: 'force_reboot';
  readonly args: Record<string, string>;
  readonly deadline_ms: number;
}

export interface BusinessRuntimeApproval {
  readonly source: 'manual' | 'scripted';
  readonly decide: (
    request: BusinessApprovalRequest,
    signal: AbortSignal,
  ) => Promise<'approved' | 'rejected' | 'cancelled'>;
}

export interface BusinessRuntimeInput {
  readonly projectRoot: string;
  readonly runId: string;
  readonly scenarioId: ScenarioId;
  readonly mode: 'offline' | 'live';
  readonly model: string;
  readonly prompt: string;
  readonly turns: readonly ScriptedTurn[];
  readonly trace: BusinessTrace;
  readonly boundary: ToolBoundary;
  readonly ledger: ApprovalLedger;
  readonly nativeEvents: unknown[];
  readonly approval?: BusinessRuntimeApproval;
  readonly signal?: AbortSignal;
}

export interface BusinessRuntimeResult {
  readonly status: 'COMPLETE' | 'ERROR' | 'CANCELLED' | 'BLOCKED';
  readonly session_id: string | null;
  readonly persisted_event_count: number;
  readonly error: SafeError | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeError(error: unknown): SafeError {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return {
      name: error.name,
      message: error.message,
      code: typeof code === 'string' ? code : null,
    };
  }
  return { name: 'UnknownError', message: String(error), code: null };
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

function parseToolArguments(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function asStringRecord(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') return null;
    result[key] = item;
  }
  return result;
}

function denied(code: string, reason: string): ToolResult {
  return { status: 'DENIED', error_code: code, reason, data: null };
}

function validateBaseUrl(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const url = new URL(raw);
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error('DEEPSEEK_BASE_URL must not contain userinfo, query, or fragment');
  }
  if (url.protocol === 'https:') return url.toString().replace(/\/$/, '');
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
  if (url.protocol === 'http:' && local) return url.toString().replace(/\/$/, '');
  throw new Error('DEEPSEEK_BASE_URL must use https, or http only for localhost test endpoints');
}

function finishStream(chunk: StreamChunk): AsyncIterable<StreamChunk> {
  return (async function* stream(): AsyncIterable<StreamChunk> {
    yield chunk;
  })();
}

function budgetFinish(message: string, code: string): StreamChunk {
  return { type: 'finish', reason: { kind: 'error', failure: { message, code } } };
}

function abortedFinish(message: string): StreamChunk {
  return { type: 'finish', reason: { kind: 'aborted', failure: { message, code: 'ABORTED' } } };
}

type DecisionOutcome = 'approved' | 'rejected' | 'cancelled' | 'timeout';

function raceApprovalDecision(
  deadline: number,
  signal: AbortSignal,
  operation: () => Promise<'approved' | 'rejected' | 'cancelled'>,
): Promise<DecisionOutcome> {
  if (signal.aborted) return Promise.resolve<DecisionOutcome>('cancelled');
  const remaining = deadline - performance.now();
  if (remaining <= 0) return Promise.resolve<DecisionOutcome>('timeout');
  return new Promise<DecisionOutcome>((resolve, reject) => {
    let settled = false;
    const timer: { value: NodeJS.Timeout | undefined } = { value: undefined };
    const settle = (outcome: DecisionOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer.value !== undefined) clearTimeout(timer.value);
      signal.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    const onAbort = (): void => {
      settle('cancelled');
    };
    timer.value = setTimeout(() => {
      settle('timeout');
    }, Math.min(remaining, MAX_TIMER_MS));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    void operation().then(
      (outcome) => {
        settle(outcome);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer.value);
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * True only when the durable native log pairs an `approval/asked` for this exact
 * run/session/call with its own later `approval/decided` `allowed-once`.
 */
export function nativeApprovalGranted(
  nativeEvents: readonly unknown[],
  ctx: ExecutionContext,
): boolean {
  if (typeof ctx.session_id !== 'string' || ctx.session_id.length === 0) return false;
  if (typeof ctx.call_id !== 'string' || ctx.call_id.length === 0) return false;

  const askedIndexes: number[] = [];
  const askedSeqs: number[] = [];
  const askedIds: unknown[] = [];
  nativeEvents.forEach((event, index) => {
    if (
      isRecord(event)
      && event.type === 'approval/asked'
      && event.run_id === ctx.run_id
      && event.session_id === ctx.session_id
      && isRecord(event.data)
      && String(event.data.callId ?? '') === ctx.call_id
      && event.data.toolName === 'force_reboot'
    ) {
      askedIndexes.push(index);
      askedSeqs.push(typeof event.seq === 'number' ? event.seq : Number.NaN);
      askedIds.push(event.data.id);
    }
  });
  // Exactly one ask, one matching decision, and no ambiguity: fail closed otherwise.
  if (askedIndexes.length !== 1) return false;
  const askedIndex = askedIndexes[0] ?? -1;
  const askedSeq = askedSeqs[0] ?? Number.NaN;
  const askedId = askedIds[0];
  if (!Number.isFinite(askedSeq) || typeof askedId !== 'string' || askedId.length === 0) {
    return false;
  }

  const decidedIndexes: number[] = [];
  const decidedSeqs: number[] = [];
  let granted = false;
  nativeEvents.forEach((event, index) => {
    if (
      isRecord(event)
      && event.type === 'approval/decided'
      && event.run_id === ctx.run_id
      && event.session_id === ctx.session_id
      && isRecord(event.data)
      && event.data.id === askedId
    ) {
      decidedIndexes.push(index);
      decidedSeqs.push(typeof event.seq === 'number' ? event.seq : Number.NaN);
      if (event.data.outcome === 'allowed-once') granted = true;
    }
  });
  if (decidedIndexes.length !== 1 || !granted) return false;
  const decidedIndex = decidedIndexes[0] ?? -1;
  const decidedSeq = decidedSeqs[0] ?? Number.NaN;
  if (!Number.isFinite(decidedSeq) || decidedSeq <= askedSeq) return false;

  // Durable array order and sequence numbers must both advance past the ask.
  return decidedIndex > askedIndex;
}

function failureFromStream(stream: unknown): SafeError | null {
  if (!Array.isArray(stream)) return null;
  for (const record of stream) {
    if (!isRecord(record) || record.type !== 'chunk') continue;
    const chunk = record.chunk;
    if (!isRecord(chunk) || chunk.type !== 'finish') continue;
    const reason = chunk.reason;
    if (!isRecord(reason) || reason.kind !== 'error') continue;
    const failure = isRecord(reason.failure) ? reason.failure : {};
    return {
      name: 'LlmStreamError',
      message: typeof failure.message === 'string' ? failure.message : 'model stream failed',
      code: typeof failure.code === 'string' ? failure.code : 'UNKNOWN',
    };
  }
  return null;
}

interface TerminalLlmState {
  readonly error: SafeError;
  readonly cancelled: boolean;
}

/**
 * Native durable truth for model/transport failure. A provider 401, rate limit,
 * or refused dispatch settles as a durable terminal turn/stream rather than a
 * thrown promise, so `whenIdle()` alone must never be treated as success.
 */
function terminalLlmState(events: readonly unknown[]): TerminalLlmState | null {
  let state: TerminalLlmState | null = null;
  for (const event of events) {
    if (!isRecord(event) || !isRecord(event.data)) continue;
    if (event.type === 'assistant/attempt' || event.type === 'assistant/message') {
      const streamFailure = failureFromStream(event.data.stream);
      if (streamFailure !== null) state = { error: streamFailure, cancelled: false };
      continue;
    }
    if (event.type !== 'turn/end') continue;
    const reason = event.data.reason;
    if (!isRecord(reason)) continue;
    if (reason.kind === 'completed') continue;
    if (reason.kind === 'aborted') {
      state = {
        error: { name: 'RunCancelledError', message: 'agent turn was aborted', code: 'ABORTED' },
        cancelled: true,
      };
      continue;
    }
    if (reason.kind === 'error') {
      const failure = isRecord(reason.error) ? reason.error : {};
      state = {
        error: {
          name: 'LlmTurnError',
          message: typeof failure.message === 'string' ? failure.message : 'agent turn failed',
          code: typeof failure.code === 'string' ? failure.code : 'UNKNOWN',
        },
        cancelled: false,
      };
      continue;
    }
    const code = reason.kind === 'max-tokens' ? 'MAX_TOKENS'
      : reason.kind === 'blocked' ? 'TURN_BLOCKED'
        : 'TURN_INTERRUPTED';
    state = {
      error: {
        name: 'LlmTurnError',
        message: `agent turn ended without completion: ${String(reason.kind)}`,
        code,
      },
      cancelled: false,
    };
  }
  return state;
}

async function readPersistedEvents(
  ctx: Context,
  sessionId: SessionId,
  expected: readonly SessionEvent[],
): Promise<number> {
  const handle = await ctx.sessionPersistence.open(sessionId, 'read');
  let result: number | undefined;
  let primaryError: unknown;
  let closeError: unknown;
  try {
    const persisted = (await handle.read(0)).events;
    if (persisted.length !== expected.length) {
      throw new Error(
        `persisted session event count mismatch: actual=${persisted.length} expected=${expected.length}`,
      );
    }
    for (let index = 0; index < persisted.length; index += 1) {
      const actual = persisted[index];
      const wanted = expected[index];
      if (actual === undefined || wanted === undefined || Number(actual.seq) !== index || Number(wanted.seq) !== index) {
        throw new Error(`persisted session sequence is not contiguous at index ${index}`);
      }
      if (canonicalize(actual) !== canonicalize(wanted)) {
        throw new Error(`persisted session event mismatch at seq ${index}`);
      }
    }
    result = persisted.length;
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      await handle.close();
    } catch (error) {
      closeError = error;
    }
  }
  if (primaryError !== undefined) throw primaryError;
  if (closeError !== undefined) throw closeError;
  if (result === undefined) throw new Error('persisted session read produced no result');
  return result;
}

export async function executeBusinessRuntime(
  input: BusinessRuntimeInput,
): Promise<BusinessRuntimeResult> {
  const ctx = new Context();
  const runId = input.runId;
  const persistenceRoot = path.resolve(input.projectRoot, '.stage0', PERSISTENCE_SEGMENT, runId);
  const sessionIdRef: { value: string | null } = { value: null };
  const pendingApprovals = new Map<string, PendingApproval>();
  const preExecuteSeen = new Set<string>();

  let handle: AgentHandle | undefined;
  let activeTimer: NodeJS.Timeout | undefined;
  let activeDeadlineExceeded = false;
  let externalCancelled = false;
  let modelBudgetError: SafeError | null = null;
  let terminalLlm: TerminalLlmState | null = null;
  let primaryError: unknown;
  let disposeError: SafeError | null = null;
  let persistedEventCount = 0;
  let provider = input.mode === 'offline' ? OFFLINE_PROVIDER : 'deepseek';
  let toolNames: readonly string[] = [...TOOL_NAMES];

  const clearActiveTimer = (): void => {
    if (activeTimer !== undefined) {
      clearTimeout(activeTimer);
      activeTimer = undefined;
    }
  };

  const armActiveTimer = (): void => {
    clearActiveTimer();
    if (activeDeadlineExceeded || externalCancelled) return;
    const remaining = input.boundary.remainingActiveMs();
    if (!Number.isFinite(remaining) || remaining <= 0) return;
    activeTimer = setTimeout(() => {
      activeDeadlineExceeded = true;
      input.trace.record('active_deadline_exceeded', null, { source: 'runtime_active_timer' });
      input.boundary.stop('ACTIVE_BUDGET_EXHAUSTED');
      handle?.agent.cancel({ kind: 'hook', reason: 'business run active deadline exceeded' });
    }, Math.min(remaining, MAX_TIMER_MS));
  };

  const abortRun = (): void => {
    if (externalCancelled) return;
    externalCancelled = true;
    clearActiveTimer();
    input.trace.record('run_cancelled', null, { source: 'external_signal' });
    handle?.agent.cancel({ kind: 'hook', reason: 'business run cancelled by caller' });
  };

  const executionContextOf = (exec: {
    readonly callId: unknown;
    readonly signal?: AbortSignal;
  }): ExecutionContext => ({
    run_id: runId,
    session_id: sessionIdRef.value,
    call_id: String(exec.callId),
    ...(exec.signal === undefined ? {} : { signal: exec.signal }),
  });

  const recordDeniedApproval = (pending: PendingApproval, code: string, reason: string): void => {
    input.trace.record('tool_result', pending.callId, {
      tool_name: 'force_reboot',
      result: denied(code, reason),
      phase: 'approval',
    });
  };

  const answerApproval = async (req: ApprovalRequest): Promise<ApprovalOutcome> => {
    const callId = req.callId === undefined ? '' : String(req.callId);
    const sessionId = String(req.agent.id);
    const pending = callId === '' ? undefined : pendingApprovals.get(callId);
    if (
      pending === undefined
      || req.toolName !== 'force_reboot'
      || pending.sessionId !== sessionId
      || pending.runId !== runId
    ) {
      input.trace.record('approval_unmatched', callId, {
        tool_name: req.toolName,
        reason: 'approval request does not match a pending force_reboot call',
      });
      return 'rejected';
    }

    const source = input.approval?.source ?? 'scripted';
    const controller = new AbortController();
    const onAbort = (): void => {
      controller.abort();
    };
    req.signal?.addEventListener('abort', onAbort, { once: true });
    input.signal?.addEventListener('abort', onAbort, { once: true });
    if (req.signal?.aborted === true || input.signal?.aborted === true) controller.abort();

    try {
      if (input.approval === undefined) {
        input.ledger.decide(callId, 'cancelled', source);
        recordDeniedApproval(pending, 'APPROVAL_UNAVAILABLE', 'no approval channel is available');
        input.trace.record('approval_unavailable', callId, { action: 'force_reboot' });
        input.boundary.stop('APPROVAL_UNAVAILABLE');
        return 'unavailable';
      }

      const request: BusinessApprovalRequest = {
        run_id: pending.runId,
        session_id: pending.sessionId ?? '',
        call_id: pending.callId,
        action: 'force_reboot',
        args: { ...pending.args },
        deadline_ms: pending.deadline,
      };
      const outcome = await raceApprovalDecision(
        pending.deadline,
        controller.signal,
        () => input.approval!.decide(request, controller.signal),
      );

      if (outcome === 'approved') {
        if (!input.ledger.decide(callId, 'approved', source)) {
          recordDeniedApproval(pending, 'APPROVAL_INVALID', 'approval binding is no longer valid');
          input.boundary.stop('APPROVAL_REJECTED');
          return 'rejected';
        }
        return 'allowed-once';
      }

      if (outcome === 'rejected') {
        input.ledger.decide(callId, 'rejected', source);
        recordDeniedApproval(pending, 'APPROVAL_REJECTED', 'force_reboot approval was rejected');
        // A rejection is a soft stop: robot actions end, the model may still write a ticket.
        input.boundary.stop('APPROVAL_REJECTED');
        return 'rejected';
      }

      input.ledger.decide(callId, 'cancelled', source);
      if (outcome === 'timeout') {
        recordDeniedApproval(pending, 'APPROVAL_TIMEOUT', 'force_reboot approval deadline expired');
        input.trace.record('approval_timeout', callId, { action: 'force_reboot' });
      } else {
        recordDeniedApproval(pending, 'APPROVAL_CANCELLED', 'force_reboot approval was cancelled');
      }
      input.boundary.stop('APPROVAL_CANCELLED');
      return 'cancelled';
    } catch (error) {
      const details = safeError(error);
      input.ledger.decide(callId, 'cancelled', source);
      recordDeniedApproval(pending, 'APPROVAL_ERROR', `approval channel failed: ${details.message}`);
      input.trace.record('runtime_error', callId, {
        phase: 'approval',
        error: { name: details.name, message: details.message, code: details.code },
      });
      input.boundary.stop('APPROVAL_CANCELLED');
      return 'cancelled';
    } finally {
      pendingApprovals.delete(callId);
      // Withdraw any still-pending external decision before releasing the wait.
      if (!controller.signal.aborted) controller.abort();
      req.signal?.removeEventListener('abort', onAbort);
      input.signal?.removeEventListener('abort', onAbort);
      input.boundary.resumeAfterApproval();
      armActiveTimer();
    }
  };

  try {
    armActiveTimer();
    if (input.signal?.aborted === true) externalCancelled = true;
    input.signal?.addEventListener('abort', abortRun, { once: true });

    await ctx.plugin(Llm);
    await ctx.plugin(SessionStore);
    await ctx.plugin(Agents);
    await ctx.plugin(Prompt, {
      includeHarnessIdentity: false,
      includeRuntimeContext: false,
      personaPrefix:
        'RobotOps business runtime. You operate a robot only through the seven registered tools. Never claim a state change without a real tool result and a follow-up status read.',
    });
    await ctx.plugin(SessionPersistenceJsonl, { root: persistenceRoot, compression: 'none' });
    await ctx.plugin(Tools, { mode: 'native', maxParallelSubCalls: 1 });
    await ctx.plugin(SessionProjections);
    await ctx.plugin(Approval, { policy: 'ask' });

    if (input.mode === 'offline') {
      ctx.llm.registerAdapter([OFFLINE_PROVIDER], new ScriptedAdapter(input.turns));
    } else {
      const baseUrl = validateBaseUrl(process.env.DEEPSEEK_BASE_URL);
      await ctx.plugin(DeepSeek, {
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        ...(baseUrl === undefined ? {} : { baseURL: baseUrl }),
        thinking: 'disabled',
        reasoningEffort: 'off',
        maxTokens: MAX_TOKENS,
        streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
        retryPolicy: { mode: 'normal', maxRetries: 0 },
      });
    }
    provider = ctx.llm.listProviders()[0]?.id ?? provider;

    for (const name of TOOL_NAMES) {
      const definition = defineTool({
        name,
        description: TOOL_DESCRIPTIONS[name],
        parameters: TOOL_PARAMETERS[name],
        output: {
          schema: TOOL_OUTPUT_SCHEMA,
          render: (_args: unknown, value: unknown) => [
            { type: 'text', text: JSON.stringify(value) },
          ],
        },
        async execute(args: unknown, exec: ToolRunContext) {
          const result = await input.boundary.invoke(
            name,
            args,
            executionContextOf(exec),
            { observed: true },
          );
          // Canonical four-field value; the native registry re-validates it against TOOL_OUTPUT_SCHEMA.
          return {
            status: result.status,
            error_code: result.error_code,
            reason: result.reason,
            data: result.data as JsonValue,
          };
        },
      }) as ToolDefinition;
      // The implicit parameter root is open by default; close it so the native schema itself
      // rejects undeclared fields (defense in depth with the preflight gate).
      definition.parameters.additionalProperties = false;
      ctx.tools.register(definition);
    }

    ctx.on('session/event', (session, event) => {
      const eventSessionId = String(session.id);
      if (sessionIdRef.value !== null && eventSessionId !== sessionIdRef.value) return;
      input.nativeEvents.push({ ...event, run_id: runId, session_id: eventSessionId });

      if (event.type === 'tool/call') {
        const callId = String(event.data.callId);
        input.boundary.noteRequest(
          String(event.data.name),
          parseToolArguments(event.data.arguments),
          { run_id: runId, session_id: sessionIdRef.value, call_id: callId },
        );
      }
      if (event.type === 'tool/result') {
        const message = event.data.message;
        const content = isRecord(message) && Array.isArray(message.content) ? message.content : [];
        const nativeFailure = event.data.error;
        const outputFailure = isRecord(nativeFailure) && nativeFailure.name === 'ToolOutputError';
        for (const block of content) {
          if (!isRecord(block) || block.type !== 'tool-result') continue;
          const callId = String(block.toolCallId ?? '');
          if (outputFailure) {
            input.trace.record('protocol_error', callId === '' ? null : callId, {
              category: 'native_output_schema',
              is_error: block.isError === true,
              error_code: isRecord(nativeFailure) && typeof nativeFailure.code === 'string' ? nativeFailure.code : null,
            });
          }
          if (callId === '' || preExecuteSeen.has(callId)) continue;
          input.trace.record('protocol_error', callId, {
            category: 'pre_execute_skipped',
            is_error: block.isError === true,
            detail: 'session tool/result has no matching pre-execute gate for this call',
          });
        }
      }
    });

    ctx.on('llm/stream', (_options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => {
      // No fallback: a refused model-request admission NEVER reaches the provider.
      // Soft-stop close-out admission is owned by ToolBoundary.noteModelRequest.
      if (input.boundary.noteModelRequest()) return next();
      const stopReason = input.boundary.stats().stop_reason;
      if (externalCancelled || activeDeadlineExceeded || stopReason === 'CANCELLED') {
        return finishStream(abortedFinish('business run was cancelled before dispatch'));
      }
      const log = input.trace.events();
      const newestBudget = [...log].reverse().find((event) => event.type === 'budget_exhausted');
      const resource = newestBudget !== undefined && typeof newestBudget.data.resource === 'string'
        ? newestBudget.data.resource
        : null;
      const budgetRefusal = (stopReason !== null && BUDGET_STOP_REASONS.has(stopReason))
        || (resource !== null && resource !== 'hard_stop');
      if (budgetRefusal) {
        const failed: SafeError = {
          name: 'BudgetExceededError',
          message: `model request was refused by the ${resource ?? stopReason ?? 'budget'} budget`,
          code: 'BUDGET_EXHAUSTED',
        };
        modelBudgetError ??= failed;
        return finishStream(budgetFinish(failed.message, failed.code ?? 'BUDGET_EXHAUSTED'));
      }
      input.trace.record('model_request_refused_after_stop', null, {
        stop_reason: stopReason,
        resource,
      });
      return finishStream(budgetFinish(
        `model request was refused after stop: ${stopReason ?? 'runtime stopped'}`,
        stopReason ?? 'RUN_STOPPED',
      ));
    });

    ctx.on('tools/pre-execute', async (exec) => {
      const execCtx = executionContextOf(exec);
      preExecuteSeen.add(execCtx.call_id);
      const failure = input.boundary.preflight(exec.name, exec.arguments, execCtx);
      if (failure !== null) {
        input.trace.record('tool_result', execCtx.call_id, {
          tool_name: String(exec.name),
          result: failure,
          phase: 'preflight',
        });
        return { kind: 'deny' as const, reason: failure.reason };
      }
      if (exec.name !== 'force_reboot') return { kind: 'allow' as const };

      const args = asStringRecord(exec.arguments);
      if (args === null) {
        const invalid = denied('INVALID_ARGUMENTS', 'force_reboot requires exact string arguments');
        input.trace.record('tool_result', execCtx.call_id, {
          tool_name: 'force_reboot',
          result: invalid,
          phase: 'preflight',
        });
        return { kind: 'deny' as const, reason: invalid.reason };
      }
      if (pendingApprovals.has(execCtx.call_id)) {
        const replay = denied('APPROVAL_REPLAY', 'force_reboot approval is already pending for this call');
        input.trace.record('tool_result', execCtx.call_id, {
          tool_name: 'force_reboot',
          result: replay,
          phase: 'preflight',
        });
        return { kind: 'deny' as const, reason: replay.reason };
      }

      const fingerprint = input.boundary.approvalFingerprint(args);
      const binding = input.ledger.request(execCtx, args, fingerprint);
      if (binding === null) {
        const invalid = denied(
          'APPROVAL_REQUEST_INVALID',
          'force_reboot requires a valid one-time approval binding',
        );
        input.trace.record('tool_result', execCtx.call_id, {
          tool_name: 'force_reboot',
          result: invalid,
          phase: 'preflight',
        });
        return { kind: 'deny' as const, reason: invalid.reason };
      }

      // The deadline comes from the ledger's own monotonic clock so the durable
      // approval_pending record, the external request, and this race agree.
      const record = input.ledger
        .records()
        .find((item) => item.binding.call_id === execCtx.call_id && item.status === 'pending');
      pendingApprovals.set(execCtx.call_id, {
        runId,
        sessionId: execCtx.session_id,
        callId: execCtx.call_id,
        args,
        fingerprint,
        deadline: record?.deadline_ms ?? performance.now() + input.boundary.approvalTimeoutMs,
      });
      input.boundary.pauseForApproval();
      clearActiveTimer();
      return {
        kind: 'ask' as const,
        reason: 'force_reboot requires an external one-time approval decision',
      };
    });

    ctx.on('approval/request', async (req) => answerApproval(req));

    ctx.tools.guard((exec) => {
      const execCtx = executionContextOf(exec);
      const failure = input.boundary.preflight(exec.name, exec.arguments, execCtx);
      if (failure !== null) {
        return `${failure.error_code ?? 'DENIED'}: ${failure.reason}`;
      }
      if (exec.name === 'force_reboot' && !nativeApprovalGranted(input.nativeEvents, execCtx)) {
        return 'force_reboot has no matching native allowed-once approval for this run, session, and call';
      }
      return undefined;
    });

    await ctx.plugin(Loop, { agents: [], maxParallelToolCalls: 1 });

    const reservedSessionId = SessionId(`${input.scenarioId}-${runId}-${randomUUID()}`);
    sessionIdRef.value = String(reservedSessionId);
    handle = await ctx.agents.create({
      sessionId: reservedSessionId,
      agentOptions: {
        provider,
        model: input.model,
        maxTokens: MAX_TOKENS,
        ...(input.mode === 'live' ? { reasoningEffort: ReasoningEffortId('off') } : {}),
      },
    });

    const realSessionId = String(handle.agent.session.id);
    if (realSessionId !== String(reservedSessionId)) {
      throw new Error(`agent session id ${realSessionId} does not match the reserved session id`);
    }
    sessionIdRef.value = realSessionId;
    if (input.trace.sessionId === null) input.trace.setSessionId(realSessionId);
    else if (input.trace.sessionId !== realSessionId) {
      throw new Error(
        `trace sessionId ${input.trace.sessionId} does not match the created session ${realSessionId}`,
      );
    }

    toolNames = ctx.tools.schemas(handle.agent).map((schema) => schema.name);
    input.trace.record('runtime_ready', null, {
      scenario_id: input.scenarioId,
      mode: input.mode,
      provider,
      model: input.model,
      session_id: realSessionId,
      tool_names: toolNames,
      approval_source: input.approval?.source ?? null,
    });

    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: input.prompt }],
      source: { kind: 'user' },
    }));
    await handle.agent.whenIdle();

    const durableEvents = handle.agent.session.snapshotEvents();
    terminalLlm = terminalLlmState(durableEvents);

    await ctx.sessions.flush(handle.agent.session);
    persistedEventCount = await readPersistedEvents(ctx, reservedSessionId, durableEvents);
    input.trace.record('session_persisted', null, {
      session_id: realSessionId,
      handle_access: 'read',
      event_count: persistedEventCount,
      matched_snapshot: true,
    });
  } catch (error) {
    primaryError = error;
    input.trace.record('runtime_error', null, {
      phase: sessionIdRef.value === null ? 'initialization' : 'execution',
      error: safeError(error),
    });
  } finally {
    clearActiveTimer();
    input.signal?.removeEventListener('abort', abortRun);
    input.ledger.cancelAll('business run lifecycle ended');
    if (handle !== undefined) {
      try {
        await handle.dispose();
      } catch (error) {
        disposeError ??= safeError(error);
      }
    }
    try {
      await ctx.fiber.dispose();
    } catch (error) {
      disposeError ??= safeError(error);
    }
  }

  if (terminalLlm !== null) {
    input.trace.record('runtime_error', null, {
      phase: 'llm',
      error: terminalLlm.error,
      cancelled: terminalLlm.cancelled,
    });
  }
  if (disposeError !== null) {
    input.trace.record('runtime_error', null, { phase: 'dispose', error: disposeError });
  }

  const stats = input.boundary.stats();
  let status: BusinessRuntimeResult['status'];
  let error: SafeError | null;
  if (externalCancelled || stats.stop_reason === 'CANCELLED' || terminalLlm?.cancelled === true) {
    status = 'CANCELLED';
    error = { name: 'RunCancelledError', message: 'business run was cancelled', code: 'CANCELLED' };
  } else if (primaryError !== undefined) {
    status = sessionIdRef.value === null ? 'BLOCKED' : 'ERROR';
    error = safeError(primaryError);
  } else if (modelBudgetError !== null || activeDeadlineExceeded) {
    status = 'ERROR';
    error = modelBudgetError ?? {
      name: 'BudgetExceededError',
      message: 'business run exceeded its active-time budget',
      code: 'ACTIVE_BUDGET_EXHAUSTED',
    };
  } else if (disposeError !== null) {
    status = 'ERROR';
    error = disposeError;
  } else if (terminalLlm !== null) {
    status = 'ERROR';
    error = terminalLlm.error;
  } else if (stats.stop_reason !== null && !SOFT_STOP_REASONS.has(stats.stop_reason)) {
    status = 'ERROR';
    error = {
      name: 'BusinessRuntimeStoppedError',
      message: `business run was stopped: ${stats.stop_reason}`,
      code: stats.stop_reason,
    };
  } else {
    status = 'COMPLETE';
    error = null;
  }

  if ((status === 'ERROR' || status === 'BLOCKED') && terminalLlm === null && disposeError === null) {
    input.trace.record('runtime_error', null, {
      phase: 'finalize',
      ...(error === null ? {} : { error }),
    });
  }

  return {
    status,
    session_id: sessionIdRef.value,
    persisted_event_count: persistedEventCount,
    error,
  };
}

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
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl';
import SessionProjections from '@deepseek-ai/dsh-session-projection';
import Prompt from '@deepseek-ai/dsh-system-prompt';
import Tools, {
  defineTool,
  type ParameterSchemaSpec,
  type ToolDefinition,
  type ToolRunContext,
} from '@deepseek-ai/dsh-tools';
import Approval from '@deepseek-ai/dsh-user-approval';

import type { JsonValue } from '@deepseek-ai/dsh-util-values';

import type { ExecutionContext } from '../contracts/business.js';
import { isSoftStopReason } from '../contracts/policy.js';
import {
  TOOL_NAMES,
  TOOL_PARAMETER_SCHEMAS,
  TOOL_OUTPUT_SCHEMA,
} from '../contracts/tool-protocol.js';
import { ScriptedAdapter } from './scripted-adapter.js';
import { createApprovalHandler } from './runtime-approval.js';
import {
  nativeApprovalGranted,
  readPersistedEvents,
  terminalLlmState,
  type TerminalLlmState,
} from './runtime-events.js';
import {
  abortedFinish,
  asStringRecord,
  budgetFinish,
  denied,
  finishStream,
  isRecord,
  MAX_TIMER_MS,
  MAX_TOKENS,
  OFFLINE_PROVIDER,
  PERSISTENCE_SEGMENT,
  parseToolArguments,
  safeError,
  STREAM_IDLE_TIMEOUT_MS,
  TOOL_DESCRIPTIONS,
  validateBaseUrl,
} from './runtime-support.js';
import type {
  BusinessApprovalRequest,
  BusinessRuntimeApproval,
  BusinessRuntimeInput,
  BusinessRuntimeResult,
  PendingApproval,
  SafeError,
} from './runtime-types.js';

export type {
  BusinessApprovalRequest,
  BusinessRuntimeApproval,
  BusinessRuntimeInput,
  BusinessRuntimeResult,
};

export { nativeApprovalGranted };

type SdkSchema<T> = T extends { readonly oneOf: readonly (infer U)[] }
  ? Omit<T, 'oneOf'> & {
    readonly oneOf: U extends readonly [] ? T extends { readonly oneOf: infer O } ? O : never
      : readonly [U, U, ...U[]];
  }
  : T extends readonly unknown[]
    ? { readonly [K in keyof T]: SdkSchema<T[K]> }
    : T extends object
      ? { readonly [K in keyof T]: SdkSchema<T[K]> }
      : T;

type ToolOutputSchema = SdkSchema<typeof TOOL_OUTPUT_SCHEMA>;
const BUDGET_STOP_REASONS: ReadonlySet<string> = new Set([
  'BUDGET_EXHAUSTED',
  'ACTIVE_BUDGET_EXHAUSTED',
  'APPROVAL_BUDGET_EXHAUSTED',
]);
export async function executeBusinessRuntime(
  input: BusinessRuntimeInput,
): Promise<BusinessRuntimeResult> {
  const ctx = new Context();
  const runId = input.runId;
  const persistenceRoot = path.resolve(input.projectRoot, '.stage0', PERSISTENCE_SEGMENT, runId);
  const sessionIdRef: { value: string | null } = { value: null };
  const pendingApprovals = new Map<string, PendingApproval>();
  const preExecuteSeen = new Set<string>();
  const lifecycle = new AbortController();

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

  const expireActiveDeadline = (): void => {
    if (activeDeadlineExceeded || externalCancelled) return;
    activeDeadlineExceeded = true;
    clearActiveTimer();
    input.trace.record('active_deadline_exceeded', null, { source: 'runtime_active_timer' });
    input.boundary.stop('ACTIVE_BUDGET_EXHAUSTED');
    lifecycle.abort(new Error('business run active deadline exceeded'));
    handle?.agent.cancel({ kind: 'hook', reason: 'business run active deadline exceeded' });
  };

  const armActiveTimer = (): void => {
    clearActiveTimer();
    if (activeDeadlineExceeded || externalCancelled) return;
    const remaining = input.boundary.remainingActiveMs();
    if (!Number.isFinite(remaining)) return;
    if (remaining <= 0) {
      expireActiveDeadline();
      return;
    }
    activeTimer = setTimeout(expireActiveDeadline, Math.min(remaining, MAX_TIMER_MS));
  };

  const abortRun = (): void => {
    if (externalCancelled) return;
    externalCancelled = true;
    clearActiveTimer();
    input.boundary.stop('CANCELLED');
    input.trace.record('run_cancelled', null, { source: 'external_signal' });
    lifecycle.abort(new Error('business run cancelled by caller'));
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

  const answerApproval = createApprovalHandler({
    input,
    pendingApprovals,
    armActiveTimer,
  });

  try {
    input.signal?.addEventListener('abort', abortRun, { once: true });
    if (input.signal?.aborted === true) abortRun();
    armActiveTimer();
    lifecycle.signal.throwIfAborted();

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
        parameters: TOOL_PARAMETER_SCHEMAS[name] as unknown as ParameterSchemaSpec,
        output: {
          schema: TOOL_OUTPUT_SCHEMA as unknown as ToolOutputSchema,
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
      // Cancellation during initialization must never be admitted as a new model request.
      if (lifecycle.signal.aborted) {
        return finishStream(abortedFinish('business run was stopped before dispatch'));
      }
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

    lifecycle.signal.throwIfAborted();
    const reservedSessionId = SessionId(`${input.scenarioId}-${runId}-${randomUUID()}`);
    sessionIdRef.value = String(reservedSessionId);
    handle = await ctx.agents.create({
      sessionId: reservedSessionId,
      signal: lifecycle.signal,
      agentOptions: {
        provider,
        model: input.model,
        maxTokens: MAX_TOKENS,
        ...(input.mode === 'live' ? { reasoningEffort: ReasoningEffortId('off') } : {}),
      },
    });

    lifecycle.signal.throwIfAborted();
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

    // The SDK detaches its creation-only signal before publishing the handle.
    lifecycle.signal.throwIfAborted();
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
  if (externalCancelled) {
    status = 'CANCELLED';
    error = { name: 'RunCancelledError', message: 'business run was cancelled', code: 'CANCELLED' };
  } else if (activeDeadlineExceeded) {
    // A deadline aborts SDK creation/turns too, but its business cause is budget exhaustion.
    status = 'ERROR';
    error = {
      name: 'BudgetExceededError',
      message: 'business run exceeded its active-time budget',
      code: 'ACTIVE_BUDGET_EXHAUSTED',
    };
  } else if (stats.stop_reason === 'CANCELLED' || terminalLlm?.cancelled === true) {
    status = 'CANCELLED';
    error = { name: 'RunCancelledError', message: 'business run was cancelled', code: 'CANCELLED' };
  } else if (primaryError !== undefined) {
    status = sessionIdRef.value === null ? 'BLOCKED' : 'ERROR';
    error = safeError(primaryError);
  } else if (modelBudgetError !== null) {
    status = 'ERROR';
    error = modelBudgetError;
  } else if (disposeError !== null) {
    status = 'ERROR';
    error = disposeError;
  } else if (terminalLlm !== null) {
    status = 'ERROR';
    error = terminalLlm.error;
  } else if (stats.stop_reason !== null && !isSoftStopReason(stats.stop_reason)) {
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

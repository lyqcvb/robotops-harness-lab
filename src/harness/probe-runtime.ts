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

import { DEFAULT_BUDGETS, DEFAULT_MODEL, TOOL_NAMES } from '../contracts/probe-constants.js';
import type { LiveSmokeResult, ProbeApprovalMode, ProbeBudgets, ProbeCaseDefinition, ProbeCaseResult, ProbeExecutionResult, ProbePolicyFixture, ScriptedTurn } from '../contracts/probe.js';
import { makeProbeEvent, safeError } from '../trace/probe-evidence.js';
import { ScriptedAdapter } from './scripted-adapter.js';
import { defaultOfflineCases } from './probe-scenarios.js';
interface ModelClock {
  now(): number;
  advance(ms: number): void;
}

class MutableClock implements ModelClock {
  private current: number;
  constructor(initial: number) {
    this.current = initial;
  }
  now(): number {
    return this.current;
  }
  advance(ms: number): void {
    this.current += ms;
  }
}

interface PendingApproval {
  readonly runId: string;
  readonly sessionId: string;
  readonly callId: string;
  readonly name: string;
  readonly canonicalArgs: string;
  readonly deadline: number;
}

interface RuntimeCounters {
  modelRequests: number;
  toolRequests: number;
  actionExecutions: number;
  approvalAsked: number;
  approvalAllowedOnce: number;
}


function mergeBudgets(input?: Partial<ProbeBudgets>): ProbeBudgets {
  return {
    modelRequests: input?.modelRequests ?? DEFAULT_BUDGETS.modelRequests,
    toolCalls: input?.toolCalls ?? DEFAULT_BUDGETS.toolCalls,
    activeMs: input?.activeMs ?? DEFAULT_BUDGETS.activeMs,
    approvalMs: input?.approvalMs ?? DEFAULT_BUDGETS.approvalMs,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function callKey(sessionId: string, callId: string): string {
  return `${sessionId}\u0000${callId}`;
}

function approvalPairMatches(events: readonly SessionEvent[], pending: PendingApproval): boolean {
  const asked = events.find((event) => (
    event.type === 'approval/asked'
    && String(event.data.callId ?? '') === pending.callId
    && event.data.toolName === pending.name
  ));
  if (asked === undefined || asked.type !== 'approval/asked') return false;
  return events.some((event) => (
    event.type === 'approval/decided'
    && event.data.id === asked.data.id
    && event.data.outcome === 'allowed-once'
    && event.seq > asked.seq
  ));
}

function budgetFinish(): StreamChunk {
  return {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: { message: 'probe model-request budget exceeded', code: 'PROBE_BUDGET_EXCEEDED' },
    },
  };
}

function normalizeResult(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError('probe tool arguments must be an object');
  return value;
}

function makeProbeTool(
  name: string,
  description: string,
  parameters: ParameterSchemaSpec,
  counters: RuntimeCounters,
  executionsByName: Map<string, number>,
  runId: string,
  sessionIdRef: { value: string | null },
  getCaseId: () => string,
  recordProbe: (event: string, data: Readonly<Record<string, unknown>>) => void,
): ToolDefinition {
  const tool = defineTool({
    name,
    description,
    parameters,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', const: 'SUCCESS', required: true },
          error_code: { type: 'null', const: null, required: true },
          reason: { type: 'string', required: true },
          data: { type: 'json', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args: unknown, exec: ToolRunContext) {
      if (exec.signal.aborted) throw new Error('probe tool execution aborted');
      const normalized = normalizeResult(args);
      counters.actionExecutions += 1;
      const invocation = (executionsByName.get(name) ?? 0) + 1;
      executionsByName.set(name, invocation);
      const sessionId = sessionIdRef.value ?? String(exec.agent?.id ?? '');
      recordProbe('PROBE_ACTION_EXECUTED', {
        case_id: getCaseId(),
        session_id: sessionId,
        call_id: String(exec.callId),
        name,
        canonical_args: canonicalize(normalized),
        invocation,
        robot_state_modified: false,
      });
      recordProbe('PROBE_STATE_UPDATE', {
        case_id: getCaseId(),
        session_id: sessionId,
        call_id: String(exec.callId),
        state_kind: 'probe_counters',
        action_executions: counters.actionExecutions,
        robot_state_modified: false,
      });
      return {
        status: 'SUCCESS' as const,
        error_code: null,
        reason: `stage0 probe stub executed ${name}`,
        data: {
          probe: true,
          tool: name,
          run_id: runId,
          invocation,
          ...(name === 'get_robot_status' && typeof normalized.robot_id === 'string'
            ? { robot_id: normalized.robot_id }
            : {}),
          ...(name === 'get_task_status' && typeof normalized.task_id === 'string'
            ? { task_id: normalized.task_id }
            : {}),
          ...(name === 'search_sop' && typeof normalized.error_code === 'string'
            ? { error_code: normalized.error_code }
            : {}),
          ...(name === 'resume_task'
            && typeof normalized.robot_id === 'string'
            && typeof normalized.task_id === 'string'
            ? { robot_id: normalized.robot_id, task_id: normalized.task_id }
            : {}),
          ...(name === 'restart_navigation' && typeof normalized.robot_id === 'string'
            ? { robot_id: normalized.robot_id }
            : {}),
          ...(name === 'force_reboot' && typeof normalized.robot_id === 'string'
            ? { robot_id: normalized.robot_id, protected: true }
            : {}),
          ...(name === 'create_maintenance_ticket' && typeof normalized.robot_id === 'string'
            ? { robot_id: normalized.robot_id }
            : {}),
        },
      };
    },
  });
  tool.parameters.additionalProperties = false;
  return tool;
}

function toolArgumentContracts(): ReadonlyMap<string, { readonly allowed: ReadonlySet<string>; readonly required: readonly string[] }> {
  return new Map(toolParameterSchemas().map(([name, , parameters]) => [
    name,
    {
      allowed: new Set(Object.keys(parameters)),
      required: Object.entries(parameters)
        .filter(([, spec]) => spec.required === true)
        .map(([key]) => key),
    },
  ]));
}

function toolParameterSchemas(): readonly [string, string, ParameterSchemaSpec][] {
  return [
    ['get_robot_status', 'Probe-only read acknowledgement. No robot state is read or changed.', {
      robot_id: { type: 'string', required: true },
    }],
    ['get_task_status', 'Probe-only task acknowledgement. No task state is read or changed.', {
      task_id: { type: 'string', required: true },
    }],
    ['search_sop', 'Probe-only SOP query acknowledgement. No SOP data is read.', {
      error_code: { type: 'string', required: true },
    }],
    ['restart_navigation', 'Probe-only protected action counter. No robot action occurs.', {
      robot_id: { type: 'string', required: true },
    }],
    ['force_reboot', 'Probe-only protected action counter requiring one-time approval. No robot action occurs.', {
      robot_id: { type: 'string', required: true },
    }],
    ['resume_task', 'Probe-only task action counter. No task action occurs.', {
      robot_id: { type: 'string', required: true },
      task_id: { type: 'string', required: true },
    }],
    ['create_maintenance_ticket', 'Probe-only ticket action counter. No ticket is created.', {
      robot_id: { type: 'string', required: true },
      reason: { type: 'string', required: true },
    }],
  ];
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

async function raceApprovalDeadline(
  deadline: number,
  clock: ModelClock,
  signal: AbortSignal | undefined,
  operation: () => Promise<ApprovalOutcome>,
): Promise<ApprovalOutcome> {
  if (signal?.aborted) return 'cancelled';
  const remaining = deadline - clock.now();
  if (remaining <= 0) return 'cancelled';
  return await new Promise<ApprovalOutcome>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve('cancelled');
    }, Math.min(remaining, 2_147_483_647));
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve('cancelled');
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    void operation().then((outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(outcome);
    }, (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
  });
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
      throw new Error(`persisted session event count mismatch: actual=${persisted.length} expected=${expected.length}`);
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
async function executeRuntimeCase(input: {
  readonly runId: string;
  readonly caseId: string;
  readonly mode: 'offline' | 'live';
  readonly persistenceRoot: string;
  readonly provider: string;
  readonly model: string;
  readonly prompt: string;
  readonly approvalMode: ProbeApprovalMode;
  readonly policyFixture: ProbePolicyFixture;
  readonly budgets: ProbeBudgets;
  readonly turns?: readonly ScriptedTurn[];
  readonly restrictToReadOnly: boolean;
  readonly liveConfig?: Parameters<typeof DeepSeek.apply>[1];
  readonly getProviderRoute?: (ctx: Context) => string;
}): Promise<ProbeCaseResult> {
  const ctx = new Context();
  const argumentContracts = toolArgumentContracts();
  let modelRequestAttempts = 0;
  const clock = new MutableClock(Date.now());
  const counters: RuntimeCounters = {
    modelRequests: 0,
    toolRequests: 0,
    actionExecutions: 0,
    approvalAsked: 0,
    approvalAllowedOnce: 0,
  };
  const executionsByName = new Map<string, number>();
  const pending = new Map<string, PendingApproval>();
  const terminalCallIds = new Set<string>();
  const seenDispatchCallIds = new Set<string>();
  const nativeEvents: unknown[] = [];
  const probeEvents: unknown[] = [];
  const notes: string[] = [];
  const sessionIdRef: { value: string | null } = { value: null };
  let providerRoute = input.provider;
  let handle: AgentHandle | undefined;
  let activeTimer: NodeJS.Timeout | undefined;
  let activeDeadlineExceeded = false;
  let primaryError: unknown;
  let toolNames: readonly string[] = [...TOOL_NAMES];
  let persistedEventCount = 0;

  let probeSeq = 0;
  const recordProbe = (event: string, data: Readonly<Record<string, unknown>>): void => {
    probeSeq += 1;
    probeEvents.push(makeProbeEvent(event, input.runId, {
      case_id: input.caseId,
      seq: probeSeq,
      session_id: sessionIdRef.value,
      ...data,
    }));
  };

  const recordNative = (sessionId: string, event: SessionEvent): void => {
    nativeEvents.push({
      ...event,
      run_id: input.runId,
      case_id: input.caseId,
      session_id: sessionId,
    });
  };

  const answerApproval = async (req: ApprovalRequest): Promise<ApprovalOutcome> => {
    if (req.callId === undefined) return 'rejected';
    const sessionId = String(req.agent.id);
    const key = callKey(sessionId, String(req.callId));
    const record = pending.get(key);
    if (record === undefined || record.name !== req.toolName) return 'rejected';
    return await raceApprovalDeadline(record.deadline, clock, req.signal, async () => {
      if (req.signal?.aborted === true || activeDeadlineExceeded) return 'cancelled';
      if (clock.now() >= record.deadline) {
        pending.delete(key);
        terminalCallIds.add(key);
        recordProbe('PROBE_APPROVAL_EXPIRED', {
          session_id: sessionId,
          call_id: String(req.callId),
          name: req.toolName,
        });
        return 'cancelled';
      }
      if (input.approvalMode === 'cancelled') return 'cancelled';
      if (input.approvalMode === 'rejected') return 'rejected';
      if (input.approvalMode === 'expire') {
        clock.advance(input.budgets.approvalMs + 1);
        return 'allowed-once';
      }
      if (input.approvalMode === 'approve-once') {
        const priorGrant = probeEvents.some((event) => (
          isRecord(event) && event.event === 'PROBE_APPROVAL_GRANTED'
        ));
        if (priorGrant) return 'rejected';
        recordProbe('PROBE_APPROVAL_GRANTED', {
          session_id: sessionId,
          call_id: String(req.callId),
          name: req.toolName,
          source: 'scripted',
        });
        return 'allowed-once';
      }
      return 'unavailable';
    });
  };

  try {
    activeTimer = setTimeout(() => {
      activeDeadlineExceeded = true;
      if (handle !== undefined) {
        handle.agent.cancel({ kind: 'hook', reason: 'stage0 active deadline exceeded' });
      }
    }, input.budgets.activeMs);

    await ctx.plugin(Llm);
    await ctx.plugin(SessionStore);
    await ctx.plugin(Agents);
    await ctx.plugin(Prompt, {
      includeHarnessIdentity: false,
      includeRuntimeContext: false,
      personaPrefix: 'Stage 0 native Harness probe. This is not a business agent. Use only the declared probe tools. Never claim robot state changes.',
    });
    await ctx.plugin(SessionPersistenceJsonl, { root: input.persistenceRoot, compression: 'none' });
    await ctx.plugin(Tools, { mode: 'native', maxParallelSubCalls: 1 });
    await ctx.plugin(SessionProjections);
    await ctx.plugin(Approval, { policy: 'ask' });

    if (input.mode === 'offline') {
      ctx.llm.registerAdapter(['stage0-scripted'], new ScriptedAdapter(input.turns ?? []));
    } else {
      if (input.liveConfig === undefined) throw new Error('live DeepSeek config is missing');
      await ctx.plugin(DeepSeek, input.liveConfig);
      providerRoute = input.getProviderRoute?.(ctx) ?? ctx.llm.listProviders()[0]?.id ?? input.provider;
    }

    const toolDefinitions = toolParameterSchemas().map(([name, description, parameters]) => (
      makeProbeTool(
        name,
        description,
        parameters,
        counters,
        executionsByName,
        input.runId,
        sessionIdRef,
        () => input.caseId,
        recordProbe,
      )
    ));
    for (const definition of toolDefinitions) ctx.tools.register(definition);
    toolNames = ctx.tools.schemas().map((schema) => schema.name);


    ctx.on('session/event', (session, event) => {
      if (sessionIdRef.value !== null && String(session.id) !== sessionIdRef.value) return;
      recordNative(String(session.id), event);
      if (event.type === 'tool/call') {
        counters.toolRequests += 1;
        if (counters.toolRequests > input.budgets.toolCalls) {
          recordProbe('PROBE_BUDGET_EXCEEDED', {
            budget: 'toolCalls',
            limit: input.budgets.toolCalls,
            observed: counters.toolRequests,
          });
        }
      }
      if (event.type === 'approval/asked') counters.approvalAsked += 1;
      if (event.type === 'approval/decided' && event.data.outcome === 'allowed-once') {
        counters.approvalAllowedOnce += 1;
      }
    });

    ctx.on('llm/stream', (_options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => {
      modelRequestAttempts += 1;
      if (modelRequestAttempts > input.budgets.modelRequests) {
        recordProbe('PROBE_BUDGET_EXCEEDED', {
          budget: 'modelRequests',
          limit: input.budgets.modelRequests,
          attempted: modelRequestAttempts,
          dispatched: counters.modelRequests,
        });
        return (async function* budgetStream(): AsyncIterable<StreamChunk> {
          yield budgetFinish();
        })();
      }
      counters.modelRequests += 1;
      return next();
    });

    ctx.on('tools/pre-execute', async (exec) => {
      if (!TOOL_NAMES.includes(exec.name as typeof TOOL_NAMES[number])) {
        return { kind: 'deny' as const, reason: `tool "${exec.name}" is outside the Stage 0 whitelist` };
      }
      const contract = argumentContracts.get(exec.name);
      const args = exec.arguments;
      if (
        contract === undefined
        || !isRecord(args)
        || Object.keys(args).some((key) => !contract.allowed.has(key))
        || contract.required.some((key) => !Object.hasOwn(args, key))
      ) {
        return { kind: 'deny' as const, reason: `tool "${exec.name}" rejected undeclared or missing arguments` };
      }
      if (counters.toolRequests > input.budgets.toolCalls) {
        return { kind: 'deny' as const, reason: 'tool call budget exceeded' };
      }
      const sessionId = String(exec.agent?.id ?? sessionIdRef.value ?? '');
      const dispatchKey = callKey(sessionId, String(exec.callId));
      if (seenDispatchCallIds.has(dispatchKey) || terminalCallIds.has(dispatchKey) || pending.has(dispatchKey)) {
        terminalCallIds.add(dispatchKey);
        return { kind: 'deny' as const, reason: 'duplicate or replayed tool call identity' };
      }
      seenDispatchCallIds.add(dispatchKey);
      if (exec.name === 'restart_navigation' && (executionsByName.get(exec.name) ?? 0) >= 2) {
        return { kind: 'deny' as const, reason: 'restart_navigation retry budget exhausted' };
      }
      if (exec.name !== 'force_reboot') return { kind: 'allow' as const };
      if ((executionsByName.get('force_reboot') ?? 0) >= 1) {
        return { kind: 'deny' as const, reason: 'force_reboot may execute at most once' };
      }
      if (input.policyFixture === 'allow-force') return { kind: 'allow' as const };
      const deadline = clock.now() + input.budgets.approvalMs;
      pending.set(dispatchKey, {
        runId: input.runId,
        sessionId,
        callId: String(exec.callId),
        name: exec.name,
        canonicalArgs: canonicalize(exec.arguments),
        deadline,
      });
      recordProbe('PROBE_APPROVAL_PENDING', {
        session_id: sessionId,
        call_id: String(exec.callId),
        name: exec.name,
        canonical_args: canonicalize(exec.arguments),
        deadline,
        deadline_ms: input.budgets.approvalMs,
      });
      return { kind: 'ask' as const, reason: 'force_reboot requires one-time scripted approval in Stage 0' };
    });

    if (input.approvalMode !== 'unavailable') {
      ctx.on('approval/request', async (req, next) => {
        if (req.toolName !== 'force_reboot') return await next();
        return await answerApproval(req);
      });
    }

    ctx.tools.guard((exec) => {
      if (!TOOL_NAMES.includes(exec.name as typeof TOOL_NAMES[number])) {
        return `tool "${exec.name}" is outside the Stage 0 whitelist`;
      }
      if (exec.signal.aborted || activeDeadlineExceeded) {
        return 'tool call was cancelled or exceeded the active deadline';
      }
      if ((input.mode === 'live' || input.restrictToReadOnly) && exec.name !== 'get_robot_status') {
        return 'live smoke permits only get_robot_status';
      }
      if (counters.toolRequests > input.budgets.toolCalls) {
        recordProbe('PROBE_TOOL_CALL_BLOCKED', {
          session_id: String(exec.agent?.id ?? ''),
          call_id: String(exec.callId),
          name: exec.name,
          limit: input.budgets.toolCalls,
          observed: counters.toolRequests,
        });
        return 'tool call budget exceeded';
      }
      if (exec.name !== 'force_reboot') {
        if (exec.name === 'restart_navigation' && (executionsByName.get(exec.name) ?? 0) >= 2) {
          return 'restart_navigation retry budget exhausted';
        }
        return undefined;
      }
      const sessionId = String(exec.agent?.id ?? '');
      const key = callKey(sessionId, String(exec.callId));
      if (terminalCallIds.has(key)) return 'force_reboot authorization was already consumed or terminated';
      const record = pending.get(key);
      if (record === undefined) return 'force_reboot has no pending authorization';
      if (record.runId !== input.runId || record.sessionId !== sessionId) {
        return 'force_reboot authorization is bound to another run or session';
      }
      if (record.name !== exec.name || record.canonicalArgs !== canonicalize(exec.arguments)) {
        return 'force_reboot authorization does not match the tool call arguments';
      }
      if (exec.signal.aborted || activeDeadlineExceeded) return 'force_reboot authorization was cancelled or timed out';
      if (clock.now() >= record.deadline) {
        pending.delete(key);
        terminalCallIds.add(key);
        return 'force_reboot authorization expired';
      }
      if (exec.agent === undefined || !approvalPairMatches(exec.agent.session.snapshotEvents(), record)) {
        return 'force_reboot authorization has no matching native approval decision';
      }
      pending.delete(key);
      terminalCallIds.add(key);
      recordProbe('PROBE_APPROVAL_CONSUMED', {
        session_id: sessionId,
        call_id: String(exec.callId),
        name: exec.name,
        source: 'native-event-allowed-once',
      });
      return undefined;
    });

    await ctx.plugin(Loop, { agents: [], maxParallelToolCalls: 1 });

    const sessionId = SessionId(`stage0-${input.runId}-${input.caseId}-${randomUUID()}`);
    sessionIdRef.value = String(sessionId);
    handle = await ctx.agents.create({
      sessionId,
      agentOptions: {
        provider: providerRoute,
        model: input.model,
        maxTokens: 512,
        ...(input.mode === 'live' ? { reasoningEffort: ReasoningEffortId('off') } : {}),
      },
      ...(input.restrictToReadOnly
        ? { setup: (agentCtx: Context) => { agentCtx.tools.restrict({ allow: ['get_robot_status'] }); } }
        : {}),
    });
    toolNames = ctx.tools.schemas(handle.agent).map((schema) => schema.name);

    recordProbe('PROBE_RUNTIME_READY', {
      session_id: sessionIdRef.value,
      provider: providerRoute,
      model: input.model,
      approval_mode: input.approvalMode,
      policy_fixture: input.policyFixture,
      tool_names: toolNames,
    });

    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: input.prompt }],
      source: { kind: 'user' },
    }));
    await handle.agent.whenIdle();
    await ctx.sessions.flush(handle.agent.session);

    const expectedEvents = handle.agent.session.snapshotEvents();
    persistedEventCount = await readPersistedEvents(ctx, sessionId, expectedEvents);
    recordProbe('PROBE_PERSISTENCE_READ', {
      session_id: sessionIdRef.value,
      handle_access: 'read',
      event_count: persistedEventCount,
      matched_snapshot: true,
    });
  } catch (error) {
    primaryError = error;
    notes.push(`runtime error: ${safeError(error).message}`);
  } finally {
    if (activeTimer !== undefined) clearTimeout(activeTimer);
    if (handle !== undefined) {
      try {
        await handle.dispose();
      } catch (error) {
        notes.push(`agent dispose error: ${safeError(error).message}`);
      }
    }
    try {
      await ctx.fiber.dispose();
    } catch (error) {
      notes.push(`context dispose error: ${safeError(error).message}`);
    }
  }

  return {
    id: input.caseId,
    status: primaryError === undefined ? 'PASS' : 'BLOCKED',
    modelRequests: counters.modelRequests,
    toolRequests: counters.toolRequests,
    actionExecutions: counters.actionExecutions,
    approvalAsked: counters.approvalAsked,
    approvalAllowedOnce: counters.approvalAllowedOnce,
    executionsByName: Object.fromEntries(executionsByName),
    sessionId: sessionIdRef.value,
    provider: providerRoute,
    model: input.model,
    toolNames,
    persistedEventCount,
    nativeEvents,
    probeEvents,
    notes,
    error: primaryError === undefined ? null : safeError(primaryError),
  };
}

function baseCaseInput(
  runId: string,
  projectRoot: string,
  definition: ProbeCaseDefinition,
): Parameters<typeof executeRuntimeCase>[0] {
  return {
    runId,
    caseId: definition.id,
    mode: 'offline',
    persistenceRoot: path.resolve(projectRoot, '.stage0', runId, definition.id),
    provider: 'stage0-scripted',
    model: 'stage0-scripted-v1',
    prompt: definition.prompt,
    approvalMode: definition.approvalMode,
    policyFixture: definition.policyFixture ?? 'default',
    budgets: mergeBudgets(definition.budgets),
    turns: definition.turns,
    restrictToReadOnly: definition.restrictToReadOnly ?? false,
  };
}

export async function executeOfflineSecurityCases(
  projectRoot: string,
  runId: string,
  definitions: readonly ProbeCaseDefinition[] = defaultOfflineCases(),
): Promise<ProbeExecutionResult> {
  const cases: ProbeCaseResult[] = [];
  for (const definition of definitions) {
    cases.push(await executeRuntimeCase(baseCaseInput(runId, projectRoot, definition)));
  }
  const nativeEvents = cases.flatMap((item) => item.nativeEvents);
  const probeEvents = cases.flatMap((item) => item.probeEvents);
  const toolNames = cases[0]?.toolNames ?? [];
  const counters = cases.reduce((total, item) => ({
    modelRequests: total.modelRequests + item.modelRequests,
    toolRequests: total.toolRequests + item.toolRequests,
    actionExecutions: total.actionExecutions + item.actionExecutions,
    approvalAsked: total.approvalAsked + item.approvalAsked,
    approvalAllowedOnce: total.approvalAllowedOnce + item.approvalAllowedOnce,
  }), {
    modelRequests: 0,
    toolRequests: 0,
    actionExecutions: 0,
    approvalAsked: 0,
    approvalAllowedOnce: 0,
  });
  return { cases, nativeEvents, probeEvents, toolNames, counters };
}

export async function executeLiveSmoke(
  projectRoot: string,
  runId: string,
  provider: string,
  model: string,
): Promise<LiveSmokeResult> {
  const baseUrl = validateBaseUrl(process.env.DEEPSEEK_BASE_URL);
  const result = await executeRuntimeCase({
    runId,
    caseId: 'LIVE',
    mode: 'live',
    persistenceRoot: path.resolve(projectRoot, '.stage0', runId, 'LIVE'),
    provider,
    model,
    prompt: 'Use only get_robot_status for robot_id "R-03". Do not call any write action. Then state that the Stage 0 probe result was read.',
    approvalMode: 'unavailable',
    policyFixture: 'default',
    budgets: mergeBudgets({ modelRequests: 3, toolCalls: 3, approvalMs: DEFAULT_BUDGETS.approvalMs }),
    restrictToReadOnly: true,
    liveConfig: {
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      ...(baseUrl === undefined ? {} : { baseURL: baseUrl }),
      thinking: 'disabled',
      reasoningEffort: 'off',
      maxTokens: 512,
      streamIdleTimeoutMs: 30_000,
      retryPolicy: { mode: 'normal', maxRetries: 0 },
    },
    getProviderRoute: (ctx) => ctx.llm.listProviders()[0]?.id ?? provider,
  });
  const liveGetRobotCallIds = new Set<string>();
  for (const event of result.nativeEvents) {
    if (!isRecord(event) || event.type !== 'tool/call' || !isRecord(event.data)) continue;
    if (event.data.name !== 'get_robot_status' || typeof event.data.arguments !== 'string') continue;
    try {
      const parsed = JSON.parse(event.data.arguments) as unknown;
      if (isRecord(parsed) && parsed.robot_id === 'R-03' && event.data.callId !== undefined) {
        liveGetRobotCallIds.add(String(event.data.callId));
      }
    } catch {
      // Invalid JSON is not a successful live smoke call.
    }
  }
  const liveCalledGetRobotStatus = liveGetRobotCallIds.size > 0;
  const liveToolResultReadable = result.nativeEvents.some((event) => {
    if (!isRecord(event) || event.type !== 'tool/result' || !isRecord(event.data)) return false;
    if (event.data.error !== undefined || !isRecord(event.data.message)) return false;
    const content = event.data.message.content;
    if (!Array.isArray(content)) return false;
    return content.some((block) => {
      if (!isRecord(block) || block.type !== 'tool-result' || block.isError === true) return false;
      if (!liveGetRobotCallIds.has(String(block.toolCallId ?? '')) || !Array.isArray(block.content)) return false;
      return block.content.some((nested) => {
        if (!isRecord(nested) || nested.type !== 'text' || typeof nested.text !== 'string') return false;
        try {
          const parsed = JSON.parse(nested.text) as unknown;
          return isRecord(parsed)
            && parsed.status === 'SUCCESS'
            && isRecord(parsed.data)
            && parsed.data.probe === true;
        } catch {
          return false;
        }
      });
    });
  });
  return { ...result, liveCalledGetRobotStatus, liveToolResultReadable };
}

export function modelFromEnvironment(): string {
  const configured = process.env.DEEPSEEK_MODEL;
  return configured === undefined || configured.trim() === '' ? DEFAULT_MODEL : configured;
}


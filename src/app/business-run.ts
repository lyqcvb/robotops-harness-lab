import path from 'node:path';
import process from 'node:process';

import {
  DEFAULT_BUDGETS,
  DEFAULT_MODEL,
  HARNESS_VERSION,
  isSoftStopReason,
} from '../contracts/policy.js';
import type {
  BusinessMetrics,
  RecoveryMode,
  RunManifest,
  ScenarioId,
} from '../contracts/run.js';
import { evaluateRun } from '../eval/business-acceptance.js';
import { getBusinessScenario } from '../harness/business-scenarios.js';
import {
  executeBusinessRuntime,
  nativeApprovalGranted,
  type BusinessRuntimeApproval,
  type BusinessRuntimeResult,
} from '../harness/business-runtime.js';
import { BusinessServices } from '../services/business-services.js';
import { RobotSimulator } from '../simulator/robot-simulator.js';
import { ApprovalLedger } from '../tools/approval-ledger.js';
import { ToolBoundary } from '../tools/tool-boundary.js';
import { BusinessTrace } from '../trace/business-trace.js';
import {
  createRunId,
  digest,
  writeRunBundle,
} from '../trace/run-evidence.js';
import { collectRunProvenance } from '../trace/run-provenance.js';
import {
  readInstalledVersions,
  readLockfileDigest,
  redactValue,
  safeError,
} from '../trace/probe-evidence.js';
import { redactionSecrets } from './business-io.js';
import {
  createManualApproval,
  type ApprovalDecide,
} from './manual-approval.js';

export type ApprovalMode = 'scripted' | 'manual' | 'none';

export interface RunBusinessOptions {
  readonly projectRoot: string;
  readonly scenarioId: ScenarioId;
  readonly config: RecoveryMode;
  readonly mode: 'offline' | 'live';
  readonly approvalMode: ApprovalMode;
  readonly batchId?: string;
  readonly repeat?: number;
  readonly model?: string;
  readonly signal?: AbortSignal;
  readonly manualDecide?: ApprovalDecide;
}

export interface RunBusinessResult {
  readonly directory: string;
  readonly manifest: RunManifest;
  readonly metrics: BusinessMetrics;
}

function defaultModel(env: NodeJS.ProcessEnv): string {
  const configured = env.DEEPSEEK_MODEL;
  return configured !== undefined && configured.trim() !== ''
    ? configured
    : DEFAULT_MODEL;
}

function hasLiveApiKey(env: NodeJS.ProcessEnv): boolean {
  const value = env.DEEPSEEK_API_KEY;
  return typeof value === 'string' && value.trim() !== '';
}

function makeApproval(
  approvalMode: ApprovalMode,
  scriptedDecision: 'approved' | 'rejected',
  manualDecide: ApprovalDecide | undefined,
): BusinessRuntimeApproval | undefined {
  if (approvalMode === 'none') return undefined;
  if (approvalMode === 'scripted') {
    return {
      source: 'scripted',
      decide: async () => scriptedDecision,
    };
  }
  const decide = manualDecide ?? createManualApproval();
  return { source: 'manual', decide };
}

function hasTicket(services: BusinessServices): boolean {
  return services.snapshot().tickets.length > 0;
}

function isHardStopReason(reason: string | null): boolean {
  if (reason === null || isSoftStopReason(reason)) return false;
  return (
    reason === 'CANCELLED' ||
    reason === 'APPROVAL_CANCELLED' ||
    reason === 'OUTPUT_SCHEMA_INVALID' ||
    reason.includes('TIMEOUT') ||
    reason.includes('DEADLINE') ||
    reason.includes('BUDGET') ||
    reason.endsWith('_ERROR')
  );
}

function shouldRunHostCleanup(
  runtimeStatus: BusinessRuntimeResult['status'],
  stopReason: string | null,
): boolean {
  if (runtimeStatus === 'COMPLETE') return isHardStopReason(stopReason);
  return (
    runtimeStatus === 'ERROR' ||
    runtimeStatus === 'CANCELLED' ||
    runtimeStatus === 'BLOCKED'
  );
}

async function runHostCleanup(
  services: BusinessServices,
  trace: BusinessTrace,
  runtime: BusinessRuntimeResult,
  boundary: ToolBoundary,
  secrets: readonly string[],
): Promise<void> {
  const stats = boundary.stats();
  if (!shouldRunHostCleanup(runtime.status, stats.stop_reason)) return;
  if (hasTicket(services)) return;
  const robotId = services.snapshot().simulator.robots.find(
    (robot) => robot.robot_id === 'R-03',
  )?.robot_id;
  if (robotId === undefined) return;

  const reason = `Host cleanup after runtime status ${runtime.status}; stop reason ${stats.stop_reason ?? 'none'}`;
  const callId = `host-cleanup-${trace.runId}`;
  const context = {
    run_id: trace.runId,
    session_id: trace.sessionId,
    call_id: callId,
  };
  try {
    const result = services.invoke(
      'create_maintenance_ticket',
      { robot_id: robotId, reason },
      context,
    );
    trace.record('host_cleanup', callId, {
      robot_id: robotId,
      reason,
      runtime_status: runtime.status,
      stop_reason: stats.stop_reason,
      result: redactValue(result, secrets),
    });
  } catch (error) {
    trace.record('host_cleanup', callId, {
      robot_id: robotId,
      reason,
      runtime_status: runtime.status,
      stop_reason: stats.stop_reason,
      error: safeError(error, secrets),
    });
  }
}

export async function runBusinessInternal(
  options: RunBusinessOptions,
  env: NodeJS.ProcessEnv,
): Promise<RunBusinessResult> {
  const projectRoot = path.resolve(options.projectRoot);
  const scenario = getBusinessScenario(options.scenarioId, options.config);
  const runId = createRunId(options.mode);
  const repeat = options.repeat ?? 1;
  if (!Number.isInteger(repeat) || repeat < 0) {
    throw new TypeError('repeat must be a non-negative integer');
  }

  const [installedVersions, lockfileSha256, provenance] = await Promise.all([
    readInstalledVersions(projectRoot),
    readLockfileDigest(projectRoot),
    collectRunProvenance(),
  ]);
  const model =
    options.mode === 'offline'
      ? 'scripted-business-v1'
      : options.model?.trim() || defaultModel(env);

  const manifest: RunManifest = {
    schema_version: 2,
    provenance,
    run_id: runId,
    created_at: new Date().toISOString(),
    scenario_id: options.scenarioId,
    mode: options.mode,
    model,
    config: options.config,
    approval_source: options.approvalMode,
    batch_id: options.batchId ?? runId,
    repeat,
    fixture_sha256: digest({
      fixture: scenario.fixture,
      failures: scenario.failures,
    }),
    prompt_sha256: digest(scenario.prompt),
    config_sha256: digest({
      mode: options.mode,
      recovery_mode: options.config,
      approval_source: options.approvalMode,
      model,
      budgets: {
        model_requests: DEFAULT_BUDGETS.modelRequests,
        tool_calls: DEFAULT_BUDGETS.toolCalls,
        active_ms: DEFAULT_BUDGETS.activeMs,
        approval_ms: DEFAULT_BUDGETS.approvalMs,
      },
    }),
    lockfile_sha256: lockfileSha256,
    installed_versions: installedVersions,
    harness_version: HARNESS_VERSION,
  };

  const secrets = redactionSecrets(env);
  const trace = new BusinessTrace({ runId, scenarioId: options.scenarioId });
  const simulator = new RobotSimulator({
    runId,
    trace,
    fixture: scenario.fixture,
    failures: scenario.failures,
  });
  const services = new BusinessServices({ runId, simulator, trace });
  const nativeEvents: unknown[] = [];
  const ledger = new ApprovalLedger({
    runId,
    trace,
    allowScripted: options.approvalMode === 'scripted',
  });
  const boundary = new ToolBoundary({
    runId,
    trace,
    services,
    recoveryMode: options.config,
    authorizeForce: (ctx, args, fingerprint) =>
      ledger.consume(
        ctx,
        args,
        fingerprint,
        nativeApprovalGranted(nativeEvents, ctx),
      ),
  });
  const approval = makeApproval(
    options.approvalMode,
    scenario.scriptedDecision,
    options.manualDecide,
  );

  let runtime: BusinessRuntimeResult;
  if (options.mode === 'live' && !hasLiveApiKey(env)) {
    runtime = {
      status: 'BLOCKED',
      session_id: null,
      persisted_event_count: 0,
      error: {
        name: 'MissingApiKeyError',
        message: 'DEEPSEEK_API_KEY is required for live mode',
        code: 'MISSING_API_KEY',
      },
    };
    trace.record('runtime_blocked', null, {
      phase: 'initialization',
      error: runtime.error,
    });
  } else {
    try {
      runtime = await executeBusinessRuntime({
        projectRoot,
        runId,
        scenarioId: options.scenarioId,
        mode: options.mode,
        model,
        prompt: scenario.prompt,
        turns: scenario.turns,
        trace,
        boundary,
        ledger,
        nativeEvents,
        ...(approval === undefined ? {} : { approval }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      const details = safeError(error, secrets);
      runtime = {
        status: trace.sessionId === null ? 'BLOCKED' : 'ERROR',
        session_id: trace.sessionId,
        persisted_event_count: 0,
        error: {
          name: details.name,
          message: details.message,
          code: details.code,
        },
      };
      trace.record('runtime_error', null, { phase: 'execution', error: details });
    }
  }

  const runtimeAttempted = !(options.mode === 'live' && !hasLiveApiKey(env));
  if (runtimeAttempted) {
    await runHostCleanup(services, trace, runtime, boundary, secrets);
  }

  trace.record('run_finished', null, {
    snapshot: services.snapshot(),
    runtime_status: runtime.status,
    stats: boundary.stats(),
  });

  const events = trace.events();
  const metrics = evaluateRun({ manifest, events, nativeEvents });
  // Report the manifest exactly as written, so the returned value and the on-disk
  // artifact agree (this is what seals the evidence digest).
  const written = await writeRunBundle({
    projectRoot,
    manifest,
    events,
    nativeEvents,
    metrics,
    redactionSecrets: secrets,
  });
  return { directory: written.directory, manifest: written.manifest, metrics };
}

export async function runBusiness(
  options: RunBusinessOptions,
): Promise<RunBusinessResult> {
  return runBusinessInternal(options, process.env);
}

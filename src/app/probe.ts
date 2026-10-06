import process from 'node:process';

import { evaluateDefaultOfflineAcceptance, evaluateLiveAcceptance } from '../eval/probe-acceptance.js';
import { buildSummary, issueDetail } from '../eval/probe-report.js';
import type { AcceptanceReport } from '../contracts/probe-acceptance.js';
import type { GateEvidence, GateStatus, LiveEvidence } from '../contracts/probe-evidence.js';
import type { LiveSmokeResult, ProbeExecutionResult, SafeError } from '../contracts/probe.js';
import {
  executeLiveSmoke,
  executeOfflineSecurityCases,
  modelFromEnvironment,
} from '../harness/probe-runtime.js';
import {
  createRunPaths,
  readInstalledVersions,
  readLockfileDigest,
  safeError,
  writeEvidenceBundle,
} from '../trace/probe-evidence.js';

const DEEPSEEK_PROVIDER_ROUTE = 'deepseek-official';
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function annotateCaseSequence(events: readonly unknown[], caseSequence: number): readonly unknown[] {
  return events.map((event) => isRecord(event)
    ? { ...event, case_sequence: caseSequence }
    : { value: event, case_sequence: caseSequence });
}

function assignBatchSequence(events: readonly unknown[]): readonly unknown[] {
  return events.map((event, index) => isRecord(event)
    ? { ...event, batch_sequence: index + 1 }
    : { value: event, batch_sequence: index + 1 });
}

export async function runProbeCli(mode: 'offline' | 'live'): Promise<number> {
  const projectRoot = process.cwd();
  const paths = createRunPaths(projectRoot, mode);
  const configuredKey = process.env.DEEPSEEK_API_KEY;
  const apiKey = configuredKey === undefined ? '' : configuredKey.trim();
  const secrets = apiKey === '' ? [] : [apiKey];
  const model = modelFromEnvironment();
  let installedVersions: Record<string, string> = {};
  let lockfileSha256 = '';
  let envError: SafeError | null = null;
  let offlineResult: ProbeExecutionResult | undefined;
  let offlineReport: AcceptanceReport | undefined;
  let offlineRuntimeError: SafeError | null = null;
  let liveResult: LiveSmokeResult | undefined;
  let liveReport: AcceptanceReport | undefined;
  let liveError: SafeError | null = null;
  let liveBlockedReason: string | undefined;
  let status: GateStatus = 'BLOCKED';
  let stage0Complete = false;
  let exitCode = 2;
  const blocked: string[] = [];
  const notes: string[] = [];

  try {
    try {
      installedVersions = await readInstalledVersions(projectRoot);
      lockfileSha256 = await readLockfileDigest(projectRoot);
    } catch (error) {
      envError = safeError(error, secrets);
      blocked.push(`static dependency gate: ${envError.message}`);
    }

    if (envError === null) {
      try {
        offlineResult = await executeOfflineSecurityCases(projectRoot, paths.runId);
        offlineReport = evaluateDefaultOfflineAcceptance(offlineResult);
      } catch (error) {
        offlineRuntimeError = safeError(error, secrets);
        notes.push(`offline runtime failed: ${offlineRuntimeError.message}`);
      }
    }

    if (envError !== null) {
      status = 'BLOCKED';
      exitCode = 2;
      notes.push('offline and live verification were not run because the static dependency gate is blocked');
    } else if (offlineRuntimeError !== null || offlineResult === undefined || offlineReport === undefined) {
      status = 'FAIL';
      exitCode = 1;
      notes.push('offline runtime did not return an independently verifiable result');
    } else if (!offlineReport.passed) {
      status = 'FAIL';
      exitCode = 1;
      notes.push(`offline acceptance failed: ${issueDetail(offlineReport.issues, 'unknown acceptance failure')}`);
    } else if (mode === 'offline') {
      status = 'PASS';
      stage0Complete = false;
      exitCode = 0;
      notes.push('offline acceptance passed, but live smoke remains NOT_RUN and Stage 0 is not complete');
    } else {
      if (apiKey === '') {
        liveBlockedReason = 'DEEPSEEK_API_KEY is required for live smoke; no provider request was made';
        blocked.push(liveBlockedReason);
        status = 'BLOCKED';
        exitCode = 2;
        notes.push(liveBlockedReason);
      } else {
        try {
          liveResult = await executeLiveSmoke(projectRoot, paths.runId, DEEPSEEK_PROVIDER_ROUTE, model);
        } catch (error) {
          liveError = safeError(error, secrets);
        }

        if (liveError !== null) {
          liveBlockedReason = `live smoke was blocked: ${liveError.message}`;
          blocked.push(liveBlockedReason);
          status = 'BLOCKED';
          exitCode = 2;
          notes.push(liveBlockedReason);
        } else if (liveResult === undefined) {
          liveBlockedReason = 'live smoke returned no result';
          blocked.push(liveBlockedReason);
          status = 'BLOCKED';
          exitCode = 2;
          notes.push(liveBlockedReason);
        } else {
          liveReport = evaluateLiveAcceptance(liveResult);
          if (liveResult.status === 'BLOCKED' && liveResult.error !== null) {
            liveBlockedReason = `live smoke was blocked by the runtime: ${liveResult.error.message}`;
            blocked.push(liveBlockedReason);
            status = 'BLOCKED';
            exitCode = 2;
            notes.push(liveBlockedReason);
          } else if (liveReport.passed) {
            status = 'PASS';
            stage0Complete = true;
            exitCode = 0;
            notes.push('live get_robot_status request, readable handler result, and persisted native events were verified');
          } else {
            status = 'FAIL';
            stage0Complete = false;
            exitCode = 1;
            notes.push(`live acceptance failed: ${issueDetail(liveReport.issues, 'unknown live acceptance failure')}`);
          }
        }
      }
    }
  } catch (error) {
    offlineRuntimeError = safeError(error, secrets);
    status = 'FAIL';
    stage0Complete = false;
    exitCode = 1;
    notes.push(`unexpected CLI failure: ${offlineRuntimeError.message}`);

  } finally {
    const liveStatus: GateStatus = mode === 'offline'
      ? 'NOT_RUN'
      : envError !== null || offlineRuntimeError !== null || offlineReport === undefined || !offlineReport.passed
        ? 'NOT_RUN'
        : liveBlockedReason !== undefined
          ? 'BLOCKED'
          : liveReport === undefined
            ? 'NOT_RUN'
            : liveReport.passed ? 'PASS' : 'FAIL';
    const liveDetail = mode === 'offline'
      ? 'Live smoke was not run in offline mode.'
      : liveBlockedReason
        ?? (liveReport === undefined
          ? 'Live gate was not reached because offline acceptance did not pass.'
          : liveReport.passed
            ? 'Real get_robot_status call, readable handler result, and persisted events verified.'
            : issueDetail(liveReport.issues, 'live acceptance failed'));
    const liveGate: GateEvidence = {
      name: 'live-gate',
      status: liveStatus,
      verification: 'live',
      detail: liveDetail,
    };
    const liveEvidence: LiveEvidence = {
      status: liveStatus,
      provider: liveResult?.provider ?? '',
      model: liveResult?.model ?? model,
      detail: liveDetail,
    };
    const summary = buildSummary({
      runId: paths.runId,
      mode,
      installedVersions,
      lockfileSha256,
      envError,
      offlineResult,
      offlineReport,
      offlineRuntimeError,
      liveResult,
      liveReport,
      liveGate,
      liveEvidence,
      status,
      stage0Complete,
      blocked,
      notes,
    });

    const offlineCases = offlineResult?.cases ?? [];
    const liveCaseSequence = offlineCases.length + 1;
    const nativeForBatch: unknown[] = [
      ...offlineCases.flatMap((item, index) => annotateCaseSequence(item.nativeEvents, index + 1)),
      ...(liveResult === undefined ? [] : annotateCaseSequence(liveResult.nativeEvents, liveCaseSequence)),
    ];
    const probeForBatch: unknown[] = [
      ...offlineCases.flatMap((item, index) => annotateCaseSequence(item.probeEvents, index + 1)),
      ...(liveResult === undefined ? [] : annotateCaseSequence(liveResult.probeEvents, liveCaseSequence)),
    ];
    const nativeEvents = assignBatchSequence(nativeForBatch);
    const probeEvents = assignBatchSequence(probeForBatch);

    let evidenceError: SafeError | null = null;
    try {
      await writeEvidenceBundle({
        projectRoot,
        runId: paths.runId,
        nativeEvents,
        probeEvents,
        summary,
        redactionSecrets: secrets,
      });
    } catch (error) {
      evidenceError = safeError(error, secrets);
      exitCode = 1;
      notes.push(`evidence write failed: ${evidenceError.message}`);
    }

    const consoleStatus: GateStatus = evidenceError === null ? status : 'FAIL';
    const consoleComplete = evidenceError === null && stage0Complete;
    console.log(JSON.stringify({
      status: consoleStatus,
      runId: paths.runId,
      evidenceDir: paths.evidenceDir,
      stage0Complete: consoleComplete,
      ...(evidenceError === null ? {} : { error: evidenceError }),
    }));
  }
  return exitCode;
}

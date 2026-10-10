import process from 'node:process';

import { evaluateLiveAcceptance } from '../eval/probe-acceptance.js';
import { buildSummary, issueDetail } from '../eval/probe-report.js';
import type { AcceptanceReport } from '../contracts/probe-acceptance.js';
import type { GateEvidence, GateStatus, LiveEvidence } from '../contracts/probe-evidence.js';
import type { LiveSmokeResult, SafeError } from '../contracts/probe.js';
import { executeLiveSmoke, modelFromEnvironment } from '../harness/probe-runtime.js';
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

function assignBatchSequence(events: readonly unknown[]): readonly unknown[] {
  return events.map((event, index) => isRecord(event)
    ? { ...event, batch_sequence: index + 1 }
    : { value: event, batch_sequence: index + 1 });
}

/**
 * Stage 0 probe: a static dependency gate followed by a real-model smoke run. There is
 * no scripted model path; without DEEPSEEK_API_KEY the live gate is BLOCKED.
 */
export async function runProbeCli(): Promise<number> {
  const projectRoot = process.cwd();
  const paths = createRunPaths(projectRoot);
  const configuredKey = process.env.DEEPSEEK_API_KEY;
  const apiKey = configuredKey === undefined ? '' : configuredKey.trim();
  const secrets = apiKey === '' ? [] : [apiKey];
  const model = modelFromEnvironment();
  let installedVersions: Record<string, string> = {};
  let lockfileSha256 = '';
  let envError: SafeError | null = null;
  let liveResult: LiveSmokeResult | undefined;
  let liveReport: AcceptanceReport | undefined;
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

    if (envError !== null) {
      notes.push('live verification was not run because the static dependency gate is blocked');
    } else if (apiKey === '') {
      liveBlockedReason = 'DEEPSEEK_API_KEY is required for live smoke; no provider request was made';
      blocked.push(liveBlockedReason);
      notes.push(liveBlockedReason);
    } else {
      let liveError: SafeError | null = null;
      try {
        liveResult = await executeLiveSmoke(projectRoot, paths.runId, DEEPSEEK_PROVIDER_ROUTE, model);
      } catch (error) {
        liveError = safeError(error, secrets);
      }

      if (liveError !== null || liveResult === undefined) {
        liveBlockedReason = liveError === null
          ? 'live smoke returned no result'
          : `live smoke was blocked: ${liveError.message}`;
        blocked.push(liveBlockedReason);
        notes.push(liveBlockedReason);
      } else {
        liveReport = evaluateLiveAcceptance(liveResult);
        if (liveResult.status === 'BLOCKED' && liveResult.error !== null) {
          liveBlockedReason = `live smoke was blocked by the runtime: ${liveResult.error.message}`;
          blocked.push(liveBlockedReason);
          notes.push(liveBlockedReason);
        } else if (liveReport.passed) {
          status = 'PASS';
          stage0Complete = true;
          exitCode = 0;
          notes.push('live get_robot_status request, readable handler result, and persisted native events were verified');
        } else {
          status = 'FAIL';
          exitCode = 1;
          notes.push(`live acceptance failed: ${issueDetail(liveReport.issues, 'unknown live acceptance failure')}`);
        }
      }
    }
  } catch (error) {
    const unexpected = safeError(error, secrets);
    status = 'FAIL';
    stage0Complete = false;
    exitCode = 1;
    notes.push(`unexpected CLI failure: ${unexpected.message}`);
  } finally {
    const liveStatus: GateStatus = envError !== null
      ? 'NOT_RUN'
      : liveBlockedReason !== undefined
        ? 'BLOCKED'
        : liveReport === undefined
          ? 'NOT_RUN'
          : liveReport.passed ? 'PASS' : 'FAIL';
    const liveDetail = liveBlockedReason
      ?? (liveReport === undefined
        ? 'Live gate was not reached.'
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
      installedVersions,
      lockfileSha256,
      envError,
      liveResult,
      liveReport,
      liveGate,
      liveEvidence,
      status,
      stage0Complete,
      blocked,
      notes,
    });

    let evidenceError: SafeError | null = null;
    try {
      await writeEvidenceBundle({
        projectRoot,
        runId: paths.runId,
        nativeEvents: assignBatchSequence(liveResult?.nativeEvents ?? []),
        probeEvents: assignBatchSequence(liveResult?.probeEvents ?? []),
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

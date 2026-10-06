import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  BusinessMetrics,
  RecoveryMode,
  ScenarioId,
} from '../contracts/run.js';
import { SCENARIO_IDS } from '../contracts/run.js';
import { createRunId } from '../trace/run-evidence.js';
import { safeError } from '../trace/probe-evidence.js';
import {
  aggregateExitCode,
  emitError,
  emitJson,
  emitRun,
  redactionSecrets,
  valueAfter,
  writeFailure,
  type BusinessCliIO,
} from './business-io.js';
import { runBusinessInternal } from './business-run.js';

type LiveMode = 'offline' | 'live';

interface EvalSpec {
  readonly scenarioId: ScenarioId;
  readonly approvalMode: 'scripted';
  readonly config: RecoveryMode;
  readonly repeat: number;
}

interface EvalOptions {
  readonly offline: boolean;
  readonly repeats: number;
}

interface EvalRunRecord extends EvalSpec {
  readonly run_id: string | null;
  readonly directory: string | null;
  readonly metrics: BusinessMetrics | null;
  readonly error: ReturnType<typeof safeError> | null;
}

interface EvalCounts {
  readonly pass: number;
  readonly fail: number;
  readonly blocked: number;
  readonly task_success: number;
  readonly unsafe_action_count: number;
}

const DEFAULT_EVAL_REPEATS = 3;
const MIN_EVAL_REPEATS = 1;
const MAX_EVAL_REPEATS = 100;

export const CONFIGS: readonly RecoveryMode[] = ['full', 'fail-fast'];

function isValidEvalRepeats(repeats: number): boolean {
  return Number.isInteger(repeats)
    && repeats >= MIN_EVAL_REPEATS
    && repeats <= MAX_EVAL_REPEATS;
}

export function createEvalPlan(repeats: number): readonly EvalSpec[] {
  if (!isValidEvalRepeats(repeats)) {
    throw new RangeError('eval repeats must be an integer between 1 and 100');
  }
  return SCENARIO_IDS.flatMap((scenarioId) =>
    CONFIGS.flatMap((config) =>
      Array.from({ length: repeats }, (_, index) => ({
        scenarioId,
        config,
        repeat: index + 1,
        approvalMode: 'scripted' as const,
      })),
    ),
  );
}

export const EVAL_PLAN: readonly EvalSpec[] = createEvalPlan(DEFAULT_EVAL_REPEATS);

function parseEvalOptions(argv: readonly string[]): EvalOptions | string {
  let offline = false;
  let repeats = DEFAULT_EVAL_REPEATS;
  let repeatsSeen = false;

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]!;
    if (option === '--offline') {
      if (offline) return 'duplicate eval option: --offline';
      offline = true;
      continue;
    }
    if (option === '--repeats') {
      if (repeatsSeen) return 'duplicate eval option: --repeats';
      const parsed = valueAfter(argv, index, option);
      if (typeof parsed === 'string') return parsed;
      if (!/^\d+$/.test(parsed.value)) return `invalid eval repeats: ${parsed.value}`;
      const value = Number(parsed.value);
      if (!isValidEvalRepeats(value)) return `invalid eval repeats: ${parsed.value}`;
      repeats = value;
      repeatsSeen = true;
      index = parsed.nextIndex;
      continue;
    }
    return `unknown eval option: ${option}`;
  }

  return { offline, repeats };
}

function evalRecordStatus(record: EvalRunRecord): BusinessMetrics['status'] {
  return record.error !== null || record.metrics === null
    ? 'BLOCKED'
    : record.metrics.status;
}

function evalCounts(records: readonly EvalRunRecord[]): EvalCounts {
  const counts = { pass: 0, fail: 0, blocked: 0, task_success: 0, unsafe_action_count: 0 };
  for (const record of records) {
    const status = evalRecordStatus(record);
    if (status === 'PASS') counts.pass += 1;
    else if (status === 'FAIL') counts.fail += 1;
    else counts.blocked += 1;
    if (record.metrics?.task_success === true) counts.task_success += 1;
    counts.unsafe_action_count += record.metrics?.unsafe_action_count ?? 0;
  }
  return counts;
}

function evalGroups(
  records: readonly EvalRunRecord[],
  repeats: number,
): readonly (Omit<EvalSpec, 'repeat'> & EvalCounts & {
  readonly planned: number;
  readonly actual: number;
  readonly run_ids: readonly string[];
  readonly statuses: readonly BusinessMetrics['status'][];
})[] {
  return SCENARIO_IDS.flatMap((scenarioId) =>
    CONFIGS.map((config) => {
      const matches = records.filter(
        (record) => record.scenarioId === scenarioId && record.config === config,
      );
      return {
        scenarioId,
        config,
        approvalMode: 'scripted' as const,
        planned: repeats,
        actual: matches.length,
        run_ids: matches.flatMap((record) => record.run_id === null ? [] : [record.run_id]),
        statuses: matches.map(evalRecordStatus),
        ...evalCounts(matches),
      };
    }),
  );
}

function createEvalSummary(
  records: readonly EvalRunRecord[],
  plan: readonly EvalSpec[],
  repeats: number,
  batchId: string,
  mode: LiveMode,
) {
  return {
    schema_version: 1,
    batch_id: batchId,
    command: 'eval',
    mode,
    repeats,
    planned: plan.length,
    expected: plan.length,
    actual: records.length,
    missing: plan.length - records.length,
    complete: records.length === plan.length,
    ...evalCounts(records),
    plan: plan.map((spec) => ({
      scenario_id: spec.scenarioId,
      config: spec.config,
      approval_mode: spec.approvalMode,
      approval_source: spec.approvalMode,
      repeat: spec.repeat,
    })),
    runs: records.map((record) => ({
      scenario_id: record.scenarioId,
      config: record.config,
      approval_mode: record.approvalMode,
      approval_source: record.approvalMode,
      repeat: record.repeat,
      run_id: record.run_id,
      directory: record.directory,
      metrics: record.metrics,
      error: record.error,
    })),
    groups: evalGroups(records, repeats).map((group) => ({
      scenario_id: group.scenarioId,
      config: group.config,
      approval_mode: group.approvalMode,
      approval_source: group.approvalMode,
      planned: group.planned,
      actual: group.actual,
      run_ids: group.run_ids,
      statuses: group.statuses,
      pass: group.pass,
      fail: group.fail,
      blocked: group.blocked,
      task_success: group.task_success,
      unsafe_action_count: group.unsafe_action_count,
    })),
  };
}

async function persistEvalSummary(summaryPath: string, summary: unknown): Promise<void> {
  const temporaryPath = `${summaryPath}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, summaryPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function runEval(io: BusinessCliIO, argv: readonly string[]): Promise<number> {
  const options = parseEvalOptions(argv);
  if (typeof options === 'string') return writeFailure(io, options);

  const mode: LiveMode = options.offline ? 'offline' : 'live';
  const projectRoot = path.resolve(io.cwd);
  const batchId = createRunId('eval-batch');
  const plan = createEvalPlan(options.repeats);
  const records: EvalRunRecord[] = [];
  const summaryDirectory = path.resolve(projectRoot, 'results', 'batches', batchId);
  const summaryPath = path.join(summaryDirectory, 'summary.json');

  try {
    await mkdir(summaryDirectory, { recursive: true });
    await persistEvalSummary(
      summaryPath,
      createEvalSummary(records, plan, options.repeats, batchId, mode),
    );
  } catch (error) {
    emitError(io, error);
    return 2;
  }

  for (const spec of plan) {
    try {
      const result = await runBusinessInternal(
        {
          projectRoot,
          scenarioId: spec.scenarioId,
          config: spec.config,
          mode,
          approvalMode: spec.approvalMode,
          batchId,
          repeat: spec.repeat,
        },
        io.env,
      );
      records.push({
        ...spec,
        run_id: result.manifest.run_id,
        directory: result.directory,
        metrics: result.metrics,
        error: null,
      });
      emitRun(io, result);
    } catch (error) {
      const details = safeError(error, redactionSecrets(io.env));
      records.push({
        ...spec,
        run_id: null,
        directory: null,
        metrics: null,
        error: details,
      });
      emitJson(io, {
        status: 'BLOCKED',
        scenario_id: spec.scenarioId,
        config: spec.config,
        approval_source: spec.approvalMode,
        error: details,
      });
    }

    try {
      await persistEvalSummary(
        summaryPath,
        createEvalSummary(records, plan, options.repeats, batchId, mode),
      );
    } catch (error) {
      emitError(io, error);
      return 2;
    }
  }

  const summary = createEvalSummary(records, plan, options.repeats, batchId, mode);
  emitJson(io, summary);
  const metrics = records.flatMap((record) =>
    record.metrics === null ? [] : [record.metrics],
  );
  return aggregateExitCode(
    metrics,
    records.some((record) => record.error !== null || record.metrics === null),
  );
}

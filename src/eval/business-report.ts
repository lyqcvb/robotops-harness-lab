import type {
  BusinessMetrics,
  RunManifest,
  ScenarioId,
  RecoveryMode,
} from '../contracts/run.js';
import { SCENARIO_IDS } from '../contracts/run.js';
import { evaluateRun } from './business-acceptance.js';
import { readRunEvidence } from '../trace/run-evidence.js';

export interface RunSummaryInput {
  readonly manifest: RunManifest;
  readonly metrics: BusinessMetrics;
}

export interface SummaryBucket {
  readonly total: number;
  readonly pass: number;
  readonly fail: number;
  readonly blocked: number;
  readonly task_success: number;
  readonly unsafe_action_count: number;
  readonly run_ids: readonly string[];
}

export interface ModeSummary extends SummaryBucket {
  readonly mode: 'offline' | 'live';
  readonly complete: boolean;
  readonly missing: number;
}

export interface ScenarioArmSummary extends SummaryBucket {
  readonly mode: 'offline' | 'live';
  readonly scenario_id: ScenarioId;
  readonly config: RecoveryMode;
}

export interface BatchSummary {
  readonly expected: number;
  readonly actual: number;
  readonly missing: number;
  readonly extra: number;
  readonly complete: boolean;
  readonly modes: {
    readonly offline: ModeSummary;
    readonly live: ModeSummary;
  };
  readonly groups: readonly ScenarioArmSummary[];
  readonly run_ids: readonly string[];
}

function emptyBucket(): SummaryBucket {
  return {
    total: 0,
    pass: 0,
    fail: 0,
    blocked: 0,
    task_success: 0,
    unsafe_action_count: 0,
    run_ids: [],
  };
}

function addRun(bucket: SummaryBucket, run: RunSummaryInput): void {
  const mutable = bucket as {
    total: number;
    pass: number;
    fail: number;
    blocked: number;
    task_success: number;
    unsafe_action_count: number;
    run_ids: string[];
  };
  mutable.total += 1;
  if (run.metrics.status === 'PASS') mutable.pass += 1;
  else if (run.metrics.status === 'BLOCKED') mutable.blocked += 1;
  else mutable.fail += 1;
  if (run.metrics.task_success) mutable.task_success += 1;
  mutable.unsafe_action_count += run.metrics.unsafe_action_count;
  mutable.run_ids.push(run.manifest.run_id);
}

function groupKey(
  mode: RunManifest['mode'],
  scenarioId: ScenarioId,
  config: RecoveryMode,
): string {
  return `${mode}\u0000${scenarioId}\u0000${config}`;
}

export function summarizeRuns(
  runs: readonly RunSummaryInput[],
  expected = 30,
): BatchSummary {
  const offline = emptyBucket();
  const live = emptyBucket();
  const groups = new Map<string, ScenarioArmSummary>();

  for (const run of runs) {
    const modeBucket = run.manifest.mode === 'live' ? live : offline;
    addRun(modeBucket, run);

    const key = groupKey(run.manifest.mode, run.manifest.scenario_id, run.manifest.config);
    const existing = groups.get(key);
    if (existing === undefined) {
      const bucket = emptyBucket();
      const group: ScenarioArmSummary = {
        ...bucket,
        mode: run.manifest.mode,
        scenario_id: run.manifest.scenario_id,
        config: run.manifest.config,
      };
      addRun(group, run);
      groups.set(key, group);
    } else {
      addRun(existing, run);
    }
  }

  const actual = runs.length;
  const missing = Math.max(expected - actual, 0);
  const extra = Math.max(actual - expected, 0);
  const complete = actual === expected;
  const modeComplete = (bucket: SummaryBucket): boolean => bucket.total === expected;
  const modeMissing = (bucket: SummaryBucket): number => Math.max(expected - bucket.total, 0);

  return {
    expected,
    actual,
    missing,
    extra,
    complete,
    modes: {
      offline: {
        ...offline,
        mode: 'offline',
        complete: modeComplete(offline),
        missing: modeMissing(offline),
      },
      live: {
        ...live,
        mode: 'live',
        complete: modeComplete(live),
        missing: modeMissing(live),
      },
    },
    groups: [...groups.values()].sort((left, right) => {
      const leftIndex = SCENARIO_IDS.indexOf(left.scenario_id);
      const rightIndex = SCENARIO_IDS.indexOf(right.scenario_id);
      return (
        left.mode.localeCompare(right.mode) ||
        leftIndex - rightIndex ||
        left.config.localeCompare(right.config)
      );
    }),
    run_ids: runs.map((run) => run.manifest.run_id),
  };
}

export async function recomputeRun(directory: string): Promise<BusinessMetrics> {
  const evidence = await readRunEvidence(directory);
  return evaluateRun(evidence);
}

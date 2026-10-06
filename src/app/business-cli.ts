import path from 'node:path';
import process from 'node:process';

import type { BusinessMetrics, RecoveryMode, ScenarioId } from '../contracts/run.js';
import { SCENARIO_IDS } from '../contracts/run.js';
import { createRunId } from '../trace/run-evidence.js';
import { CONFIGS, runEval } from './business-batch.js';
import {
  aggregateExitCode,
  emitError,
  emitRun,
  metricsExitCode,
  resolveIo,
  valueAfter,
  writeFailure,
  type BusinessCliIO,
} from './business-io.js';
import {
  runBusinessInternal,
  type ApprovalMode,
} from './business-run.js';
import { runRecompute } from './business-recompute.js';

interface E2eOptions {
  readonly scenarioId: ScenarioId;
  readonly config: RecoveryMode;
  readonly approvalMode: ApprovalMode;
}

export const DEFAULT_E2E: E2eOptions = {
  scenarioId: 'navigation_restart_success',
  config: 'full',
  approvalMode: 'scripted',
};

function isScenarioId(value: string): value is ScenarioId {
  return (SCENARIO_IDS as readonly string[]).includes(value);
}

function isRecoveryMode(value: string): value is RecoveryMode {
  return value === 'full' || value === 'fail-fast';
}

function isApprovalMode(value: string): value is ApprovalMode {
  return value === 'scripted' || value === 'manual' || value === 'none';
}

function parseE2e(argv: readonly string[]): E2eOptions | string {
  let scenarioId = DEFAULT_E2E.scenarioId;
  let config = DEFAULT_E2E.config;
  let approvalMode = DEFAULT_E2E.approvalMode;

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]!;
    if (option !== '--scenario' && option !== '--config' && option !== '--approval') {
      return `unknown e2e option: ${option}`;
    }
    const parsed = valueAfter(argv, index, option);
    if (typeof parsed === 'string') return parsed;
    index = parsed.nextIndex;
    if (option === '--scenario') {
      if (!isScenarioId(parsed.value)) return `invalid scenario: ${parsed.value}`;
      scenarioId = parsed.value;
    } else if (option === '--config') {
      if (!isRecoveryMode(parsed.value)) return `invalid config: ${parsed.value}`;
      config = parsed.value;
    } else {
      if (!isApprovalMode(parsed.value)) return `invalid approval mode: ${parsed.value}`;
      approvalMode = parsed.value;
    }
  }

  return { scenarioId, config, approvalMode };
}

async function runIntegration(io: BusinessCliIO): Promise<number> {
  const projectRoot = path.resolve(io.cwd);
  const batchId = createRunId('integration-batch');
  const metrics: BusinessMetrics[] = [];
  let threw = false;

  for (const scenarioId of SCENARIO_IDS) {
    for (const config of CONFIGS) {
      try {
        const result = await runBusinessInternal(
          {
            projectRoot,
            scenarioId,
            config,
            mode: 'offline',
            approvalMode: 'scripted',
            batchId,
            repeat: 1,
          },
          io.env,
        );
        emitRun(io, result);
        metrics.push(result.metrics);
      } catch (error) {
        threw = true;
        emitError(io, error);
      }
    }
  }

  return aggregateExitCode(metrics, threw);
}

async function runE2e(io: BusinessCliIO, argv: readonly string[]): Promise<number> {
  const parsed = parseE2e(argv);
  if (typeof parsed === 'string') return writeFailure(io, parsed);

  try {
    const result = await runBusinessInternal(
      {
        projectRoot: path.resolve(io.cwd),
        scenarioId: parsed.scenarioId,
        config: parsed.config,
        mode: 'live',
        approvalMode: parsed.approvalMode,
        repeat: 1,
      },
      io.env,
    );
    emitRun(io, result);
    return metricsExitCode(result.metrics);
  } catch (error) {
    emitError(io, error);
    return 2;
  }
}

async function runDemo(io: BusinessCliIO, argv: readonly string[]): Promise<number> {
  for (const option of argv) {
    if (option === '--approval' || option.startsWith('--approval=')) {
      return writeFailure(io, 'demo always uses real manual approval; scripted approval is not allowed');
    }
    return writeFailure(io, `unknown demo option: ${option}`);
  }

  try {
    const result = await runBusinessInternal(
      {
        projectRoot: path.resolve(io.cwd),
        scenarioId: 'navigation_restart_fail_then_reboot',
        config: 'full',
        mode: 'live',
        approvalMode: 'manual',
        repeat: 1,
      },
      io.env,
    );
    emitRun(io, result);
    return metricsExitCode(result.metrics);
  } catch (error) {
    emitError(io, error);
    return 2;
  }
}

export async function dispatch(
  argv: readonly string[],
  io?: Partial<BusinessCliIO>,
): Promise<number> {
  const resolved = resolveIo(io);
  const command = argv[0];
  if (command === undefined) return writeFailure(resolved, 'missing command');

  switch (command) {
    case 'integration':
      if (argv.length !== 1) return writeFailure(resolved, `unknown integration option: ${argv[1]!}`);
      return runIntegration(resolved);
    case 'e2e':
      return runE2e(resolved, argv.slice(1));
    case 'eval':
      return runEval(resolved, argv.slice(1));
    case 'demo':
      return runDemo(resolved, argv.slice(1));
    case 'recompute':
      return runRecompute(resolved, argv.slice(1));
    default:
      return writeFailure(resolved, `unknown command: ${command}`);
  }
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  io?: Partial<BusinessCliIO>,
): Promise<number> {
  const resolved = resolveIo(io);
  try {
    return await dispatch(argv, resolved);
  } catch (error) {
    emitError(resolved, error);
    return 2;
  }
}

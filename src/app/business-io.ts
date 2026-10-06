import process from 'node:process';

import type { BusinessMetrics } from '../contracts/run.js';
import { redactValue, safeError } from '../trace/probe-evidence.js';

export interface BusinessCliIO {
  stdout(line: string): void;
  stderr(line: string): void;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

interface RunOutput {
  readonly directory: string;
  readonly manifest: {
    readonly run_id: string;
    readonly scenario_id: string;
    readonly config: string;
    readonly mode: string;
    readonly approval_source: string;
  };
  readonly metrics: BusinessMetrics;
}
export const USAGE = [
  'usage: business <command> [options]',
  '  integration',
  '  e2e [--scenario <scenario>] [--config full|fail-fast] [--approval scripted|manual|none]',
  '  eval [--offline]',
  '  demo',
  '  recompute [--run <run-directory>]',
].join('\n');

const SECRET_ENV_KEY = /(^|_)(api_?key|authorization|bearer|password|secret|token)($|_)/i;

export function resolveIo(io: Partial<BusinessCliIO> = {}): BusinessCliIO {
  return {
    stdout: io.stdout ?? ((line: string): void => {
      process.stdout.write(`${line}\n`);
    }),
    stderr: io.stderr ?? ((line: string): void => {
      process.stderr.write(`${line}\n`);
    }),
    env: io.env ?? process.env,
    cwd: io.cwd ?? process.cwd(),
  };
}

export function writeFailure(io: BusinessCliIO, message: string): number {
  io.stderr(`error: ${message}`);
  io.stderr(USAGE);
  return 2;
}

export function valueAfter(
  argv: readonly string[],
  index: number,
  option: string,
): { readonly value: string; readonly nextIndex: number } | string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    return `${option} requires a value`;
  }
  return { value, nextIndex: index + 1 };
}
export function metricsExitCode(metrics: BusinessMetrics): number {
  if (metrics.status === 'BLOCKED') return 2;
  if (metrics.status === 'FAIL') return 1;
  return 0;
}

export function aggregateExitCode(
  metrics: readonly BusinessMetrics[],
  threw: boolean,
): number {
  if (threw || metrics.some((item) => item.status === 'BLOCKED')) return 2;
  if (metrics.some((item) => item.status === 'FAIL')) return 1;
  return 0;
}

export function redactionSecrets(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const secrets = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' && value.length > 0 && SECRET_ENV_KEY.test(key)) {
      secrets.add(value);
    }
  }
  return [...secrets];
}

export function emitJson(io: BusinessCliIO, value: unknown): void {
  io.stdout(JSON.stringify(redactValue(value, redactionSecrets(io.env))));
}

export function emitRun(io: BusinessCliIO, result: RunOutput): void {
  emitJson(io, {
    directory: result.directory,
    run_id: result.manifest.run_id,
    scenario_id: result.manifest.scenario_id,
    config: result.manifest.config,
    mode: result.manifest.mode,
    approval_source: result.manifest.approval_source,
    metrics: result.metrics,
  });
}

export function emitError(io: BusinessCliIO, error: unknown): void {
  emitJson(io, {
    status: 'BLOCKED',
    error: safeError(error, redactionSecrets(io.env)),
  });
}

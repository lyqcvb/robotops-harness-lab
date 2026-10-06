import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { CaseEvidence, EvidenceBundleInput, GateStatus, RunPaths, VerificationKind } from '../contracts/probe-evidence.js';
import type { SafeError } from '../contracts/probe.js';
const PACKAGE_NAMES = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-agent-loop',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-llm-deepseek',
  '@deepseek-ai/dsh-scope',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-persistence-jsonl',
  '@deepseek-ai/dsh-session-projection',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-user-approval',
] as const;

const SECRET_KEY = /(^|_)(api_?key|authorization|bearer|password|secret|token)($|_)/i;


function redactText(value: string, secrets: readonly string[]): string {
  let result = value;
  for (const secret of secrets) {
    if (secret.length > 0) result = result.split(secret).join('[REDACTED]');
  }
  result = result
    .replace(/Authorization[ \t]*[:=][ \t]*(?:(?:Basic|Bearer)[ \t]+)?[^\s,}"']+/gi, 'Authorization: [REDACTED]')
    .replace(/Bearer[ \t]+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]{8,}/gi, '[REDACTED]');
  return result;
}

export function redactValue(value: unknown, secrets: readonly string[] = []): unknown {
  if (typeof value === 'string') return redactText(value, secrets);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets));
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      Object.defineProperty(result, key, {
        value: SECRET_KEY.test(key) ? '[REDACTED]' : redactValue(child, secrets),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return result;
  }
  return String(value);
}

export function safeError(error: unknown, secrets: readonly string[] = []): SafeError {
  if (error instanceof Error) {
    const coded = error as Error & { readonly code?: unknown };
    return {
      type: 'Error',
      name: error.name,
      code: typeof coded.code === 'string' ? coded.code : null,
      message: redactText(error.message || 'Error', secrets),
    };
  }
  return {
    type: typeof error,
    name: 'UnknownError',
    code: null,
    message: redactText(String(error), secrets),
  };
}

export function createRunPaths(projectRoot: string, mode: 'offline' | 'live', now = new Date()): RunPaths {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const runId = `${stamp}-${mode}-${randomUUID()}`;
  const evidenceRoot = path.resolve(projectRoot, 'evidence', 'stage0');
  return {
    runId,
    evidenceRoot,
    evidenceDir: path.join(evidenceRoot, runId),
    persistenceRoot: path.resolve(projectRoot, '.stage0', runId),
  };
}

export async function writeEvidenceBundle(input: EvidenceBundleInput): Promise<string> {
  const secrets = input.redactionSecrets ?? [];
  const evidenceRoot = path.resolve(input.projectRoot, 'evidence', 'stage0');
  const evidenceDir = path.join(evidenceRoot, input.runId);
  await mkdir(evidenceRoot, { recursive: true });
  await mkdir(evidenceDir);

  const nativeLines = input.nativeEvents.map((event) => JSON.stringify(redactValue(event, secrets)));
  const probeLines = input.probeEvents.map((event) => JSON.stringify(redactValue(event, secrets)));
  const summary = redactValue(input.summary, secrets);

  await writeFile(path.join(evidenceDir, 'native-events.jsonl'), `${nativeLines.join('\n')}${nativeLines.length > 0 ? '\n' : ''}`, { flag: 'wx' });
  await writeFile(path.join(evidenceDir, 'probe-events.jsonl'), `${probeLines.join('\n')}${probeLines.length > 0 ? '\n' : ''}`, { flag: 'wx' });
  await writeFile(path.join(evidenceDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' });
  return evidenceDir;
}

export async function readLockfileDigest(projectRoot: string): Promise<string> {
  const contents = await readFile(path.resolve(projectRoot, 'package-lock.json'));
  return `sha256:${createHash('sha256').update(contents).digest('hex')}`;
}

export async function readInstalledVersions(projectRoot: string): Promise<Record<string, string>> {
  const lock = JSON.parse(await readFile(path.resolve(projectRoot, 'package-lock.json'), 'utf8')) as {
    readonly packages?: Record<string, { readonly version?: unknown }>;
  };
  const versions: Record<string, string> = {};
  const issues: string[] = [];
  for (const name of PACKAGE_NAMES) {
    const installedPath = path.resolve(projectRoot, 'node_modules', ...name.split('/'), 'package.json');
    const lockVersion = lock.packages?.[`node_modules/${name}`]?.version;
    let installedVersion: string | undefined;
    try {
      const installedPackage = JSON.parse(await readFile(installedPath, 'utf8')) as { readonly version?: unknown };
      installedVersion = typeof installedPackage.version === 'string' ? installedPackage.version : undefined;
    } catch (error) {
      const coded = error as { readonly code?: unknown };
      issues.push(`${name}: installed package metadata unavailable (${typeof coded.code === 'string' ? coded.code : 'unknown'})`);
      continue;
    }
    if (installedVersion === undefined) {
      issues.push(`${name}: installed package.json has no version`);
      continue;
    }
    if (typeof lockVersion !== 'string') {
      issues.push(`${name}: lockfile entry is missing`);
      continue;
    }
    if (lockVersion !== installedVersion) {
      issues.push(`${name}: installed=${installedVersion} lock=${lockVersion}`);
      continue;
    }
    versions[name] = installedVersion;
  }
  if (issues.length > 0) {
    const error = new Error(`installed dependency version gate failed: ${issues.join('; ')}`);
    Object.assign(error, { code: 'ENV_INSTALLED_VERSION_MISMATCH' });
    throw error;
  }
  return versions;
}

export function makeProbeEvent(
  event: string,
  runId: string,
  data: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    schema_version: 1,
    event,
    run_id: runId,
    time: new Date().toISOString(),
    ...data,
  };
}

export function makeCaseEvidence(input: {
  readonly id: string;
  readonly status: GateStatus;
  readonly verification: VerificationKind;
  readonly sessionId?: string | null;
  readonly modelRequests: number;
  readonly toolRequests: number;
  readonly actionExecutions: number;
  readonly approvalAsked: number;
  readonly approvalAllowedOnce: number;
  readonly notes?: readonly string[];
}): CaseEvidence {
  return {
    id: input.id,
    status: input.status,
    verification: input.verification,
    sessionId: input.sessionId ?? null,
    modelRequests: input.modelRequests,
    toolRequests: input.toolRequests,
    actionExecutions: input.actionExecutions,
    approvalAsked: input.approvalAsked,
    approvalAllowedOnce: input.approvalAllowedOnce,
    notes: input.notes ?? [],
  };
}


import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson } from '../contracts/canonical-json.js';
import type { BusinessMetrics } from '../contracts/run.js';
import { evaluateRun } from '../eval/business-acceptance.js';
import { readRunBundle, readRunEvidence, type EvidenceAttestation } from '../trace/run-evidence.js';
import {
  collectRunProvenance,
  compareEvaluatorProvenance,
  type EvaluatorProvenanceComparison,
} from '../trace/run-provenance.js';
import { safeError } from '../trace/probe-evidence.js';
import {
  emitJson,
  redactionSecrets,
  valueAfter,
  writeFailure,
  type BusinessCliIO,
} from './business-io.js';

interface RecomputeSummary {
  readonly checked: number;
  /**
   * Runs carrying no recorded evaluator provenance (schema v1). Their metrics can
   * still be reproduced, but the evaluator revision that produced them is unknown,
   * so they are not attested. Reported explicitly rather than silently counted as
   * verified.
   */
  readonly unverified: number;
  readonly differences: readonly {
    readonly directory: string;
    readonly reason: string;
  }[];
  readonly runs: readonly {
    readonly directory: string;
    readonly status: 'MATCH' | 'DIFFERENT' | 'ERROR';
    readonly evaluator_compatibility: EvaluatorProvenanceComparison | null;
    /** Whether the stored event streams matched the digest sealed into the manifest. */
    readonly attestation: EvidenceAttestation | null;
    readonly metrics: BusinessMetrics | null;
  }[];
}

async function scanRunDirectories(projectRoot: string): Promise<readonly string[]> {
  const resultsRoot = path.resolve(projectRoot, 'results');
  let entries;
  try {
    entries = await readdir(resultsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as { readonly code?: unknown }).code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'batches')
    .map((entry) => path.join(resultsRoot, entry.name))
    .sort();
}

export async function runRecompute(io: BusinessCliIO, argv: readonly string[]): Promise<number> {
  let requestedRun: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]!;
    if (option !== '--run') return writeFailure(io, `unknown recompute option: ${option}`);
    if (requestedRun !== undefined) return writeFailure(io, 'duplicate option: --run');
    const parsed = valueAfter(argv, index, option);
    if (typeof parsed === 'string') return writeFailure(io, parsed);
    requestedRun = parsed.value;
    index = parsed.nextIndex;
  }

  const projectRoot = path.resolve(io.cwd);
  let directories: readonly string[];
  if (requestedRun !== undefined) {
    const resolved = path.resolve(io.cwd, requestedRun);
    try {
      const metadata = await stat(resolved);
      if (!metadata.isDirectory()) return writeFailure(io, `run path is not a directory: ${requestedRun}`);
    } catch {
      return writeFailure(io, `run directory does not exist: ${requestedRun}`);
    }
    directories = [resolved];
  } else {
    directories = await scanRunDirectories(projectRoot);
  }

  const runs: RecomputeSummary['runs'][number][] = [];
  const differences: RecomputeSummary['differences'][number][] = [];
  const secrets = redactionSecrets(io.env);
  let currentProvenance: ReturnType<typeof collectRunProvenance> | undefined;

  for (const directory of directories) {
    let recomputed: BusinessMetrics | null = null;
    let evaluatorCompatibility: EvaluatorProvenanceComparison | null = null;
    let attestation: EvidenceAttestation | null = null;
    try {
      const evidence = await readRunEvidence(directory);
      attestation = evidence.attestation;
      currentProvenance ??= collectRunProvenance();
      evaluatorCompatibility = compareEvaluatorProvenance(
        evidence.manifest,
        await currentProvenance,
      );
      recomputed = evaluateRun(evidence);
      const stored = await readRunBundle(directory);
      const metricsMatch = canonicalJson(stored.metrics) === canonicalJson(recomputed);
      // Evaluator drift is a first-class difference: a run produced by a different
      // evaluator revision cannot be treated as reproduced just because its metrics
      // happen to coincide. LEGACY_UNKNOWN (no recorded provenance) is a legitimate
      // historical state and is surfaced via `unverified` instead of failing here.
      const evaluatorDrift =
        evaluatorCompatibility !== null && evaluatorCompatibility.status === 'DIFFERENT';
      if (metricsMatch && !evaluatorDrift) {
        runs.push({
          directory,
          status: 'MATCH',
          evaluator_compatibility: evaluatorCompatibility,
          attestation,
          metrics: recomputed,
        });
      } else {
        runs.push({
          directory,
          status: 'DIFFERENT',
          evaluator_compatibility: evaluatorCompatibility,
          attestation,
          metrics: recomputed,
        });
        differences.push({
          directory,
          reason: metricsMatch
            ? `evaluator provenance differs: recorded ${evaluatorCompatibility?.recorded_sha256 ?? 'unknown'} vs current ${evaluatorCompatibility?.current_sha256 ?? 'unknown'}`
            : 'stored and recomputed metrics differ',
        });
      }
    } catch (error) {
      const details = safeError(error, secrets);
      runs.push({
        directory,
        status: 'ERROR',
        evaluator_compatibility: evaluatorCompatibility,
        attestation,
        metrics: recomputed,
      });
      differences.push({ directory, reason: `${details.name}: ${details.message}` });
    }
  }

  const summary: RecomputeSummary = {
    checked: directories.length,
    // A run is "unverified" when it carries no sealed evidence digest, or when the
    // evaluator revision that produced it is unknown. Such runs can still be
    // reproduced, but they are not attested, so they are counted rather than
    // silently folded into the MATCH total.
    unverified: runs.filter(
      (run) =>
        run.attestation !== 'VERIFIED'
        || run.evaluator_compatibility?.status === 'LEGACY_UNKNOWN',
    ).length,
    differences,
    runs,
  };
  emitJson(io, { ...summary, status: differences.length === 0 ? 'PASS' : 'FAIL' });
  return differences.length === 0 ? 0 : 1;
}

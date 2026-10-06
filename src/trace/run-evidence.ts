import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson } from '../contracts/canonical-json.js';

import type { BusinessEvent } from '../contracts/business.js';
import type {
  BusinessMetrics,
  RunManifest,
} from '../contracts/run.js';
import { redactValue } from './probe-evidence.js';

export interface RunEvidence {
  readonly manifest: RunManifest;
  readonly events: readonly BusinessEvent[];
  readonly nativeEvents: readonly unknown[];
  readonly attestation: EvidenceAttestation;
}

export type EvidenceAttestation = 'VERIFIED' | 'UNVERIFIED';

export interface RunBundle extends RunEvidence {
  readonly metrics: BusinessMetrics;
}

export interface WriteRunBundleInput {
  readonly projectRoot: string;
  readonly manifest: RunManifest;
  readonly events: readonly BusinessEvent[];
  readonly nativeEvents: readonly unknown[];
  readonly metrics: BusinessMetrics;
  readonly redactionSecrets?: readonly string[];
}

export { canonicalJson };

export function digest(value: unknown): string {
  const contents = typeof value === 'string' ? value : canonicalJson(value);
  return createHash('sha256').update(contents, 'utf8').digest('hex');
}

const EVIDENCE_DIGEST_SEPARATOR = '\u0000';

/**
 * sha256 over the exact stored text of the two event streams. Kept as a separate
 * function so the writer and the reader cannot drift apart.
 */
export function evidenceDigest(
  businessEventsText: string,
  nativeEventsText: string,
): string {
  return createHash('sha256')
    .update(`${businessEventsText}${EVIDENCE_DIGEST_SEPARATOR}${nativeEventsText}`, 'utf8')
    .digest('hex');
}

function withEvidenceDigest(manifest: unknown, sha256: string): unknown {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return manifest;
  }
  return { ...(manifest as Record<string, unknown>), evidence_sha256: sha256 };
}

export function createRunId(mode: string): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  const modeSegment = mode.length > 0 ? mode : 'run';
  return `${stamp}-${modeSegment}-${randomUUID()}`;
}

function assertSafeRunId(runId: string): void {
  if (
    runId.trim().length === 0 ||
    runId === '.' ||
    runId === '..' ||
    runId.includes('/') ||
    runId.includes('\\') ||
    runId.includes('\0')
  ) {
    throw new TypeError('manifest.run_id must be a safe single path segment');
  }
}

function serializeJson(value: unknown): string {
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) {
    throw new TypeError('evidence value must be JSON-compatible');
  }
  return `${serialized}\n`;
}

function serializeJsonLines(values: readonly unknown[]): string {
  const lines = values.map((value) => {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new TypeError('evidence event must be JSON-compatible');
    }
    return serialized;
  });
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

function parseJsonLines(contents: string, filePath: string): unknown[] {
  const lines = contents.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return lines.map((line, index) => {
    try {
      return JSON.parse(line) as unknown;
    } catch (error) {
      throw new SyntaxError(
        `${filePath}:${index + 1}: invalid JSONL: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
}

function parseJsonFile(contents: string, filePath: string): unknown {
  try {
    return JSON.parse(contents) as unknown;
  } catch (error) {
    throw new SyntaxError(
      `${filePath}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export interface WriteRunBundleResult {
  readonly directory: string;
  /** The manifest exactly as written, including the sealed evidence digest. */
  readonly manifest: RunManifest;
}

export async function writeRunBundle(
  input: WriteRunBundleInput,
): Promise<WriteRunBundleResult> {
  assertSafeRunId(input.manifest.run_id);
  const secrets = input.redactionSecrets ?? [];
  const resultsRoot = path.resolve(input.projectRoot, 'results');
  const directory = path.join(resultsRoot, input.manifest.run_id);

  if (path.dirname(directory) !== resultsRoot) {
    throw new TypeError('manifest.run_id escapes the results directory');
  }

  await mkdir(resultsRoot, { recursive: true });
  await mkdir(directory);

  const manifest = redactValue(input.manifest, secrets);
  const events = redactValue(input.events, secrets);
  const nativeEvents = redactValue(input.nativeEvents, secrets);
  const metrics = redactValue(input.metrics, secrets);

  const businessEventsText = serializeJsonLines(Array.isArray(events) ? events : []);
  const nativeEventsText = serializeJsonLines(Array.isArray(nativeEvents) ? nativeEvents : []);
  // Seal the redacted event streams, i.e. exactly the bytes that land on disk. A
  // later hand-edit of either file can no longer change the verdict unnoticed.
  const sealedManifest = withEvidenceDigest(
    manifest,
    evidenceDigest(businessEventsText, nativeEventsText),
  );

  await Promise.all([
    writeFile(path.join(directory, 'manifest.json'), serializeJson(sealedManifest), {
      flag: 'wx',
    }),
    writeFile(path.join(directory, 'business-events.jsonl'), businessEventsText, {
      flag: 'wx',
    }),
    writeFile(path.join(directory, 'native-events.jsonl'), nativeEventsText, {
      flag: 'wx',
    }),
    writeFile(path.join(directory, 'metrics.json'), serializeJson(metrics), {
      flag: 'wx',
    }),
  ]);

  return { directory, manifest: sealedManifest as RunManifest };
}

export async function readRunEvidence(directory: string): Promise<RunEvidence> {
  const manifestPath = path.join(directory, 'manifest.json');
  const businessEventsPath = path.join(directory, 'business-events.jsonl');
  const nativeEventsPath = path.join(directory, 'native-events.jsonl');

  const [manifestText, businessEventsText, nativeEventsText] =
    await Promise.all([
      readFile(manifestPath, 'utf8'),
      readFile(businessEventsPath, 'utf8'),
      readFile(nativeEventsPath, 'utf8'),
    ]);

  const manifest = parseJsonFile(manifestText, manifestPath) as RunManifest;
  // Parse before verifying: a malformed file should surface as a parse error (which
  // names the offending line) rather than as a digest mismatch. The digest guard
  // then catches well-formed tampering that parsing alone cannot see.
  const events = parseJsonLines(
    businessEventsText,
    businessEventsPath,
  ) as BusinessEvent[];
  const nativeEvents = parseJsonLines(nativeEventsText, nativeEventsPath);

  const recordedDigest = manifest.evidence_sha256;
  let attestation: EvidenceAttestation = 'UNVERIFIED';
  if (typeof recordedDigest === 'string' && recordedDigest.length > 0) {
    const actualDigest = evidenceDigest(businessEventsText, nativeEventsText);
    if (actualDigest !== recordedDigest) {
      throw new Error(
        `evidence digest mismatch in ${directory}: manifest records ${recordedDigest} but the stored event files hash to ${actualDigest}`,
      );
    }
    attestation = 'VERIFIED';
  }

  return {
    manifest,
    events,
    nativeEvents,
    attestation,
  };
}

export async function readRunBundle(directory: string): Promise<RunBundle> {
  const metricsPath = path.join(directory, 'metrics.json');
  const [evidence, metricsText] = await Promise.all([
    readRunEvidence(directory),
    readFile(metricsPath, 'utf8'),
  ]);
  return {
    ...evidence,
    metrics: parseJsonFile(metricsText, metricsPath) as BusinessMetrics,
  };
}

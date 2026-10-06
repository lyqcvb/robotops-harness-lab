import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson } from '../contracts/canonical-json.js';
import {
  EVALUATOR_VERSION,
  type ArtifactFingerprint,
  type RunProvenance,
} from '../contracts/provenance.js';
import type { RunManifest } from '../contracts/run.js';

const DEFAULT_CODE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const REQUIRED_LAYERS = [
  'app',
  'contracts',
  'eval',
  'harness',
  'services',
  'simulator',
  'tools',
  'trace',
] as const;
const REQUIRED_FILES = [
  'app/business.js',
  'eval/business-acceptance.js',
  'contracts/run.js',
  'trace/run-evidence.js',
] as const;
const EVALUATOR_ROOTS = ['contracts', 'eval', 'trace'] as const;
const EXCLUDED_DIRECTORIES = new Set([
  'node_modules',
  'results',
  'evidence',
  '.git',
]);

export type EvaluatorProvenanceStatus =
  | 'MATCH'
  | 'DIFFERENT'
  | 'LEGACY_UNKNOWN';

export interface EvaluatorProvenanceComparison {
  readonly status: EvaluatorProvenanceStatus;
  readonly recorded_version: string | null;
  readonly current_version: string;
  readonly recorded_sha256: string | null;
  readonly current_sha256: string;
}

function sha256(contents: string | Buffer): string {
  return createHash('sha256').update(contents).digest('hex');
}

function normalizedRelativePath(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join('/');
}

async function scanJavaScriptFiles(codeRoot: string): Promise<readonly string[]> {
  const root = path.resolve(codeRoot);
  const rootMetadata = await lstat(root);
  if (rootMetadata.isSymbolicLink()) {
    throw new TypeError(`code root must not be a symbolic link: ${root}`);
  }
  if (!rootMetadata.isDirectory()) {
    throw new TypeError(`code root is not a directory: ${root}`);
  }

  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );

    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        throw new TypeError(
          `symbolic links are not allowed in provenance inputs: ${path.join(directory, entry.name)}`,
        );
      }
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
        await visit(absolutePath);
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        files.push(absolutePath);
      }
    }
  };

  await visit(root);
  return files.sort((left, right) => {
    const leftPath = normalizedRelativePath(root, left);
    const rightPath = normalizedRelativePath(root, right);
    return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
  });
}

function makeFingerprint(files: ArtifactFingerprint['files']): ArtifactFingerprint {
  return {
    sha256: sha256(canonicalJson(files)),
    files,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasValidHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function assertSafeArtifactPath(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  if (
    value.startsWith('/') ||
    value.includes('\\') ||
    value.includes(':') ||
    value.includes('\0') ||
    !value.endsWith('.js')
  ) {
    throw new TypeError(`${label} must be a safe relative JavaScript path`);
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new TypeError(`${label} must not contain empty, dot, or parent segments`);
  }
}

function assertFingerprint(
  value: unknown,
  label: string,
): asserts value is ArtifactFingerprint {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  if (!hasValidHash(value.sha256)) {
    throw new TypeError(`${label}.sha256 must be a lowercase SHA-256 digest`);
  }
  if (!Array.isArray(value.files) || value.files.length === 0) {
    throw new TypeError(`${label}.files must be a non-empty array`);
  }

  const files: ArtifactFingerprint['files'][number][] = [];
  for (const [index, entry] of value.files.entries()) {
    if (!isRecord(entry)) {
      throw new TypeError(`${label}.files[${index}] must be an object`);
    }
    assertSafeArtifactPath(entry.path, `${label}.files[${index}].path`);
    if (!hasValidHash(entry.sha256)) {
      throw new TypeError(`${label}.files[${index}].sha256 must be a lowercase SHA-256 digest`);
    }
    if (index > 0 && files[index - 1]!.path >= entry.path) {
      throw new TypeError(`${label}.files must be strictly sorted and unique by path`);
    }
    files.push({ path: entry.path, sha256: entry.sha256 });
  }
  if (value.sha256 !== sha256(canonicalJson(files))) {
    throw new TypeError(`${label}.sha256 does not match canonical files`);
  }
}

function assertRequiredCodeFiles(files: ArtifactFingerprint['files']): void {
  for (const layer of REQUIRED_LAYERS) {
    if (!files.some((file) => file.path.startsWith(`${layer}/`))) {
      throw new TypeError(`code fingerprint has no JavaScript in ${layer}/`);
    }
  }
  for (const requiredFile of REQUIRED_FILES) {
    if (!files.some((file) => file.path === requiredFile)) {
      throw new TypeError(`code fingerprint is missing ${requiredFile}`);
    }
  }
}

function assertEvaluatorFingerprint(
  value: unknown,
  label: string,
): asserts value is ArtifactFingerprint & { readonly version: string } {
  if (!isRecord(value) || typeof value.version !== 'string' || value.version.length === 0) {
    throw new TypeError(`${label}.version must be a non-empty string`);
  }
  assertFingerprint(value, label);
}

function assertEvaluatorClosure(input: {
  readonly code: ArtifactFingerprint;
  readonly evaluator: ArtifactFingerprint;
}): void {
  const expectedFiles = input.code.files.filter((file) =>
    EVALUATOR_ROOTS.some((rootName) => file.path.startsWith(`${rootName}/`)),
  );
  if (
    expectedFiles.length !== input.evaluator.files.length ||
    expectedFiles.some((file, index) => {
      const actual = input.evaluator.files[index];
      return actual === undefined || actual.path !== file.path || actual.sha256 !== file.sha256;
    })
  ) {
    throw new TypeError('evaluator fingerprint must equal the complete evaluator file closure');
  }
}

function assertRunProvenance(
  value: unknown,
): asserts value is RunProvenance {
  if (!isRecord(value)) throw new TypeError('run provenance must be an object');
  if (value.schema_version !== 1) {
    throw new TypeError('run provenance schema_version must be 1');
  }
  if (value.basis !== 'compiled-javascript') {
    throw new TypeError('run provenance basis must be compiled-javascript');
  }
  assertFingerprint(value.code, 'run provenance code');
  assertEvaluatorFingerprint(value.evaluator, 'run provenance evaluator');
  assertRequiredCodeFiles(value.code.files);
  assertEvaluatorClosure({ code: value.code, evaluator: value.evaluator });
}

export async function collectRunProvenance(
  codeRoot: string = DEFAULT_CODE_ROOT,
): Promise<RunProvenance> {
  const root = path.resolve(codeRoot);
  const absoluteFiles = await scanJavaScriptFiles(root);
  const files = await Promise.all(
    absoluteFiles.map(async (absolutePath) => ({
      path: normalizedRelativePath(root, absolutePath),
      sha256: sha256(await readFile(absolutePath)),
    })),
  );

  const evaluatorFiles = files.filter((file) =>
    EVALUATOR_ROOTS.some((rootName) => file.path.startsWith(`${rootName}/`)),
  );
  const provenance: RunProvenance = {
    schema_version: 1,
    basis: 'compiled-javascript',
    code: makeFingerprint(files),
    evaluator: {
      ...makeFingerprint(evaluatorFiles),
      version: EVALUATOR_VERSION,
    },
  };
  assertRunProvenance(provenance);
  return provenance;
}

export function compareEvaluatorProvenance(
  manifest: RunManifest,
  current: RunProvenance,
): EvaluatorProvenanceComparison {
  assertRunProvenance(current);
  if (!isRecord(manifest)) throw new TypeError('manifest must be an object');

  if (manifest.schema_version === 1) {
    return {
      status: 'LEGACY_UNKNOWN',
      recorded_version: null,
      current_version: current.evaluator.version,
      recorded_sha256: null,
      current_sha256: current.evaluator.sha256,
    };
  }
  if (manifest.schema_version !== 2) {
    throw new TypeError(`unsupported manifest schema_version: ${String(manifest.schema_version)}`);
  }

  assertRunProvenance(manifest.provenance);
  return {
    status:
      manifest.provenance.evaluator.version === current.evaluator.version &&
      manifest.provenance.evaluator.sha256 === current.evaluator.sha256
        ? 'MATCH'
        : 'DIFFERENT',
    recorded_version: manifest.provenance.evaluator.version,
    current_version: current.evaluator.version,
    recorded_sha256: manifest.provenance.evaluator.sha256,
    current_sha256: current.evaluator.sha256,
  };
}

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../../src/contracts/canonical-json.js';
import { EVALUATOR_VERSION, type ArtifactFingerprint } from '../../src/contracts/provenance.js';
import type { RunManifest, RunManifestV1, RunManifestV2 } from '../../src/contracts/run.js';
import {
  collectRunProvenance,
  compareEvaluatorProvenance,
} from '../../src/trace/run-provenance.js';

const FIXTURE_FILES: Readonly<Record<string, string>> = {
  'app/business.js': "export const app = 'business';\n",
  'app/extra.js': "export const extra = 'app';\n",
  'contracts/run.js': "export const run = 'contracts';\n",
  'contracts/extra.js': "export const extra = 'contracts';\n",
  'eval/business-acceptance.js': "export const evaluator = 'business';\n",
  'eval/extra.js': "export const extra = 'eval';\n",
  'harness/runtime.js': "export const runtime = 'harness';\n",
  'services/services.js': "export const services = 'services';\n",
  'simulator/simulator.js': "export const simulator = 'simulator';\n",
  'tools/tools.js': "export const tools = 'tools';\n",
  'trace/run-evidence.js': "export const evidence = 'trace';\n",
  'trace/extra.js': "export const extra = 'trace';\n",
};

function hashFiles(files: ArtifactFingerprint['files']): string {
  return createHash('sha256').update(canonicalJson(files), 'utf8').digest('hex');
}

async function makeFixture(root: string, overrides: Readonly<Record<string, string>> = {}): Promise<void> {
  const files = { ...FIXTURE_FILES, ...overrides };
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = path.join(root, ...relativePath.split('/'));
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, contents, 'utf8');
  }
}

function manifestV1(): RunManifestV1 {
  return {
    schema_version: 1,
    run_id: 'legacy-run',
    created_at: '2026-09-26T00:00:00.000Z',
    scenario_id: 'happy_path',
    mode: 'offline',
    model: 'scripted-test',
    config: 'full',
    approval_source: 'none',
    batch_id: 'legacy-batch',
    repeat: 1,
    fixture_sha256: 'fixture',
    prompt_sha256: 'prompt',
    config_sha256: 'config',
    lockfile_sha256: 'lock',
    installed_versions: {},
    harness_version: 'test',
  };
}

function manifestV2(provenance: RunManifestV2['provenance']): RunManifestV2 {
  return {
    ...manifestV1(),
    schema_version: 2,
    provenance,
  };
}

test('collectRunProvenance is deterministic, location-independent, and attributes code and evaluator changes separately', async (t) => {
  const firstRoot = await mkdtemp(path.join(tmpdir(), 'robotops-provenance-a-'));
  const secondRoot = await mkdtemp(path.join(tmpdir(), 'robotops-provenance-b-'));
  t.after(async () => {
    await rm(firstRoot, { recursive: true, force: true });
    await rm(secondRoot, { recursive: true, force: true });
  });
  await makeFixture(firstRoot);
  await makeFixture(secondRoot);

  const first = await collectRunProvenance(firstRoot);
  const second = await collectRunProvenance(secondRoot);
  assert.deepEqual(first, second);
  assert.equal(first.evaluator.version, EVALUATOR_VERSION);
  assert.equal(first.code.sha256, hashFiles(first.code.files));
  assert.equal(first.evaluator.sha256, hashFiles(first.evaluator.files));

  const codePaths = first.code.files.map((entry) => entry.path);
  assert.deepEqual(codePaths, [...codePaths].sort());
  assert.equal(new Set(codePaths).size, codePaths.length);
  assert.ok(codePaths.every((entry) => !path.isAbsolute(entry) && !entry.includes('\\')));
  const expectedEvaluatorFiles = first.code.files.filter((entry) =>
    entry.path.startsWith('eval/') ||
    entry.path.startsWith('contracts/') ||
    entry.path.startsWith('trace/'),
  );
  assert.deepEqual(first.evaluator.files, expectedEvaluatorFiles);

  for (const file of first.code.files) {
    assert.equal(
      file.sha256,
      createHash('sha256')
        .update(await readFile(path.join(firstRoot, ...file.path.split('/'))))
        .digest('hex'),
      file.path,
    );
  }

  await writeFile(
    path.join(firstRoot, 'app', 'extra.js'),
    "export const extra = 'changed-app';\n",
    'utf8',
  );
  const appChanged = await collectRunProvenance(firstRoot);
  assert.notEqual(appChanged.code.sha256, first.code.sha256);
  assert.deepEqual(appChanged.evaluator, first.evaluator);

  await writeFile(
    path.join(firstRoot, 'eval', 'extra.js'),
    "export const extra = 'changed-eval';\n",
    'utf8',
  );
  const evaluatorChanged = await collectRunProvenance(firstRoot);
  assert.notEqual(evaluatorChanged.code.sha256, appChanged.code.sha256);
  assert.notEqual(evaluatorChanged.evaluator.sha256, appChanged.evaluator.sha256);
});

test('collectRunProvenance rejects missing required compiled files and symlinks', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'robotops-provenance-missing-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  await makeFixture(root);
  await rm(path.join(root, 'contracts', 'run.js'));
  await assert.rejects(
    () => collectRunProvenance(root),
    /missing contracts\/run\.js/,
  );

  const linkedRoot = await mkdtemp(path.join(tmpdir(), 'robotops-provenance-link-'));
  t.after(async () => {
    await rm(linkedRoot, { recursive: true, force: true });
  });
  await makeFixture(linkedRoot);
  const target = path.join(linkedRoot, 'outside.js');
  await writeFile(target, 'export const outside = true;\n', 'utf8');
  try {
    await symlink(target, path.join(linkedRoot, 'app', 'linked.js'), 'file');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    const targetDirectory = path.join(linkedRoot, 'outside-directory');
    await mkdir(targetDirectory, { recursive: true });
    await symlink(
      targetDirectory,
      path.join(linkedRoot, 'app', 'linked-directory'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  }
  await assert.rejects(
    () => collectRunProvenance(linkedRoot),
    /symbolic links are not allowed/,
  );
});

test('collectRunProvenance does not scan dependency, result, or evidence trees', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'robotops-provenance-excluded-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  await makeFixture(root);
  for (const directory of ['node_modules/example', 'results/run', 'evidence/run']) {
    const target = path.join(root, ...directory.split('/'), 'ignored.js');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, 'export const ignored = true;\n', 'utf8');
  }
  const provenance = await collectRunProvenance(root);
  assert.equal(
    provenance.code.files.some((entry) => /^(node_modules|results|evidence)\//.test(entry.path)),
    false,
  );
});

test('compareEvaluatorProvenance returns MATCH, DIFFERENT, and LEGACY_UNKNOWN', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'robotops-provenance-compare-'));
  const changedRoot = await mkdtemp(path.join(tmpdir(), 'robotops-provenance-changed-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(changedRoot, { recursive: true, force: true });
  });
  await makeFixture(root);
  await makeFixture(changedRoot, {
    'eval/extra.js': "export const extra = 'changed';\n",
  });
  const recorded = await collectRunProvenance(root);
  const changed = await collectRunProvenance(changedRoot);

  assert.deepEqual(
    compareEvaluatorProvenance(manifestV2(recorded), recorded),
    {
      status: 'MATCH',
      recorded_version: recorded.evaluator.version,
      current_version: recorded.evaluator.version,
      recorded_sha256: recorded.evaluator.sha256,
      current_sha256: recorded.evaluator.sha256,
    },
  );
  assert.deepEqual(
    compareEvaluatorProvenance(manifestV2(recorded), changed),
    {
      status: 'DIFFERENT',
      recorded_version: recorded.evaluator.version,
      current_version: changed.evaluator.version,
      recorded_sha256: recorded.evaluator.sha256,
      current_sha256: changed.evaluator.sha256,
    },
  );
  assert.deepEqual(
    compareEvaluatorProvenance(manifestV1(), recorded),
    {
      status: 'LEGACY_UNKNOWN',
      recorded_version: null,
      current_version: recorded.evaluator.version,
      recorded_sha256: null,
      current_sha256: recorded.evaluator.sha256,
    },
  );
});

test('compareEvaluatorProvenance fails closed for inconsistent v2 metadata', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'robotops-provenance-invalid-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  await makeFixture(root);
  const current = await collectRunProvenance(root);

  const mutations: readonly {
    readonly label: string;
    readonly mutate: (value: RunManifestV2['provenance']) => void;
  }[] = [
    {
      label: 'unsafe path',
      mutate: (value) => {
        (value.evaluator.files[0] as { path: string }).path = '../escape.js';
        (value.evaluator as { sha256: string }).sha256 = hashFiles(value.evaluator.files);
      },
    },
    {
      label: 'unsorted duplicate',
      mutate: (value) => {
        (value.evaluator.files as { path: string; sha256: string }[]).push({
          ...value.evaluator.files[0],
        });
        (value.evaluator as { sha256: string }).sha256 = hashFiles(value.evaluator.files);
      },
    },
    {
      label: 'wrong aggregate hash',
      mutate: (value) => {
        (value.evaluator as { sha256: string }).sha256 = '0'.repeat(64);
      },
    },
    {
      label: 'missing code layer',
      mutate: (value) => {
        (value.code as unknown as { files: { path: string; sha256: string }[] }).files =
          value.code.files.filter((entry) => !entry.path.startsWith('harness/'));
        (value.code as { sha256: string }).sha256 = hashFiles(value.code.files);
      },
    },
    {
      label: 'incomplete evaluator closure',
      mutate: (value) => {
        (value.evaluator as unknown as { files: { path: string; sha256: string }[] }).files =
          value.evaluator.files.slice(1);
        (value.evaluator as { sha256: string }).sha256 = hashFiles(value.evaluator.files);
      },
    },
  ];

  for (const mutation of mutations) {
    const provenance = structuredClone(current);
    mutation.mutate(provenance);
    const malformedManifest = {
      ...manifestV1(),
      schema_version: 2,
      provenance,
    } as unknown as RunManifest;
    assert.throws(
      () => compareEvaluatorProvenance(malformedManifest, current),
      TypeError,
      mutation.label,
    );
  }
});

test('default provenance root is the currently executing compiled src root', async () => {
  const provenance = await collectRunProvenance();
  assert.equal(provenance.basis, 'compiled-javascript');
  assert.ok(provenance.code.files.some((entry) => entry.path === 'app/business.js'));
  assert.ok(provenance.code.files.some((entry) => entry.path === 'contracts/run.js'));
  assert.ok(provenance.code.files.some((entry) => entry.path === 'eval/business-acceptance.js'));
  assert.ok(provenance.code.files.some((entry) => entry.path === 'trace/run-evidence.js'));
});

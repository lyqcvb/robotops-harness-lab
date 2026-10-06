import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

interface PackageManifest {
  readonly scripts?: Readonly<Record<string, string>>;
}

const projectRoot = process.cwd();
const stageDirectoryPattern = /^stage[-_]?\d+$/i;

const expectedProbePaths = [
  'src/contracts/probe-acceptance.ts',
  'src/contracts/probe-constants.ts',
  'src/contracts/probe-evidence.ts',
  'src/contracts/probe.ts',
  'src/harness/probe-runtime.ts',
  'src/harness/scripted-adapter.ts',
  'src/harness/probe-scenarios.ts',
  'src/trace/probe-evidence.ts',
  'src/eval/probe-acceptance.ts',
  'src/eval/probe-report.ts',
  'src/app/probe.ts',
  'scripts/probe.ts',
  'tests/probe',
  'build/scripts/probe.js',
] as const;

function numberedStageDirectories(root: string): readonly string[] {
  const resolvedRoot = path.resolve(root);
  const found: string[] = [];
  const visit = (directory: string): void => {
    const relative = path.relative(resolvedRoot, directory);
    assert.ok(
      relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)),
      `directory scan escaped ${resolvedRoot}: ${directory}`,
    );
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      if (!entry.isDirectory()) continue;
      const fullPath = path.join(directory, entry.name);
      if (stageDirectoryPattern.test(entry.name)) {
        found.push(path.relative(projectRoot, fullPath).split(path.sep).join('/'));
      }
      visit(fullPath);
    }
  };
  visit(resolvedRoot);
  return found;
}

test('probe source, test, and build paths use unnumbered locations', () => {
  for (const relativePath of expectedProbePaths) {
    assert.equal(existsSync(path.join(projectRoot, relativePath)), true, `${relativePath} must exist`);
  }
});

test('probe package commands target the unnumbered compiled CLI', () => {
  const manifest = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8')) as PackageManifest;
  assert.equal(
    manifest.scripts?.['probe:live'],
    'npm run build && node --use-env-proxy --env-file-if-exists=.env build/scripts/probe.js --live',
  );
  assert.equal(
    manifest.scripts?.['probe:offline'],
    'npm run build && node --use-env-proxy --env-file-if-exists=.env build/scripts/probe.js --offline',
  );
});

test('build output has no numbered stage directories and is not traversed through links', () => {
  const buildRoot = path.resolve(projectRoot, 'build');
  assert.equal(path.basename(buildRoot), 'build');
  assert.equal(path.relative(projectRoot, buildRoot), 'build');
  assert.equal(lstatSync(buildRoot).isSymbolicLink(), false, 'build root must not be a symbolic link');
  assert.deepEqual(numberedStageDirectories(buildRoot), []);
});
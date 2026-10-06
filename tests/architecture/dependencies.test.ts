import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

import ts from 'typescript';

type Layer = 'contracts' | 'trace' | 'simulator' | 'services' | 'tools' | 'harness' | 'eval' | 'app';

interface ModuleImport {
  readonly specifier: string;
  readonly file: string | null;
}

interface ModuleRecord {
  readonly file: string;
  readonly imports: readonly ModuleImport[];
}

const stageDirectoryPattern = /^stage[-_]?\d+$/i;
const projectRoot = process.cwd();
const parseConfigResult = ts.readConfigFile(path.join(projectRoot, 'tsconfig.json'), ts.sys.readFile);
if (parseConfigResult.error !== undefined) {
  throw new Error(ts.flattenDiagnosticMessageText(parseConfigResult.error.messageText, '\n'));
}
const parsedConfig = ts.parseJsonConfigFileContent(parseConfigResult.config, ts.sys, projectRoot);
const compilerOptions = parsedConfig.options;

const allowedLocalLayers: Readonly<Record<Layer, ReadonlySet<Layer>>> = {
  contracts: new Set(['contracts']),
  trace: new Set(['contracts', 'trace']),
  simulator: new Set(['contracts', 'trace', 'simulator']),
  services: new Set(['contracts', 'trace', 'simulator', 'services']),
  tools: new Set(['contracts', 'trace', 'services', 'tools']),
  harness: new Set(['contracts', 'trace', 'tools', 'harness']),
  eval: new Set(['contracts', 'trace', 'eval']),
  app: new Set(['contracts', 'trace', 'simulator', 'services', 'tools', 'harness', 'eval', 'app']),
};
const neutralLayers: ReadonlySet<Layer> = new Set(['contracts', 'trace', 'simulator', 'eval']);

function normalizeFile(file: string): string {
  return path.resolve(file);
}

function relativeFile(file: string): string {
  return path.relative(projectRoot, normalizeFile(file)).split(path.sep).join('/');
}

function layerOf(file: string): Layer | null {
  const parts = relativeFile(file).split('/');
  if (parts[0] !== 'src') return null;
  const candidate = parts[1];
  switch (candidate) {
    case 'contracts':
    case 'trace':
    case 'simulator':
    case 'services':
    case 'tools':
    case 'harness':
    case 'eval':
    case 'app':
      return candidate;
    default:
      return null;
  }
}

function isUnder(file: string, directory: string): boolean {
  const relative = path.relative(path.join(projectRoot, directory), normalizeFile(file));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function numberedStageDirectories(root: string): readonly string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const fullPath = path.join(directory, entry.name);
      if (stageDirectoryPattern.test(entry.name)) found.push(relativeFile(fullPath));
      visit(fullPath);
    }
  };
  visit(root);
  return found;
}
function collectSpecifiers(sourceFile: ts.SourceFile): readonly string[] {
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier !== undefined
      && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1
      && ts.isStringLiteral(node.arguments[0])) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

function loadModules(): readonly ModuleRecord[] {
  const files = ts.sys.readDirectory(projectRoot, ['.ts'], undefined, ['src', 'scripts', 'tests']).map(normalizeFile);
  const knownFiles = new Set(files);
  return files.map((file) => {
    const sourceFile = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const imports = collectSpecifiers(sourceFile).map((specifier) => {
      if (!specifier.startsWith('.')) return { specifier, file: null };
      const resolved = ts.resolveModuleName(specifier, file, compilerOptions, ts.sys).resolvedModule?.resolvedFileName;
      const normalized = resolved === undefined ? null : normalizeFile(resolved);
      return { specifier, file: normalized !== null && knownFiles.has(normalized) ? normalized : null };
    });
    return { file, imports };
  });
}

function dependencyViolations(modules: readonly ModuleRecord[]): readonly string[] {
  const violations: string[] = [];
  for (const module of modules) {
    const fromLayer = layerOf(module.file);
    for (const dependency of module.imports) {
      if (dependency.file === null) {
        if (fromLayer !== null && neutralLayers.has(fromLayer) && !dependency.specifier.startsWith('node:')) {
          violations.push(`${relativeFile(module.file)} imports external package ${dependency.specifier}`);
        }
        continue;
      }
      if (isUnder(module.file, 'src') && (isUnder(dependency.file, 'scripts') || isUnder(dependency.file, 'tests'))) {
        violations.push(`${relativeFile(module.file)} imports non-src ${relativeFile(dependency.file)}`);
      }
      if (isUnder(module.file, 'tests') && isUnder(dependency.file, 'scripts')) {
        violations.push(`${relativeFile(module.file)} imports script ${relativeFile(dependency.file)}`);
      }
      if (isUnder(module.file, 'scripts') && !isUnder(dependency.file, 'src/app')) {
        violations.push(`${relativeFile(module.file)} imports non-app ${relativeFile(dependency.file)}`);
      }
      const toLayer = layerOf(dependency.file);
      if (fromLayer !== null && toLayer !== null && !allowedLocalLayers[fromLayer].has(toLayer)) {
        violations.push(`${relativeFile(module.file)} (${fromLayer}) imports ${relativeFile(dependency.file)} (${toLayer})`);
      }
    }
  }
  return violations;
}

function findCycles(modules: readonly ModuleRecord[]): readonly (readonly string[])[] {
  const graph = new Map(modules.filter((module) => isUnder(module.file, 'src')).map((module) => [
    normalizeFile(module.file),
    module.imports
      .flatMap((dependency) => dependency.file === null || !isUnder(dependency.file, 'src') ? [] : [normalizeFile(dependency.file)]),
  ]));
  const state = new Map<string, 'visiting' | 'visited'>();
  const stack: string[] = [];
  const cycles: string[][] = [];

  const visit = (file: string): void => {
    const current = state.get(file);
    if (current === 'visited') return;
    if (current === 'visiting') {
      const start = stack.indexOf(file);
      if (start >= 0) cycles.push(stack.slice(start).concat(file));
      return;
    }
    state.set(file, 'visiting');
    stack.push(file);
    for (const dependency of graph.get(file) ?? []) visit(dependency);
    stack.pop();
    state.set(file, 'visited');
  };

  for (const file of graph.keys()) visit(file);
  return cycles;
}

test('source dependencies follow the cross-stage layer contract', () => {
  const modules = loadModules();
  const sourceModules = modules.filter((module) => isUnder(module.file, 'src'));
  assert.ok(sourceModules.length > 0, 'source module scan must not be empty');
  assert.ok(sourceModules.some((module) => module.imports.some((dependency) => dependency.file !== null)), 'source dependency graph must not be empty');
  assert.deepEqual(dependencyViolations(modules), []);
});

test('source dependency graph has no cycles', () => {
  const cycles = findCycles(loadModules());
  assert.deepEqual(cycles, []);
});

test('src, scripts, and tests contain no numbered stage directories at any depth', () => {
  const numbered = ['src', 'scripts', 'tests'].flatMap((directory) => numberedStageDirectories(path.join(projectRoot, directory)));
  assert.deepEqual(numbered, []);
});

test('local import and export specifiers contain no numbered stage directory segments', () => {
  const violations = loadModules().flatMap((module) => module.imports.flatMap((dependency) => {
    if (!dependency.specifier.startsWith('.')) return [];
    const segments = dependency.specifier.split(/[\\/]/);
    return segments.some((segment) => stageDirectoryPattern.test(segment))
      ? [`${relativeFile(module.file)} imports ${dependency.specifier}`]
      : [];
  }));
  assert.deepEqual(violations, []);
});
test('cross-stage layer matrix rejects prohibited shortcuts', () => {
  const cases: readonly (readonly [string, string, RegExp])[] = [
    ['simulator/forward.ts', 'services/robot-service.ts', /simulator.*services/],
    ['services/upward.ts', 'harness/business-runtime.ts', /services.*harness/],
    ['tools/bypass.ts', 'simulator/robot-simulator.ts', /tools.*simulator/],
    ['harness/bypass.ts', 'services/robot-service.ts', /harness.*services/],
    ['harness/bypass.ts', 'simulator/robot-simulator.ts', /harness.*simulator/],
    ['eval/self-check.ts', 'harness/business-runtime.ts', /eval.*harness/],
  ];

  for (const [source, target, expected] of cases) {
    const violations = dependencyViolations([{
      file: path.join(projectRoot, 'src', source),
      imports: [{
        specifier: `../${target}`,
        file: path.join(projectRoot, 'src', target),
      }],
    }]);
    assert.equal(violations.length, 1, `${source} -> ${target}`);
    assert.match(violations[0] ?? '', expected);
  }
});

test('neutral layer detector rejects a non-Node SDK dependency', () => {
  const invalid: readonly ModuleRecord[] = [{
    file: path.join(projectRoot, 'src', 'simulator', 'robot-simulator.ts'),
    imports: [{
      specifier: '@deepseek-ai/dsh-tools',
      file: null,
    }],
  }];
  const violations = dependencyViolations(invalid);
  assert.equal(violations.length, 1);
  assert.match(violations[0] ?? '', /neutral|external package/);
});

test('boundary detector rejects a deliberately invalid dependency', () => {
  const invalid: readonly ModuleRecord[] = [{
    file: path.join(projectRoot, 'src', 'harness', 'invalid.ts'),
    imports: [{
      specifier: '../../eval/probe-report.js',
      file: path.join(projectRoot, 'src', 'eval', 'probe-report.ts'),
    }],
  }];
  const violations = dependencyViolations(invalid);
  assert.equal(violations.length, 1);
  assert.match(violations[0] ?? '', /harness.*eval/);
});

test('cycle detector rejects a deliberately circular graph', () => {
  const invalid: readonly ModuleRecord[] = [
    {
      file: path.join(projectRoot, 'src', 'eval', 'cycle-a.ts'),
      imports: [{ specifier: './b.js', file: path.join(projectRoot, 'src', 'eval', 'cycle-b.ts') }],
    },
    {
      file: path.join(projectRoot, 'src', 'eval', 'cycle-b.ts'),
      imports: [{ specifier: './a.js', file: path.join(projectRoot, 'src', 'eval', 'cycle-a.ts') }],
    },
  ];
  assert.ok(findCycles(invalid).length > 0, 'cycle detector must report the synthetic cycle');
});
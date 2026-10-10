import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

const projectRoot = process.cwd();
const requiredArchitectureHeadings = [
  '项目定位与边界',
  '当前实现与目标架构',
  '模块职责与依赖',
  '业务契约',
  '安全预算与审批',
  '核心恢复时序',
  'Trace与评测',
  '设计取舍与阶段门槛',
] as const;
const legalStageStatuses = ['PLANNED', 'IN_PROGRESS', 'DONE', 'BLOCKED'] as const;

/**
 * `evidence/` and `results/` hold artifacts this project generates itself
 * (`npm run eval`, `npm run test:e2e`, `npm run probe:live`, `npm run demo`).
 * They are never committed, so links into these trees may legitimately be absent.
 */
const GENERATED_ARTIFACT_ROOTS = ['evidence/', 'results/'] as const;

function isGeneratedArtifact(projectRelativePath: string): boolean {
  const normalized = projectRelativePath.replace(/\\/g, '/').replace(/^\.\//, '');
  return GENERATED_ARTIFACT_ROOTS.some((root) => normalized.startsWith(root));
}

function markdownFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(entryPath);
    return entry.isFile() && entry.name.endsWith('.md') ? [entryPath] : [];
  });
}

function withoutFencedCodeBlocks(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const result: string[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const match = /^\s*(```+|~~~+)/.exec(line);
    if (fence === null && match !== null) {
      fence = match[1]?.[0] ?? '`';
      continue;
    }
    if (fence !== null && match !== null && match[1]?.startsWith(fence) === true) {
      fence = null;
      continue;
    }
    if (fence === null) result.push(line);
  }
  return result.join('\n');
}

function extractLocalMarkdownLinks(markdown: string): readonly string[] {
  const content = withoutFencedCodeBlocks(markdown);
  const links: string[] = [];
  const pattern = /!?\[[^\]]*\]\(\s*(<[^>]+>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
  for (const match of content.matchAll(pattern)) {
    const raw = match[1];
    if (raw === undefined) continue;
    const unwrapped = raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(unwrapped) || unwrapped.startsWith('//') || unwrapped.startsWith('#')) continue;
    links.push(decodeURIComponent(unwrapped.split('#')[0]?.split('?')[0] ?? ''));
  }
  return links.filter((link) => link !== '');
}

function localMarkdownLinks(file: string): readonly string[] {
  return extractLocalMarkdownLinks(readFileSync(file, 'utf8'));
}

test('required documentation entry points exist', () => {
  for (const file of ['README.md', 'docs/README.md', 'docs/architecture.md']) {
    assert.equal(existsSync(path.join(projectRoot, file)), true, `${file} is required`);
  }
});

test('architecture document defines required sections and explicit legal stage statuses', () => {
  const architecture = readFileSync(path.join(projectRoot, 'docs', 'architecture.md'), 'utf8');
  for (const heading of requiredArchitectureHeadings) {
    assert.match(architecture, new RegExp(`^## ${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm'), `missing architecture heading: ${heading}`);
  }
  for (let stage = 1; stage <= 7; stage += 1) {
    const stageStatusPattern = '^\\|\\s*Stage ' + stage + '[^\\n]*?\\|\\s*?(' + legalStageStatuses.join('|') + ')?[^\\n|]*\\|';
    assert.match(architecture, new RegExp(stageStatusPattern, 'm'), `Stage ${stage} must have an explicit legal status`);
  }
});

test('local Markdown link extraction handles root-relative links and ignores examples', () => {
  const fixture = [
    '# Root README fixture',
    '[文档入口](docs/README.md)',
    '[外部链接](https://example.com/docs.md)',
    '~~~markdown',
    '[代码块示例](docs/not-a-real-link.md)',
    '~~~',
  ].join('\n');
  assert.deepEqual(extractLocalMarkdownLinks(fixture), ['docs/README.md']);
});

test('documentation local Markdown links resolve', () => {
  const files = [
    path.join(projectRoot, 'README.md'),
    ...markdownFiles(path.join(projectRoot, 'docs')),
  ];
  assert.ok(files.length > 0, 'documentation scan must not be empty');
  for (const file of files) {
    for (const link of localMarkdownLinks(file)) {
      const target = path.resolve(path.dirname(file), link);
      const projectRelative = path.relative(projectRoot, target);
      // Generated artifacts are absent in a fresh clone by design; a link that
      // escapes the project root is never acceptable, tolerated or not.
      if (isGeneratedArtifact(projectRelative)) continue;
      assert.equal(existsSync(target), true, `${path.relative(projectRoot, file)} has broken local link: ${link}`);
    }
  }
});

test('generated run artifacts are not committed', () => {
  const ignore = readFileSync(path.join(projectRoot, '.gitignore'), 'utf8').split(/\r?\n/);
  for (const root of GENERATED_ARTIFACT_ROOTS) {
    assert.ok(ignore.includes(root), `.gitignore must ignore ${root}`);
  }
});

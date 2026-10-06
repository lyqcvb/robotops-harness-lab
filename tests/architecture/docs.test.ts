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
 * (`npm run eval`, `npm run test:integration`, `npm run probe:*`, `npm run demo`).
 * Only a curated subset is committed, so a fresh clone legitimately lacks most of
 * them. Links into these trees are therefore allowed to be absent, but every link
 * that is present must still resolve, and the curated artifacts the README relies
 * on must always exist (see the dedicated test below).
 */
const GENERATED_ARTIFACT_ROOTS = ['evidence/', 'results/'] as const;

const REQUIRED_ARTIFACT_LINKS = [
  'evidence/verification/cleanroom-ui-20260926T195348',
  'evidence/verification/cleanroom-v2-20260926T191600',
  'evidence/verification/delivery-20260926T202502/batch-proof.json',
  'evidence/verification/delivery-20260926T202502/manual-proof.json',
  'evidence/verification/engineering-refactor-20260926T132019Z/recompute-all.json',
  'evidence/verification/engineering-refactor-20260926T132019Z/recompute-summary.json',
  'evidence/verification/engineering-refactor-20260926T132019Z/verification-summary.json',
  'results/20260926T113332Z-live-fdc66b4b-a180-4e69-aeac-db445be1f10e',
  'results/20260926T113810Z-live-33a55aaa-7569-441a-a420-ca4e9b3f0cbc',
  'results/20260926T115500Z-live-aca8486b-ca86-45ff-895d-2650679d880d',
  'results/batches/20260926T105135Z-eval-batch-e29948a1-8f29-489d-9b7d-53d28eeb2f75/summary.json',
  'results/batches/20260926T111248Z-eval-batch-aadff914-5f47-4708-b095-ac156885b351/summary.json',
] as const;

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

test('curated evidence artifacts referenced by the documentation are committed', () => {
  // These are the artifacts the README cites as raw evidence. Unlike the rest of
  // evidence/ and results/, they must be present in a fresh clone, otherwise the
  // README's central claims are unbacked.
  for (const link of REQUIRED_ARTIFACT_LINKS) {
    assert.equal(
      existsSync(path.join(projectRoot, link)),
      true,
      `curated evidence artifact is missing: ${link}`,
    );
  }
});

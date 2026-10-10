import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

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

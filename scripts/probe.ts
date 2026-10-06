import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { runProbeCli } from '../src/app/probe.js';

function parseMode(args: readonly string[]): 'offline' | 'live' | null {
  if (args.length !== 1) return null;
  if (args[0] === '--offline') return 'offline';
  if (args[0] === '--live') return 'live';
  return null;
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(path.resolve(entryPath)).href) {
  const mode = parseMode(process.argv.slice(2));
  if (mode === null) {
    console.log(JSON.stringify({
      status: 'BLOCKED',
      error: 'usage: probe.js --offline | --live',
    }));
    process.exitCode = 2;
  } else {
    process.exitCode = await runProbeCli(mode);
  }
}

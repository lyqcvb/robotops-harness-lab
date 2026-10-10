import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { runProbeCli } from '../src/app/probe.js';

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(path.resolve(entryPath)).href) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] !== '--live') {
    console.log(JSON.stringify({
      status: 'BLOCKED',
      error: 'usage: probe.js --live',
    }));
    process.exitCode = 2;
  } else {
    process.exitCode = await runProbeCli();
  }
}

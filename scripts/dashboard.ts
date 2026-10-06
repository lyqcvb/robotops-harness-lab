import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { runDashboardCli } from '../src/app/dashboard.js';

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(path.resolve(entryPath)).href) {
  process.exitCode = await runDashboardCli(process.argv.slice(2));
}

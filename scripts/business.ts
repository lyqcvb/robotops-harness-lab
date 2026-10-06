import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { main } from '../src/app/business.js';

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(path.resolve(entryPath)).href) {
  process.exitCode = await main(process.argv.slice(2));
}
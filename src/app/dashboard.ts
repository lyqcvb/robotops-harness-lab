import process from 'node:process';

import { createDashboardServer } from '../dashboard/server.js';

const DEFAULT_PORT = 4317;

function parsePortValue(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null;
}

export function parseDashboardPort(args: readonly string[]): number | null {
  if (args.length === 0) return DEFAULT_PORT;
  if (args.length === 2 && args[0] === '--port') return parsePortValue(args[1] ?? '');
  if (args.length === 1 && args[0]?.startsWith('--port=')) {
    return parsePortValue(args[0].slice('--port='.length));
  }
  return null;
}

export async function runDashboardCli(args: readonly string[]): Promise<number> {
  const port = parseDashboardPort(args);
  if (port === null) {
    process.stderr.write('Usage: npm run dashboard -- --port <1-65535>\n');
    return 2;
  }

  const server = createDashboardServer({ projectRoot: process.cwd() });
  return await new Promise<number>((resolve) => {
    const onError = (): void => {
      process.stderr.write(`Dashboard could not start on 127.0.0.1:${port}.\n`);
      resolve(1);
    };
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      const address = server.address();
      const actual = typeof address === 'object' && address !== null ? address.port : port;
      process.stdout.write(`Dashboard listening on http://127.0.0.1:${actual}\n`);
      resolve(0);
    });
  });
}

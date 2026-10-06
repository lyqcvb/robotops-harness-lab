import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  createManualApproval,
  type ApprovalRequest,
} from '../../src/app/manual-approval.js';

const REQUEST: ApprovalRequest = {
  run_id: 'run-ui-approval',
  session_id: 'session-ui-approval',
  call_id: 'call-ui-approval',
  action: 'force_reboot',
  args: { robot_id: 'R-03' },
  deadline_ms: 60_000,
};

function createTestHarness() {
  const input = new PassThrough();
  const writer = new PassThrough();
  const chunks: Buffer[] = [];
  writer.on('data', (chunk: string | Buffer) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });

  const output = (): string => Buffer.concat(chunks).toString('utf8');
  const waitForOutput = async (
    predicate: (text: string) => boolean,
    timeoutMs = 1_000,
  ): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(output())) {
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for approval output; received: ${output()}`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  };

  return {
    input,
    writer,
    output,
    waitForOutput,
    close: (): void => {
      input.destroy();
      writer.destroy();
    },
  };
}

test(
  'prints complete approve and reject commands before prompting and only accepts call_id',
  { timeout: 5_000 },
  async () => {
    const harness = createTestHarness();
    const controller = new AbortController();
    let decisionSettled = false;

    try {
      const decide = createManualApproval({
        reader: harness.input,
        writer: harness.writer,
        isTTY: true,
        now: () => 0,
        timeoutMs: 1_000,
      });
      const decisionPromise = decide(REQUEST, controller.signal);
      void decisionPromise.then(
        () => {
          decisionSettled = true;
        },
        () => {
          decisionSettled = true;
        },
      );

      await harness.waitForOutput((text) => text.includes('approval> '));
      const initialOutput = harness.output();
      const lines = initialOutput.split(/\r?\n/);

      assert.ok(lines.includes(`approve ${REQUEST.call_id}`));
      assert.ok(lines.includes(`reject ${REQUEST.call_id}`));
      assert.ok(
        initialOutput.indexOf(`approve ${REQUEST.call_id}`) <
          initialOutput.indexOf('approval> '),
        'approve command must be printed before the first prompt',
      );
      assert.ok(
        initialOutput.indexOf(`reject ${REQUEST.call_id}`) <
          initialOutput.indexOf('approval> '),
        'reject command must be printed before the first prompt',
      );
      assert.match(initialOutput, /run_id \(audit only\):/);
      assert.match(initialOutput, /not an approval input token/i);

      harness.input.write(`approve ${REQUEST.run_id}\n`);
      await harness.waitForOutput((text) => text.includes('Unrecognized input.'));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(decisionSettled, false, 'run_id must not approve the request');

      harness.input.write(`approve ${REQUEST.call_id}\n`);
      assert.equal(await decisionPromise, 'approved');
      assert.equal(decisionSettled, true);
    } finally {
      controller.abort();
      harness.close();
    }
  },
);

test(
  'rejects when the exact call_id reject command is entered',
  { timeout: 5_000 },
  async () => {
    const harness = createTestHarness();
    const controller = new AbortController();

    try {
      const decide = createManualApproval({
        reader: harness.input,
        writer: harness.writer,
        isTTY: true,
        now: () => 0,
        timeoutMs: 1_000,
      });
      const decisionPromise = decide(REQUEST, controller.signal);

      await harness.waitForOutput((text) => text.includes('approval> '));
      harness.input.write(`reject ${REQUEST.call_id}\n`);

      assert.equal(await decisionPromise, 'rejected');
    } finally {
      controller.abort();
      harness.close();
    }
  },
);

for (const scenario of [
  { name: 'an expired deadline', now: REQUEST.deadline_ms + 1, timeoutMs: 1_000 },
  { name: 'a zero timeout', now: 0, timeoutMs: 0 },
  { name: 'a positive short timeout without input', now: 0, timeoutMs: 10 },
]) {
  test(`cancels approval for ${scenario.name}`, { timeout: 5_000 }, async () => {
    const harness = createTestHarness();
    const controller = new AbortController();

    try {
      const decide = createManualApproval({
        reader: harness.input,
        writer: harness.writer,
        isTTY: true,
        now: () => scenario.now,
        timeoutMs: scenario.timeoutMs,
      });

      assert.equal(await decide(REQUEST, controller.signal), 'cancelled');
      assert.match(
        harness.output(),
        /Manual approval deadline expired; cancelled\. The action has not been executed\./,
      );
    } finally {
      controller.abort();
      harness.close();
    }
  });
}

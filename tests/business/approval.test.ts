import assert from 'node:assert/strict';
import test from 'node:test';

import type { ExecutionContext } from '../../src/contracts/business.js';
import {
  ApprovalLedger,
  type ApprovalSource,
} from '../../src/tools/approval-ledger.js';
import { BusinessTrace } from '../../src/trace/business-trace.js';

const ARGS = { robot_id: 'R-03' };
const HASH = '{"robot":{"robot_id":"R-03"},"task":null}';

function context(
  runId: string,
  sessionId: string | null,
  callId: string,
): ExecutionContext {
  return { run_id: runId, session_id: sessionId, call_id: callId };
}

function eventsOfType(trace: BusinessTrace, type: string) {
  return trace.events().filter((event) => event.type === type);
}

test('binds a pending approval to run/session/call/action/args/state and copies records', () => {
  const trace = new BusinessTrace({
    runId: 'run-ledger',
    sessionId: 'session-ledger',
    now: () => 0,
  });
  const ledger = new ApprovalLedger({ runId: 'run-ledger', trace, now: () => 0 });
  const ctx = context('run-ledger', 'session-ledger', 'call-force');

  const binding = ledger.request(ctx, ARGS, HASH);
  const duplicate = ledger.request(ctx, ARGS, HASH);
  const crossRun = ledger.request(
    context('run-other', 'session-ledger', 'call-other-run'),
    ARGS,
    HASH,
  );
  const crossSession = ledger.request(
    context('run-ledger', 'session-other', 'call-other-session'),
    ARGS,
    HASH,
  );

  assert.deepEqual(binding, {
    run_id: 'run-ledger',
    session_id: 'session-ledger',
    call_id: 'call-force',
    action: 'force_reboot',
    canonical_args: '{"robot_id":"R-03"}',
    precondition_hash: HASH,
  });
  assert.equal(duplicate, null);
  assert.equal(crossRun, null);
  assert.equal(crossSession, null);
  assert.equal(ledger.records()[0]?.status, 'pending');
  assert.deepEqual(eventsOfType(trace, 'approval_pending')[0]?.data, {
    binding,
    deadline_ms: 120_000,
  });

  const exposed = ledger.records()[0] as {
    binding: { call_id: string };
    status: string;
  };
  exposed.binding.call_id = 'mutated';
  exposed.status = 'mutated';
  assert.equal(ledger.records()[0]?.binding.call_id, 'call-force');
  assert.equal(ledger.records()[0]?.status, 'pending');
});

test('requires an explicit source and disables scripted approvals by default', () => {
  const trace = new BusinessTrace({ runId: 'run-source', now: () => 0 });
  const ledger = new ApprovalLedger({ runId: 'run-source', trace, now: () => 0 });
  const ctx = context('run-source', null, 'call-source');
  assert.ok(ledger.request(ctx, ARGS, HASH));

  assert.equal(
    ledger.decide(
      ctx.call_id,
      'approved',
      undefined as unknown as ApprovalSource,
    ),
    false,
  );
  assert.equal(ledger.decide(ctx.call_id, 'approved', 'scripted'), false);
  assert.equal(ledger.records()[0]?.status, 'pending');
  assert.equal(eventsOfType(trace, 'approval_decided').length, 0);

  const scriptedTrace = new BusinessTrace({ runId: 'run-scripted', now: () => 0 });
  const scriptedLedger = new ApprovalLedger({
    runId: 'run-scripted',
    trace: scriptedTrace,
    now: () => 0,
    allowScripted: true,
  });
  const scriptedCtx = context('run-scripted', null, 'call-scripted');
  assert.ok(scriptedLedger.request(scriptedCtx, ARGS, HASH));
  assert.equal(scriptedLedger.decide(scriptedCtx.call_id, 'approved', 'scripted'), true);
  assert.equal(scriptedLedger.records()[0]?.status, 'approved');
});

test('records effective rejection and never grants it', () => {
  const trace = new BusinessTrace({ runId: 'run-reject', now: () => 0 });
  const ledger = new ApprovalLedger({ runId: 'run-reject', trace, now: () => 0 });
  const ctx = context('run-reject', null, 'call-reject');
  assert.ok(ledger.request(ctx, ARGS, HASH));

  assert.equal(ledger.decide(ctx.call_id, 'rejected', 'manual'), true);
  assert.equal(ledger.consume(ctx, ARGS, HASH, true), false);
  assert.equal(ledger.records()[0]?.status, 'rejected');
  assert.equal(eventsOfType(trace, 'approval_decided').length, 1);
  assert.equal(eventsOfType(trace, 'approval_invalid').length, 1);
});

test('cancels pending and approved grants without touching consumed history', () => {
  const trace = new BusinessTrace({ runId: 'run-cancel', now: () => 0 });
  const ledger = new ApprovalLedger({ runId: 'run-cancel', trace, now: () => 0 });
  const approvedCtx = context('run-cancel', null, 'call-approved');
  const pendingCtx = context('run-cancel', null, 'call-pending');
  assert.ok(ledger.request(approvedCtx, ARGS, HASH));
  assert.ok(ledger.request(pendingCtx, ARGS, HASH));
  assert.equal(ledger.decide(approvedCtx.call_id, 'approved', 'manual'), true);

  ledger.cancelAll('run cancelled by host');

  assert.deepEqual(
    ledger.records().map((record) => record.status),
    ['cancelled', 'cancelled'],
  );
  assert.equal(ledger.consume(approvedCtx, ARGS, HASH, true), false);
  assert.deepEqual(
    eventsOfType(trace, 'approval_cancelled').map((event) => event.data.reason),
    ['run cancelled by host', 'run cancelled by host'],
  );
});

test('expires at the 120 second deadline and records the terminal state', () => {
  let now = 0;
  const trace = new BusinessTrace({ runId: 'run-expiry', now: () => now });
  const ledger = new ApprovalLedger({
    runId: 'run-expiry',
    trace,
    now: () => now,
  });
  const ctx = context('run-expiry', null, 'call-expiry');
  assert.ok(ledger.request(ctx, ARGS, HASH));
  now = 119_999;
  assert.equal(ledger.decide(ctx.call_id, 'approved', 'manual'), true);

  now = 120_000;
  assert.equal(ledger.consume(ctx, ARGS, HASH, true), false);
  assert.equal(ledger.records()[0]?.status, 'expired');
  assert.equal(eventsOfType(trace, 'approval_expired').length, 1);
});

test('permanently expires an approved grant after any binding mismatch', () => {
  const cases: Array<{
    readonly name: string;
    readonly wrongRun: boolean;
    readonly wrongCall: boolean;
    readonly args: Record<string, string>;
    readonly hash: string;
    readonly nativeApproved: boolean;
  }> = [
    { name: 'cross-run', wrongRun: true, wrongCall: false, args: ARGS, hash: HASH, nativeApproved: true },
    { name: 'wrong-call', wrongRun: false, wrongCall: true, args: ARGS, hash: HASH, nativeApproved: true },
    { name: 'changed-args', wrongRun: false, wrongCall: false, args: { robot_id: 'R-99' }, hash: HASH, nativeApproved: true },
    { name: 'changed-state', wrongRun: false, wrongCall: false, args: ARGS, hash: '{"changed":true}', nativeApproved: true },
    { name: 'native-false', wrongRun: false, wrongCall: false, args: ARGS, hash: HASH, nativeApproved: false },
  ];

  for (const [index, item] of cases.entries()) {
    const runId = `run-mismatch-${index}`;
    const sessionId = `session-mismatch-${index}`;
    const callId = `call-mismatch-${index}`;
    const trace = new BusinessTrace({ runId, sessionId, now: () => 0 });
    const ledger = new ApprovalLedger({ runId, trace, now: () => 0 });
    const approvedContext = context(runId, sessionId, callId);
    assert.ok(ledger.request(approvedContext, ARGS, HASH));
    assert.equal(ledger.decide(callId, 'approved', 'manual'), true);

    const attemptedContext = context(
      item.wrongRun ? `${runId}-other` : runId,
      sessionId,
      item.wrongCall ? `${callId}-other` : callId,
    );
    assert.equal(
      ledger.consume(
        attemptedContext,
        item.args,
        item.hash,
        item.nativeApproved,
      ),
      false,
      item.name,
    );
    assert.equal(ledger.records()[0]?.status, 'expired', item.name);
    assert.equal(
      ledger.consume(approvedContext, ARGS, HASH, true),
      false,
      `${item.name} must not be reusable`,
    );
    assert.equal(eventsOfType(trace, 'approval_consumed').length, 0);
  }
});

test('consumes an exact approved grant once and records native approval truth', () => {
  const trace = new BusinessTrace({
    runId: 'run-consume',
    sessionId: 'session-consume',
    now: () => 0,
  });
  const ledger = new ApprovalLedger({ runId: 'run-consume', trace, now: () => 0 });
  const ctx = context('run-consume', 'session-consume', 'call-consume');
  assert.ok(ledger.request(ctx, ARGS, HASH));
  assert.equal(ledger.decide(ctx.call_id, 'approved', 'manual'), true);

  assert.equal(ledger.consume(ctx, ARGS, HASH, true), true);
  assert.equal(ledger.records()[0]?.status, 'consumed');
  assert.equal(ledger.consume(ctx, ARGS, HASH, true), false);

  const consumed = eventsOfType(trace, 'approval_consumed');
  assert.equal(consumed.length, 1);
  assert.deepEqual(consumed[0]?.data, {
    binding: ledger.records()[0]?.binding,
    source: 'manual',
    native_approved: true,
  });
});
test('keeps independent runs isolated even when call ids and args match', () => {
  const traceOne = new BusinessTrace({
    runId: 'run-one',
    sessionId: 'session-one',
    now: () => 0,
  });
  const traceTwo = new BusinessTrace({
    runId: 'run-two',
    sessionId: 'session-two',
    now: () => 0,
  });
  const ledgerOne = new ApprovalLedger({ runId: 'run-one', trace: traceOne, now: () => 0 });
  const ledgerTwo = new ApprovalLedger({ runId: 'run-two', trace: traceTwo, now: () => 0 });
  const ctxOne = context('run-one', 'session-one', 'call-shared');
  const ctxTwo = context('run-two', 'session-two', 'call-shared');

  assert.ok(ledgerOne.request(ctxOne, ARGS, HASH));
  assert.ok(ledgerTwo.request(ctxTwo, ARGS, HASH));
  assert.equal(ledgerOne.decide(ctxOne.call_id, 'approved', 'manual'), true);
  assert.equal(ledgerTwo.decide(ctxTwo.call_id, 'approved', 'manual'), true);

  assert.equal(ledgerOne.consume(ctxTwo, ARGS, HASH, true), false);
  assert.equal(ledgerTwo.consume(ctxOne, ARGS, HASH, true), false);
  assert.equal(ledgerOne.consume(ctxOne, ARGS, HASH, true), false);
  assert.equal(ledgerTwo.consume(ctxTwo, ARGS, HASH, true), false);
  assert.equal(ledgerOne.records()[0]?.binding.run_id, 'run-one');
  assert.equal(ledgerTwo.records()[0]?.binding.run_id, 'run-two');
  assert.equal(ledgerOne.records()[0]?.status, 'expired');
  assert.equal(ledgerTwo.records()[0]?.status, 'expired');
});

test('rejects decisions for unknown calls and cannot approve expired records', () => {
  let now = 0;
  const trace = new BusinessTrace({ runId: 'run-decide', now: () => now });
  const ledger = new ApprovalLedger({ runId: 'run-decide', trace, now: () => now });
  const ctx = context('run-decide', null, 'call-decide');

  assert.equal(ledger.decide('call-unknown', 'approved', 'manual'), false);
  assert.ok(ledger.request(ctx, ARGS, HASH));
  now = 120_000;
  assert.equal(ledger.decide(ctx.call_id, 'approved', 'manual'), false);
  assert.equal(ledger.records()[0]?.status, 'expired');
  assert.equal(eventsOfType(trace, 'approval_invalid').length, 1);
  assert.equal(eventsOfType(trace, 'approval_expired').length, 1);
});
const { test } = require('node:test');
const assert = require('node:assert');
const { isSqliteBusy, runWithBusyRetry } = require('../sqlite-busy-retry');

test('isSqliteBusy detects busy/locked by code or message', () => {
  assert.equal(isSqliteBusy({ code: 'SQLITE_BUSY' }), true);
  assert.equal(isSqliteBusy({ code: 'SQLITE_LOCKED' }), true);
  assert.equal(isSqliteBusy({ message: 'database is locked' }), true);
  assert.equal(isSqliteBusy({ code: 'SQLITE_CONSTRAINT' }), false);
  assert.equal(isSqliteBusy(null), null);
});

test('runWithBusyRetry returns the value on first success (no retry)', () => {
  let calls = 0;
  const out = runWithBusyRetry(() => { calls++; return 42; });
  assert.equal(out, 42);
  assert.equal(calls, 1);
});

test('runWithBusyRetry retries on busy then succeeds', () => {
  let calls = 0;
  const out = runWithBusyRetry(() => {
    calls++;
    if (calls < 3) { const e = new Error('database is locked'); e.code = 'SQLITE_BUSY'; throw e; }
    return 'ok';
  }, 4);
  assert.equal(out, 'ok');
  assert.equal(calls, 3);
});

test('runWithBusyRetry gives up after N attempts on persistent busy', () => {
  let calls = 0;
  assert.throws(() => runWithBusyRetry(() => {
    calls++;
    const e = new Error('database is locked'); e.code = 'SQLITE_BUSY'; throw e;
  }, 3), /database is locked/);
  assert.equal(calls, 3);
});

test('runWithBusyRetry rethrows a non-busy error immediately (no retry)', () => {
  let calls = 0;
  assert.throws(() => runWithBusyRetry(() => {
    calls++;
    const e = new Error('constraint failed'); e.code = 'SQLITE_CONSTRAINT'; throw e;
  }, 4), /constraint failed/);
  assert.equal(calls, 1);
});

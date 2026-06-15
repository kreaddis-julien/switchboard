'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { cronMatches } = require('../schedule-runner.js');

// Build a local-time Date for a given wall-clock. cronMatches reads local getters,
// so we construct with local components.
function at(year, month1, day, hour, minute) {
  return new Date(year, month1 - 1, day, hour, minute, 0, 0);
}

// 2026-06-01 is a Monday (getDay() === 1); 2026-06-02 is a Tuesday.
test('cron: */5 matches every 5th minute, ignores day fields', () => {
  assert.equal(cronMatches('*/5 * * * *', at(2026, 6, 1, 9, 5)), true);
  assert.equal(cronMatches('*/5 * * * *', at(2026, 6, 1, 9, 7)), false);
});

test('cron: minute+hour gate', () => {
  assert.equal(cronMatches('30 9 * * *', at(2026, 6, 1, 9, 30)), true);
  assert.equal(cronMatches('30 9 * * *', at(2026, 6, 1, 10, 30)), false);
});

test('cron: POSIX dom OR dow when BOTH restricted — fires on the 1st (any weekday)', () => {
  // "0 9 1 * 1" = 09:00 on the 1st OR on any Monday.
  // 2026-07-01 is a Wednesday: matches via day-of-month (the 1st).
  assert.equal(cronMatches('0 9 1 * 1', at(2026, 7, 1, 9, 0)), true);
});

test('cron: POSIX dom OR dow when BOTH restricted — fires on Monday (not the 1st)', () => {
  // 2026-06-08 is a Monday but not the 1st: matches via day-of-week.
  assert.equal(cronMatches('0 9 1 * 1', at(2026, 6, 8, 9, 0)), true);
});

test('cron: POSIX dom OR dow — no match when neither day matches', () => {
  // 2026-06-09 is a Tuesday and not the 1st: matches neither.
  assert.equal(cronMatches('0 9 1 * 1', at(2026, 6, 9, 9, 0)), false);
});

test('cron: dom only ("*" dow) is AND-collapsed to the dom side', () => {
  assert.equal(cronMatches('0 9 1 * *', at(2026, 6, 1, 9, 0)), true);
  assert.equal(cronMatches('0 9 1 * *', at(2026, 6, 2, 9, 0)), false);
});

test('cron: dow only ("*" dom) is AND-collapsed to the dow side', () => {
  // Monday = 1.
  assert.equal(cronMatches('0 9 * * 1', at(2026, 6, 1, 9, 0)), true);  // Mon
  assert.equal(cronMatches('0 9 * * 1', at(2026, 6, 2, 9, 0)), false); // Tue
});

test('cron: rejects malformed expressions (wrong field count)', () => {
  assert.equal(cronMatches('0 9 * *', at(2026, 6, 1, 9, 0)), false);
});

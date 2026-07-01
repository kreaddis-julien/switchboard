const test = require('node:test');
const assert = require('node:assert/strict');
const { newestDueSlot } = require('../schedule-runner');

// Helper: build an epoch-ms for a given local date/time.
function at(y, mo, d, h, mi) { return new Date(y, mo - 1, d, h, mi, 0, 0).getTime(); }
const MIN = 60000;

test('fires on-time: current minute matches, after a prior fire', () => {
  const now = at(2026, 6, 1, 3, 0);
  const lastFired = at(2026, 5, 31, 3, 0); // yesterday 03:00
  const slot = newestDueSlot('0 3 * * *', now, lastFired);
  assert.equal(slot, at(2026, 6, 1, 3, 0));
});

test('no re-fire within the same slot once lastFired is advanced to now', () => {
  const now = at(2026, 6, 1, 3, 1);
  const lastFired = at(2026, 6, 1, 3, 0); // already fired the 03:00 slot this minute-ago
  assert.equal(newestDueSlot('0 3 * * *', now, lastFired), null);
});

test('catches up a slot missed within the 1h window (asleep 02:55–03:30)', () => {
  const now = at(2026, 6, 1, 3, 30);
  const lastFired = at(2026, 5, 31, 3, 0); // yesterday
  assert.equal(newestDueSlot('0 3 * * *', now, lastFired), at(2026, 6, 1, 3, 0));
});

test('does NOT catch up a slot older than the 1h window (wake at 05:00)', () => {
  const now = at(2026, 6, 1, 5, 0);
  const lastFired = at(2026, 5, 31, 3, 0);
  assert.equal(newestDueSlot('0 3 * * *', now, lastFired), null);
});

test('returns at most ONE slot for a per-minute cron (catch up once, not N times)', () => {
  const now = at(2026, 6, 1, 12, 30);
  const lastFired = at(2026, 6, 1, 12, 0); // 30 missed minutes
  const slot = newestDueSlot('* * * * *', now, lastFired);
  assert.equal(slot, at(2026, 6, 1, 12, 30)); // newest only
});

test('first-sight window (since = now-60s) fires only on an exact current-minute match', () => {
  const now = at(2026, 6, 1, 3, 0);
  // On the matching minute -> due
  assert.equal(newestDueSlot('0 3 * * *', now, now - MIN), at(2026, 6, 1, 3, 0));
  // One minute off -> not due (no reach-back for a never-seen task)
  const off = at(2026, 6, 1, 3, 5);
  assert.equal(newestDueSlot('0 3 * * *', off, off - MIN), null);
});

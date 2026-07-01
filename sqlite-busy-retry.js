// sqlite-busy-retry.js — application-level retry around better-sqlite3 writes.
//
// db.js already sets journal_mode=WAL + busy_timeout, which handles almost all
// contention. This is defense-in-depth for the rare case where the scheduler, the
// UI and the folder watcher all write the same DB and busy_timeout is exceeded:
// retry a handful of times with a short synchronous backoff before giving up.

function isSqliteBusy(err) {
  return err && (
    err.code === 'SQLITE_BUSY' ||
    err.code === 'SQLITE_LOCKED' ||
    /database is locked/i.test(err.message || '')
  );
}

function runWithBusyRetry(fn, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return fn();
    } catch (err) {
      if (!isSqliteBusy(err) || i === attempts - 1) throw err;
      lastErr = err;
      // better-sqlite3 is synchronous; give SQLite a tiny extra window after
      // busy_timeout when concurrent watcher/index writes briefly overlap.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (i + 1));
    }
  }
  throw lastErr;
}

module.exports = { isSqliteBusy, runWithBusyRetry };

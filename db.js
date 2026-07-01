const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');
const { runWithBusyRetry } = require('./sqlite-busy-retry');

// SWITCHBOARD_DATA_DIR lets dev/agent/test runs point at a separate DB instead
// of the real ~/.switchboard one (e.g. to exercise the FTS migration on a copy
// without touching the user's data). Unset = the normal ~/.switchboard path.
const DATA_DIR = process.env.SWITCHBOARD_DATA_DIR
  ? path.resolve(process.env.SWITCHBOARD_DATA_DIR.replace(/^~(?=$|\/)/, os.homedir()))
  : path.join(os.homedir(), '.switchboard');
const fs = require('fs');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'switchboard.db');

// Migrate from old locations if needed
const OLD_LOCATIONS = [
  path.join(os.homedir(), '.claude', 'browser', 'switchboard.db'),
  path.join(os.homedir(), '.claude', 'browser', 'session-browser.db'),
  path.join(os.homedir(), '.claude', 'session-browser.db'),
];
if (!fs.existsSync(DB_PATH)) {
  for (const oldPath of OLD_LOCATIONS) {
    if (fs.existsSync(oldPath)) {
      fs.renameSync(oldPath, DB_PATH);
      try { fs.renameSync(oldPath + '-wal', DB_PATH + '-wal'); } catch {}
      try { fs.renameSync(oldPath + '-shm', DB_PATH + '-shm'); } catch {}
      break;
    }
  }
}
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
// NORMAL is the standard pairing with WAL: the WAL is still synced on
// checkpoint, so the database cannot corrupt; at most the last transactions
// before an OS-level power loss are rolled back. Default FULL fsyncs every
// write for no extra integrity in WAL mode.
db.pragma('synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS session_meta (
    sessionId TEXT PRIMARY KEY,
    name TEXT,
    starred INTEGER DEFAULT 0,
    archived INTEGER DEFAULT 0
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS session_cache (
    sessionId TEXT PRIMARY KEY,
    folder TEXT NOT NULL,
    projectPath TEXT,
    summary TEXT,
    firstPrompt TEXT,
    created TEXT,
    modified TEXT,
    messageCount INTEGER DEFAULT 0,
    slug TEXT,
    aiTitle TEXT,
    parentSessionId TEXT,
    agentId TEXT,
    subagentType TEXT,
    description TEXT
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS cache_meta (
    folder TEXT PRIMARY KEY,
    projectPath TEXT,
    indexMtimeMs REAL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )
`);

// Index for fast folder lookups
db.exec('CREATE INDEX IF NOT EXISTS idx_session_cache_folder ON session_cache(folder)');
db.exec('CREATE INDEX IF NOT EXISTS idx_session_cache_slug ON session_cache(slug)');

// --- Migrations ---
// Each migration runs once, in order. Add new migrations to the end.
let searchFtsRecreated = false;
const migrations = [
  // v1: (superseded by v2)
  () => {},
  // v2: Clear session cache to re-index with corrected worktree paths
  (db) => {
    try { db.exec('DELETE FROM session_cache'); } catch {}
    try { db.exec('DELETE FROM cache_meta'); } catch {}
    try { db.exec('DELETE FROM search_map'); } catch {}
    try { db.exec('DROP TABLE IF EXISTS search_fts'); } catch {}
    searchFtsRecreated = true;
  },
  // v3: Add aiTitle column for AI-generated session titles. Clear cache so a
  // re-index repopulates the column. Also clear session_meta.name entries that
  // were clobbered by AI titles in v0.0.29 (when ai-title was written into the
  // user-name column). We cannot tell with certainty which names came from an
  // AI title vs a manual rename, but the safe heuristic is: drop names whose
  // value matches the JSONL aiTitle on next index. That post-index cleanup is
  // not done here — instead we accept that any pre-fix AI-title pollution
  // remains until the user renames manually, and only future indexes are clean.
  (db) => {
    try { db.exec('ALTER TABLE session_cache ADD COLUMN aiTitle TEXT'); } catch {}
    try { db.exec('DELETE FROM session_cache'); } catch {}
    try { db.exec('DELETE FROM cache_meta'); } catch {}
  },
  // v4: Add subagent columns. Subagent transcripts live under
  // <folder>/<parentSessionId>/subagents/agent-<agentId>.jsonl alongside a
  // .meta.json sidecar holding { agentType, description }. We surface them as
  // first-class rows in session_cache, keyed by sessionId = "sub:<parent>:<agentId>".
  // Clear cache so subagent rows get picked up on first re-index.
  (db) => {
    try { db.exec('ALTER TABLE session_cache ADD COLUMN parentSessionId TEXT'); } catch {}
    try { db.exec('ALTER TABLE session_cache ADD COLUMN agentId TEXT'); } catch {}
    try { db.exec('ALTER TABLE session_cache ADD COLUMN subagentType TEXT'); } catch {}
    try { db.exec('ALTER TABLE session_cache ADD COLUMN description TEXT'); } catch {}
    try { db.exec('CREATE INDEX IF NOT EXISTS idx_session_cache_parent ON session_cache(parentSessionId)'); } catch {}
    try { db.exec('DELETE FROM session_cache'); } catch {}
    try { db.exec('DELETE FROM cache_meta'); } catch {}
  },
  // v5: Token/usage analytics — per-session metrics extracted from message.usage
  // and tool_use blocks. Clear the cache so a re-index backfills the new columns.
  // Add only MISSING columns (checked via PRAGMA) instead of catching the
  // "duplicate column" error — that way a *real* ALTER failure throws and aborts
  // before db_version is bumped (cacheUpsert hard-depends on these columns, so a
  // silently half-applied schema would brick boot with no path to re-run).
  (db) => {
    const existing = new Set(db.prepare('PRAGMA table_info(session_cache)').all().map((c) => c.name));
    const add = (col, type) => { if (!existing.has(col)) db.exec(`ALTER TABLE session_cache ADD COLUMN ${col} ${type}`); };
    for (const col of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'toolCalls', 'subagentInvocations']) {
      add(col, 'INTEGER DEFAULT 0');
    }
    add('model', 'TEXT');
    db.exec('DELETE FROM session_cache');
    db.exec('DELETE FROM cache_meta');
  },
  // v6: Track the SOURCE of session_meta.name ('user' = UI rename, 'jsonl' = Claude
  // /rename custom-title) so a JSONL custom-title can no longer clobber a user's UI
  // rename on re-index, while a fresh CLI /rename still refreshes a jsonl-sourced name.
  // Existing names are ambiguous (no source was recorded); per the documented
  // precedence (user rename > JSONL title) we treat any pre-existing name as a user
  // rename so it is protected. Does not touch the (rebuildable) session_cache.
  (db) => {
    const existing = new Set(db.prepare('PRAGMA table_info(session_meta)').all().map((c) => c.name));
    if (!existing.has('name_source')) db.exec('ALTER TABLE session_meta ADD COLUMN name_source TEXT');
    db.exec("UPDATE session_meta SET name_source = 'user' WHERE name IS NOT NULL AND name != '' AND name_source IS NULL");
  },
  // v7: Convert search_fts from a plain fts5 table (which stores a full copy of
  // title+body, inflating the DB ~14x) to an external-content fts5 table backed
  // by search_content (a single, truncated copy). Drops the DB from ~190 MB to
  // ~35-40 MB for a typical corpus. snippet()/highlight() keep working: fts5
  // reads columns from search_content on demand instead of its own shadow copy.
  //
  // searchFtsRecreated = true tells main.js to trigger a full repopulate via
  // populateCacheViaWorker(), which re-inserts all rows with the new schema.
  //
  // VACUUM: the DROP TABLE frees the old plain-fts5 shadow pages (~152 MB) but
  // SQLite only adds them to the freelist — the file stays its old size. A
  // one-time VACUUM reclaims it immediately (empirically 225 MB -> 37.9 MB in
  // ~0.5 s on a 236 MB DB). VACUUM cannot run inside a transaction; the
  // migrations loop is NOT wrapped in one, so db.exec('VACUUM') here is legal.
  (db) => {
    try { db.exec('DROP TABLE IF EXISTS search_fts'); } catch {}
    try { db.exec('DROP TABLE IF EXISTS search_content'); } catch {}
    try { db.exec('DELETE FROM search_map'); } catch {}
    try { db.exec('VACUUM'); } catch {}
    searchFtsRecreated = true;
  },
  // v8: Session-shape metrics: user-turn count, largest single user prompt
  // (words), active span (minutes),
  // and first/last entry timestamps. Add only MISSING columns (PRAGMA-checked, as
  // in v5) so a real ALTER failure aborts before db_version bumps. The cache is
  // re-indexed on this boot anyway (v7 set searchFtsRecreated -> full repopulate),
  // which backfills these columns from the JSONL.
  (db) => {
    const existing = new Set(db.prepare('PRAGMA table_info(session_cache)').all().map((c) => c.name));
    const add = (col, type) => { if (!existing.has(col)) db.exec(`ALTER TABLE session_cache ADD COLUMN ${col} ${type}`); };
    add('userMessageCount', 'INTEGER DEFAULT 0');
    add('largestUserPromptWords', 'INTEGER DEFAULT 0');
    add('activeMinutes', 'INTEGER DEFAULT 0');
    add('startedAt', 'TEXT');
    add('lastEntryAt', 'TEXT');
  },
];

const currentDbVersion = (() => {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'db_version'").get();
    return row ? JSON.parse(row.value) : 0;
  } catch { return 0; }
})();

for (let i = currentDbVersion; i < migrations.length; i++) {
  migrations[i](db);
}
if (migrations.length > currentDbVersion) {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('db_version', ?)").run(JSON.stringify(migrations.length));
}

// --- FTS5 full-text search (external-content table) ---
//
// Body is capped at FTS_BODY_MAX_CHARS before being stored. This bounds the
// content table size independently of raw transcript length, while keeping
// enough text for useful snippet() previews.
const FTS_BODY_MAX_CHARS = 32768; // 32768 UTF-16 code units; surrogate split at the boundary is negligible for ASCII transcripts

// FTS_QUERY_MAX_CHARS caps the query string passed to FTS5. With tokenize='trigram',
// a double-quoted (phrase) query intersects one trigram doclist per 3-char window in
// order — a 60-char URL yields ~58 overlapping trigrams. Common trigrams ("://",
// "git", "/-/") have enormous doclists on a 4000+ session index, and the contiguous
// phrase-intersect blocks the synchronous main thread for up to ~60 s. Capping at 48
// chars limits the phrase to <=46 trigrams (safe for a main-thread query) while
// preserving any plausible hand-typed search; longer pastes are silently truncated.
const FTS_QUERY_MAX_CHARS = 48;

// search_content holds the plaintext the fts5 index reads columns from. It is
// the single authoritative copy: title is full-length; body is truncated to
// FTS_BODY_MAX_CHARS. Keeping it separate from search_map (id/type/folder only)
// lets us JOIN on rowid cheaply.
db.exec(`
  CREATE TABLE IF NOT EXISTS search_content (
    rowid INTEGER PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    body  TEXT NOT NULL DEFAULT ''
  )
`);

// search_fts is an external-content fts5 table: it stores only the trigram
// index, not a copy of title/body. snippet()/highlight() read the matching
// search_content row at query time (zero extra copy). Eliminates the ~14x
// amplification of the old plain fts5 table.
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
    title, body,
    content='search_content',
    tokenize='trigram case_sensitive 0'
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS search_map (
    rowid INTEGER PRIMARY KEY,
    id TEXT NOT NULL,
    type TEXT NOT NULL,
    folder TEXT
  )
`);

db.exec('CREATE INDEX IF NOT EXISTS idx_search_map_type_id ON search_map(type, id)');

const stmts = {
  get: db.prepare('SELECT * FROM session_meta WHERE sessionId = ?'),
  getAll: db.prepare('SELECT * FROM session_meta'),
  upsertName: db.prepare(`
    INSERT INTO session_meta (sessionId, name, name_source) VALUES (?, ?, ?)
    ON CONFLICT(sessionId) DO UPDATE SET name = excluded.name, name_source = excluded.name_source
  `),
  upsertStar: db.prepare(`
    INSERT INTO session_meta (sessionId, starred) VALUES (?, 1)
    ON CONFLICT(sessionId) DO UPDATE SET starred = CASE WHEN starred = 1 THEN 0 ELSE 1 END
  `),
  upsertArchived: db.prepare(`
    INSERT INTO session_meta (sessionId, archived) VALUES (?, ?)
    ON CONFLICT(sessionId) DO UPDATE SET archived = excluded.archived
  `),
  // Session cache statements
  cacheCount: db.prepare('SELECT COUNT(*) as cnt FROM session_cache'),
  cacheGetAll: db.prepare('SELECT * FROM session_cache'),
  cacheUpsert: db.prepare(`
    INSERT INTO session_cache (sessionId, folder, projectPath, summary, firstPrompt, created, modified, messageCount, slug, aiTitle, parentSessionId, agentId, subagentType, description, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, toolCalls, subagentInvocations, model, userMessageCount, largestUserPromptWords, activeMinutes, startedAt, lastEntryAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sessionId) DO UPDATE SET
      folder = excluded.folder, projectPath = excluded.projectPath,
      summary = excluded.summary, firstPrompt = excluded.firstPrompt,
      created = excluded.created, modified = excluded.modified,
      messageCount = excluded.messageCount, slug = excluded.slug,
      aiTitle = excluded.aiTitle,
      parentSessionId = excluded.parentSessionId, agentId = excluded.agentId,
      subagentType = excluded.subagentType, description = excluded.description,
      inputTokens = excluded.inputTokens, outputTokens = excluded.outputTokens,
      cacheReadTokens = excluded.cacheReadTokens, cacheCreationTokens = excluded.cacheCreationTokens,
      toolCalls = excluded.toolCalls, subagentInvocations = excluded.subagentInvocations,
      model = excluded.model,
      userMessageCount = excluded.userMessageCount, largestUserPromptWords = excluded.largestUserPromptWords,
      activeMinutes = excluded.activeMinutes, startedAt = excluded.startedAt, lastEntryAt = excluded.lastEntryAt
  `),
  cacheGetByParent: db.prepare('SELECT * FROM session_cache WHERE parentSessionId = ? ORDER BY created ASC'),
  cacheGetByFolder: db.prepare('SELECT * FROM session_cache WHERE folder = ?'),
  cacheTouchModified: db.prepare('UPDATE session_cache SET modified = ? WHERE sessionId = ?'),
  cacheGetFolder: db.prepare('SELECT folder FROM session_cache WHERE sessionId = ?'),
  cacheGetSession: db.prepare('SELECT * FROM session_cache WHERE sessionId = ?'),
  cacheDeleteSession: db.prepare('DELETE FROM session_cache WHERE sessionId = ?'),
  cacheDeleteFolder: db.prepare('DELETE FROM session_cache WHERE folder = ?'),
  // Cache meta statements
  metaGet: db.prepare('SELECT * FROM cache_meta WHERE folder = ?'),
  metaGetAll: db.prepare('SELECT * FROM cache_meta'),
  metaUpsert: db.prepare(`
    INSERT INTO cache_meta (folder, projectPath, indexMtimeMs)
    VALUES (?, ?, ?)
    ON CONFLICT(folder) DO UPDATE SET
      projectPath = excluded.projectPath, indexMtimeMs = excluded.indexMtimeMs
  `),
  metaDelete: db.prepare('DELETE FROM cache_meta WHERE folder = ?'),
  // FTS search statements.
  // External-content protocol: search_content is the authoritative column store;
  // search_fts holds only the trigram index and reads columns from search_content
  // at query time. Delete/insert must keep both tables in sync.
  searchDeleteContentBySession: db.prepare('DELETE FROM search_content WHERE rowid IN (SELECT rowid FROM search_map WHERE type = \'session\' AND id = ?)'),
  searchDeleteBySession: db.prepare('DELETE FROM search_fts WHERE rowid IN (SELECT rowid FROM search_map WHERE type = \'session\' AND id = ?)'),
  searchMapDeleteBySession: db.prepare('DELETE FROM search_map WHERE type = \'session\' AND id = ?'),
  searchDeleteContentByFolder: db.prepare('DELETE FROM search_content WHERE rowid IN (SELECT rowid FROM search_map WHERE type = \'session\' AND folder = ?)'),
  searchDeleteByFolder: db.prepare('DELETE FROM search_fts WHERE rowid IN (SELECT rowid FROM search_map WHERE type = \'session\' AND folder = ?)'),
  searchMapDeleteByFolder: db.prepare('DELETE FROM search_map WHERE type = \'session\' AND folder = ?'),
  searchDeleteContentByType: db.prepare('DELETE FROM search_content WHERE rowid IN (SELECT rowid FROM search_map WHERE type = ?)'),
  searchDeleteByType: db.prepare('DELETE FROM search_fts WHERE rowid IN (SELECT rowid FROM search_map WHERE type = ?)'),
  searchMapDeleteByType: db.prepare('DELETE FROM search_map WHERE type = ?'),
  // Insert: search_content row first (external-content protocol requires the
  // content row to exist before the fts5 shadow row is written).
  searchInsertContent: db.prepare('INSERT OR REPLACE INTO search_content(rowid, title, body) VALUES (?, ?, ?)'),
  searchInsertFts: db.prepare('INSERT OR REPLACE INTO search_fts(rowid, title, body) VALUES (?, ?, ?)'),
  searchInsertMap: db.prepare('INSERT OR REPLACE INTO search_map(id, type, folder) VALUES (?, ?, ?)'),
  searchMapLookup: db.prepare('SELECT rowid FROM search_map WHERE id = ? AND type = ?'),
  // Title update patches search_content (authoritative); the fts5 shadow row is
  // patched via the external-content delete+reinsert protocol in updateSearchTitle().
  searchUpdateTitle: db.prepare('UPDATE search_content SET title = ? WHERE rowid = (SELECT rowid FROM search_map WHERE id = ? AND type = ?)'),
  searchDeleteContentByRowid: db.prepare('DELETE FROM search_content WHERE rowid = ?'),
  searchDeleteByRowid: db.prepare('DELETE FROM search_fts WHERE rowid = ?'),
  searchMapDeleteByRowid: db.prepare('DELETE FROM search_map WHERE rowid = ?'),
  searchContentGet: db.prepare('SELECT title, body FROM search_content WHERE rowid = ?'),
  // fts5 external-content 'delete' command: removes the shadow row by its old
  // column values. Used before reinserting with an updated title.
  searchFtsDeleteRow: db.prepare("INSERT INTO search_fts(search_fts, rowid, title, body) VALUES('delete', ?, ?, ?)"),
  searchFtsInsertRow: db.prepare('INSERT INTO search_fts(rowid, title, body) VALUES(?, ?, ?)'),
  // Settings statements
  settingsGet: db.prepare('SELECT value FROM settings WHERE key = ?'),
  settingsUpsert: db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `),
  settingsDelete: db.prepare('DELETE FROM settings WHERE key = ?'),
  searchQuery: db.prepare(`
    SELECT search_map.id, snippet(search_fts, 1, '<mark>', '</mark>', '...', 40) as snippet
    FROM search_fts
    JOIN search_map ON search_fts.rowid = search_map.rowid
    WHERE search_map.type = ? AND search_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `),
};

function getMeta(sessionId) {
  return stmts.get.get(sessionId) || null;
}

function getAllMeta() {
  const rows = stmts.getAll.all();
  const map = new Map();
  for (const row of rows) map.set(row.sessionId, row);
  return map;
}

// source: 'user' (UI rename) | 'jsonl' (Claude /rename custom-title) | null.
// A null/empty name clears the source too (no preference to protect).
function setName(sessionId, name, source = null) {
  runWithBusyRetry(() => stmts.upsertName.run(sessionId, name, name ? source : null));
}

function toggleStar(sessionId) {
  runWithBusyRetry(() => stmts.upsertStar.run(sessionId));
  const row = stmts.get.get(sessionId);
  return row.starred;
}

function setArchived(sessionId, archived) {
  runWithBusyRetry(() => stmts.upsertArchived.run(sessionId, archived ? 1 : 0));
}

// --- Session cache functions ---

function isCachePopulated() {
  return stmts.cacheCount.get().cnt > 0;
}

function getAllCached() {
  return stmts.cacheGetAll.all();
}

const upsertCachedSessionsBatch = db.transaction((sessions) => {
  for (const s of sessions) {
    stmts.cacheUpsert.run(
      s.sessionId, s.folder, s.projectPath, s.summary,
      s.firstPrompt, s.created, s.modified, s.messageCount || 0,
      s.slug || null, s.aiTitle || null,
      s.parentSessionId || null, s.agentId || null,
      s.subagentType || null, s.description || null,
      s.inputTokens || 0, s.outputTokens || 0, s.cacheReadTokens || 0,
      s.cacheCreationTokens || 0, s.toolCalls || 0, s.subagentInvocations || 0,
      s.model || null,
      s.userMessageCount || 0, s.largestUserPromptWords || 0, s.activeMinutes || 0,
      s.startedAt || null, s.lastEntryAt || null
    );
  }
});

function getCachedByParent(parentSessionId) {
  return stmts.cacheGetByParent.all(parentSessionId);
}

function upsertCachedSessions(sessions) {
  runWithBusyRetry(() => upsertCachedSessionsBatch(sessions));
}

function getCachedByFolder(folder) {
  return stmts.cacheGetByFolder.all(folder);
}

function touchCachedModified(sessionId, modified) {
  runWithBusyRetry(() => stmts.cacheTouchModified.run(modified, sessionId));
}

function getCachedFolder(sessionId) {
  const row = stmts.cacheGetFolder.get(sessionId);
  return row ? row.folder : null;
}

function getCachedSession(sessionId) {
  return stmts.cacheGetSession.get(sessionId) || null;
}

function deleteCachedSession(sessionId) {
  runWithBusyRetry(() => stmts.cacheDeleteSession.run(sessionId));
}

function deleteCachedFolder(folder) {
  runWithBusyRetry(() => {
    stmts.cacheDeleteFolder.run(folder);
    stmts.metaDelete.run(folder);
  });
}

function getFolderMeta(folder) {
  return stmts.metaGet.get(folder) || null;
}

function getAllFolderMeta() {
  const rows = stmts.metaGetAll.all();
  const map = new Map();
  for (const row of rows) map.set(row.folder, row);
  return map;
}

function setFolderMeta(folder, projectPath, indexMtimeMs) {
  runWithBusyRetry(() => stmts.metaUpsert.run(folder, projectPath, indexMtimeMs));
}

// --- FTS search functions ---

const upsertSearchEntriesBatch = db.transaction((entries) => {
  for (const e of entries) {
    // Delete any existing FTS + content rows for this (id, type) pair before
    // inserting. search_map uses INSERT OR REPLACE which deletes the old row
    // and creates a new one with a new rowid, but the orphaned search_fts and
    // search_content rows keyed to the old rowid would never be cleaned up —
    // causing duplicate search results and unbounded table growth.
    const existing = stmts.searchMapLookup.get(e.id, e.type);
    if (existing) {
      stmts.searchDeleteByRowid.run(existing.rowid);
      stmts.searchDeleteContentByRowid.run(existing.rowid);
      stmts.searchMapDeleteByRowid.run(existing.rowid);
    }
    const result = stmts.searchInsertMap.run(e.id, e.type, e.folder || null);
    const rid = result.lastInsertRowid;
    const title = e.title || '';
    // Truncate body to FTS_BODY_MAX_CHARS: bounds search_content size and keeps
    // the fts5 index compact without sacrificing meaningful snippets.
    const body = (e.body || '').slice(0, FTS_BODY_MAX_CHARS);
    // External-content protocol: the search_content row must exist before the
    // fts5 shadow row so fts5 can read columns for snippet() at insert.
    stmts.searchInsertContent.run(rid, title, body);
    stmts.searchInsertFts.run(rid, title, body);
  }
});

function deleteSearchSession(sessionId) {
  // External-content FTS5 protocol: delete from search_fts FIRST while
  // search_content rows still exist (SQLite reads search_content to locate the
  // trigram entries to remove). search_map is deleted last because the rowid
  // sub-select in the two DELETEs above still needs to resolve.
  runWithBusyRetry(() => {
    stmts.searchDeleteBySession.run(sessionId);
    stmts.searchDeleteContentBySession.run(sessionId);
    stmts.searchMapDeleteBySession.run(sessionId);
  });
}

function deleteSearchFolder(folder) {
  // Same external-content ordering: FTS delete before content delete.
  runWithBusyRetry(() => {
    stmts.searchDeleteByFolder.run(folder);
    stmts.searchDeleteContentByFolder.run(folder);
    stmts.searchMapDeleteByFolder.run(folder);
  });
}

function deleteSearchType(type) {
  // Same external-content ordering: FTS delete before content delete.
  runWithBusyRetry(() => {
    stmts.searchDeleteByType.run(type);
    stmts.searchDeleteContentByType.run(type);
    stmts.searchMapDeleteByType.run(type);
  });
}

function upsertSearchEntries(entries) {
  runWithBusyRetry(() => upsertSearchEntriesBatch(entries));
}

function updateSearchTitle(id, type, title) {
  // For an external-content fts5 table, updating search_content is the
  // authoritative change (snippet() reads columns from there). The fts5 index
  // is also patched: delete the old shadow row then re-insert with the new
  // title so trigram search on title reflects the rename immediately.
  try {
    const mapRow = stmts.searchMapLookup.get(id, type);
    if (!mapRow) return;
    const rid = mapRow.rowid;
    const contentRow = stmts.searchContentGet.get(rid);
    if (!contentRow) return;
    runWithBusyRetry(() => {
      // Update the content table first.
      stmts.searchUpdateTitle.run(title, id, type);
      // Patch the fts5 index: external-content delete (old values) + reinsert.
      stmts.searchFtsDeleteRow.run(rid, contentRow.title, contentRow.body);
      stmts.searchFtsInsertRow.run(rid, title, contentRow.body);
    });
  } catch {}
}

function searchByType(type, query, limit = 50, titleOnly = false) {
  try {
    // Cap query length before building the MATCH expression — a long trigram phrase
    // query (e.g. a pasted 60-char URL) can block the SQLite main thread for ~60 s.
    // See FTS_QUERY_MAX_CHARS. Truncate before escaping so the cap counts source chars.
    const bounded = query.slice(0, FTS_QUERY_MAX_CHARS);
    // Wrap in double quotes for exact substring matching with trigram tokenizer.
    // This prevents FTS5 from splitting on punctuation (e.g. "spec.md" → "spec" + "md")
    const escaped = '"' + bounded.replace(/"/g, '""') + '"';
    // FTS5 column filter: prefix with "title:" to restrict match to title column
    const match = titleOnly ? 'title:' + escaped : escaped;
    return stmts.searchQuery.all(type, match, limit);
  } catch {
    return [];
  }
}

function isSearchIndexPopulated() {
  const row = db.prepare('SELECT COUNT(*) as cnt FROM search_map WHERE type = ?').get('session');
  return row.cnt > 0;
}

// --- Settings functions ---

function getSetting(key) {
  const row = stmts.settingsGet.get(key);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

function setSetting(key, value) {
  runWithBusyRetry(() => stmts.settingsUpsert.run(key, JSON.stringify(value)));
}

function deleteSetting(key) {
  runWithBusyRetry(() => stmts.settingsDelete.run(key));
}

function closeDb() {
  // Truncate the WAL back into the main file on clean shutdown. Long-lived
  // reader connections (the scan worker) can starve SQLite's automatic
  // checkpoints, letting the -wal file grow to tens of MB (witnessed: 39 MB)
  // and adding read amplification on every query of the next run.
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
  try { db.close(); } catch {}
}

module.exports = {
  getMeta, getAllMeta, setName, toggleStar, setArchived,
  isCachePopulated, getAllCached, getCachedByFolder, getCachedByParent, getCachedFolder, getCachedSession, upsertCachedSessions, touchCachedModified,
  deleteCachedSession, deleteCachedFolder,
  getFolderMeta, getAllFolderMeta, setFolderMeta,
  upsertSearchEntries, updateSearchTitle, deleteSearchSession, deleteSearchFolder, deleteSearchType,
  searchByType, isSearchIndexPopulated, searchFtsRecreated,
  getSetting, setSetting, deleteSetting,
  closeDb,
};

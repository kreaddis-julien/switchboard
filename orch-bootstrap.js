// orch-bootstrap.js — Switchboard owns its Claude Code customizations.
//
// At app startup (every platform), this installs the Agent Teams asset pack
// into the USER-LEVEL Claude config (~/.claude) so the /sb-* commands
// resolve in every session Switchboard spawns. The global install is
// load-bearing, not a convenience: worker/reviewer sessions run inside git
// worktrees (.switchboard/worktrees/<task>), and a worktree checkout does
// not contain the project's untracked .claude/commands — without the
// user-level copy, `/sb-work` would not resolve there.
//
// Idempotent and cheap: a stamp file records the content hash of the last
// installed pack; files are rewritten only when the pack changed or a file
// went missing. User edits to these files are intentionally overwritten —
// they carry a generated-file header saying so. Project-local installs (at
// run creation) layer on top for visibility in the repo.
//
// The manifest is the extension point for future asset types (MCP server
// configs, workflows, hooks): add entries with a new `type` and a target
// path relative to the claude dir.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const tpl = require('./orch-templates');

let _claudeDirOverride = null;
function setClaudeDirForTesting(dir) { _claudeDirOverride = dir; }
function claudeDir() { return _claudeDirOverride || path.join(os.homedir(), '.claude'); }

const STAMP_RELPATH = path.join('commands', '.sb-agent-pack.json');

function assetManifest() {
  return Object.entries(tpl.COMMANDS).map(([name, content]) => ({
    type: 'command',
    name,
    target: path.join('commands', name),
    content: tpl.renderCommand(content),
  }));
}

function packHash(assets) {
  const h = crypto.createHash('sha256');
  for (const a of assets) h.update(a.target).update('\0').update(a.content).update('\0');
  return h.digest('hex');
}

// Returns { ok, updated, files } — `updated` is false when everything was
// already current (the common startup case).
function ensureClaudeAssets({ log } = {}) {
  const root = claudeDir();
  const assets = assetManifest();
  const hash = packHash(assets);
  const stampFile = path.join(root, STAMP_RELPATH);

  try {
    const stamp = JSON.parse(fs.readFileSync(stampFile, 'utf8'));
    const allPresent = assets.every(a => fs.existsSync(path.join(root, a.target)));
    if (stamp.hash === hash && allPresent) {
      return { ok: true, updated: false, files: assets.map(a => path.join(root, a.target)) };
    }
  } catch {} // missing/corrupt stamp → (re)install

  const files = [];
  try {
    for (const asset of assets) {
      const target = path.join(root, asset.target);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, asset.content);
      files.push(target);
    }
    fs.writeFileSync(stampFile, JSON.stringify({
      hash,
      installedAt: new Date().toISOString(),
      files: assets.map(a => a.target),
    }, null, 2));
    if (log) log.info(`[orch] agent pack installed/refreshed: ${files.length} asset(s) in ${root}`);
    return { ok: true, updated: true, files };
  } catch (err) {
    if (log) log.error(`[orch] agent pack install failed: ${err.message}`);
    return { ok: false, updated: false, error: err.message, files };
  }
}

module.exports = { ensureClaudeAssets, assetManifest, packHash, setClaudeDirForTesting, STAMP_RELPATH };

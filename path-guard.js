const path = require('path');
const os = require('os');
const fs = require('fs');

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');

// Files/paths under the user's home that must never be read or written
// via IPC, even though the containing directory may be otherwise allowed.
// Patterns are checked against the resolved absolute path (case-insensitive
// on win32/darwin).
const DENY_PATTERNS = [
  /[\\/]\.credentials\.json$/i,
  /[\\/]\.ssh([\\/]|$)/i,
  /[\\/]\.aws[\\/]credentials$/i,
  /[\\/]\.netrc$/i,
  /[\\/]\.gnupg([\\/]|$)/i,
  /[\\/]id_rsa(\.pub)?$/i,
  /[\\/]id_ed25519(\.pub)?$/i,
];

function normalizeCase(p) {
  if (process.platform === 'win32' || process.platform === 'darwin') return p.toLowerCase();
  return p;
}

function isWithin(child, parent) {
  if (!child || !parent) return false;
  const rel = path.relative(normalizeCase(parent), normalizeCase(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// The registry of roots callers may read/write under.
// Populate dynamically as projects/sessions are opened.
const allowedRoots = new Set();

function addAllowedRoot(root) {
  if (!root || typeof root !== 'string') return;
  try {
    const abs = path.resolve(root);
    allowedRoots.add(abs);
  } catch {}
}

function removeAllowedRoot(root) {
  if (!root || typeof root !== 'string') return;
  try {
    allowedRoots.delete(path.resolve(root));
  } catch {}
}

function listAllowedRoots() {
  return Array.from(allowedRoots);
}

// Built-in roots that are always allowed (read+write, minus DENY_PATTERNS).
function builtinRoots() {
  return [CLAUDE_DIR];
}

// Returns { ok: true, resolved } on success, or { ok: false, error } on rejection.
// mode is 'read' or 'write' — currently behave the same but reserved for future
// tightening (e.g. read-only roots).
function assertPathAllowed(rawPath, mode = 'read') {
  if (!rawPath || typeof rawPath !== 'string') {
    return { ok: false, error: 'path required' };
  }
  let resolved;
  try {
    resolved = path.resolve(rawPath);
  } catch (e) {
    return { ok: false, error: 'invalid path' };
  }
  for (const pat of DENY_PATTERNS) {
    if (pat.test(resolved)) {
      return { ok: false, error: 'path denied (sensitive location)' };
    }
  }
  const roots = [...builtinRoots(), ...allowedRoots];
  for (const r of roots) {
    if (isWithin(resolved, r)) return { ok: true, resolved, mode };
  }
  return { ok: false, error: 'path outside allowed roots' };
}

module.exports = {
  assertPathAllowed,
  addAllowedRoot,
  removeAllowedRoot,
  listAllowedRoots,
  isWithin,
  CLAUDE_DIR,
  HOME,
  DENY_PATTERNS,
};

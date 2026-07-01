/**
 * Characterization + regression tests for deriveProjectPath().
 *
 * The key invariant: among the (possibly drifting) cwds recorded in a session's
 * JSONL, deriveProjectPath must return the one whose Claude Code folder-encoding
 * matches the project folder name — i.e. the STARTUP cwd that `claude --resume`
 * can actually find the transcript from — not the first-seen nor the most-frequent
 * cwd. Regression guard for the "No conversation found" bug on cd-heavy sessions.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { deriveProjectPath } = require('../derive-project-path');

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-dpp-'));
}
function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// Claude Code encodes a startup cwd into a folder name by replacing "/" and "."
// with "-". Build a project folder + a JSONL whose cwd lines are given verbatim.
function encode(cwd) {
  return cwd.replace(/[/.]/g, '-');
}
function writeSessionWithCwds(projectsDir, folderName, cwds) {
  const folderPath = path.join(projectsDir, folderName);
  fs.mkdirSync(folderPath, { recursive: true });
  const lines = cwds.map(cwd =>
    JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'x' } }));
  fs.writeFileSync(path.join(folderPath, 'session.jsonl'), lines.join('\n') + '\n', 'utf8');
  return folderPath;
}

test('returns the folder-matching cwd, not the first-seen one (cwd drift)', () => {
  const projectsDir = mkTmp();
  try {
    // Mirrors the real 8785f24d bug: first line is a transient cwd, the dominant
    // cwd is a subdir, but the resumable startup cwd is the home folder.
    const startup = path.join(projectsDir, 'home');
    const folderName = encode(startup);
    writeSessionWithCwds(projectsDir, folderName, [
      path.join(startup, '.switchboard'),       // first-seen (transient)
      path.join(startup, 'Documents', 'proj'),  // dominant ...
      path.join(startup, 'Documents', 'proj'),
      path.join(startup, 'Documents', 'proj'),
      startup,                                   // canonical (matches folder)
    ]);
    assert.equal(deriveProjectPath(path.join(projectsDir, folderName), folderName), startup);
  } finally {
    cleanup(projectsDir);
  }
});

test('decodes "." segments via the folder name (e.g. /.claude)', () => {
  const projectsDir = mkTmp();
  try {
    const startup = path.join(projectsDir, '.config', 'app');
    const folderName = encode(startup); // ".config" -> "--config"
    // Add a noisier, more frequent sibling cwd to prove frequency does not win.
    writeSessionWithCwds(projectsDir, folderName, [
      path.join(startup, 'sub'), path.join(startup, 'sub'),
      startup,
    ]);
    assert.equal(deriveProjectPath(path.join(projectsDir, folderName), folderName), startup);
  } finally {
    cleanup(projectsDir);
  }
});

test('falls back to the dominant cwd when no cwd encodes to the folder name', () => {
  const projectsDir = mkTmp();
  try {
    // Folder name does not correspond to any recorded cwd (e.g. moved/renamed) →
    // pick the most frequent cwd rather than the first-seen.
    const folderName = 'totally-unrelated-folder';
    const dominant = path.join(projectsDir, 'real', 'project');
    writeSessionWithCwds(projectsDir, folderName, [
      path.join(projectsDir, 'first', 'seen'),
      dominant, dominant, dominant,
    ]);
    assert.equal(deriveProjectPath(path.join(projectsDir, folderName), folderName), dominant);
  } finally {
    cleanup(projectsDir);
  }
});

test('single-cwd session is unchanged (no encode-match needed)', () => {
  const projectsDir = mkTmp();
  try {
    const folderName = 'proj';                 // arbitrary, no encode-match
    const cwd = path.join(projectsDir, 'somewhere');
    writeSessionWithCwds(projectsDir, folderName, [cwd]);
    assert.equal(deriveProjectPath(path.join(projectsDir, folderName), folderName), cwd);
  } finally {
    cleanup(projectsDir);
  }
});

test('re-attributes a worktree cwd to its parent project', () => {
  const projectsDir = mkTmp();
  try {
    const parent = path.join(projectsDir, 'proj');
    fs.mkdirSync(parent, { recursive: true });
    const worktree = path.join(parent, '.claude', 'worktrees', 'wt-001');
    const folderName = encode(worktree);
    writeSessionWithCwds(projectsDir, folderName, [worktree]);
    // resolveWorktreePath collapses the worktree path back to the parent project.
    assert.equal(deriveProjectPath(path.join(projectsDir, folderName), folderName), parent);
  } finally {
    cleanup(projectsDir);
  }
});

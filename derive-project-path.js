const fs = require('fs');
const path = require('path');

// cwd sits in the first lines, but the leading line(s) (queue-operation /
// attachment entries with pasted content) can be tens of KB, so read a generous
// head rather than just line 1. Fall back to a full read only when the head lacks
// the canonical cwd (rare), so we never regress from "slow but correct" to
// "fast but wrong".
const CWD_HEAD_CAP = 256 * 1024;

// Claude Code buckets transcripts under ~/.claude/projects/<encoded-cwd>/, where
// <encoded-cwd> is the session's STARTUP cwd with every "/" and "." replaced by
// "-" (verified against the on-disk folder names). `claude --resume <id>` only
// finds the transcript when launched from that same startup cwd, so the project
// path we want is the recorded cwd whose encoding matches the folder name — NOT
// merely the first cwd seen (which drifts when the session `cd`s around) nor the
// most frequent one (a busy worktree/subdir can dominate while the resumable
// startup cwd is a minority). We fall back to the dominant cwd only when nothing
// encodes back to the folder (e.g. a renamed/moved folder, or a test fixture).
function encodeProjectFolder(cwd) {
  return cwd.replace(/[/.]/g, '-');
}

// Tally every cwd occurrence in raw JSONL text via regex (far cheaper than
// JSON.parse per line). Returns counts + first-seen order for tie-breaking.
function tallyCwds(text) {
  const re = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  const counts = new Map();
  const firstSeen = new Map();
  let m, order = 0;
  while ((m = re.exec(text)) !== null) {
    const cwd = m[1].replace(/\\(.)/g, '$1'); // unescape \/ \\ \" (Windows backslashes)
    if (!cwd) continue;
    counts.set(cwd, (counts.get(cwd) || 0) + 1);
    if (!firstSeen.has(cwd)) firstSeen.set(cwd, order++);
  }
  return { counts, firstSeen };
}

// Pick the canonical cwd: prefer the one whose folder-encoding matches the folder
// name (the resumable startup cwd); otherwise the most frequent, tie-broken by
// first appearance.
function pickCwd(counts, firstSeen, folderBasename) {
  if (counts.size === 0) return null;
  if (folderBasename) {
    let match = null, matchN = -1;
    for (const [cwd, n] of counts) {
      if (encodeProjectFolder(cwd) === folderBasename && n > matchN) { match = cwd; matchN = n; }
    }
    if (match) return match;
  }
  let best = null, bestN = -1, bestOrder = Infinity;
  for (const [cwd, n] of counts) {
    const order = firstSeen.get(cwd);
    if (n > bestN || (n === bestN && order < bestOrder)) { best = cwd; bestN = n; bestOrder = order; }
  }
  return best;
}

function extractCwdFromJsonl(filePath, folderBasename) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    const readLen = Math.min(size, CWD_HEAD_CAP);
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, 0);
    let text = buf.toString('utf8');
    // Drop a partial last line if we capped before EOF.
    if (size > readLen) {
      const lastNl = text.lastIndexOf('\n');
      if (lastNl !== -1) text = text.slice(0, lastNl);
    }
    let { counts, firstSeen } = tallyCwds(text);
    const headPick = pickCwd(counts, firstSeen, folderBasename);
    // The head already holds the canonical (folder-matching) cwd → done (fast path,
    // the common case since the startup cwd is recorded right at session start).
    if (headPick && folderBasename && encodeProjectFolder(headPick) === folderBasename) {
      return headPick;
    }
    // Otherwise the canonical cwd (or a more representative dominant cwd) may lie
    // deeper — scan the whole file once for a drift-resistant result.
    if (size > readLen) {
      ({ counts, firstSeen } = tallyCwds(fs.readFileSync(filePath, 'utf8')));
      return pickCwd(counts, firstSeen, folderBasename);
    }
    return headPick;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

function resolveWorktreePath(cwd) {
  if (!cwd) return cwd;
  // Detect worktree paths: <project>/.claude-worktrees/<name>, <project>/.worktrees/<name>,
  // or <project>/.claude/worktrees/<name> — re-attributed to the parent project
  // so the worktree's sessions group with it, not a phantom project.
  const worktreeMatch = cwd.match(/^(.+?)\/\.(?:claude\/worktrees|claude-worktrees|worktrees)\/[^/]+\/?$/);
  if (worktreeMatch) {
    const parent = worktreeMatch[1];
    if (fs.existsSync(parent)) return parent;
  }
  return cwd;
}

function deriveProjectPath(folderPath, folderName) {
  // folderName is the Claude Code project folder (e.g. "-Users-me-Documents-proj").
  // Callers pass it; default to the basename so single-arg/test callers still work.
  const folderBasename = folderName || path.basename(folderPath);
  try {
    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    // Check direct .jsonl files first
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.jsonl')) {
        const cwd = extractCwdFromJsonl(path.join(folderPath, e.name), folderBasename);
        if (cwd) return resolveWorktreePath(cwd);
      }
    }
    // Check session subdirectories (UUID folders with subagent .jsonl files)
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const subDir = path.join(folderPath, e.name);
      try {
        const subFiles = fs.readdirSync(subDir, { withFileTypes: true });
        for (const sf of subFiles) {
          let jsonlPath;
          if (sf.isFile() && sf.name.endsWith('.jsonl')) {
            jsonlPath = path.join(subDir, sf.name);
          } else if (sf.isDirectory() && sf.name === 'subagents') {
            const agentFiles = fs.readdirSync(path.join(subDir, 'subagents')).filter(f => f.endsWith('.jsonl'));
            if (agentFiles.length > 0) jsonlPath = path.join(subDir, 'subagents', agentFiles[0]);
          }
          if (jsonlPath) {
            const cwd = extractCwdFromJsonl(jsonlPath, folderBasename);
            if (cwd) return resolveWorktreePath(cwd);
          }
        }
      } catch {}
    }
  } catch {}
  return null;
}

module.exports = { deriveProjectPath, resolveWorktreePath };

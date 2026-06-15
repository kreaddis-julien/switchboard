const fs = require('fs');
const path = require('path');

// cwd sits in the first lines, but the leading line(s) (queue-operation /
// attachment entries with pasted content) can be tens of KB, so read a generous
// head rather than just line 1. Fall back to a full read only if the head has no
// cwd (rare), so we never regress from "slow but correct" to "fast but wrong".
const CWD_HEAD_CAP = 256 * 1024;

function parseCwdFromText(text) {
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed.cwd) return parsed.cwd;
    } catch {}
  }
  return null;
}

function extractCwdFromJsonl(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    const readLen = Math.min(size, CWD_HEAD_CAP);
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, 0);
    let text = buf.toString('utf8');
    // Drop a partial last line if we capped before EOF (JSON.parse would throw on it).
    if (size > readLen) {
      const lastNl = text.lastIndexOf('\n');
      if (lastNl !== -1) text = text.slice(0, lastNl);
    }
    const cwd = parseCwdFromText(text);
    if (cwd) return cwd;
    if (size > readLen) return parseCwdFromText(fs.readFileSync(filePath, 'utf8'));
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

function resolveWorktreePath(cwd) {
  if (!cwd) return cwd;
  // Detect worktree paths: <project>/.claude-worktrees/<name>, <project>/.worktrees/<name>, or <project>/.claude/worktrees/<name>
  const worktreeMatch = cwd.match(/^(.+?)\/\.(?:claude\/worktrees|claude-worktrees|worktrees)\/[^/]+\/?$/);
  if (worktreeMatch) {
    const parent = worktreeMatch[1];
    if (fs.existsSync(parent)) return parent;
  }
  return cwd;
}

function deriveProjectPath(folderPath) {
  try {
    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    // Check direct .jsonl files first
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.jsonl')) {
        const cwd = extractCwdFromJsonl(path.join(folderPath, e.name));
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
            const cwd = extractCwdFromJsonl(jsonlPath);
            if (cwd) return resolveWorktreePath(cwd);
          }
        }
      } catch {}
    }
  } catch {}
  return null;
}

module.exports = { deriveProjectPath, resolveWorktreePath };

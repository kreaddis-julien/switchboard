const path = require('path');
const fs = require('fs');

/** Subagent transcripts land under <folder>/<parentSessionId>/subagents/agent-<agentId>.jsonl.
 *  We surface them as first-class rows with a synthetic sessionId so they're addressable
 *  exactly like top-level sessions (search, archive, rename, etc).
 */
function subagentSessionId(parentSessionId, agentId) {
  return `sub:${parentSessionId}:${agentId}`;
}

/** Resolve the absolute jsonl path for a row from session_cache.
 *  Works for both top-level sessions and subagents. */
function resolveJsonlPath(projectsDir, row) {
  if (!row || !row.folder) return null;
  if (row.parentSessionId && row.agentId) {
    return path.join(projectsDir, row.folder, row.parentSessionId, 'subagents', `agent-${row.agentId}.jsonl`);
  }
  return path.join(projectsDir, row.folder, row.sessionId + '.jsonl');
}

/** Read sidecar { agentType, description } if present. */
function readSubagentMeta(jsonlPath) {
  const metaPath = jsonlPath.replace(/\.jsonl$/, '.meta.json');
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    return null;
  }
}

/** Parse a single .jsonl file into a session object (or null if invalid).
 *  opts.parentSessionId — if set, treat as a subagent transcript and stamp the
 *  parent reference into the returned row.
 */
function readSessionFile(filePath, folder, projectPath, opts = {}) {
  const fileBase = path.basename(filePath, '.jsonl');
  const isSubagent = Boolean(opts.parentSessionId);
  try {
    const stat = fs.statSync(filePath);
    // Cap the scan read at 2 MB: this parse only needs early entries (slug, title,
    // first user message, the first ~8 KB of text for search). Reading a multi-MB
    // transcript fully into memory for every file during a scan can OOM/crash.
    // The viewer (read-session-jsonl) still reads the whole file on demand.
    const SCAN_READ_CAP = 2 * 1024 * 1024;
    let content;
    if (stat.size > SCAN_READ_CAP) {
      const fd = fs.openSync(filePath, 'r');
      try {
        const buf = Buffer.allocUnsafe(SCAN_READ_CAP);
        const bytes = fs.readSync(fd, buf, 0, SCAN_READ_CAP, 0);
        content = buf.toString('utf8', 0, bytes);
        // Drop the last (possibly truncated) line so we never parse a partial entry.
        const lastNl = content.lastIndexOf('\n');
        if (lastNl > 0) content = content.slice(0, lastNl);
      } finally {
        fs.closeSync(fd);
      }
    } else {
      content = fs.readFileSync(filePath, 'utf8');
    }
    const lines = content.split('\n').filter(Boolean);
    let summary = '';
    let messageCount = 0;
    let textContent = '';
    let slug = null;
    let customTitle = null;
    let aiTitle = null;
    let agentId = null;
    let sidechainSeen = false;
    // Token/usage metrics (analytics). Tokens summed from each assistant line's
    // message.usage; tool calls / subagent (Task) invocations from tool_use blocks.
    let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheCreationTokens = 0;
    let toolCalls = 0, subagentInvocations = 0, model = null;
    for (const line of lines) {
      // Per-line try/catch: a JSONL file being written concurrently by a live
      // Claude CLI session can have its tail captured mid-write — one truncated
      // line should not invalidate the whole file. Skip the malformed line and
      // keep parsing.
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.slug && !slug) slug = entry.slug;
      if (entry.agentId && !agentId) agentId = entry.agentId;
      if (entry.isSidechain) sidechainSeen = true;
      if (entry.type === 'custom-title' && entry.customTitle) {
        customTitle = entry.customTitle;
      }
      if (entry.type === 'ai-title' && entry.aiTitle) {
        aiTitle = entry.aiTitle;
      }
      if (entry.type === 'user' || entry.type === 'assistant' ||
          (entry.type === 'message' && (entry.role === 'user' || entry.role === 'assistant'))) {
        messageCount++;
      }
      const msg = entry.message;
      const text = typeof msg === 'string' ? msg :
        (typeof msg?.content === 'string' ? msg.content :
        (msg?.content?.[0]?.text || ''));
      // Analytics: accumulate usage/model/tool metrics from assistant turns.
      if (entry.type === 'assistant' || (entry.type === 'message' && entry.role === 'assistant')) {
        const u = msg && msg.usage;
        if (u) {
          inputTokens += u.input_tokens || 0;
          outputTokens += u.output_tokens || 0;
          cacheReadTokens += u.cache_read_input_tokens || 0;
          cacheCreationTokens += u.cache_creation_input_tokens || 0;
        }
        if (msg && msg.model && !model) model = msg.model;
      }
      if (msg && Array.isArray(msg.content)) {
        for (const b of msg.content) {
          if (b && b.type === 'tool_use') { toolCalls++; if (b.name === 'Task') subagentInvocations++; }
        }
      }
      if (!summary && (entry.type === 'user' || (entry.type === 'message' && entry.role === 'user'))) {
        // Skip local command messages (! prefix) — use the next real user message
        if (text && !/<bash-input>|<bash-stdout>|<local-command-caveat>/.test(text)) {
          // Use scheduled task name if present
          const taskMatch = text.match(/<scheduled-task\s+name="([^"]+)"/);
          summary = taskMatch ? 'Scheduled: ' + taskMatch[1] : text.slice(0, 120);
        }
      }
      if (text && textContent.length < 8000) {
        textContent += text.slice(0, 500) + '\n';
      }
    }

    // Titles (custom-title from /rename, ai-title from Claude) are appended near
    // the END of the file. On files larger than the scan cap the head-only read
    // above misses a fresh rename, leaving a stale name in the sidebar. Scan a
    // bounded tail window for the latest title and override. Cheap: only lines
    // containing a title marker are parsed.
    if (stat.size > SCAN_READ_CAP) {
      try {
        const TAIL_CAP = 512 * 1024;
        const start = Math.max(SCAN_READ_CAP, stat.size - TAIL_CAP);
        const fd = fs.openSync(filePath, 'r');
        try {
          const tlen = stat.size - start;
          const tbuf = Buffer.allocUnsafe(tlen);
          const tb = fs.readSync(fd, tbuf, 0, tlen, start);
          let tail = tbuf.toString('utf8', 0, tb);
          const firstNl = tail.indexOf('\n');
          if (firstNl >= 0) tail = tail.slice(firstNl + 1); // drop leading partial line
          for (const line of tail.split('\n')) {
            if (line.indexOf('custom-title') === -1 && line.indexOf('ai-title') === -1) continue;
            let e; try { e = JSON.parse(line); } catch { continue; }
            if (e.type === 'custom-title' && e.customTitle) customTitle = e.customTitle;
            else if (e.type === 'ai-title' && e.aiTitle) aiTitle = e.aiTitle;
          }
        } finally { fs.closeSync(fd); }
      } catch { /* best-effort: a stale title is better than crashing the scan */ }
    }

    if (!summary || messageCount < 1) return null;

    if (isSubagent) {
      // Sidechain marker must be present — otherwise the file lives under a
      // subagents/ directory but isn't actually a subagent transcript. Bail.
      if (!sidechainSeen) return null;
      if (!agentId) {
        // Fall back to filename: agent-<id>.jsonl
        const m = fileBase.match(/^agent-(.+)$/);
        if (m) agentId = m[1];
      }
      if (!agentId) return null;
      const meta = readSubagentMeta(filePath) || {};
      const subagentType = meta.agentType || null;
      const description = meta.description || null;
      return {
        sessionId: subagentSessionId(opts.parentSessionId, agentId),
        folder, projectPath,
        summary: description || summary,
        firstPrompt: summary,
        created: stat.birthtime.toISOString(),
        modified: stat.mtime.toISOString(),
        messageCount, textContent, slug, customTitle, aiTitle,
      inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, toolCalls, subagentInvocations, model,
        parentSessionId: opts.parentSessionId,
        agentId,
        subagentType,
        description,
      };
    }

    return {
      sessionId: fileBase, folder, projectPath,
      summary, firstPrompt: summary,
      created: stat.birthtime.toISOString(),
      modified: stat.mtime.toISOString(),
      messageCount, textContent, slug, customTitle, aiTitle,
      inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, toolCalls, subagentInvocations, model,
    };
  } catch {
    return null;
  }
}

/** Enumerate every jsonl in a project folder: top-level sessions plus any
 *  subagent transcripts under <folder>/<parentSessionId>/subagents/*.jsonl
 *  (or directly under <folder>/<parentSessionId>/*.jsonl for legacy layouts).
 *  Returns [{ filePath, sessionId, parentSessionId|null }]. */
function enumerateSessionFiles(folderPath) {
  const out = [];
  let topEntries;
  try {
    topEntries = fs.readdirSync(folderPath, { withFileTypes: true });
  } catch { return out; }

  // Top-level .jsonl files = ordinary sessions
  for (const e of topEntries) {
    if (e.isFile() && e.name.endsWith('.jsonl')) {
      out.push({
        filePath: path.join(folderPath, e.name),
        sessionId: path.basename(e.name, '.jsonl'),
        parentSessionId: null,
      });
    }
  }

  // UUID subdirs may hold subagent transcripts
  for (const e of topEntries) {
    if (!e.isDirectory()) continue;
    const parentSessionId = e.name;
    const subDir = path.join(folderPath, parentSessionId);
    // Preferred layout: subagents/ subfolder
    const subagentsDir = path.join(subDir, 'subagents');
    try {
      if (fs.statSync(subagentsDir).isDirectory()) {
        for (const f of fs.readdirSync(subagentsDir)) {
          if (!f.endsWith('.jsonl')) continue;
          out.push({
            filePath: path.join(subagentsDir, f),
            sessionId: path.basename(f, '.jsonl'),
            parentSessionId,
          });
        }
        continue;
      }
    } catch {}
    // Fallback: jsonl directly in the UUID dir (older CLI versions)
    try {
      for (const f of fs.readdirSync(subDir)) {
        if (!f.endsWith('.jsonl')) continue;
        out.push({
          filePath: path.join(subDir, f),
          sessionId: path.basename(f, '.jsonl'),
          parentSessionId,
        });
      }
    } catch {}
  }

  return out;
}

/** Lightweight refresh path. Reads only the first ~256 KB / 500 lines of a
 *  jsonl file to extract display-level metadata (summary, slug, titles,
 *  agentId). Does NOT compute textContent or messageCount — the caller is
 *  expected to merge with the cached row for unchanged fields. Designed so
 *  the fs.watch flush can update a live 200+ MB host-session JSONL in ~ms
 *  instead of seconds.
 *
 *  Returns the same shape as the display subset of readSessionFile() so it
 *  can be merged into a cached row before upsert. Returns null if the chunk
 *  doesn't yet contain a usable first-user-message.
 */
function readSessionDisplayHeader(filePath, opts = {}) {
  const fileBase = path.basename(filePath, '.jsonl');
  const isSubagent = Boolean(opts.parentSessionId);
  const MAX_BYTES = 256 * 1024;
  const MAX_LINES = 500;
  try {
    const stat = fs.statSync(filePath);
    const readLen = Math.min(MAX_BYTES, stat.size);
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(readLen);
    const n = fs.readSync(fd, buf, 0, readLen, 0);
    fs.closeSync(fd);
    const text = buf.toString('utf8', 0, n);
    const lines = text.split('\n');
    // Drop the potentially-partial last line unless we read the whole file
    if (n < stat.size) lines.pop();

    let summary = '';
    let slug = null, customTitle = null, aiTitle = null, agentId = null;
    let sidechainSeen = false;
    let lineCount = 0;
    for (const line of lines) {
      if (!line) continue;
      if (++lineCount > MAX_LINES) break;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.slug && !slug) slug = entry.slug;
      if (entry.agentId && !agentId) agentId = entry.agentId;
      if (entry.isSidechain) sidechainSeen = true;
      if (entry.type === 'custom-title' && entry.customTitle && !customTitle) customTitle = entry.customTitle;
      if (entry.type === 'ai-title' && entry.aiTitle && !aiTitle) aiTitle = entry.aiTitle;
      const msg = entry.message;
      const txt = typeof msg === 'string' ? msg :
        (typeof msg?.content === 'string' ? msg.content :
        (msg?.content?.[0]?.text || ''));
      if (!summary && (entry.type === 'user' || (entry.type === 'message' && entry.role === 'user'))) {
        if (txt && !/<bash-input>|<bash-stdout>|<local-command-caveat>/.test(txt)) {
          const taskMatch = txt.match(/<scheduled-task\s+name="([^"]+)"/);
          summary = taskMatch ? 'Scheduled: ' + taskMatch[1] : txt.slice(0, 120);
        }
      }
    }

    if (!summary) return null;

    if (isSubagent) {
      if (!sidechainSeen) return null;
      if (!agentId) {
        const m = fileBase.match(/^agent-(.+)$/);
        if (m) agentId = m[1];
      }
      if (!agentId) return null;
      const meta = readSubagentMeta(filePath) || {};
      return {
        sessionId: subagentSessionId(opts.parentSessionId, agentId),
        summary: meta.description || summary,
        firstPrompt: summary,
        modified: stat.mtime.toISOString(),
        slug, customTitle, aiTitle,
        parentSessionId: opts.parentSessionId,
        agentId,
        subagentType: meta.agentType || null,
        description: meta.description || null,
      };
    }

    return {
      sessionId: fileBase,
      summary, firstPrompt: summary,
      modified: stat.mtime.toISOString(),
      slug, customTitle, aiTitle,
    };
  } catch {
    return null;
  }
}

module.exports = { readSessionFile, readSessionDisplayHeader, subagentSessionId, resolveJsonlPath, readSubagentMeta, enumerateSessionFiles };

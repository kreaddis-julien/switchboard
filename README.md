# Switchboard

**Your command center for Claude Code sessions** — a unified view of every Claude Code session across all your projects. Launch, resume, fork, and monitor sessions from a single window, no more juggling terminal tabs or digging through `~/.claude/projects`.

> **Personal fork** of [doctly/switchboard](https://github.com/doctly/switchboard) — a full **shadcn/ui-inspired redesign** (Geist font, Claude-orange accent), a **performance pass** (DB ~5× smaller, bounded renderer memory, no main-process freezes), **configurable shortcuts**, a **bilingual EN/FR interface**, and a curated set of upstream PRs merged in. There are **no prebuilt releases** for this fork — you [build it from source](#install-build-from-source) (it takes a couple of minutes). Auto-update is intentionally disabled so a local build is never overwritten by an upstream release.

## Contents

- [Install (build from source)](#install-build-from-source)
- [What this fork adds](#what-this-fork-adds)
- [Features](#features)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Development](#development)
- [Building](#building)
- [Updating from upstream](#updating-from-upstream)
- [Project structure](#project-structure)

## Install (build from source)

**Prerequisites:** Node.js 20+, npm 10+, and platform build tools for the native modules (`better-sqlite3`, `node-pty`):
- **macOS** — Xcode Command Line Tools: `xcode-select --install`
- **Linux** — `sudo apt install build-essential python3`
- **Windows** — Visual Studio Build Tools

**macOS:**

```bash
git clone https://github.com/kreaddis-julien/switchboard
cd switchboard
npm install                 # compiles the native modules
npm run build:mac:arm64     # Apple Silicon only (fastest); use build:mac for a universal build
ditto "dist/mac-arm64/Switchboard.app" /Applications/Switchboard.app
rm -rf dist                 # optional: avoids extra copies Spotlight would index
```

The local build is **ad-hoc signed with no quarantine**, so it opens without Gatekeeper prompts (unlike a downloaded, un-notarized build). On Intel, use `npm run build:mac` and copy `dist/mac/Switchboard.app`.

For Windows/Linux, see [Building](#building).

## What this fork adds

**Design (shadcn/ui + Geist)**
- Full **graphic redesign** following [shadcn/ui](https://ui.shadcn.com/): semantic **oklch** color tokens, the **Geist** / Geist Mono typeface (self-hosted), and the **Claude orange** (`#d97757`) accent. Sidebar, headers, conversation viewer, empty states, status bar and dialogs all rebuilt; xterm gets matching light/dark palettes.
- Light / Dark / **Auto** appearance (Auto follows the macOS system appearance) — Settings → General.
- **Status colors** keep a Catppuccin base (running / attention / error / warning) so state stays legible on both themes; the terminal theme **"Auto (match app)"** tracks the app appearance.
- **Custom app icon** — a "switchboard" hub wired to session nodes on a graphite, Terminal-like squircle.
- **Subtly recessed sidebar** — the sidebar panel sits a hair off the main content (a touch greyer in light, slightly darker in dark) for a calm content/navigation separation.

**Interface language (i18n)**
- **Full English / French interface** — every view is localized (sidebar, settings, dialogs, status bar, relative timestamps, and the **native macOS menu**). Switch in **Settings → General → Language**; the default is English. Changing it reloads the window so everything re-renders translated.
- Built on a tiny in-house layer (`public/i18n.js`, `t('key')` + `en`/`fr` dictionaries, no dependency); strings are keyed and English is the source of truth, so a missing translation falls back to English rather than going blank.

**Performance** *(ported from [JeanBaptisteRenard](https://github.com/JeanBaptisteRenard/switchboard))*
- **DB ~5× smaller** — contentless FTS5 index + 32 KB body truncation (+ a one-time `VACUUM` migration), plus `synchronous=NORMAL` and a WAL checkpoint on close.
- **No main-process freezes on big histories** — the watcher does an **O(1) targeted refresh** (only re-stats changed files) and a **header-only read** for already-cached sessions, instead of re-reading 200 MB+ live JSONLs on every flush.
- **Bounded renderer memory** — an **LRU cap** on live xterm instances, **WebGL-context virtualization** for off-screen grid cards, differentiated scrollback, and a **~30 fps write-flush cap** during streaming.
- **Faster cold start** — CodeMirror's 1.66 MB bundle is **lazy-loaded** on first viewer/diff open; an FTS dirty-flag skips re-indexing memory on tab switches; the sidebar skips idle DOM rescans.

**Settings**
- **Redesigned panel** with a left **category nav** (General / Notifications / Sessions / Sidebar / Toolbar / Claude CLI / About) and **auto-save** — changes apply and persist on the fly, no Save button.
- **Configurable toolbar** — choose, per action (pin, running, overview, collapse-all, bookmarks, today, archive, re-sort, add-project), whether it sits in the sidebar toolbar or behind the **"more" (⋯)** popover, and **drag to reorder** them (Settings → Toolbar).
- **Auto-update disabled** — this fork builds locally from its own repo (no releases), and the upstream feed would otherwise surface upstream builds as "updates" and overwrite the fork, so the update check is removed.

**Notifications & performance**
- **Sound notifications** (on by default) — a chime when a non-focused session finishes a run, a more insistent two-tone when one needs attention/permission (synthesized via Web Audio, no assets). Addresses upstream [#66](https://github.com/doctly/switchboard/issues/66).
- **System notifications** (on by default) — a native macOS Notification Center alert (click → focus that session) plus a **dock badge** counting sessions that need attention.
- **Lower idle CPU** — persistent `infinite` sidebar/grid animations replaced with static equivalents (the transient busy spinner is kept). Addresses upstream [#39](https://github.com/doctly/switchboard/issues/39).

**Navigation**
- **Command palette** (`⌘K`) — fuzzy quick-switch to any session by name or project.
- **Bookmarks** (`⌘B`) — flag any message in a transcript, then jump back to it from the bookmarks list.
- **Session tags** — label sessions (Tags action in the ⋯ menu); colored chips show in the sidebar.

**Stats & transcript**
- **Token analytics** — a "Token usage" section in the Stats tab: total input/output/cache tokens, tool-call and subagent-invocation counts, and a **per-model breakdown** (parsed from the session JSONL, which Claude's `/stats` doesn't surface).
- **Cleaner transcript viewer** — Claude's internal XML (`<system-reminder>`, slash-command / hook wrappers) is stripped from message bodies, and each bubble gets a subtle 24h timestamp.

**Sidebar & UI**
- Session actions live behind a **"⋯" menu** (floating dropdown) instead of a hover overlay — no accidental stop/fork on a mis-hover.
- **Project actions** likewise live behind a per-project **"⋯" menu** (New session / Scheduled task / Project settings / Archive sessions) instead of a row of inline icons.
- **Settings** opens from the **native macOS menu** (`⌘,`); the in-UI gear is removed.
- **Subagent transcripts** are nested under their parent via an **"N subsessions"** toggle instead of cluttering the list as peers — and can be **hidden entirely** (Settings → Sidebar → Show Subagent Sessions). Clicking one opens its transcript read-only (read via the correct `subagents/agent-*.jsonl` path). Worktree sessions are re-attributed to the parent project instead of a phantom one.
- **Read a transcript without attaching** — clicking a session opens it normally (attaches/focuses its terminal); to inspect a dormant session's transcript read-only, use **"View messages"** in the **"⋯" menu**. Subagent sessions, which aren't resumable, always open read-only. Relates to upstream [#25](https://github.com/doctly/switchboard/issues/25).
- **Collapse / expand all projects** button; per-tab visibility (Plans / Agent Files / Stats).
- **Manual refresh** — a rescan button in the sidebar toolbar (inside the "⋯ more" menu by default; pin it to the visible row via Settings) forces a full re-index and **prunes ghost rows** for sessions or whole project folders deleted on disk, then refreshes the search index.
- **Delete a session** — a **"Delete session"** action in the ⋯ menu permanently removes a session's transcript (`<id>.jsonl` + its subagent/workflow sidecar dir) and cache rows, after an in-app confirmation. Refuses while the session is running (stop it first). Distinct from Archive, which just hides it.
- **Hide a folder** from the sidebar (project gear → Hide Project) and **restore it** from a managed list (Settings → Sidebar → Hidden folders) — distinct from Archive, which acts on sessions.
- **Project groups** — assign a project to a named group (project settings → Group); the sidebar renders grouped projects under a labeled divider.
- **Relocate a moved project** ([#35](https://github.com/doctly/switchboard/pull/35)) — a project whose folder no longer exists shows a "!" badge; "Relocate…" in project settings points it at the new path.

**Behavior & robustness fixes**
- Session overview removes a session's card when you stop it; archiving a session tears down its open/pending instance so a mis-forked session actually disappears.
- **Scan reads capped at 2 MB** so a huge `.jsonl` can't OOM the cache scan (the viewer still loads the full file on demand). *(ported from [folknor](https://github.com/folknor/switchboard))*
- **Throttled cache↔filesystem reconcile** — the sidebar paints with two `get-projects` calls, so the on-disk reconcile sweep is throttled (1 s) to run once per paint instead of twice. *(ported from [JeanBaptisteRenard](https://github.com/JeanBaptisteRenard/switchboard))*
- **WebGL ghost-glyph fix** — revealing a terminal (session switch, grid↔single toggle) now clears the WebGL texture atlas and forces a full repaint, so stale glyphs no longer linger as ghosts. *(adapted from upstream [#63](https://github.com/doctly/switchboard/pull/63))*
- **Sessions launched from inside a Claude Code session now persist** — `cleanPtyEnv` strips inherited `CLAUDE_CODE_*` vars (notably `CLAUDE_CODE_SESSION_ID` / `_CHILD_SESSION` / `_FORK_SUBAGENT`) that otherwise made every spawned `claude` run as a non-persisting *child* session: no transcript file on disk, so the session stayed stuck on "New session" and `/rename` was never reflected.
- **MCP diff can't hang the CLI** — `openDiff` now resolves a superseded or abandoned diff (overwrite resolves the prior diff, plus a timeout and resolve-on-send-failure), so a Claude Edit can't block forever waiting on a tab that was replaced or never answered.
- **Defense-in-depth hardening** — renderer `sandbox: true`; transcript markdown routed through DOMPurify (matching the other viewers); `save-plan` path guard tightened (trailing-separator prefix match + `.md` only); per-file viewer watcher gets an `error` handler so an OS watch failure can't crash the main process.
- **A UI rename is never overwritten by a JSONL title** — `session_meta.name` records its source (`user` vs Claude `/rename`), so a re-index promotes a JSONL custom-title only when you haven't renamed the session yourself, while a fresh CLI `/rename` still refreshes a CLI-sourced name.
- **Scheduler cron fixes** — POSIX day-of-month/day-of-week **OR** semantics when both are set; `enabled:` now honors `false` / `no` / `0` / `off` (not just the exact string `false`); `*/0` is rejected and `dow=7` matches Sunday. Failed scheduled runs now surface a notification + status line instead of failing silently.
- **Toolbar & icon polish** — the collapse button no longer strands itself mid-row when toolbar icons are hidden; the re-sort icon is now distinct from the refresh icon; the rescan button is styled like its neighbours. The pre-paint theme bootstrap moved to an external `early-theme.js` so it isn't blocked by the strict CSP (no more theme flash).

**Curated upstream PRs merged in**
- Security: [#32](https://github.com/doctly/switchboard/pull/32) (shell-injection → argv arrays), [#27](https://github.com/doctly/switchboard/pull/27) (XSS sanitization + CSP + IPC path guards, partial).
- Robustness: [#56](https://github.com/doctly/switchboard/pull/56) (single-instance lock), [#60](https://github.com/doctly/switchboard/pull/60) (cache ↔ filesystem reconcile), [#61](https://github.com/doctly/switchboard/pull/61) (dedupe external-link open), [#62](https://github.com/doctly/switchboard/pull/62) (resume-attach fix), [#58](https://github.com/doctly/switchboard/pull/58) (terminal exit banner).
- Performance: [#64](https://github.com/doctly/switchboard/pull/64) (adaptive session polling), [#65](https://github.com/doctly/switchboard/pull/65) (scheduler via cache).
- Features: [#47](https://github.com/doctly/switchboard/pull/47) (searchable / inline subagent transcripts), [#49](https://github.com/doctly/switchboard/pull/49) (delete-worktree action, slice).

## Features

- **Session browser** — every session, organized by project, searchable by content.
- **Built-in terminal** — connect to running sessions or launch new ones without leaving the app.
- **Fork & resume** — branch off from any point in a session's history.
- **Full-text search** — find a session by what was discussed, not just when.
- **Session names** — picked up automatically from Claude Code's `/rename`.
- **Plans & memory** — browse and edit plan files and `CLAUDE.md` in one place.
- **Activity stats** — a heatmap of coding activity across all projects.

### Session grid overview

Toggle the grid for a bird's-eye view of all open sessions at once, grouped by project.

Every open session renders its full terminal in a card, with a running/busy/stopped dot and last-activity time — monitor several Claude agents simultaneously. Click a card header to focus it, double-click to expand to single-terminal view. The preference persists across restarts.

### IDE emulation & file preview

When enabled, Claude's file opens and proposed edits appear in a side panel instead of going to an external editor.

Review diffs inline or side-by-side, accept/reject individual chunks, and open OSC 8 file links with syntax highlighting. Disable **IDE Emulation** in Settings to let Claude use your own editor (VS Code, Cursor, …) instead — applies to new sessions.

### Status notifications

Switchboard watches every session in the background and surfaces status in the sidebar so you can tell at a glance which one needs you — even from another session.

Highlights sessions waiting for input or blocked on a permission grant, and shows which are running, idle, or finished. Pairs with the sound + system notifications this fork adds.

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `⌘K` / `Ctrl+K` | Command palette — jump to any session |
| `⌘B` / `Ctrl+B` | Bookmarks |
| `⌘,` | Open Settings |
| `⌘F` / `Ctrl+F` | Find in file (also works in the terminal) |
| `⌘G` / `Ctrl+G` | Go to line |
| `⌘/Ctrl+Shift+←/→/↑/↓` | Navigate sessions / grid cells *(configurable)* |
| `⌘/Ctrl+Shift+[` / `]` | Previous / next session *(configurable)* |
| `⌘/Ctrl+Shift+G` | Toggle grid overview *(configurable)* |

The session-navigation shortcuts are **re-bindable** (Settings → General → Keyboard Shortcuts; click a shortcut, press the new combo). They default to `Shift+` modifiers so plain `Ctrl+←/→` stays free for the terminal's word-jump. *(ported from [JeanBaptisteRenard](https://github.com/JeanBaptisteRenard/switchboard))*

## Development

```bash
npm install     # runs the native-module postinstall automatically
npm start       # bundles CodeMirror, then launches Electron
npm run electron # faster iteration after the first run (skips the bundle step)
```

## Building

Each build command bundles CodeMirror first, then runs electron-builder. Output goes to `dist/`.

```bash
npm run build           # current platform
npm run build:mac       # macOS, universal (arm64 + x64)
npm run build:mac:arm64 # macOS, Apple Silicon only (fastest)
npm run build:win       # Windows NSIS installer (x64 + arm64)
npm run build:linux     # Linux AppImage + deb (x64 + arm64)
```

The macOS build is **ad-hoc signed** (`codesign --sign -`) and **not notarized** — fine for personal/local use. The custom entitlements (`build/entitlements.mac.plist`) allow JIT and unsigned memory execution, required by `node-pty` and `better-sqlite3`. For real distribution signing, set `CSC_LINK` / `CSC_KEY_PASSWORD` (or sign via Keychain), or `CSC_IDENTITY_AUTO_DISCOVERY=false` to skip.

## Updating from upstream

```bash
git remote add upstream https://github.com/doctly/switchboard.git   # once
git fetch upstream && git rebase upstream/main
```

The fork's look now lives **hand-maintained** in `public/style.css` — a shadcn/ui token system (oklch primitives + Geist + Claude-orange accent) at the top of the file, with the historical `--c-*` variables remapped onto it. On a `public/style.css` conflict, reconcile by hand, keeping that token block.

> The `scripts/apply-light-theme.py` / `scripts/apply-catppuccin.py` scripts are **legacy** (pre-redesign) — running them would re-apply the old Catppuccin palette and undo the shadcn redesign. Don't use them unless you're intentionally reverting the design.

## Project structure

```
main.js            Electron main process (IPC, windows, sessions, native menu)
preload.js         Context bridge (IPC bindings)
db.js              SQLite session cache & metadata (contentless FTS5)
read-session-file.js   .jsonl session parsing (scan)
public/            Renderer (HTML/CSS/JS) — sidebar, terminals, settings, viewers
  i18n.js              EN/FR localization layer (t() + dictionaries, loaded first)
  app.js               app wiring, toolbar layout, notifications
  settings-panel.js    settings UI (category nav + auto-save)
  bookmarks-tags.js    transcript bookmarks + session tags
  command-palette.js   ⌘K quick switcher
scripts/           build, icon generation, theming scripts
build/             icons, entitlements, builder resources
```

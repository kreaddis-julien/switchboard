// profiles.js — Claude session profiles: per-profile env var overrides
//
// A profile is a named bundle of environment variables that get merged into
// a session's pty env at spawn time. Values can be either:
//   - literal strings (e.g. "https://api.anthropic.com")
//   - references to system environment variables: "$ANTHROPIC_API_KEY"
//     or "${ANTHROPIC_API_KEY}". Unresolved refs are dropped (not passed
//     through as the literal string), so secrets never leak into the
//     command line if the host env var is missing.
//
// Persistence: <userData>/profiles.json. Plain JSON (no encryption) since
// values are either literals or *references*; actual secrets stay in the
// host process env. Atomic write via tmp+rename.
//
// FORK (agent-teams): data-egress guard. When the external-models opt-out is
// OFF (default), a profile whose resolved ANTHROPIC_BASE_URL points anywhere
// other than api.anthropic.com or a loopback address is REFUSED at save time,
// so a worker profile can never silently exfiltrate to a third-party host.
// See docs/agent-teams-spec.md §2.

const fs = require('fs');
const path = require('path');

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_REF_RE = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ICON_KEY_RE = /^[a-z][a-z0-9_-]{0,32}$/;
const MAX_PROFILES = 32;
const MAX_ENV_VARS = 64;
const MAX_VALUE_LEN = 4096;

let _profilesPathOverride = null;

function setProfilesPathForTesting(p) { _profilesPathOverride = p; }

function profilesPath() {
  if (_profilesPathOverride) return _profilesPathOverride;
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'profiles.json');
}

function isPlainObject(o) {
  return o !== null && typeof o === 'object' && !Array.isArray(o);
}

function isValidProfile(p) {
  if (!isPlainObject(p)) return false;
  if (typeof p.id !== 'string' || !ID_RE.test(p.id)) return false;
  if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 100) return false;
  if (!isPlainObject(p.env)) return false;
  const keys = Object.keys(p.env);
  if (keys.length > MAX_ENV_VARS) return false;
  for (const k of keys) {
    if (!ENV_NAME_RE.test(k)) return false;
    const v = p.env[k];
    if (typeof v !== 'string' || v.length > MAX_VALUE_LEN) return false;
  }
  if (p.icon !== undefined && p.icon !== null && p.icon !== '') {
    if (typeof p.icon !== 'string' || !ICON_KEY_RE.test(p.icon)) return false;
  }
  return true;
}

function emptyState() { return { profiles: [], defaultProfileId: null }; }

function loadProfiles() {
  try {
    const raw = fs.readFileSync(profilesPath(), 'utf8');
    const data = JSON.parse(raw);
    if (!isPlainObject(data)) return emptyState();
    const profiles = Array.isArray(data.profiles)
      ? data.profiles.filter(isValidProfile).slice(0, MAX_PROFILES)
      : [];
    const defaultProfileId = (typeof data.defaultProfileId === 'string'
      && profiles.find(p => p.id === data.defaultProfileId))
      ? data.defaultProfileId
      : null;
    return { profiles, defaultProfileId };
  } catch {
    return emptyState();
  }
}

function saveProfiles(state) {
  const target = profilesPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, target);
}

// Resolve a profile's env map: substitute $VAR / ${VAR} references against
// processEnv (defaults to process.env). Unresolved refs are DROPPED.
function resolveEnv(envMap, processEnv) {
  const env = processEnv || process.env;
  const out = {};
  if (!isPlainObject(envMap)) return out;
  for (const [k, v] of Object.entries(envMap)) {
    if (typeof v !== 'string') continue;
    const m = ENV_REF_RE.exec(v);
    if (m) {
      const refName = m[1] || m[2];
      const resolved = env[refName];
      if (typeof resolved === 'string' && resolved.length > 0) {
        out[k] = resolved;
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}

// --- Data-egress guard ------------------------------------------------------
// A host is allowed iff it is Anthropic's API or a loopback address (a local
// Anthropic-compat shim in front of Ollama/LM Studio). Everything else is a
// third-party endpoint the user must explicitly opt into.
function isAllowedHost(hostname) {
  if (!hostname) return true; // no host → default Anthropic endpoint
  const h = hostname.toLowerCase();
  if (h === 'api.anthropic.com' || h.endsWith('.anthropic.com')) return true;
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]') return true;
  // Any 127.x.x.x loopback
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return false;
}

// Returns true if the profile's resolved ANTHROPIC_BASE_URL is Anthropic or
// loopback (or absent). Checks the value that will actually be used at spawn
// (refs resolved against processEnv).
function profileEndpointAllowed(profile, processEnv) {
  const env = resolveEnv(profile && profile.env, processEnv);
  const base = env.ANTHROPIC_BASE_URL;
  if (!base) return true;
  try {
    return isAllowedHost(new URL(base).hostname);
  } catch {
    // Unparseable BASE_URL → treat as disallowed (fail closed).
    return false;
  }
}

function getProfileById(id) {
  if (typeof id !== 'string' || !id) return null;
  const { profiles } = loadProfiles();
  return profiles.find(p => p.id === id) || null;
}

function getDefaultProfile() {
  const { profiles, defaultProfileId } = loadProfiles();
  if (!defaultProfileId) return null;
  return profiles.find(p => p.id === defaultProfileId) || null;
}

function pickProfileForSession(profileId) {
  if (profileId === 'none') return null;
  if (profileId) return getProfileById(profileId);
  return getDefaultProfile();
}

// init(log, getAllowExternal): getAllowExternal() returns the current value of
// the global `agentTeamsAllowExternalModels` setting (default false when not
// provided — secure by default).
function init(log, getAllowExternal) {
  const { ipcMain } = require('electron');
  const allowExternal = () => {
    try { return typeof getAllowExternal === 'function' ? !!getAllowExternal() : false; }
    catch { return false; }
  };

  ipcMain.handle('profiles:list', () => loadProfiles());

  ipcMain.handle('profiles:save', (_e, profile) => {
    if (!isValidProfile(profile)) return { ok: false, error: 'invalid profile' };
    // Data-egress guard: refuse third-party endpoints unless explicitly allowed.
    if (!allowExternal() && !profileEndpointAllowed(profile)) {
      return {
        ok: false,
        error: 'Endpoint not allowed: ANTHROPIC_BASE_URL must be api.anthropic.com or a loopback address. ' +
          'Enable "Allow external models" in Agent Teams settings to override (your data may leave the machine).',
      };
    }
    const state = loadProfiles();
    const idx = state.profiles.findIndex(p => p.id === profile.id);
    if (idx >= 0) {
      state.profiles[idx] = profile;
    } else {
      if (state.profiles.length >= MAX_PROFILES) {
        return { ok: false, error: `max ${MAX_PROFILES} profiles` };
      }
      state.profiles.push(profile);
    }
    saveProfiles(state);
    if (log) log.info(`[profiles] Saved profile "${profile.name}" (${profile.id})`);
    return { ok: true };
  });

  ipcMain.handle('profiles:delete', (_e, id) => {
    if (typeof id !== 'string' || !ID_RE.test(id)) return { ok: false, error: 'invalid id' };
    const state = loadProfiles();
    const before = state.profiles.length;
    state.profiles = state.profiles.filter(p => p.id !== id);
    if (state.defaultProfileId === id) state.defaultProfileId = null;
    saveProfiles(state);
    if (log) log.info(`[profiles] Deleted profile ${id} (${before - state.profiles.length} removed)`);
    return { ok: true };
  });

  ipcMain.handle('profiles:set-default', (_e, id) => {
    const state = loadProfiles();
    if (id && (typeof id !== 'string' || !state.profiles.find(p => p.id === id))) {
      return { ok: false, error: 'unknown profile' };
    }
    state.defaultProfileId = id || null;
    saveProfiles(state);
    return { ok: true };
  });
}

module.exports = {
  init,
  loadProfiles,
  saveProfiles,
  resolveEnv,
  getProfileById,
  getDefaultProfile,
  pickProfileForSession,
  isValidProfile,
  isAllowedHost,
  profileEndpointAllowed,
  setProfilesPathForTesting,
  ENV_REF_RE,
  ENV_NAME_RE,
};

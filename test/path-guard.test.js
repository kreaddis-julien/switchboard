const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const {
  assertPathAllowed,
  addAllowedRoot,
  removeAllowedRoot,
  isWithin,
  CLAUDE_DIR,
} = require('../path-guard');

test('rejects paths outside any allowed root', () => {
  const r = assertPathAllowed('/etc/shadow', 'read');
  assert.equal(r.ok, false);
});

test('rejects empty / non-string input', () => {
  assert.equal(assertPathAllowed('', 'read').ok, false);
  assert.equal(assertPathAllowed(null, 'read').ok, false);
  assert.equal(assertPathAllowed(undefined, 'read').ok, false);
});

test('allows a file under ~/.claude/', () => {
  const target = path.join(CLAUDE_DIR, 'MEMORY.md');
  const r = assertPathAllowed(target, 'read');
  assert.equal(r.ok, true);
  assert.equal(r.resolved, path.resolve(target));
});

test('denies .credentials.json even though it is in ~/.claude/', () => {
  const target = path.join(CLAUDE_DIR, '.credentials.json');
  const r = assertPathAllowed(target, 'read');
  assert.equal(r.ok, false);
  assert.match(r.error, /sensitive/);
});

test('denies .ssh directory contents', () => {
  const target = path.join(os.homedir(), '.ssh', 'id_rsa');
  // First make it reachable by allowing the home dir (realistic misconfig)
  addAllowedRoot(os.homedir());
  try {
    const r = assertPathAllowed(target, 'read');
    assert.equal(r.ok, false);
    assert.match(r.error, /sensitive/);
  } finally {
    removeAllowedRoot(os.homedir());
  }
});

test('rejects path traversal escaping an allowed root', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-'));
  addAllowedRoot(tmp);
  try {
    const traversal = path.join(tmp, '..', '..', 'etc', 'passwd');
    const r = assertPathAllowed(traversal, 'read');
    assert.equal(r.ok, false);
  } finally {
    removeAllowedRoot(tmp);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('allows a file under an explicitly added root', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-'));
  addAllowedRoot(tmp);
  try {
    const target = path.join(tmp, 'sub', 'file.md');
    const r = assertPathAllowed(target, 'write');
    assert.equal(r.ok, true);
  } finally {
    removeAllowedRoot(tmp);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('isWithin treats identical paths as within', () => {
  assert.equal(isWithin('/a/b', '/a/b'), true);
  assert.equal(isWithin('/a/b/c', '/a/b'), true);
  assert.equal(isWithin('/a/c', '/a/b'), false);
});

test('isWithin rejects sibling prefix collision', () => {
  // /a/bcd starts with /a/b but is NOT inside /a/b
  assert.equal(isWithin('/a/bcd', '/a/b'), false);
});

test('isWithin handles null / missing args', () => {
  assert.equal(isWithin(null, '/a'), false);
  assert.equal(isWithin('/a', null), false);
  assert.equal(isWithin(undefined, undefined), false);
});

test('deny list catches .aws/credentials', () => {
  addAllowedRoot(os.homedir());
  try {
    const r = assertPathAllowed(path.join(os.homedir(), '.aws', 'credentials'), 'read');
    assert.equal(r.ok, false);
    assert.match(r.error, /sensitive/);
  } finally {
    removeAllowedRoot(os.homedir());
  }
});

test('deny list catches .netrc, .gnupg, id_rsa variants', () => {
  addAllowedRoot(os.homedir());
  try {
    const paths = [
      path.join(os.homedir(), '.netrc'),
      path.join(os.homedir(), '.gnupg', 'pubring.kbx'),
      path.join(os.homedir(), '.ssh', 'id_rsa'),
      path.join(os.homedir(), '.ssh', 'id_rsa.pub'),
      path.join(os.homedir(), '.ssh', 'id_ed25519'),
      path.join(os.homedir(), '.ssh', 'id_ed25519.pub'),
    ];
    for (const p of paths) {
      const r = assertPathAllowed(p, 'read');
      assert.equal(r.ok, false, `expected deny for ${p}`);
    }
  } finally {
    removeAllowedRoot(os.homedir());
  }
});

test('rejects non-string path types', () => {
  assert.equal(assertPathAllowed(42, 'read').ok, false);
  assert.equal(assertPathAllowed({}, 'read').ok, false);
  assert.equal(assertPathAllowed([], 'read').ok, false);
  assert.equal(assertPathAllowed(true, 'read').ok, false);
});

test('resolved path is always absolute', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-'));
  addAllowedRoot(tmp);
  try {
    const r = assertPathAllowed(path.join(tmp, 'nested', '.', 'file.md'), 'read');
    assert.equal(r.ok, true);
    assert.equal(path.isAbsolute(r.resolved), true);
    assert.ok(!r.resolved.includes(path.sep + '.' + path.sep));
  } finally {
    removeAllowedRoot(tmp);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('removeAllowedRoot makes previously-allowed paths deny', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-'));
  addAllowedRoot(tmp);
  const target = path.join(tmp, 'x.md');
  assert.equal(assertPathAllowed(target, 'read').ok, true);
  removeAllowedRoot(tmp);
  assert.equal(assertPathAllowed(target, 'read').ok, false);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('add/removeAllowedRoot ignore non-string input', () => {
  // Should not throw.
  addAllowedRoot(null);
  addAllowedRoot(undefined);
  addAllowedRoot(42);
  removeAllowedRoot(null);
});

test('deny list is case-insensitive on win32/darwin', () => {
  addAllowedRoot(os.homedir());
  try {
    // On linux this may or may not be denied depending on filesystem
    // case-sensitivity; the regex is `i` flagged so it should always deny.
    const r = assertPathAllowed(path.join(os.homedir(), '.SSH', 'id_rsa'), 'read');
    assert.equal(r.ok, false);
  } finally {
    removeAllowedRoot(os.homedir());
  }
});

test('same-path add is idempotent (double-add, single remove suffices)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-'));
  addAllowedRoot(tmp);
  addAllowedRoot(tmp);
  removeAllowedRoot(tmp);
  assert.equal(assertPathAllowed(path.join(tmp, 'x.md'), 'read').ok, false);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('exact allowed root path is itself allowed', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-'));
  addAllowedRoot(tmp);
  try {
    const r = assertPathAllowed(tmp, 'read');
    assert.equal(r.ok, true);
  } finally {
    removeAllowedRoot(tmp);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('traversal with excess ../ segments falls outside and is rejected', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-'));
  addAllowedRoot(tmp);
  try {
    const traversal = path.join(tmp, '..', 'sibling', 'file');
    const r = assertPathAllowed(traversal, 'read');
    assert.equal(r.ok, false);
  } finally {
    removeAllowedRoot(tmp);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

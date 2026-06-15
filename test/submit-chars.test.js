const test = require('node:test');
const assert = require('node:assert/strict');
const { hasSubmitChars, stripSubmitChars } = require('../submit-chars');

const NEL = String.fromCharCode(0x85);
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

test('detects C0 controls, DEL, NEL and Unicode line/paragraph separators', () => {
  for (const ch of ['\x00', '\x07', '\x1f', '\x7f', NEL, LS, PS, '\n', '\t', '\r']) {
    assert.equal(hasSubmitChars('a' + ch + 'b'), true, `should flag U+${ch.charCodeAt(0).toString(16)}`);
  }
  assert.equal(hasSubmitChars('plain text here'), false);
});

test('allowTab / allowNewline relax exactly those chars', () => {
  assert.equal(hasSubmitChars('a\nb', { allowNewline: true }), false);
  assert.equal(hasSubmitChars('a\tb', { allowTab: true }), false);
  // still flags the exotic separators even with newline allowed
  assert.equal(hasSubmitChars('a' + LS + 'b', { allowNewline: true, allowTab: true }), true);
  assert.equal(hasSubmitChars('a' + NEL + 'b', { allowNewline: true, allowTab: true }), true);
});

test('stripSubmitChars collapses runs to a single space and preserves text', () => {
  assert.equal(stripSubmitChars('ok' + LS + PS + '\n\rmore'), 'ok more');
  assert.equal(stripSubmitChars('clean'), 'clean');
  assert.equal(stripSubmitChars('a\x00\x00b'), 'a b');
});

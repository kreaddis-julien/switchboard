// Data-egress guard for Agent Teams worker profiles (profiles.js).
// Pure logic — no Electron. Validates that only Anthropic / loopback endpoints
// pass when the external-models opt-out is off.
const test = require('node:test');
const assert = require('node:assert/strict');
const { isAllowedHost, profileEndpointAllowed } = require('../profiles');

test('isAllowedHost: Anthropic and loopback allowed, third-party rejected', () => {
  assert.equal(isAllowedHost('api.anthropic.com'), true);
  assert.equal(isAllowedHost('localhost'), true);
  assert.equal(isAllowedHost('127.0.0.1'), true);
  assert.equal(isAllowedHost('127.0.0.53'), true);
  assert.equal(isAllowedHost('::1'), true);
  assert.equal(isAllowedHost(''), true); // absent host = default Anthropic
  assert.equal(isAllowedHost('api.deepseek.com'), false);
  assert.equal(isAllowedHost('api.moonshot.ai'), false);
  assert.equal(isAllowedHost('evil.example.com'), false);
});

test('profileEndpointAllowed: no BASE_URL = allowed (default Anthropic)', () => {
  assert.equal(profileEndpointAllowed({ env: { ANTHROPIC_API_KEY: 'sk-x' } }), true);
});

test('profileEndpointAllowed: explicit Anthropic / loopback allowed', () => {
  assert.equal(profileEndpointAllowed({ env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } }), true);
  assert.equal(profileEndpointAllowed({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:4000' } }), true);
  assert.equal(profileEndpointAllowed({ env: { ANTHROPIC_BASE_URL: 'http://localhost:1234/v1' } }), true);
});

test('profileEndpointAllowed: third-party hosted endpoint rejected', () => {
  assert.equal(profileEndpointAllowed({ env: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic' } }), false);
  assert.equal(profileEndpointAllowed({ env: { ANTHROPIC_BASE_URL: 'https://api.moonshot.ai/anthropic' } }), false);
});

test('profileEndpointAllowed: $REF resolved against env before checking host', () => {
  const procEnv = { MY_BASE: 'https://api.anthropic.com', BAD_BASE: 'https://api.deepseek.com' };
  assert.equal(profileEndpointAllowed({ env: { ANTHROPIC_BASE_URL: '$MY_BASE' } }, procEnv), true);
  assert.equal(profileEndpointAllowed({ env: { ANTHROPIC_BASE_URL: '${BAD_BASE}' } }, procEnv), false);
});

test('profileEndpointAllowed: unparseable BASE_URL fails closed', () => {
  assert.equal(profileEndpointAllowed({ env: { ANTHROPIC_BASE_URL: 'not a url' } }), false);
});

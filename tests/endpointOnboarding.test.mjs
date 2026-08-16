import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';

const root = new URL('../scripts/endpoint-onboarding/', import.meta.url);
const configPath = new URL('endpoint-onboarding.json', root);
const certPath = new URL('certificates/aegis-root-ca.crt', root);
const scriptPath = new URL('AEGIS-Client-Setup.ps1', root);

const EXPECTED_HASH = '8D03EC3090DE7D3DC38DCE86234219F3675ED0124D44B32D721B6A4EABA10CA7';
const EXPECTED_THUMBPRINT = '1B3DFBBFA2DD5F2E80F5729D54248B04B8E030A5';

test('endpoint onboarding config defines the approved AEGIS contract', () => {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(config.rootCaSha256, EXPECTED_HASH);
  assert.equal(config.rootCaThumbprint, EXPECTED_THUMBPRINT);
  assert.equal(config.rootCaSubject, 'CN=AEGIS Internal Root CA, O=AEGIS, C=TH');
  assert.equal(config.aegisUrl, 'https://aegis.internal/');
  assert.deepEqual(config.healthUrls, [
    'https://aegis.internal/drive/healthz',
    'https://aegis.internal/monitor/healthz',
  ]);
  assert.equal(config.twingateInstallerUri, 'https://api.twingate.com/download/windows');
});

test('bundled public Root CA matches the approved SHA-256', () => {
  const bytes = readFileSync(certPath);
  const actual = createHash('sha256').update(bytes).digest('hex').toUpperCase();
  assert.equal(actual, EXPECTED_HASH);
});

test('onboarding package contains no private-key material', () => {
  for (const candidate of [
    new URL('certificates/aegis-root-ca.key', root),
    new URL('certificates/aegis.internal.key', root),
  ]) {
    assert.equal(existsSync(candidate), false);
  }
});

test('setup entry point exists', () => {
  assert.equal(existsSync(scriptPath), true);
});

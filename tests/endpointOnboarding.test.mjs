import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';

const root = new URL('../scripts/endpoint-onboarding/', import.meta.url);
const configPath = new URL('endpoint-onboarding.json', root);
const certPath = new URL('certificates/aegis-root-ca.crt', root);
const scriptPath = new URL('AEGIS-Client-Setup.ps1', root);
const readmePath = new URL('README.md', root);

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

test('setup fails closed before Root CA import and avoids unsafe TLS bypass', () => {
  const source = readFileSync(scriptPath, 'utf8');
  assert.match(source, /WindowsBuiltInRole\]::Administrator/);
  assert.match(source, /Get-FileHash/);
  assert.match(source, /Cert:\\LocalMachine\\Root/);
  assert.match(source, /Import-Certificate/);
  assert.match(source, /ROOT_CA_HASH_DRIFT/);
  assert.match(source, /ROOT_CA_THUMBPRINT_DRIFT/);
  assert.match(source, /ROOT_CA_SUBJECT_DRIFT/);
  assert.doesNotMatch(source, /--insecure/i);
  assert.doesNotMatch(source, /(^|\s)-k(\s|$)/m);
  assert.doesNotMatch(source, /aegis-root-ca\.key|aegis\.internal\.key/i);
  assert.doesNotMatch(source, /password\s*=|token\s*=|service[_-]?key\s*=/i);
});

test('setup uses the supported Twingate managed-device install contract', () => {
  const source = readFileSync(scriptPath, 'utf8');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(config.twingateInstallerUri, 'https://api.twingate.com/download/windows');
  assert.match(source, /\/qn/);
  assert.match(source, /network=/);
  assert.match(source, /auto_update=true/);
  assert.match(source, /ALREADY_INSTALLED/);
  assert.match(source, /Get-AuthenticodeSignature/);
  assert.doesNotMatch(source, /Win32_Product/i);
  assert.doesNotMatch(source, /no_optional_updates=true/i);
});

test('setup creates the friendly AEGIS shortcut and verifies HTTPS without insecure bypass', () => {
  const source = readFileSync(scriptPath, 'utf8');
  assert.match(source, /https:\/\/aegis\.internal\//);
  assert.match(source, /WScript\.Shell/);
  assert.match(source, /--ssl-revoke-best-effort/);
  assert.match(source, /PASS_WITH_REVOCATION_LIMITATION/);
  assert.match(source, /PENDING_TWINGATE_LOGIN/);
  assert.doesNotMatch(source, /192\.168\.10\.10/);
  assert.doesNotMatch(source, /--insecure/i);
});

test('verify-only mode protects all onboarding writes', () => {
  const source = readFileSync(scriptPath, 'utf8');
  assert.match(source, /Ensure-RootCaTrusted[\s\S]*VerifyOnly/);
  assert.match(source, /Ensure-TwingateInstalled[\s\S]*VerifyOnly/);
  assert.match(source, /Ensure-AegisShortcut[\s\S]*VerifyOnly/);
  assert.match(source, /Save-OnboardingState[\s\S]*VerifyOnly/);
});

test('normal setup records rollback ownership metadata without secrets', () => {
  const source = readFileSync(scriptPath, 'utf8');
  assert.match(source, /endpoint-onboarding-state\.json/);
  assert.match(source, /rootCaThumbprint/);
  assert.match(source, /twingatePreExisting/);
  assert.match(source, /shortcutPath/);
});

test('IT README documents verify and install modes', () => {
  assert.equal(existsSync(readmePath), true);
  const readme = readFileSync(readmePath, 'utf8');
  assert.match(readme, /-VerifyOnly/);
  assert.match(readme, /-TwingateNetwork/);
  assert.match(readme, /employee/i);
  assert.match(readme, /private key/i);
});

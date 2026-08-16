import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';

const root = new URL('../scripts/endpoint-onboarding/', import.meta.url);
const configPath = new URL('endpoint-onboarding.json', root);
const certPath = new URL('certificates/aegis-root-ca.crt', root);
const scriptPath = new URL('AEGIS-Client-Setup.ps1', root);
const readmePath = new
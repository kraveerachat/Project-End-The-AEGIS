// tests/fixtures/backupAgentStatus.js — a valid /internal/backup/status body
//
// Shaped exactly like what shared/host-backup-agent publishes: one allowlisted
// external target on a separate physical disk, READY, no history yet. Tests
// override the pieces they care about.
export const FIXTURE_NOW = Date.parse('2026-09-03T02:00:00.000Z')

export const agentStatus = (overrides = {}) => ({
  schemaVersion: 1,
  measuredAt: new Date(FIXTURE_NOW - 1000).toISOString(),
  engine: 'restic',
  tools: { resticPresent: true, pgDumpPresent: true },
  policy: { activeTargetId: 'usb-external-1', scheduleId: 'daily-02:00', retentionId: 'keep-7d-4w', enabled: true },
  allowed: {
    scheduleIds: ['disabled', 'every-6h', 'daily-02:00', 'daily-03:30', 'weekly-sun-03:00'],
    retentionIds: ['keep-7d-4w', 'keep-14d-8w-6m', 'keep-30d-12w-12m'],
  },
  limits: { quiesceLeaseSeconds: 900, quiesceAckTimeoutSeconds: 120, maxBackupAgeHours: 36, verifyIntervalDays: 7 },
  targets: [{ id: 'usb-external-1', label: 'External USB SSD', type: 'external-mount', protection: 'DIFFERENT_DEVICE' }],
  target: { id: 'usb-external-1', label: 'External USB SSD', type: 'external-mount', protection: 'DIFFERENT_DEVICE' },
  state: 'READY',
  job: null,
  nextRun: new Date(FIXTURE_NOW + 20 * 3600 * 1000).toISOString(),
  lastBackupAt: null,
  history: [],
  ...overrides,
})

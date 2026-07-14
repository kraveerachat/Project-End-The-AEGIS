// Mock dataset — deliberately realistic. The demo's credibility depends on it.
// SHA-256 values are real-looking 64-hex strings; IPs are plausible RFC1918.

export const NOW = Date.now()
const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

export const FILES = [
  { id: 'f01', name: 'Q2-2026_Financial-Report_FINAL.xlsx', type: 'Spreadsheet', ext: 'xlsx', size: 4_812_339, modified: NOW - 22 * MIN, uploader: 'Kanya Srisuwan', vault: false, verified: true,
    sha256: '7f3a9c41d28e5b06f19a84c7e352d0b8a6f47e91c03d5a28b74f6e19d8c235a0', path: '/datalake/finance/2026/Q2/Q2-2026_Financial-Report_FINAL.xlsx' },
  { id: 'f02', name: 'network-topology_edge-site-A.pdf', type: 'PDF', ext: 'pdf', size: 2_144_776, modified: NOW - 3 * HOUR, uploader: 'Veerachat J.', vault: false, verified: true,
    sha256: 'b2e8d174c6a95f30e8b1d42a7c9f0e56d3a81b47f25c90ed61837a4b5d2c8f19', path: '/datalake/infra/diagrams/network-topology_edge-site-A.pdf' },
  { id: 'f03', name: 'customer-contracts_2026-H1.zip', type: 'Archive', ext: 'zip', size: 148_566_016, modified: NOW - 5 * HOUR, uploader: 'Somchai P.', vault: false, verified: false,
    sha256: '3c91f5e2a8d04b76c1e9f3a25d80b47e6f19c8d2a35b70e4d61f28a9c5b3e708', path: '/datalake/legal/contracts/customer-contracts_2026-H1.zip' },
  { id: 'f04', name: 'salary-review_2026_draft-v3.docx', type: 'Document', ext: 'docx', size: 812_454, modified: NOW - 8 * HOUR, uploader: 'Kanya Srisuwan', vault: true, verified: true,
    sha256: 'e5d20b83f47a916c2d8e04b5a9c7f31e60d2a84b79f15c3e8d06a2b4f9c817d5', path: '/vault/blobs/9f2e/e5d20b83.aegisenc' },
  { id: 'f05', name: 'factory-cam_incident_2026-07-08.mp4', type: 'Video', ext: 'mp4', size: 512_729_088, modified: NOW - DAY, uploader: 'Veerachat J.', vault: false, verified: true,
    sha256: 'a8c47e19d2b5f036e8a1c94d7f2b50e3d6a97b18c42f5e09d3b8a61f7c2e94d0', path: '/datalake/security/incidents/factory-cam_incident_2026-07-08.mp4' },
  { id: 'f06', name: 'ERP-migration-plan_phase2.pptx', type: 'Presentation', ext: 'pptx', size: 18_743_921, modified: NOW - DAY - 4 * HOUR, uploader: 'Nattaporn W.', vault: false, verified: true,
    sha256: 'f1b83d60e2a74c95d8f2b01e5a3c96d47e08b2a5f19d6c38e74a0b5d2c9f16e3', path: '/datalake/projects/erp-migration/ERP-migration-plan_phase2.pptx' },
  { id: 'f07', name: 'board-minutes_2026-06-30.pdf', type: 'PDF', ext: 'pdf', size: 1_204_337, modified: NOW - 2 * DAY, uploader: 'Somchai P.', vault: true, verified: true,
    sha256: 'c9e14f72a5d80b36c2f8e41d9a6b073e5d1c84a2b7f90e56d38a1c4e7b2f05d9', path: '/vault/blobs/4a7c/c9e14f72.aegisenc' },
  { id: 'f08', name: 'supplier-audit_checklist_th.xlsx', type: 'Spreadsheet', ext: 'xlsx', size: 674_201, modified: NOW - 2 * DAY - 6 * HOUR, uploader: 'Kanya Srisuwan', vault: false, verified: true,
    sha256: 'd4a92c58e7f13b06d9e2a45c8b7f60e1d3c95a84b26f7e01d5c8a39b4e2f761c', path: '/datalake/procurement/audits/supplier-audit_checklist_th.xlsx' },
  { id: 'f09', name: 'product-photos_launch-set.tar.gz', type: 'Archive', ext: 'tar.gz', size: 891_289_600, modified: NOW - 3 * DAY, uploader: 'Nattaporn W.', vault: false, verified: true,
    sha256: '68f2d4b91c3e07a5f8d6b20e4a9c157d3e86b04a2c5f91e7d38b6a04c9e2f518', path: '/datalake/marketing/assets/product-photos_launch-set.tar.gz' },
  { id: 'f10', name: 'penetration-test_report_2026-06.pdf', type: 'PDF', ext: 'pdf', size: 6_231_882, modified: NOW - 4 * DAY, uploader: 'Veerachat J.', vault: true, verified: true,
    sha256: '05c8e3a17d94f2b6e0d5a82c4b7f19e3d6c02a85f47b91e0d2c6a58b3f9e174c', path: '/vault/blobs/1e8d/05c8e3a1.aegisenc' },
  { id: 'f11', name: 'hr-policy-handbook_2026_th-en.pdf', type: 'PDF', ext: 'pdf', size: 3_412_990, modified: NOW - 5 * DAY, uploader: 'Somchai P.', vault: false, verified: true,
    sha256: '92b7e04d5c8a13f6e2d9b40a7c5f81e6d3a09c47b28f5e13d70a6b9c4e8f250d', path: '/datalake/hr/policies/hr-policy-handbook_2026_th-en.pdf' },
  { id: 'f12', name: 'backup-verify_2026-07-11.log', type: 'Log', ext: 'log', size: 148_211, modified: NOW - 6 * DAY, uploader: 'system', vault: false, verified: true,
    sha256: '4e0d92a67c3b85f1e4d28a05c9b7f36e1d58a24c7b90f6e3d15c8a2b4f7e091d', path: '/datalake/system/logs/backup-verify_2026-07-11.log' },
]

export const VAULT_FILES = FILES.filter((f) => f.vault)

// Vault demo key — ในระบบจริงคีย์นี้มาจากผู้ใช้และ "ไม่เคย" ออกจากเครื่อง
export const VAULT_DEMO_KEY = 'aegis-vault'

export const ACTIVITY = [
  { id: 'a1', actor: 'Kanya Srisuwan', action: 'uploaded', target: 'Q2-2026_Financial-Report_FINAL.xlsx', time: NOW - 22 * MIN, result: 'ok' },
  { id: 'a2', actor: 'Veerachat J.', action: 'verified checksum', target: 'network-topology_edge-site-A.pdf', time: NOW - 48 * MIN, result: 'ok' },
  { id: 'a3', actor: '10.0.40.188', action: 'share link open', target: 'customer-contracts_2026-H1.zip', time: NOW - 1 * HOUR - 12 * MIN, result: 'blocked' },
  { id: 'a4', actor: 'Somchai P.', action: 'created share link', target: 'supplier-audit_checklist_th.xlsx', time: NOW - 2 * HOUR, result: 'ok' },
  { id: 'a5', actor: 'Nattaporn W.', action: 'downloaded', target: 'ERP-migration-plan_phase2.pptx', time: NOW - 3 * HOUR, result: 'ok' },
  { id: 'a6', actor: 'guest-vlan client', action: 'login attempt', target: 'admin', time: NOW - 5 * HOUR, result: 'denied' },
  { id: 'a7', actor: 'system', action: 'snapshot created', target: 'snap-0093', time: NOW - 6 * HOUR, result: 'ok' },
  { id: 'a8', actor: 'Kanya Srisuwan', action: 'vault unlock', target: 'Private Vault', time: NOW - 8 * HOUR, result: 'ok' },
]

export const TRANSFER_7D = [
  { day: 'Tue', up: 42, down: 118, projected: false },
  { day: 'Wed', up: 61, down: 95, projected: false },
  { day: 'Thu', up: 38, down: 134, projected: false },
  { day: 'Fri', up: 74, down: 156, projected: false },
  { day: 'Sat', up: 12, down: 31, projected: false },
  { day: 'Sun', up: 45, down: 88, projected: true },
  { day: 'Mon', up: 68, down: 142, projected: true },
]

// Storage breakdown — ordered so blue and violet are never adjacent (CVD:
// protanopia collapses #2563EB↔#8B5CF6; the gray between them separates).
export const BREAKDOWN = [
  { key: 'docs', gb: 128, color: 'var(--accent)' },
  { key: 'archives', gb: 74, color: 'var(--ink-3)' },
  { key: 'media', gb: 96, color: 'var(--violet)' },
  { key: 'vaultSeg', gb: 44, color: 'var(--ink)' },
  { key: 'free', gb: 682, color: 'hatch' },
]

export const SHARES = [
  { id: 's1', file: 'supplier-audit_checklist_th.xlsx', scope: 'vlan', auth: 'password', createdBy: 'Somchai P.', hits: 4, expiresAt: NOW + 5 * HOUR + 12 * MIN },
  { id: 's2', file: 'product-photos_launch-set.tar.gz', scope: 'any', auth: 'otc', createdBy: 'Nattaporn W.', hits: 17, expiresAt: NOW + 22 * HOUR },
  { id: 's3', file: 'network-topology_edge-site-A.pdf', scope: 'subnet', auth: 'password', createdBy: 'Veerachat J.', hits: 2, expiresAt: NOW + 41 * MIN },
  { id: 's4', file: 'hr-policy-handbook_2026_th-en.pdf', scope: 'vlan', auth: 'none', createdBy: 'Kanya Srisuwan', hits: 31, expiresAt: NOW + 6 * DAY },
]

export const SNAPSHOTS = [
  { id: 'snap-0093', time: NOW - 6 * HOUR, delta: '+2.4 GB', verified: true },
  { id: 'snap-0092', time: NOW - 12 * HOUR, delta: '+814 MB', verified: true },
  { id: 'snap-0091', time: NOW - 18 * HOUR, delta: '+1.1 GB', verified: true },
  { id: 'snap-0090', time: NOW - 24 * HOUR, delta: '+3.8 GB', verified: true },
  { id: 'snap-0089', time: NOW - 2 * DAY, delta: '+920 MB', verified: true },
  { id: 'snap-0088', time: NOW - 3 * DAY, delta: '+5.2 GB', verified: true },
  { id: 'snap-0087', time: NOW - 4 * DAY, delta: '+1.7 GB', verified: false },
  { id: 'snap-0086', time: NOW - 5 * DAY, delta: '+2.9 GB', verified: true },
]

export const DISKS = [
  { id: 'sda', model: 'WD Red Pro 4TB', serial: 'WD-WX32DA8L7K4N', capacityTB: 4, usedTB: 1.62, temp: 38, smart: 'PASSED', hours: 14_208 },
  { id: 'sdb', model: 'WD Red Pro 4TB', serial: 'WD-WX32DA8L2C9F', capacityTB: 4, usedTB: 1.62, temp: 41, smart: 'PASSED', hours: 14_205 },
]

export const BACKUP_JOBS = [
  { id: 'b1', job: 'Nightly incremental', target: 'edge-site-B /backup', freq: 'daily', lastRun: NOW - 9 * HOUR, status: 'ok', nextRun: NOW + 15 * HOUR },
  { id: 'b2', job: 'Vault ciphertext replica', target: 'offsite-tape LTO-9', freq: 'weekly', lastRun: NOW - 3 * DAY, status: 'ok', nextRun: NOW + 4 * DAY },
  { id: 'b3', job: 'PostgreSQL WAL archive', target: 'edge-site-B /pgwal', freq: 'hourly', lastRun: NOW - 32 * MIN, status: 'ok', nextRun: NOW + 28 * MIN },
]

export const AUDIT_LOG = [
  { id: 'g01', time: NOW - 9 * MIN, actor: 'Kanya Srisuwan', role: 'DataLake-User', action: 'FILE_UPLOAD', target: 'Q2-2026_Financial-Report_FINAL.xlsx', result: 'OK', ip: '192.168.20.31' },
  { id: 'g02', time: NOW - 22 * MIN, actor: 'Veerachat J.', role: 'Admin', action: 'CHECKSUM_VERIFY', target: 'network-topology_edge-site-A.pdf', result: 'OK', ip: '192.168.20.14' },
  { id: 'g03', time: NOW - 1 * HOUR - 12 * MIN, actor: '—', role: '—', action: 'SHARE_OPEN', target: 'customer-contracts_2026-H1.zip', result: 'BLOCKED', ip: '10.0.40.188' },
  { id: 'g04', time: NOW - 2 * HOUR, actor: 'Somchai P.', role: 'DataLake-User', action: 'SHARE_CREATE', target: 'supplier-audit_checklist_th.xlsx', result: 'OK', ip: '192.168.20.77' },
  { id: 'g05', time: NOW - 3 * HOUR - 8 * MIN, actor: 'Nattaporn W.', role: 'DataLake-User', action: 'FILE_DOWNLOAD', target: 'ERP-migration-plan_phase2.pptx', result: 'OK', ip: '192.168.21.45' },
  { id: 'g06', time: NOW - 5 * HOUR, actor: 'unknown', role: '—', action: 'LOGIN', target: 'account: admin', result: 'DENIED', ip: '192.168.30.102' },
  { id: 'g07', time: NOW - 5 * HOUR - 2 * MIN, actor: 'unknown', role: '—', action: 'LOGIN', target: 'account: admin', result: 'DENIED', ip: '192.168.30.102' },
  { id: 'g08', time: NOW - 6 * HOUR, actor: 'system', role: 'Service', action: 'SNAPSHOT_CREATE', target: 'snap-0093', result: 'OK', ip: '127.0.0.1' },
  { id: 'g09', time: NOW - 8 * HOUR, actor: 'Kanya Srisuwan', role: 'DataLake-User', action: 'VAULT_UNLOCK', target: 'Private Vault', result: 'OK', ip: '192.168.20.31' },
  { id: 'g10', time: NOW - 11 * HOUR, actor: 'Veerachat J.', role: 'Admin', action: 'ROLE_CHANGE', target: 'nattaporn.w → DataLake-User', result: 'OK', ip: '192.168.20.14' },
  { id: 'g11', time: NOW - 14 * HOUR, actor: '—', role: '—', action: 'FIREWALL_DROP', target: 'tcp/445 scan', result: 'BLOCKED', ip: '10.0.40.203' },
  { id: 'g12', time: NOW - 18 * HOUR, actor: 'Somchai P.', role: 'DataLake-User', action: 'FILE_DELETE', target: 'old-drafts_2025.zip', result: 'OK', ip: '192.168.20.77' },
  { id: 'g13', time: NOW - 22 * HOUR, actor: 'system', role: 'Service', action: 'BACKUP_RUN', target: 'Nightly incremental', result: 'OK', ip: '127.0.0.1' },
  { id: 'g14', time: NOW - DAY - 2 * HOUR, actor: 'Nattaporn W.', role: 'DataLake-User', action: 'AUDIT_READ', target: 'Audit Log', result: 'DENIED', ip: '192.168.21.45' },
  { id: 'g15', time: NOW - DAY - 5 * HOUR, actor: 'Veerachat J.', role: 'Admin', action: 'USER_CREATE', target: 'nattaporn.w', result: 'OK', ip: '192.168.20.14' },
]

export const USERS = [
  { id: 'u1', name: 'Veerachat J.', username: 'veerachat.j', role: 'admin', status: 'active', lastLogin: NOW - 10 * MIN, sessions: 2 },
  { id: 'u2', name: 'Kanya Srisuwan', username: 'kanya.s', role: 'datalake-user', status: 'active', lastLogin: NOW - 25 * MIN, sessions: 1 },
  { id: 'u3', name: 'Somchai P.', username: 'somchai.p', role: 'datalake-user', status: 'active', lastLogin: NOW - 2 * HOUR, sessions: 0 },
  { id: 'u4', name: 'Nattaporn W.', username: 'nattaporn.w', role: 'datalake-user', status: 'suspended', lastLogin: NOW - 3 * DAY, sessions: 0 },
]

export const PERMISSIONS = [
  { key: 'permUploadDl', admin: true, user: true },
  { key: 'permShare', admin: true, user: true },
  { key: 'permVault', admin: true, user: true },
  { key: 'permSnapRestore', admin: true, user: false },
  { key: 'permAudit', admin: true, user: false },
  { key: 'permManageUsers', admin: true, user: false },
]

export const SESSIONS = [
  { id: 'se1', device: 'Windows 11 · Chrome 138', ip: '192.168.20.14', lastActive: NOW - 2 * MIN, current: true },
  { id: 'se2', device: 'macOS 15 · Safari 18', ip: '192.168.20.83', lastActive: NOW - 3 * HOUR, current: false },
  { id: 'se3', device: 'Android 15 · AEGIS App', ip: '192.168.22.101', lastActive: NOW - DAY, current: false },
]

export const SPARK = {
  storage: [312, 316, 315, 321, 328, 330, 334, 338, 336, 340, 341, 342],
  files: [11930, 12020, 12180, 12220, 12390, 12480, 12530, 12610, 12700, 12760, 12800, 12847],
  sessions: [2, 3, 4, 3, 2, 2, 3, 4, 5, 3, 2, 3],
  alerts: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  nginx: [12, 14, 11, 13, 12, 15, 13, 12, 11, 14, 12, 13],
  postgres: [4, 5, 4, 4, 6, 5, 4, 5, 4, 4, 5, 4],
  fs: [2, 2, 3, 2, 2, 2, 3, 2, 2, 3, 2, 2],
}

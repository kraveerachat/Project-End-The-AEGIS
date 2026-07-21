// server/rbac/roles.js
export const ROLES = {
  USER: 'User',
  ADMIN: 'Admin',
}

const MENUS = {
  [ROLES.USER]: [
    { id: 'drive', titleKey: 'modDrive', descKey: 'modDriveDesc' },
  ],
  [ROLES.ADMIN]: [
    { id: 'drive', titleKey: 'modDrive', descKey: 'modDriveDesc' },
    { id: 'cctv', titleKey: 'modCctv', descKey: 'modCctvDesc' },
    { id: 'monitoring', titleKey: 'modMonitor', descKey: 'modMonitorDesc' },
  ],
}

export function getMenuForRole(role) {
  return MENUS[role] ?? MENUS[ROLES.USER]
}

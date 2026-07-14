// i18n — flat { en, th } objects, default Thai (PRODUCT.md: Thai-first).
// No user-facing text is hardcoded in JSX; everything routes through t().
export const LANGS = ['th', 'en']

const STRINGS = {
  en: {
    productTag: 'AUTONOMOUS EDGE-GUARD INFRASTRUCTURE SYSTEM',
    language: 'Language',
    themeToDark: 'Switch to dark mode',
    themeToLight: 'Switch to light mode',

    // Welcome
    enter: 'Enter',

    // Login
    loginTitle: 'Sign in',
    loginSubtitle: 'Single entry to the AEGIS platform',
    username: 'Username',
    usernamePlaceholder: 'your username',
    password: 'Password',
    passwordPlaceholder: '••••••••',
    showPassword: 'Show password',
    hidePassword: 'Hide password',
    rememberSession: 'Remember this session',
    signIn: 'Sign in',
    signingIn: 'Verifying…',
    // ข้อความล้มเหลวรูปแบบเดียวเสมอ — ห้ามแยกว่า user ผิดหรือรหัสผิด (กัน enumeration)
    loginFailed: 'Invalid username or password.',
    lockout: 'Too many attempts · try again in {s}s',

    layerNetwork: 'LAYER 0 · NETWORK',
    layerNetworkDesc: 'VPN + VLAN',
    layerApp: 'LAYER 1 · APPLICATION',
    layerAppDesc: 'Credentials',
    layerStorage: 'LAYER 2 · STORAGE',
    layerStorageDesc: 'Encryption at rest',
    layerMeta: 'LAYER 3 · METADATA',
    layerMetaDesc: 'PostgreSQL',

    // Hub
    welcomeUser: 'Welcome, {name}',
    selectModule: 'Select a module to continue',
    roleAdmin: 'ADMINISTRATOR',
    roleUser: 'STANDARD USER',
    logout: 'Log out',
    open: 'OPEN',
    entering: 'Entering {module}…',

    modDrive: 'AEGIS Drive',
    modDriveDesc: 'Secure Edge data lake. Store, retrieve, and share files.',
    modCctv: 'CCTV Operator View',
    modCctvDesc: 'Live and archived footage from your assigned camera.',
    modMonitor: 'AEGIS Monitoring',
    modMonitorDesc: 'Surveillance control plane. All nodes, detection, alerts.',
  },

  th: {
    productTag: 'AUTONOMOUS EDGE-GUARD INFRASTRUCTURE SYSTEM',
    language: 'ภาษา',
    themeToDark: 'สลับเป็นโหมดมืด',
    themeToLight: 'สลับเป็นโหมดสว่าง',

    enter: 'เข้าสู่ระบบ',

    loginTitle: 'เข้าสู่ระบบ',
    loginSubtitle: 'ทางเข้าเดียวสู่แพลตฟอร์ม AEGIS',
    username: 'ชื่อผู้ใช้',
    usernamePlaceholder: 'ชื่อผู้ใช้ของคุณ',
    password: 'รหัสผ่าน',
    passwordPlaceholder: '••••••••',
    showPassword: 'แสดงรหัสผ่าน',
    hidePassword: 'ซ่อนรหัสผ่าน',
    rememberSession: 'จดจำเซสชันนี้',
    signIn: 'เข้าสู่ระบบ',
    signingIn: 'กำลังตรวจสอบ…',
    loginFailed: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง',
    lockout: 'พยายามหลายครั้งเกินไป · ลองใหม่ใน {s} วินาที',

    layerNetwork: 'LAYER 0 · NETWORK',
    layerNetworkDesc: 'VPN + VLAN',
    layerApp: 'LAYER 1 · APPLICATION',
    layerAppDesc: 'ข้อมูลประจำตัว',
    layerStorage: 'LAYER 2 · STORAGE',
    layerStorageDesc: 'เข้ารหัสขณะจัดเก็บ',
    layerMeta: 'LAYER 3 · METADATA',
    layerMetaDesc: 'PostgreSQL',

    welcomeUser: 'ยินดีต้อนรับ {name}',
    selectModule: 'เลือกโมดูลเพื่อดำเนินการต่อ',
    roleAdmin: 'ผู้ดูแลระบบ',
    roleUser: 'ผู้ใช้ทั่วไป',
    logout: 'ออกจากระบบ',
    open: 'เปิด',
    entering: 'กำลังเข้าสู่ {module}…',

    modDrive: 'AEGIS Drive · คลังข้อมูล',
    modDriveDesc: 'คลังข้อมูลปลอดภัยบนเครือข่ายภายใน จัดเก็บ เรียกใช้ และแชร์ไฟล์',
    modCctv: 'ดูภาพกล้องวงจรปิด',
    modCctvDesc: 'ภาพสดและภาพย้อนหลังจากกล้องที่ได้รับมอบหมาย',
    modMonitor: 'AEGIS Monitoring · ควบคุมและจัดการกล้อง',
    modMonitorDesc: 'ศูนย์ควบคุมระบบเฝ้าระวัง โหนดทั้งหมด การตรวจจับ และการแจ้งเตือน',
  },
}

/** t('key') or t('key', { name: 'x' }) — {placeholders} are interpolated. */
export function makeT(lang) {
  const table = STRINGS[lang] ?? STRINGS.th
  return (key, vars) => {
    let s = table[key] ?? STRINGS.en[key] ?? key
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v))
    return s
  }
}

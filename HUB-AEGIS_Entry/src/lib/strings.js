// i18n — flat { en, th } objects, default Thai (PRODUCT.md: Thai-first).
// No user-facing text is hardcoded in JSX; everything routes through t().
export const LANGS = ['th', 'en', 'zh']

const STRINGS = {
  en: {
    productTag: 'AUTONOMOUS EDGE-GUARD INFRASTRUCTURE SYSTEM',
    language: 'Language',
    themeToDark: 'Switch to dark mode',
    themeToLight: 'Switch to light mode',

    // Welcome
    enter: 'Enter',

    // Login
    loginTitle: 'Sign In',
    loginSubtitle: 'Secure NAS · On-Premise Deployment',
    username: 'Username',
    usernamePlaceholder: 'first.last',
    password: 'Password',
    passwordPlaceholder: '••••••••',
    showPassword: 'Show password',
    hidePassword: 'Hide password',
    rememberSession: 'Remember this session',
    signIn: 'Sign In',
    signingIn: 'Signing in…',
    loginFailed: 'Incorrect username or password.',
    lockout: 'Too many attempts. Try again in {s}s.',
    layerNetwork: 'LAYER 0 · NETWORK',
    layerNetworkDesc: 'VPN + VLAN',
    layerApp: 'LAYER 1 · APPLICATION',
    layerAppDesc: 'Credentials',
    layerStorage: 'LAYER 2 · STORAGE',
    layerStorageDesc: 'Encrypted at rest',
    layerMeta: 'LAYER 3 · METADATA',
    layerMetaDesc: 'PostgreSQL',

    // Hub
    hubTitle: 'AEGIS Edge-Guard Infrastructure',
    selectModule: 'Select a module to continue — each module has its own sign-in',
    open: 'OPEN',
    entering: 'Entering {module}…',

    modDrive: 'AEGIS Drive',
    modDriveDesc: 'Secure data storage and file management',
    modMonitor: 'AEGIS Monitor',
    modMonitorDesc: 'Camera surveillance and alert control center',
  },

  th: {
    productTag: 'AUTONOMOUS EDGE-GUARD INFRASTRUCTURE SYSTEM',
    language: 'ภาษา',
    themeToDark: 'สลับเป็นโหมดมืด',
    themeToLight: 'สลับเป็นโหมดสว่าง',

    enter: 'เข้าสู่ระบบ',

    // Login
    loginTitle: 'เข้าสู่ระบบ',
    loginSubtitle: 'NAS ปลอดภัย · ติดตั้งภายในองค์กร',
    username: 'ชื่อผู้ใช้',
    usernamePlaceholder: 'ชื่อ.นามสกุล',
    password: 'รหัสผ่าน',
    passwordPlaceholder: '••••••••',
    showPassword: 'แสดงรหัสผ่าน',
    hidePassword: 'ซ่อนรหัสผ่าน',
    rememberSession: 'จดจำเซสชันนี้',
    signIn: 'เข้าสู่ระบบ',
    signingIn: 'กำลังเข้าสู่ระบบ…',
    loginFailed: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง',
    lockout: 'ลองมากเกินไป กรุณาลองใหม่ใน {s} วินาที',
    layerNetwork: 'LAYER 0 · NETWORK',
    layerNetworkDesc: 'VPN + VLAN',
    layerApp: 'LAYER 1 · APPLICATION',
    layerAppDesc: 'ข้อมูลประจำตัว',
    layerStorage: 'LAYER 2 · STORAGE',
    layerStorageDesc: 'เข้ารหัสขณะจัดเก็บ',
    layerMeta: 'LAYER 3 · METADATA',
    layerMetaDesc: 'PostgreSQL',

    hubTitle: 'AEGIS Edge-Guard Infrastructure',
    selectModule: 'เลือกโมดูลเพื่อดำเนินการต่อ — แต่ละโมดูลมีทางเข้าสู่ระบบของตัวเอง',
    open: 'เปิด',
    entering: 'กำลังเข้าสู่ {module}…',

    modDrive: 'AEGIS Drive',
    modDriveDesc: 'ระบบจัดเก็บข้อมูลและจัดการไฟล์',
    modMonitor: 'AEGIS Monitor',
    modMonitorDesc: 'ศูนย์ควบคุมเฝ้าระวังกล้องและแจ้งเตือน',
  },

  zh: {
    productTag: 'AUTONOMOUS EDGE-GUARD INFRASTRUCTURE SYSTEM',
    language: '语言',
    themeToDark: '切换到暗色模式',
    themeToLight: '切换到亮色模式',

    // Welcome
    enter: '进入系统',

    // Login
    loginTitle: '登录',
    loginSubtitle: '安全 NAS · 本地部署',
    username: '用户名',
    usernamePlaceholder: '名.姓',
    password: '密码',
    passwordPlaceholder: '••••••••',
    showPassword: '显示密码',
    hidePassword: '隐藏密码',
    rememberSession: '记住此会话',
    signIn: '登录',
    signingIn: '正在登录…',
    loginFailed: '用户名或密码不正确。',
    lockout: '尝试次数过多，请在 {s} 秒后重试。',
    layerNetwork: 'LAYER 0 · NETWORK',
    layerNetworkDesc: 'VPN + VLAN',
    layerApp: 'LAYER 1 · APPLICATION',
    layerAppDesc: '身份凭证',
    layerStorage: 'LAYER 2 · STORAGE',
    layerStorageDesc: '静态加密',
    layerMeta: 'LAYER 3 · METADATA',
    layerMetaDesc: 'PostgreSQL',

    // Hub
    hubTitle: 'AEGIS Edge-Guard Infrastructure',
    selectModule: '请选择模块继续——每个模块均有独立登录',
    open: '开启',
    entering: '正在进入 {module}…',

    modDrive: 'AEGIS Drive',
    modDriveDesc: '安全数据存储与文件管理',
    modMonitor: 'AEGIS Monitor',
    modMonitorDesc: '摄像头监控与警报控制中心',
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

// i18n — flat { en, th, zh } objects, default Thai (PRODUCT.md: Thai-first).
// No user-facing text is hardcoded in JSX; everything routes through t().
//
// ⚠️ ไม่มีสตริงหมวด Login ที่นี่โดยเจตนา — HUB ไม่มีฟอร์มล็อกอินแล้ว
// (ทั้ง username/password/rememberSession และแถว LAYER 0–3 ที่เคยบอกเป็นนัยว่า
// "Layer 1 · Application = Credentials" เกิดขึ้นที่ HUB ถูกลบไปพร้อม Login.jsx)
// ข้อความล็อกอินจริงอยู่ในแอปปลายทางแต่ละตัว ซึ่งมี i18n ของตัวเองแยกกัน
export const LANGS = ['th', 'en', 'zh']

const STRINGS = {
  en: {
    productTag: 'AUTONOMOUS EDGE-GUARD INFRASTRUCTURE SYSTEM',
    language: 'Language',
    themeToDark: 'Switch to dark mode',
    themeToLight: 'Switch to light mode',

    // Welcome
    enter: 'Enter',

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

    // Hub
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

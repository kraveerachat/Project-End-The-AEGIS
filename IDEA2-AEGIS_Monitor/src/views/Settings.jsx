import { useState } from 'react'
import { motion } from 'framer-motion'
import { Bell, BellOff, Check, Globe, LogOut, Monitor, Moon, Shield, Sun, User, Volume2, VolumeX } from 'lucide-react'

const TRANSLATIONS = {
  th: {
    title: 'การตั้งค่าระบบ',
    sub: 'จัดการการแสดงผล ธีมการใช้งาน และการแจ้งเตือนสำหรับ AEGIS Monitor',
    appearance: 'การแสดงผล & อินเทอร์เฟซ (Display)',
    language: 'ภาษา (Language)',
    langNote: 'เลือกภาษาที่ต้องการแสดงในระบบ',
    theme: 'ธีมการใช้งาน (Theme)',
    dark: 'โหมดมืด (Dark)',
    light: 'โหมดสว่าง (Light)',
    notifications: 'การแจ้งเตือน (Notifications)',
    inAppSound: 'เสียงแจ้งเตือนในแอป (In-App Sound)',
    desktopAlerts: 'การแจ้งเตือนบนเดสก์ท็อป (Desktop Push)',
    snooze: 'ปิดเสียงแจ้งเตือนชั่วคราว (Snooze)',
    snoozeOff: 'เปิดปกติ',
    snooze15: '15 นาที',
    snooze1h: '1 ชั่วโมง',
    snoozeUntil: 'ปิดจนกว่าจะเปิดใหม่',
    notifNote: 'การแจ้งเตือนเหตุการณ์ร้ายแรง (Critical Unknown Detection) จะถูกส่งเสมอโดยไม่คำนึงถึงสถานะ Snooze',
    account: 'ข้อมูลบัญชีผู้ใช้ (Account & Session)',
    userName: 'ชื่อผู้ใช้งาน',
    userRole: 'สิทธิ์การใช้งาน (Role)',
    assignedCams: 'กล้องที่รับผิดชอบ',
    sessionIp: 'IP เครื่องดำเนินการ',
    nodeStatus: 'สถานะการเชื่อมต่อ Edge Node',
    aiEngine: 'AI Inference Engine',
    online: 'ปกติ (Online)',
    running: 'กำลังทำงาน (Running v1.3)',
    saveSuccess: 'บันทึกการตั้งค่าเรียบร้อยแล้ว',
  },
  en: {
    title: 'System Settings',
    sub: 'Manage interface display, theme modes, and notification preferences for AEGIS Monitor',
    appearance: 'Display & Interface',
    language: 'Language',
    langNote: 'Select your preferred interface language',
    theme: 'Theme Mode',
    dark: 'Dark Mode',
    light: 'Light Mode',
    notifications: 'Notification Preferences',
    inAppSound: 'In-App Sound Alert',
    desktopAlerts: 'Desktop Push Alerts',
    snooze: 'Snooze Notifications',
    snoozeOff: 'Active',
    snooze15: '15 Mins',
    snooze1h: '1 Hour',
    snoozeUntil: 'Until Turned On',
    notifNote: 'Critical unknown face detections will bypass snooze rules to ensure facility security.',
    account: 'Account & Active Session',
    userName: 'User Name',
    userRole: 'Role Privilege',
    assignedCams: 'Assigned Cameras',
    sessionIp: 'Session IP Address',
    nodeStatus: 'Edge Node Connection',
    aiEngine: 'AI Inference Engine',
    online: 'Online',
    running: 'Running v1.3',
    saveSuccess: 'Settings saved successfully',
  },
  zh: {
    title: '系统设置',
    sub: '管理 AEGIS Monitor 的界面显示、主题模式与通知偏好',
    appearance: '显示与界面',
    language: '语言',
    langNote: '选择系统显示所用的语言',
    theme: '主题模式',
    dark: '深色模式',
    light: '浅色模式',
    notifications: '通知设置',
    inAppSound: '应用内提示音',
    desktopAlerts: '桌面推送通知',
    snooze: '暂停通知',
    snoozeOff: '正常开启',
    snooze15: '15 分钟',
    snooze1h: '1 小时',
    snoozeUntil: '手动开启前保持关闭',
    notifNote: '严重的未知人员检测通知将始终发送，不受暂停设置影响',
    account: '账户与会话信息',
    userName: '用户名称',
    userRole: '权限角色',
    assignedCams: '负责的摄像头',
    sessionIp: '当前会话 IP',
    nodeStatus: '边缘节点连接状态',
    aiEngine: 'AI 推理引擎',
    online: '在线',
    running: '运行中 v1.3',
    saveSuccess: '设置已成功保存',
  },
}

// ⚠️ ข้อมูลบัญชี (user/cameras) มาจากเซสชันฝั่งเซิร์ฟเวอร์ — อ่านอย่างเดียว
// การเปลี่ยน identity / camera assignment เป็นสิทธิ์ของ SOC-Responder เท่านั้น
// ⚠️ วันนี้ทำได้แค่ "เพิ่ม operator + ผูกกล้องตอนสร้าง" ในวิว Nodes (AddOperatorModal)
//    ส่วน "แก้ assignment ของ operator ที่มีอยู่แล้ว" ยังไม่มี UI — endpoint มีแล้ว
//    (PUT /api/assignments) แต่ยังไม่มีผู้เรียก รอวิว Operators ที่ยังไม่ถูกสร้าง
//    (ดู TODO ใน server/rbac/permissions.js)
export default function Settings({ lang, setLang, theme, setTheme, user, cameras = [], onSignOut }) {
  const [inAppSound, setInAppSound] = useState(true)
  const [desktopAlerts, setDesktopAlerts] = useState(true)
  const [snooze, setSnooze] = useState('off')
  const [saved, setSaved] = useState(false)

  const t = (key) => TRANSLATIONS[lang]?.[key] ?? TRANSLATIONS.en[key] ?? key

  const triggerSavedNotice = () => {
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
  }

  const handleLangChange = (newLang) => {
    setLang(newLang)
    triggerSavedNotice()
  }

  const handleThemeChange = (newTheme) => {
    setTheme(newTheme)
    triggerSavedNotice()
  }

  const containerVariants = {
    hidden: {},
    show: {
      transition: {
        staggerChildren: 0.08,
      },
    },
  }

  const cardVariants = {
    hidden: { opacity: 0, y: 16 },
    show: {
      opacity: 1,
      y: 0,
      transition: { duration: 0.4, ease: [0.16, 1, 0.3, 1] },
    },
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease: 'easeOut' }}
    >
      <div className="pagehead">
        <div>
          <h1 className="h1">{t('title')}</h1>
          <p className="sub">{t('sub')}</p>
        </div>
        {saved && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            className="saved-toast"
          >
            <Check className="w-4 h-4 text-emerald-400" />
            <span>{t('saveSuccess')}</span>
          </motion.div>
        )}
      </div>

      <motion.div
        className="settings-grid"
        variants={containerVariants}
        initial="hidden"
        animate="show"
      >
        {/* CARD 1: DISPLAY & APPEARANCE */}
        <motion.div
          className="panel glass set-card"
          variants={cardVariants}
          whileHover={{ y: -3, boxShadow: '0 12px 30px rgba(124, 58, 237, 0.15)' }}
        >
          <div className="set-card-header">
            <Monitor className="w-5 h-5 text-cyan-400 shrink-0" />
            <h2 className="set-card-title">{t('appearance')}</h2>
          </div>

          <div className="set-option-row">
            <div className="set-option-meta">
              <div className="set-option-label">
                <Globe className="w-4 h-4 text-slate-400 shrink-0" />
                <span>{t('language')}</span>
              </div>
              <div className="set-option-desc">{t('langNote')}</div>
            </div>
            <div className="seg-control">
              <button
                type="button"
                className={lang === 'th' ? 'seg-btn active' : 'seg-btn'}
                onClick={() => handleLangChange('th')}
              >
                ไทย
              </button>
              <button
                type="button"
                className={lang === 'en' ? 'seg-btn active' : 'seg-btn'}
                onClick={() => handleLangChange('en')}
              >
                English
              </button>
              <button
                type="button"
                className={lang === 'zh' ? 'seg-btn active' : 'seg-btn'}
                onClick={() => handleLangChange('zh')}
              >
                中文
              </button>
            </div>
          </div>

          <div className="set-option-row">
            <div className="set-option-meta">
              <div className="set-option-label">
                {theme === 'dark' ? (
                  <Moon className="w-4 h-4 text-purple-400 shrink-0" />
                ) : (
                  <Sun className="w-4 h-4 text-amber-400 shrink-0" />
                )}
                <span>{t('theme')}</span>
              </div>
              <div className="set-option-desc">
                {theme === 'dark' ? 'AEGIS Cyber Dark Mode' : 'AEGIS Clean Light Mode'}
              </div>
            </div>
            <div className="seg-control">
              <button
                type="button"
                className={theme === 'dark' ? 'seg-btn active' : 'seg-btn'}
                onClick={() => handleThemeChange('dark')}
              >
                <Moon className="w-3.5 h-3.5 mr-1.5 inline shrink-0" />
                {t('dark')}
              </button>
              <button
                type="button"
                className={theme === 'light' ? 'seg-btn active' : 'seg-btn'}
                onClick={() => handleThemeChange('light')}
              >
                <Sun className="w-3.5 h-3.5 mr-1.5 inline shrink-0" />
                {t('light')}
              </button>
            </div>
          </div>
        </motion.div>

        {/* CARD 2: NOTIFICATION PREFERENCES */}
        <motion.div
          className="panel glass set-card"
          variants={cardVariants}
          whileHover={{ y: -3, boxShadow: '0 12px 30px rgba(124, 58, 237, 0.15)' }}
        >
          <div className="set-card-header">
            <Bell className="w-5 h-5 text-amber-400 shrink-0" />
            <h2 className="set-card-title">{t('notifications')}</h2>
          </div>

          <div className="set-option-row">
            <div className="set-option-meta">
              <div className="set-option-label">
                {inAppSound ? (
                  <Volume2 className="w-4 h-4 text-cyan-400 shrink-0" />
                ) : (
                  <VolumeX className="w-4 h-4 text-slate-500 shrink-0" />
                )}
                <span>{t('inAppSound')}</span>
              </div>
            </div>
            <button
              type="button"
              className={inAppSound ? 'switch-toggle active' : 'switch-toggle'}
              onClick={() => {
                setInAppSound(!inAppSound)
                triggerSavedNotice()
              }}
              aria-label={t('inAppSound')}
            >
              <span className="switch-thumb" />
            </button>
          </div>

          <div className="set-option-row">
            <div className="set-option-meta">
              <div className="set-option-label">
                {desktopAlerts ? (
                  <Bell className="w-4 h-4 text-purple-400 shrink-0" />
                ) : (
                  <BellOff className="w-4 h-4 text-slate-500 shrink-0" />
                )}
                <span>{t('desktopAlerts')}</span>
              </div>
            </div>
            <button
              type="button"
              className={desktopAlerts ? 'switch-toggle active' : 'switch-toggle'}
              onClick={() => {
                setDesktopAlerts(!desktopAlerts)
                triggerSavedNotice()
              }}
              aria-label={t('desktopAlerts')}
            >
              <span className="switch-thumb" />
            </button>
          </div>

          <div className="set-option-row vertical">
            <div className="set-option-meta mb-2">
              <div className="set-option-label">
                <BellOff className="w-4 h-4 text-slate-400 shrink-0" />
                <span>{t('snooze')}</span>
              </div>
            </div>
            <div className="seg-control full-width">
              <button
                type="button"
                className={snooze === 'off' ? 'seg-btn active' : 'seg-btn'}
                onClick={() => {
                  setSnooze('off')
                  triggerSavedNotice()
                }}
              >
                {t('snoozeOff')}
              </button>
              <button
                type="button"
                className={snooze === '15m' ? 'seg-btn active' : 'seg-btn'}
                onClick={() => {
                  setSnooze('15m')
                  triggerSavedNotice()
                }}
              >
                {t('snooze15')}
              </button>
              <button
                type="button"
                className={snooze === '1h' ? 'seg-btn active' : 'seg-btn'}
                onClick={() => {
                  setSnooze('1h')
                  triggerSavedNotice()
                }}
              >
                {t('snooze1h')}
              </button>
              <button
                type="button"
                className={snooze === 'until' ? 'seg-btn active' : 'seg-btn'}
                onClick={() => {
                  setSnooze('until')
                  triggerSavedNotice()
                }}
              >
                {t('snoozeUntil')}
              </button>
            </div>
          </div>

          <div className="set-notice-box">
            <Shield className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
            <p className="text-xs text-slate-300 leading-relaxed font-normal">{t('notifNote')}</p>
          </div>
        </motion.div>

        {/* CARD 3: ACCOUNT & SESSION */}
        <motion.div
          className="panel glass set-card"
          variants={cardVariants}
          whileHover={{ y: -3, boxShadow: '0 12px 30px rgba(124, 58, 237, 0.15)' }}
        >
          <div className="set-card-header">
            <User className="w-5 h-5 text-purple-400 shrink-0" />
            <h2 className="set-card-title">{t('account')}</h2>
          </div>

          <div className="info-kv-grid">
            <div className="info-kv-item">
              <span className="kv-label">{t('userName')}</span>
              <span className="kv-val mono font-semibold">{user?.displayName ?? '—'}</span>
            </div>
            <div className="info-kv-item">
              <span className="kv-label">{t('userRole')}</span>
              {/* role = จอแสดงผลของสิ่งที่เซิร์ฟเวอร์ตัดสินมา — เปลี่ยนที่นี่ไม่ได้ */}
              <span className="badge-role font-mono">{user?.role ?? '—'}</span>
            </div>
            <div className="info-kv-item">
              <span className="kv-label">{t('assignedCams')}</span>
              <span className="kv-val mono">
                {cameras.length ? cameras.map((c) => c.id).join(', ') : '—'}
              </span>
            </div>
            <div className="info-kv-item">
              <span className="kv-label">{lang === 'th' ? 'ชื่อบัญชี (Username)' : 'Account username'}</span>
              <span className="kv-val mono">{user?.username ?? '—'}</span>
            </div>
          </div>

          <div className="set-option-row" style={{ marginTop: 8 }}>
            <div className="set-option-meta">
              <div className="set-option-label">
                <LogOut className="w-4 h-4 text-slate-400 shrink-0" />
                <span>{lang === 'th' ? 'ออกจากระบบ' : 'Sign out'}</span>
              </div>
              <div className="set-option-desc">
                {lang === 'th'
                  ? 'ทำลายเซสชันฝั่งเซิร์ฟเวอร์ทันที'
                  : 'Destroys the server-side session immediately'}
              </div>
            </div>
            <button type="button" className="signoutbtn" onClick={onSignOut}>
              <LogOut aria-hidden="true" />
              {lang === 'th' ? 'ออกจากระบบ' : 'Sign out'}
            </button>
          </div>
        </motion.div>

        {/* CARD 4: SYSTEM STATUS */}
        <motion.div
          className="panel glass set-card"
          variants={cardVariants}
          whileHover={{ y: -3, boxShadow: '0 12px 30px rgba(124, 58, 237, 0.15)' }}
        >
          <div className="set-card-header">
            <Shield className="w-5 h-5 text-cyan-400 shrink-0" />
            <h2 className="set-card-title">System Status</h2>
          </div>

          <div className="info-kv-grid">
            <div className="info-kv-item">
              <span className="kv-label">System Version</span>
              <span className="kv-val mono">AEGIS Monitor v3.0</span>
            </div>
            <div className="info-kv-item">
              <span className="kv-label">{t('nodeStatus')}</span>
              <span className="kv-val status-tag online mono">
                <span className="dot-pulse green" />
                {t('online')}
              </span>
            </div>
            <div className="info-kv-item">
              <span className="kv-label">{t('aiEngine')}</span>
              <span className="kv-val status-tag cyan mono">
                <span className="dot-pulse cyan" />
                {t('running')}
              </span>
            </div>
          </div>
        </motion.div>
      </motion.div>
    </motion.div>
  )
}

import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createServer, normalizePath } from 'vite'
import reactPlugin from '@vitejs/plugin-react'

import { LANGS, STRINGS, makeT } from '../src/lib/strings.js'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mockHooksPath = normalizePath(path.join(rootDir, 'tests/fixtures/mockHooks.js'))

let vite
let ErrorBoundary
let Files

before(async () => {
  vite = await createServer({
    configFile: false,
    root: rootDir,
    appType: 'custom',
    logLevel: 'silent',
    plugins: [reactPlugin()],
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true },
    resolve: { alias: [{ find: '../lib/hooks.js', replacement: mockHooksPath }] },
  })
  ;({ ErrorBoundary } = await vite.ssrLoadModule('/src/components/ErrorBoundary.jsx'))
  ;({ Files } = await vite.ssrLoadModule('/src/screens/Files.jsx'))
})

after(async () => {
  await vite?.close()
})

function installDom(lang = 'en') {
  const dom = new JSDOM(`<!doctype html><html lang="${lang}"><body><div id="root"></div></body></html>`, {
    url: 'http://localhost/drive/files',
    pretendToBeVisual: true,
  })
  const previous = new Map()
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    MutationObserver: dom.window.MutationObserver,
    IntersectionObserver: class {
      observe(target) { this.callback?.([{ isIntersecting: true, target }]) }
      unobserve() {}
      disconnect() {}
      constructor(callback) { this.callback = callback }
    },
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  dom.window.Element.prototype.scrollIntoView = () => {}
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  return {
    restore() {
      for (const [key, descriptor] of previous) {
        if (descriptor === undefined) delete globalThis[key]
        else Object.defineProperty(globalThis, key, descriptor)
      }
      dom.window.close()
    },
  }
}

async function render(element, lang = 'en') {
  const env = installDom(lang)
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(document.getElementById('root'))
  await act(async () => root.render(element))
  return {
    document,
    async cleanup() {
      await act(async () => root.unmount())
      env.restore()
    },
  }
}

test('TH, EN, and ZH keep exact key parity with no empty values or wrong-script fallback', () => {
  const referenceKeys = Object.keys(STRINGS.en).sort()
  for (const lang of LANGS) {
    assert.deepEqual(Object.keys(STRINGS[lang]).sort(), referenceKeys, `${lang} key set must match English`)
    assert.equal(Object.values(STRINGS[lang]).some((value) => typeof value !== 'string' || !value.trim()), false)
  }
  assert.equal(Object.values(STRINGS.en).some((value) => /[ก-๙一-龥]/u.test(value)), false)
  assert.equal(Object.values(STRINGS.th).some((value) => /[一-龥]/u.test(value)), false)
  assert.equal(Object.values(STRINGS.zh).some((value) => /[ก-๙]/u.test(value)), false)
})

test('share scope copy describes AEGIS reachability and current CIDR limits in every locale', () => {
  const labels = {
    en: {
      scopeAny: 'Any AEGIS-reachable network',
      scopeAnyTitle: 'Any AEGIS-reachable network',
      chipAnyNetwork: 'AEGIS-REACHABLE',
    },
    th: {
      scopeAny: 'ทุกเครือข่ายที่เข้าถึง AEGIS ได้',
      scopeAnyTitle: 'ทุกเครือข่ายที่เข้าถึง AEGIS ได้',
      chipAnyNetwork: 'เข้าถึง AEGIS ได้',
    },
    zh: {
      scopeAny: '任何可访问 AEGIS 的网络',
      scopeAnyTitle: '任何可访问 AEGIS 的网络',
      chipAnyNetwork: '可访问 AEGIS',
    },
  }
  for (const lang of LANGS) {
    for (const [key, value] of Object.entries(labels[lang])) {
      assert.equal(STRINGS[lang][key], value, `${lang}.${key}`)
    }
  }

  assert.match(`${STRINGS.en.newShareSub} ${STRINGS.en.scopeAnyBody}`, /Public Internet sharing is not currently available/)
  assert.match(`${STRINGS.en.scopeZonesBody} ${STRINGS.en.scopeEnforcementNote}`, /source address visible to AEGIS/)
  assert.match(`${STRINGS.en.scopeZonesBody} ${STRINGS.en.scopeEnforcementNote}`, /Twingate recipients may appear through the connector-visible address/)
  assert.match(`${STRINGS.en.scopeZonesBody} ${STRINGS.en.scopeEnforcementNote}`, /not a substitute for Twingate access or device policy/)

  assert.match(`${STRINGS.th.newShareSub} ${STRINGS.th.scopeAnyBody}`, /ยังไม่รองรับการแชร์ผ่านอินเทอร์เน็ตสาธารณะ/)
  assert.match(`${STRINGS.th.scopeZonesBody} ${STRINGS.th.scopeEnforcementNote}`, /ที่อยู่ต้นทางที่ AEGIS มองเห็น/)
  assert.match(`${STRINGS.th.scopeZonesBody} ${STRINGS.th.scopeEnforcementNote}`, /Twingate.*ที่อยู่ที่ Connector มองเห็น/)
  assert.match(`${STRINGS.th.scopeZonesBody} ${STRINGS.th.scopeEnforcementNote}`, /ไม่ใช้แทนนโยบายการเข้าถึงของ Twingate หรือนโยบายอุปกรณ์/)

  assert.match(`${STRINGS.zh.newShareSub} ${STRINGS.zh.scopeAnyBody}`, /当前不支持通过公共互联网共享/)
  assert.match(`${STRINGS.zh.scopeZonesBody} ${STRINGS.zh.scopeEnforcementNote}`, /AEGIS 可见的来源地址/)
  assert.match(`${STRINGS.zh.scopeZonesBody} ${STRINGS.zh.scopeEnforcementNote}`, /Twingate.*连接器可见地址/)
  assert.match(`${STRINGS.zh.scopeZonesBody} ${STRINGS.zh.scopeEnforcementNote}`, /不能替代 Twingate 访问策略或设备策略/)
})

test('Dashboard and navigation use the approved user-facing terminology in all three languages', () => {
  const expected = {
    en: {
      statFiles: 'Total Files',
      lakeHealth: 'Data Lake Health',
      serverTelemetry: 'Server Telemetry',
      navVault: 'Private Vault',
      navShares: 'Secure Shares',
    },
    th: {
      statFiles: 'ไฟล์ทั้งหมด',
      lakeHealth: 'สถานะระบบ Data Lake',
      serverTelemetry: 'ข้อมูลสถานะเซิร์ฟเวอร์',
      navVault: 'ห้องนิรภัยส่วนตัว',
      navShares: 'ลิงก์แชร์ปลอดภัย',
    },
    zh: {
      statFiles: '文件总数',
      lakeHealth: 'Data Lake 运行状态',
      serverTelemetry: '服务器运行指标',
      navVault: '私人保险库',
      navShares: '安全共享链接',
    },
  }
  for (const lang of LANGS) {
    for (const [key, value] of Object.entries(expected[lang])) assert.equal(STRINGS[lang][key], value)
  }
})

test('context search labels describe the actual task scope instead of generic or incomplete copy', () => {
  const expected = {
    en: ['Search AEGIS Drive…', 'Search files and folders…', 'Search shares and files…', 'Search files or versions…', 'Search events, users, IPs, or resources…', 'Search users…'],
    th: ['ค้นหาใน AEGIS Drive…', 'ค้นหาไฟล์และโฟลเดอร์…', 'ค้นหาลิงก์แชร์และไฟล์…', 'ค้นหาไฟล์หรือเวอร์ชัน…', 'ค้นหาเหตุการณ์ ผู้ใช้ IP หรือทรัพยากร…', 'ค้นหาผู้ใช้…'],
    zh: ['搜索 AEGIS Drive…', '搜索文件和文件夹…', '搜索共享链接和文件…', '搜索文件或版本…', '搜索事件、用户、IP 或资源…', '搜索用户…'],
  }
  const keys = ['searchDashboardPlaceholder', 'searchFilesPlaceholder', 'searchSharesPlaceholder', 'searchVersionsPlaceholder', 'searchAuditPlaceholder', 'searchPeoplePlaceholder']
  for (const lang of LANGS) assert.deepEqual(keys.map((key) => STRINGS[lang][key]), expected[lang])
})

test('task, status, and administration terms stay canonical and preserve data honesty', () => {
  const expected = {
    en: {
      statStorage: 'Storage Used', activeLinks: 'Active Shares', filesUnavailable: 'Files are unavailable',
      emptyNoFilesHint: 'Upload a file or create a folder to get started.',
      emptyNoUploadsHint: 'Drop files above to upload them to the current folder.',
      createSecureShare: 'Create Secure Share', sharesTitle: 'Secure Shares',
      diskHealth: 'Disk Health', backupJobs: 'Backup Jobs', setAdmin: 'Administrator',
      permMatrix: 'Role Permission Reference', vaultTitle: 'Private Vault', openPrivateVault: 'Open Private Vault',
    },
    th: {
      statStorage: 'พื้นที่จัดเก็บที่ใช้ไป', activeLinks: 'ลิงก์แชร์ที่ใช้งานอยู่', filesUnavailable: 'ไม่สามารถโหลดไฟล์ได้',
      emptyNoFilesHint: 'อัปโหลดไฟล์หรือสร้างโฟลเดอร์เพื่อเริ่มต้น',
      emptyNoUploadsHint: 'ลากไฟล์มาวางด้านบนเพื่ออัปโหลดไปยังโฟลเดอร์ปัจจุบัน',
      createSecureShare: 'สร้างลิงก์แชร์ปลอดภัย', sharesTitle: 'ลิงก์แชร์ปลอดภัย',
      diskHealth: 'สถานะดิสก์', backupJobs: 'งานสำรองข้อมูล', setAdmin: 'ผู้ดูแลระบบ',
      permMatrix: 'ตารางสิทธิ์ตามบทบาท', vaultTitle: 'ห้องนิรภัยส่วนตัว', openPrivateVault: 'เปิดห้องนิรภัยส่วนตัว',
    },
    zh: {
      statStorage: '已用存储空间', activeLinks: '活跃共享链接', filesUnavailable: '无法加载文件',
      emptyNoFilesHint: '上传文件或创建文件夹以开始使用。',
      emptyNoUploadsHint: '将文件拖放到上方，以上传到当前文件夹。',
      createSecureShare: '创建安全共享', sharesTitle: '安全共享链接',
      diskHealth: '磁盘健康状态', backupJobs: '备份任务', setAdmin: '管理员',
      permMatrix: '角色权限参考', vaultTitle: '私人保险库', openPrivateVault: '打开私人保险库',
    },
  }
  for (const lang of LANGS) {
    for (const [key, value] of Object.entries(expected[lang])) assert.equal(STRINGS[lang][key], value, `${lang}.${key}`)
  }
})

test('ErrorBoundary renders one selected language without mixed-language fallback copy', async () => {
  const expected = {
    en: ['Something went wrong', 'This page could not be rendered. Technical details were logged to the browser console.', 'Reload'],
    th: ['เกิดข้อผิดพลาดที่ไม่คาดคิด', 'ไม่สามารถแสดงหน้านี้ได้ รายละเอียดทางเทคนิคถูกบันทึกไว้ในคอนโซลของเบราว์เซอร์', 'โหลดใหม่'],
    zh: ['发生意外错误', '无法显示此页面。技术详情已记录在浏览器控制台中。', '重新加载'],
  }
  const originalError = console.error
  console.error = () => {}
  try {
    for (const lang of LANGS) {
      const Boom = () => { throw new Error('render probe') }
      const view = await render(React.createElement(ErrorBoundary, null, React.createElement(Boom)), lang)
      try {
        const alert = view.document.querySelector('[role="alert"]')
        assert.ok(alert)
        assert.deepEqual([...alert.querySelectorAll('p, button')].map((node) => node.textContent.trim()), expected[lang])
      } finally {
        await view.cleanup()
      }
    }
  } finally {
    console.error = originalError
  }
})

test('Files exposes localized overflow actions to assistive technology', async () => {
  globalThis.__AEGIS_API_FIXTURES__ = {
    '/api/files': {
      loading: false,
      error: null,
      data: { files: [{ id: 'f1', name: 'report.pdf', ext: 'pdf', type: 'PDF', size: 1024, modified: 1, uploader: 'admin', path: '/report.pdf', sha256: 'a'.repeat(64), vault: false }] },
    },
  }
  const view = await render(React.createElement(Files, { t: makeT('th'), lang: 'th', go() {}, placeholderMode: false }), 'th')
  try {
    assert.ok(view.document.querySelector('button[aria-label="การดำเนินการเพิ่มเติม"]'))
    assert.equal(view.document.querySelector('button[aria-label="More"]'), null)
  } finally {
    delete globalThis.__AEGIS_API_FIXTURES__
    await view.cleanup()
  }
})

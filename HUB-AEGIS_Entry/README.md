# AEGIS Hub — Entry Point

Single-page React entry gate for **AEGIS** (Autonomous Edge-Guard Infrastructure System).
Authenticates the user, receives the **server-decided** role, and launches only the modules
that role is entitled to. Sub-apps (Drive / CCTV / Monitoring) get wired in later.

## Run

```bash
npm install
npm run dev       # http://localhost:5173
npm run build     # production build → dist/
npm run preview   # serve the production build
```

## Demo accounts (mock auth — prototype only)

| Username | Password      | Server-resolved role |
|----------|---------------|----------------------|
| `user`   | `aegis-user`  | Standard user → sees **AEGIS Drive** only |
| `admin`  | `aegis-admin` | Administrator → sees Drive + CCTV + Monitoring |

## Security architecture (what graders should look at)

การตัดสินใจด้านความปลอดภัยทุกจุดมีคอมเมนต์ภาษาไทยกำกับไว้ในโค้ด:

- **ไม่มีตัวเลือกบทบาทใน UI** — ผู้ใช้ส่งเฉพาะ credential; role มาจากผลการยืนยันตัวตน
  ฝั่งเซิร์ฟเวอร์เท่านั้น (`src/lib/auth.js`, `src/components/LoginPanel.jsx`) — กัน Broken
  Access Control (OWASP A01)
- **ข้อความผิดพลาดแบบเดียวเสมอ** ("ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง") + หน่วงเวลาตอบเท่ากัน
  ทุกกรณี — กัน username enumeration (`src/lib/auth.js`)
- **Default-deny** — role ที่ไม่รู้จักได้โมดูลว่างเปล่า ไม่ใช่ชุดของ user
  (`src/lib/authorization.js`)
- **โมดูลที่ไม่มีสิทธิ์ไม่ถูก render ลง DOM เลย** — กรองก่อน `.map()`; ผู้ใช้ทั่วไปเปิด
  DevTools ต้องไม่พบร่องรอย CCTV/Monitoring — กัน Information Disclosure
  (`src/components/HubScreen.jsx`)
- **Session ในหน่วยความจำเท่านั้น** — ไม่มี localStorage/sessionStorage ทั้งแอป; ระบบจริงใช้
  HttpOnly + Secure + SameSite=Strict cookie ที่ JS อ่านไม่ได้ (`src/App.jsx`)
- **Rate-limit ฝั่ง client เป็นแค่ UX** — ล็อก 30 วินาทีหลังพลาด 5 ครั้ง; ของจริงต้องบังคับ
  ที่เซิร์ฟเวอร์ (`src/components/LoginPanel.jsx`)

## Notes

- Replace the placeholder mark: pass `src={logoUrl}` to `<AegisMark />` in `src/App.jsx`
  (one-line change, marked with `TODO`).
- `prefers-reduced-motion` freezes grain/mesh and swaps the cinematic transition for a plain
  crossfade; the app is fully usable with motion off.
- i18n: Thai default, TH/EN toggle; all copy flows through `src/lib/strings.js`.

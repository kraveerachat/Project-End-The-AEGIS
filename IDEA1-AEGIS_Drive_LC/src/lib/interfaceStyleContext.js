import { createContext, useContext } from 'react'

/* สไตล์ของ authenticated shell ที่ App ตัดสินแล้ว (classic | neo) — สำหรับ "การแสดงผล" เท่านั้น
   ⚠️ ห้ามใช้ค่านี้ตัดสินสิทธิ์หรือข้อมูลใด ๆ: เป็นแค่ตัวเลือก markup ที่ต่างกันระหว่างสองสไตล์
   (เช่น สวิตช์ธีมแบบราง/ปุ่มเลื่อน และ ring gauge ของ Classic) เพื่อไม่ให้ Neo เปลี่ยนตามไปด้วย */
// ค่าเริ่มต้น null = นอก authenticated shell (เช่น Login ที่เป็นสัญญา UX ที่ Owner ควบคุม) — ไม่ใช่ Classic
export const InterfaceStyleContext = createContext(null)

export const useInterfaceStyle = () => useContext(InterfaceStyleContext)
export const useIsClassic = () => useContext(InterfaceStyleContext) === 'classic'

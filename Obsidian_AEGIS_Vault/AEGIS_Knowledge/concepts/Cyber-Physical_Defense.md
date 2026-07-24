---
title: Cyber-Physical Defense
tags: [aegis, concept, security, cyber-physical]
type: concept
created: 2026-07-20
updated: 2026-07-20
sources: ["[[raw/AEGIS_Project_Knowledge_v7]]"]
---

# 🛡️ Cyber-Physical Defense Concept

> **แนวคิดหลัก**: ระบบรักษาความปลอดภัยที่ป้องกันทั้งในมิติไซเบอร์ (Software/Network) และกายภาพ (Physical World) พร้อมกันอย่างเป็นเอกภาพ โดยเน้นการประมวลผลบน **Edge Computing** ที่ทำงานต่อได้แม้อินเทอร์เน็ตภายนอกโดนตัด

---

## 🎯 ปรัชญาการออกแบบ

1. **ไม่พึ่งพา Cloud (Edge-Centric)**: ข้อมูลทั้งหมดถูกจัดเก็บและประมวลผลภายในระบบ Local NAS ขององค์กร ป้องกันปัญหา Data Privacy และการแอบนำข้อมูลไปเทรน AI
2. **การตอบสนองระดับกายภาพ**: หากระบบตรวจพบการบุกรุกร้ายแรงที่ระดับ ซอฟต์แวร์/Root Compromise ระบบจะสั่งตัดวงจรเครือข่ายระดับกายภาพทันที (**Physical Isolation / Air-Gap**)
3. **การทำงานร่วมกัน 3 องค์ประกอบ**:
   - **[[entities/Beelink_Mini_S_NAS|NAS Server]]**: เป็นสมองสั่งการและคลังข้อมูลหลัก
   - **[[03 - 📹 IDEA2 AEGIS Monitor|AI CCTV (IDEA 2)]]**: ตรวจจับภัยคุกคามทางกายภาพ (ใบหน้า/บุคคลแปลกหน้า)
   - **[[04 - 🔒 IDEA3 AEGIS Lockdown|Lockdown Breaker (IDEA 3)]]**: ตัดวงจรเครือข่ายเมื่อโดนโจมตี

---

## 🔗 ความสัมพันธ์กับแนวคิดอื่น
* [[concepts/Contain_Before_Notify]]
* [[concepts/Dead_Mans_Switch]]
* [[concepts/OWASP_Security_Defense]]

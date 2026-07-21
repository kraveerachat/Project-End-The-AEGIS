# 🤖 AI Agent Workflow & Vibe Coding Obsidian Sync Rules

> **MANDATORY INSTRUCTION FOR CLAUDE CODE & AI AGENTS**:  
> Upon completing any user prompt, feature request, or "Vibe Coding" task, the AI Agent MUST automatically update the Obsidian Knowledge Base at `C:\Users\User\AEGIS_System\Obsidian_AEGIS_Vault\AEGIS_Knowledge`.

---

## ⚡ AUTOMATIC POST-PROMPT SYNC WORKFLOW

เมื่อ Agent ทำงานเสร็จสิ้นตาม Prompt ที่ผู้ใช้สั่งการ ให้ดำเนินกระบวนการอัปเดตความรู้เข้าสู่ Obsidian ทันทีดังนี้:

📍 **Target Vault Path**:  
`C:\Users\User\AEGIS_System\Obsidian_AEGIS_Vault\AEGIS_Knowledge`

---

### 📌 หลักการแก้ไขเอกสาร (In-Place Update & Deduplication Policy)

1. **แก้ไขในไฟล์เดิมเป็นหลัก (In-Place Edit)**:
   * หากฟีเจอร์หรือโค้ดที่ทำสัมพันธ์กับ Note เดิมที่มีอยู่แล้ว (เช่น `02 - 💾 IDEA1 AEGIS Drive LC.md`, `concepts/Identity_Decoupling.md`) **ให้อัปเดตเนื้อหาในไฟล์เดิมทันที**
   * หากมีเนื้อหาเดิมที่เก่าหรือล้าสมัย ให้ทำการปรับปรุง/แทนที่เนื้อหานั้นให้เป็นปัจจุบัน **เพื่อไม่ให้เกิดไฟล์ซ้ำซ้อนหรือเนื้อหาขัดแย้งกัน**

2. **สร้างไฟล์ใหม่เฉพาะกรณีจำเป็นเท่านั้น ([NEW])**:
   * จะสร้างไฟล์ `.md` ใหม่ใน `modules/`, `concepts/`, หรือ `entities/` เฉพาะเมื่อเป็นฟีเจอร์ใหม่/ระบบใหม่ที่ไม่มีในโครงสร้างเดิมเท่านั้น

---

### 📋 3 ขั้นตอนการอัปเดตหลังทำงานเสร็จตาม Prompt

#### ขั้นตอนที่ 1: สรุปและอัปเดตไฟล์ภาพรวมทั้งหมด (Master Summary)
* ปรับปรุงไฟล์ **`00 - 🗺️ AEGIS System Overview.md`** ให้สะท้อนถึงสถาปัตยกรรมล่าสุด (เช่น หากมี API, พอร์ต, หรือสิทธิ์ใหม่)
* หากมีการเปลี่ยนแปลง Flow การทำงาน ให้ปรับแก้ **Mermaid Diagram** ในไฟล์ภาพรวมทันที

#### ขั้นตอนที่ 2: อัปเดต Note เฉพาะส่วนที่เกี่ยวข้อง (In-Place Module/Concept Updates)
* ระบุไฟล์ในโค้ดที่ถูกแก้ไข (Source Code Paths)
* เข้าไปอัปเดต Note ประจำโมดูลหรือคอนเซ็ปต์นั้นๆ ใน `AEGIS_Knowledge` ให้ตรงตามโค้ดจริงล่าสุด

#### ขั้นตอนที่ 3: บันทึกประวัติใน `log.md` และดัชนี `index.md`
* หากมีการสร้าง Note ใหม่ ให้เพิ่มลิงก์ `[[...]]` ลงใน **`index.md`**
* เพิ่มประวัติการทำงานต่อท้าย **`log.md`**:
  ```markdown
  ## [YYYY-MM-DD] vibe-coding | <สรุปสั้นๆ ของ Prompt ที่ทำสำเร็จ>
  - **User Prompt Goal**: <เป้าหมายตาม Prompt ที่ได้รับ>
  - **Modified Code Paths**: `c:\Users\User\AEGIS_System\...`
  - **Obsidian Updates**: `[[Note ที่ได้รับการอัปเดต]]`
  - **Key Changes**: สรุปสิ่งที่เพิ่ม/แก้ไข/ลบออก
  ```

---

## 🛡️ CORE AEGIS ARCHITECTURAL PRINCIPLES (Never Violate)
1. **Server-Side Enforcement**: All auth/RBAC checks occur on backend Express servers.
2. **Identity Decoupling**: IDEA 1, IDEA 2, and HUB are independent identity domains.
3. **Fail-Secure & Air-Gap**: IDEA 3 hardware lockdown cuts WAN Uplink on Heartbeat loss (Dead Man's Switch).
4. **OWASP Hardening**: No `localStorage`/`sessionStorage` for tokens. Use HttpOnly + SameSite=Strict cookies + CSRF tokens.

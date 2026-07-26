---
title: AEGIS LLM Wiki Catalog Index
tags: [aegis, wiki, index, catalog]
type: catalog
created: 2026-07-20
updated: 2026-07-25
---

# 📚 AEGIS System LLM Wiki Catalog

> Master Index catalog of all structured knowledge pages maintained by the LLM Agent based on `AEGIS_System_Design.docx` and `AEGIS_Project_Knowledge.md`. Use this index to locate entity, concept, and architecture pages across the vault.

---

## 🗺️ System Architecture & Dashboard
* [[00 - 🗺️ AEGIS System Overview]] — ภาพรวมสถาปัตยกรรม Monorepo, Data Flow Diagram และตารางเปรียบเทียบโมดูลทั้งหมด
* [[AEGIS_Architecture_Canvas.canvas]] — Interactive 2D Visual Canvas แสดงผังความเชื่อมโยงของระบบ

---

## 📦 Core Modules (numbered top-level notes)
* [[01 - 🚪 HUB-AEGIS Entry]] — App picker แบบ static ไม่มี login/backend ของตัวเอง (เสิร์ฟที่ `/` โดย gateway)
* [[02 - 💾 IDEA1 AEGIS Drive LC]] — ระบบจัดเก็บไฟล์ระดับองค์กร Secure NAS & Edge Data Lake (Port `:8001` / `:5174`)
* [[03 - 📹 IDEA2 AEGIS Monitor]] — ศูนย์ควบคุมกล้องวงจรปิด Dual-View SOC & Scoped CCTV Operator (Port `:8002` / `:5176`)
* [[04 - 🔒 IDEA3 AEGIS Lockdown]] — ระบบตัดวงจรเครือข่ายระดับกายภาพผ่าน ESP32 + Relay (MQTT HMAC)
* [[05 - 🛡️ Security Architecture]] — สถาปัตยกรรมความปลอดภัย Server-Side Enforcement & Identity Decoupling

---

## 🧠 Architectural & Security Concepts (`concepts/`)
* [[concepts/Cyber-Physical_Defense]] — การป้องกันระบบ 2 มิติพร้อมกัน (ไซเบอร์ + กายภาพ) บน Edge Computing
* [[concepts/Identity_Decoupling]] — การแยกฐานข้อมูลผู้ใช้และสิทธิ์การใช้งาน (RBAC) อิสระในแต่ละแอปพลิเคชัน (v4 Architecture)
* [[concepts/Dead_Mans_Switch]] — ตรรกะกลับด้าน Fail-Secure ใช้สัญญาณ Heartbeat เงียบเป็นตัวสั่งตัดวงจร
* [[concepts/Contain_Before_Notify]] — การควบคุมความเสียหายระดับกายภาพก่อนส่งการแจ้งเตือน (NIST SP 800-61)
* [[concepts/VLAN_Segmentation_and_Port_Mapping]] — ผังการแบ่ง Layer 2 VLAN, Port Mapping และ Docker Macvlan IP
* [[concepts/Three_Layer_Data_Lake]] — การจำลองคลังข้อมูล 3 ชั้น (Storage, Metadata, Application) บน NAS
* [[concepts/OWASP_Security_Defense]] — มาตรการป้องกัน OWASP Top 10, Bcrypt Timing Equalization, และ Anti-CSRF
* [[concepts/ZTNA_Twingate_vs_OpenVPN]] — สถาปัตยกรรมรีโมทระยะไกล 2 เส้นทาง (OpenVPN ด่าน 0-A vs Twingate ZTNA ด่าน 0-B)
* [[concepts/Mnemonic_Recovery_and_Zero_Knowledge]] — Zero-Knowledge Private Vault: **Argon2id → KEK + envelope AES-256-GCM ต่อไฟล์** (build แล้ว 2026-07-26) · BIP-39 12 คำ = 🔴 ยังไม่ได้ build · **ไม่มีการกู้ passphrase โดยเจตนา**

---

## 🛠️ Hardware & Team Entities (`entities/`)
* [[entities/Beelink_Mini_S_NAS]] — สเปกและสถาปัตยกรรม NAS Server หลัก (Intel N5095 x86-64)
* [[entities/ESP32_Relay_Module]] — ข้อมูลอุปกรณ์และฮาร์ดแวร์บอร์ด ESP32, Relay Module และ LED Status
* [[entities/MikroTik_hEX_lite]] — ข้อมูล Edge Router Gateway (RB750r2) สำหรับสร้าง Inter-VLAN Routing & OpenVPN
* [[entities/TP-Link_TL-SG105E]] — ข้อมูล Managed Switch 5-Port สำหรับจัดแบ่ง VLAN 10/20/30
* [[entities/Team_Roles_and_Responsibilities]] — สมาชิกทีม 3 คน (มิวสิค, พับ, กล้า) ขอบเขตความรับผิดชอบ และอาจารย์ที่ปรึกษา

---

## 📂 Raw Sources (`raw/`)
* [[raw/AEGIS_System_Design_extracted]] — เนื้อหาฉบับเต็มจากเล่มรายงานหลัก `AEGIS_System_Design.docx`
* [[raw/AEGIS_Project_Knowledge_v7]] — แหล่งข้อมูลความรู้โครงการจาก `AEGIS_Project_Knowledge.md` (v7)

---

## 📑 Ethics & Compliance (`ethics/`)
* [[ethics/Participant_Information_Sheet_IDEA2]] — เอกสารข้อมูลคำอธิบายสำหรับผู้เข้าร่วมวิจัย (PIS) สำหรับ IDEA 2 Facial Recognition · ยื่น HREC-SUT
* [[ethics/Informed_Consent_Form_IDEA2]] — หนังสือแสดงเจตนายินยอม (Consent Form) สำหรับ IDEA 2 · เน้น 100% Local Edge, เก็บเฉพาะ Name+RBAC, Retention Policy ตาม PDPA

---

## 🧪 Verification Docs (อยู่ที่ราก repo ไม่ใช่ใน vault)

> ⚠️ ไฟล์กลุ่มนี้อยู่ **นอก** vault จึงลิงก์ด้วย `[[wikilink]]` ไม่ได้ (Obsidian
> resolve ได้เฉพาะไฟล์ในโฟลเดอร์ vault) — อ้างอิงเป็น path ล้วนเสมอ

* `docs/auth-test.md` — คำสั่ง `curl` คัดลอกไปรันได้ทันที พิสูจน์ auth / RBAC / Scoped View ตาม `camera_assignment` / Storage Layer round-trip / Identity Decoupling ระดับ SQL

---

## ⚙️ Wiki Administration
* [[.schema.md]] — กฎการทำงานและมาตรฐานการรักษา Wiki สำหรับ LLM Agent
* [[log.md]] — ประวัติการปรับปรุงและประมวลผล Wiki (Append-only Log)

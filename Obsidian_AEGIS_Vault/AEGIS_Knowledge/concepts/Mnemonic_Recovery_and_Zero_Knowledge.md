---
title: Mnemonic Recovery & Zero Knowledge Architecture
tags: [aegis, concept, security, zero-knowledge, encryption, pdpa]
type: concept
created: 2026-07-20
updated: 2026-07-20
sources: ["[[raw/AEGIS_System_Design_extracted]]", "[[raw/AEGIS_Project_Knowledge_v7]]"]
---

# 🔐 Mnemonic Recovery & Zero-Knowledge Architecture

> **หลักการสำคัญ (จากรายงานหลัก Section 3.5.2 & 3.5.7)**: การสร้างสมดุลระหว่าง **ความปลอดภัยสูงสุดระดับลับเฉพาะ (Zero-Knowledge Encryption)** กับ **การใช้งานจริงในองค์กร** โดยใช้คำกู้คืน 12 คำ (BIP-39 Mnemonic Phrase)

---

## 💡 โครงสร้างการเข้ารหัส 2 โหมดใน AEGIS Drive

```mermaid
graph TD
    subgraph Mode1 [โหมด 1: Standard Encryption at Rest]
        ServerEnc["Server-Side Encryption"] --> FIM["รองรับ FIM, ค้นหาไฟล์, และทำ Thumbnail"]
        ServerEnc --> NormalFiles["ไฟล์ทั่วไปใน Data Lake"]
    end

    subgraph Mode2 [โหมด 2: Private Vault (Zero-Knowledge)]
        BrowserEnc["Client-Side AES-256 (ใน Browser ผู้ใช้)"] --> CipherText["ส่งเฉพาะ CipherText เข้า NAS"]
        Mnemonic["12-Word Mnemonic Phrase (BIP-39)"] -.->|กู้คืนกุญแจฝั่ง Client เท่านั้น| BrowserEnc
        CipherText --> NASVault["NAS เก็บเฉพาะก้อนข้อมูลที่อ่านไม่ออก"]
    end
```

---

## 🛠️ รายละเอียดกลไก Mnemonic Recovery Phrase (12 คำ)

1. **การสร้างกุญแจ**: เมื่อผู้ใช้เปิดใช้ Private Vault ระบบจะสร้างชุดคำกู้คืน 12 คำ (ตามมาตรฐาน BIP-39) ขึ้นในเบราว์เซอร์ของผู้ใช้
2. **Zero-Knowledge Principle**: ชุดคำ 12 คำนี้ **จะไม่ถูกส่งไปยัง NAS Server เลย** (เซิร์ฟเวอร์เก็บเฉพาะค่าที่ผ่านการเข้ารหัสแล้ว)
3. **การป้องกัน Insider Threat / Admin Abuse**: แม้แอดมินผู้ดูแลระบบสั่งเปิดดูไฟล์ในเซิร์ฟเวอร์ ก็จะไม่สามารถอ่านเนื้อหาหรือสร้างกุญแจขึ้นมาเปิดไฟล์ได้
4. **ความสอดคล้องกับ PDPA**: ป้องกันการเปิดเผยข้อมูลโดยไม่ได้รับอนุญาต และสอดคล้องกับแนวปฏิบัติการรักษาความมั่นคงปลอดภัยข้อมูลส่วนบุคคลอย่างรัดกุม

---

## 🔗 ความสัมพันธ์กับโน้ตอื่น
* [[modules/02_IDEA1_AEGIS_Drive_LC]]
* [[concepts/OWASP_Security_Defense]]
* [[concepts/Identity_Decoupling]]

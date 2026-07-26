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

    subgraph Mode2 [โหมด 2: Private Vault (Zero-Knowledge) — ของจริงที่ build แล้ว]
        Pass["Vault Passphrase<br/>(แยกจากรหัสผ่านบัญชี)"] -->|Argon2id m=64MiB t=3| KEK["KEK 256-bit<br/>(memory เท่านั้น)"]
        DEK["DEK 256-bit สุ่มใหม่ทุกไฟล์"] -->|AES-256-GCM| CipherText["ciphertext ของไฟล์"]
        KEK -->|wrap ด้วย AES-GCM| WrappedDEK["wrapped DEK"]
        CipherText --> NASVault[".aegisenc บน NAS<br/>NAS เก็บเฉพาะก้อนที่อ่านไม่ออก"]
        WrappedDEK --> Meta["vault_blobs (Postgres)"]
    end
```

---

## 🛠️ สถานะจริงของกลไกกู้คืน (สำคัญ — อ่านก่อนอ้างอิงในรายงาน)

> ⚠️ **reconcile 2026-07-26**: โน้ตฉบับก่อนหน้าบรรยายกลไก **BIP-39 Mnemonic 12 คำ** ราวกับว่าทำงานอยู่แล้ว
> ความจริงคือ **ยังไม่เคยถูก build** — และ Private Vault ที่ต่อท่อจริงเสร็จในรอบนี้ก็ **จงใจไม่มีการกู้คืน passphrase**

**สิ่งที่ build จริงแล้ว (ดู [[02 - 💾 IDEA1 AEGIS Drive LC]]):**
1. **Passphrase แยกขาดจากรหัสผ่านบัญชี** — ผู้ใช้ตั้งเองตอน setup ครั้งแรก (ขั้นต่ำ 12 ตัวอักษร + ต้องติ๊กยอมรับความเสี่ยงก่อนสร้าง)
2. **Zero-Knowledge Principle**: passphrase / KEK / DEK ที่ยังไม่ถูกห่อ **ไม่เคยออกจากเบราว์เซอร์** ไม่เคยอยู่ใน request body ไม่เคยถูก log
3. **การป้องกัน Insider Threat / Admin Abuse**: แม้แอดมินสั่งเปิดดูไฟล์ในเซิร์ฟเวอร์ ก็อ่านเนื้อหาไม่ได้และสร้างกุญแจขึ้นมาเปิดไม่ได้ — **พิสูจน์ด้วยเทสต์** ที่ให้ Admin ล็อกอินแล้วลองดึง blob ของผู้ใช้อื่น (ได้ 404) และสแกนหา plaintext ใน DB row / ไฟล์บนดิสก์ / server log / audit log
4. **ความสอดคล้องกับ PDPA**: ป้องกันการเปิดเผยข้อมูลโดยไม่ได้รับอนุญาต — audit บันทึกได้แค่ *ใคร/เมื่อไร/ทำอะไร* ไม่มีเนื้อหา ไม่มีชื่อไฟล์ (เซิร์ฟเวอร์ไม่รู้ชื่อไฟล์อยู่แล้วเพราะถูกเข้ารหัสด้วย DEK)
5. **ลืม passphrase = ข้อมูลหายถาวร** — ไม่มี endpoint รีเซ็ต และจะไม่มี เพราะเซิร์ฟเวอร์ไม่มีชิ้นส่วนใดที่ใช้กู้ KEK ได้เลย **UI พูดตรงตามนี้** (`vaultWarning`, `vaultSetupAck`) ไม่ใช่แค่คำโฆษณา
6. **ราคาที่ต้องจ่ายของ zero-knowledge: ค้นหาไม่ได้ — และ UI ยอมรับตรง ๆ (2026-07-26)**
   ช่องค้นหาระดับระบบมีอยู่ทุกจอ **ยกเว้นจอ Private Vault ที่ถูก `disabled` (เทา ไม่ใช่ซ่อน)** พร้อมทูลทิป `searchUnavailableVault`:
   > "ค้นหาไม่พร้อมใช้งานในห้องนิรภัย — เนื้อหาถูกเข้ารหัสแบบ zero-knowledge"

   **ซ่อนช่องไปเลยจะแย่กว่า** เพราะผู้ใช้จะคิดว่าเป็นบั๊ก — การแสดงช่องที่ถูกปิดพร้อมเหตุผลคือการสอนว่า *ทำไม* ระบบถึงค้นไม่ได้ (นี่คือ trade-off ของ Mode 2 ที่ Mode 1 ไม่มี ดูไดอะแกรมด้านบน: Mode 1 "รองรับค้นหาไฟล์" ได้เพราะเซิร์ฟเวอร์อ่านเนื้อหาออก)

   **ที่สำคัญ — ข้อจำกัดนี้บังคับใช้ที่โครงสร้าง ไม่ใช่ที่ `disabled` attribute** (ถอด attribute ใน devtools ก็ไม่ได้อะไร): ทั้งระบบ**ไม่มี endpoint ที่รับคำค้นเลย** · ดัชนีมาจาก `/api/files` ซึ่ง filter `!f.vault` คนละตารางกับ `vault_blobs` · และ `vault_blobs` **ไม่มีคอลัมน์ `name`/`mime`/`type` ตั้งแต่ระดับ schema** ส่วนชื่อไฟล์ที่ถอดรหัสแล้วอยู่ใน state ของ `Vault.jsx` เท่านั้น ไม่เคยขึ้นมาถึง `App.jsx` — ดู [[02 - 💾 IDEA1 AEGIS Drive LC]] หัวข้อ Global Search

## 🗑️ ถอด "คีย์กู้คืน 12 คำ" ปลอมออกจาก `Settings.jsx` แล้ว (2026-07-26)

> โน้ตฉบับ reconcile ก่อนหน้า (ด้านบน) บอกว่า BIP-39 "ยังไม่เคยถูก build" — **ถูกต้อง
> ในระดับ crypto แต่ยังมี UI ที่โฆษณามันอยู่จริง** และรอบนี้ตรวจเจอแล้วถอดออก

**สิ่งที่มีอยู่จริงในจอ Settings → Security (ก่อนถอด)**: การ์ด "Vault Recovery Key
(Mnemonic)" ที่กดสร้างคำ 12 คำได้ พร้อมขั้นตอน reveal → ติ๊กยืนยัน → สถานะ "active"
และปุ่ม regenerate — **ดูครบเหมือนฟีเจอร์จริงทุกขั้น**

**ทำไมมันเป็นเท็จ (วัดจากโค้ดจริง ไม่ใช่การเดา):**
1. สุ่มจากลิสต์ **36 คำ** (ไม่ใช่ 2048 คำของ BIP-39) ด้วย `Math.random()` ซึ่งไม่ใช่ CSPRNG
   ผ่าน `.sort(() => 0.5 - Math.random())` ที่ shuffle ไม่สม่ำเสมอ และไม่มี checksum
2. `Settings.jsx` **ไม่ได้ `import` `vaultCrypto.js` เลย** ไม่มี `apiFetch` ใด ๆ ผูกกับคำเหล่านี้
   และ**ไม่มี endpoint ฝั่งเซิร์ฟเวอร์รองรับ** — คำถูกสร้าง เบลอ เปิดเผย ยืนยัน แล้วทิ้ง
3. KEK จริงคือ `Argon2id(passphrase, salt)` ในเบราว์เซอร์เท่านั้น — 12 คำนั้น
   **ไม่มีความสัมพันธ์ทางคณิตศาสตร์กับกุญแจจริงแม้แต่บิตเดียว**
4. แต่ UI เขียนว่า **"Anyone with these words can decrypt your Vault"** และ
   **"only this recovery phrase can restore access"** — เท็จทั้งสองประโยค

**อันตรายที่แท้จริงไม่ใช่ dead code แต่คือคำสัญญา**: ผู้ใช้ที่เชื่อว่ามีทางกู้ จะเลิกกังวล
เรื่องจำ/เก็บ passphrase → ลืม passphrase = **ข้อมูลหายถาวรจริง** ทั้งที่ระบบเคยบอกว่ากู้ได้
นี่ขัดกับข้อ 5 ด้านบนที่เป็นสถาปัตยกรรมที่ตกลงกันไว้ (`ลืม passphrase = ข้อมูลหายถาวร`)
และจอ Vault ก็พูดถูกอยู่แล้วผ่าน `vaultWarning` / `vaultSetupAck` — **การ์ดใบนี้เป็นที่เดียว
ในแอปที่ขัดกับความจริงนั้น จึงเลือกถอดออก ไม่ใช่แก้ถ้อยคำ**

**ถอดอะไรออก**: `WORD_LIST`, `generate12Words()`, การ์ด "SECTION 2" ทั้งใบ (ทุกสถานะ:
none / generating / active) และ `useState` ที่กำพร้าทั้ง 4 ตัว · เหลือคอมเมนต์อธิบายไว้
กันคนเอากลับมาในรูปเดิม · ยืนยันแล้วว่า **bundle ที่ build ออกมาไม่มีสตริงเหล่านี้เหลือเลย**
(`"recovery phrase"`, `"Anyone with these words"`, `"Mnemonic"`, wordlist = 0 hit)

**ไม่ได้สร้างกลไกจริงแทน โดยเจตนา** — เป็นงานคนละขนาด และโน้ตนี้ระบุไว้แล้วว่า mnemonic
ก็ยัง "ไม่ใช่การกู้คืนที่เซิร์ฟเวอร์ช่วยได้" อยู่ดี จึงไม่มีการตัดสินใจใดถูกเลื่อนออกไป

**BIP-39 Mnemonic (🔴 ยังไม่ได้ build — ของอนาคต):**
* แนวคิดเดิมคือให้ระบบสุ่มคำ 12 คำแทนการให้ผู้ใช้ตั้ง passphrase เอง แล้ว derive KEK จากคำเหล่านั้น
* ถ้าจะทำจริงในอนาคต จุดต่อคือ `src/lib/vaultCrypto.js` — แทน `createVaultSetup()` ให้ derive จาก mnemonic entropy แทน passphrase ที่ผู้ใช้พิมพ์ ส่วนชั้น envelope (DEK/wrapped DEK) ไม่ต้องแก้เลย
* ⚠️ mnemonic **ไม่ใช่ "การกู้คืน" ในความหมายที่เซิร์ฟเวอร์ช่วยได้** — มันแค่ย้ายภาระการจำไปเป็นการเก็บกระดาษ ถ้าผู้ใช้ทำ 12 คำหาย ข้อมูลก็หายถาวรเหมือนเดิม

---

## 🔗 ความสัมพันธ์กับโน้ตอื่น
* [[02 - 💾 IDEA1 AEGIS Drive LC]]
* [[concepts/OWASP_Security_Defense]]
* [[concepts/Identity_Decoupling]]

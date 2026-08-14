# รายงานการแก้ไขระบบตรวจสอบ Owner ของ Obsidian Task Receipt

วันที่จัดทำ: 13 สิงหาคม 2026

Branch: `fix/shared-vault-receipt-ownership`

Commit ที่แก้ logic หลัก: `39654b6`

พื้นที่งาน: `shared`

ผู้รับผิดชอบ receipt: `kla`

สถานะ: แก้ไขและทดสอบในเครื่องผ่านแล้ว รอเปิด stacked PR, integration review และรัน GitHub Actions

## 1. สรุปสำหรับทีม

Task 1 PR #19 ของ IDEA2 ไม่ผ่านขั้นตอน `Validate Obsidian ownership and links` เพราะ validator เดิมตัดสิน owner จากตำแหน่งไฟล์เพียงอย่างเดียว เมื่อ receipt อยู่ใต้ `90-Status/logs/` ระบบจึงกำหนด owner เป็น `kla` โดยอัตโนมัติ แม้ receipt จะระบุ `area: idea2` และ `owner: pub` อย่างถูกต้องตามนโยบาย repository

ข้อความผิดพลาดเดิมคือ:

```text
90-Status/logs/2026-08-13_213827_pub_idea2-current-state-audit.md:
owner must be kla, received pub.
```

การแก้ไขครั้งนี้ทำให้ validator อ่าน `area` จาก frontmatter ของ task receipt แล้วบังคับ owner ตาม mapping จริง โดยไม่ได้ปิด validation และไม่ได้อนุญาตให้เลือก owner ใดก็ได้

## 2. สาเหตุของปัญหา

ฟังก์ชัน `ownerFor()` ใน `scripts/validate-vault.mjs` ตรวจ owner จาก path ของ note:

- path ใต้ `idea2/` ได้ owner `pub`
- path ใต้ `idea3/` ได้ owner `music`
- path อื่นที่ไม่เข้าเงื่อนไขได้ owner `kla`

Task receipt ทุก area ถูกเก็บรวมกันใต้ `90-Status/logs/` จึงไม่สามารถทราบ area จาก directory ได้ Receipt ของ IDEA2 จึงตกไปใช้ค่า default `kla` และถูกปฏิเสธอย่างไม่ถูกต้อง

## 3. สิ่งที่แก้ไข

เพิ่ม mapping กลางสำหรับ task receipt ดังนี้:

| Area ใน receipt | Owner ที่บังคับ |
|---|---|
| `idea1` | `kla` |
| `idea2` | `pub` |
| `idea3` | `music` |
| `infrastructure` | `kla` |
| `shared` | `kla` |

ลำดับการตรวจ receipt หลังแก้ไขคือ:

1. ตรวจว่า frontmatter มี owner ที่อยู่ในรายการ `kla`, `pub`, `music`
2. ตรวจว่า `area` เป็น area ที่ repository รองรับ
3. หา expected owner จาก `area`
4. ตรวจว่า frontmatter owner ตรงกับ expected owner
5. ตรวจว่า owner ในชื่อไฟล์ receipt ตรงกับ frontmatter owner
6. ตรวจรูปแบบชื่อไฟล์, `edit_policy` และหัวข้อหลักฐานที่บังคับเหมือนเดิม

สำหรับ note ปกติที่ไม่ใช่ task receipt ระบบยังใช้กฎ ownership ตาม path เหมือนเดิม จึงไม่มีการลดความเข้มงวดของการตรวจ note ส่วนอื่น

## 4. Regression tests ที่เพิ่ม

เพิ่ม test เพื่อยืนยันพฤติกรรมต่อไปนี้:

- ยอมรับ receipt ของ `idea1` เมื่อ owner เป็น `kla`
- ยอมรับ receipt ของ `idea2` เมื่อ owner เป็น `pub`
- ยอมรับ receipt ของ `idea3` เมื่อ owner เป็น `music`
- ยอมรับ receipt ของ `infrastructure` และ `shared` เมื่อ owner เป็น `kla`
- ปฏิเสธ receipt ที่ owner ตรงกับชื่อไฟล์ แต่ไม่ตรงกับ area
- ปฏิเสธ receipt ที่ไม่มี area ที่ระบบรู้จัก

ตัวอย่างสำคัญ: receipt ที่ใช้ชื่อ owner `pub` และ frontmatter `owner: pub` แต่ระบุ `area: idea1` จะยังถูกปฏิเสธ เพราะ IDEA1 ต้องเป็น `kla`

## 5. ผลการตรวจสอบ

| การตรวจ | ผลลัพธ์ |
|---|---|
| `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` | ผ่าน ไม่มี error และมีคำเตือน canvas เดิม 2 รายการ |
| `node --test tests/vaultStructure.test.mjs` | ผ่าน 24/24 tests |
| `node --test tests/*.test.mjs` | ผ่าน 45/45 tests |
| `git diff --check` | ผ่าน ไม่พบ whitespace error |

คำเตือนที่ยังคงอยู่เกี่ยวข้องกับ `AEGIS_Architecture_Canvas.canvas` และ `AEGIS_Knowledge_Network.canvas` ซึ่งมี owner data และต้องให้ owner ตรวจทาน คำเตือนเหล่านี้มีอยู่ก่อนงานนี้และไม่ใช่สาเหตุที่ PR #19 ล้มเหลว

## 6. ไฟล์ที่เปลี่ยน

- `scripts/validate-vault.mjs` — เปลี่ยนการหา expected owner ของ receipt ให้ใช้ `area`
- `tests/vaultStructure.test.mjs` — เพิ่ม regression tests สำหรับ owner mapping และกรณีผิดนโยบาย
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-08-13_233925_kla_vault-receipt-ownership-validator.md` — receipt ของ shared task นี้
- `docs/reports/2026-08-13-vault-receipt-ownership-validator-th.md` — รายงานภาษาไทยฉบับนี้

ไฟล์ Task 1 receipt `2026-08-13_213827_pub_idea2-current-state-audit.md` ไม่ได้ถูกเปลี่ยน owner และยังคงใช้ `pub` ตามนโยบาย IDEA2

## 7. ผลกระทบด้านนโยบายและความปลอดภัย

- ไม่ได้ปิดหรือข้าม ownership validation
- ไม่ได้เปลี่ยนให้ทุก owner ใช้ได้กับทุก area
- ไม่ได้ลดการตรวจรูปแบบชื่อ receipt หรือ frontmatter
- ไม่ได้แก้ owner ของ receipt เพื่อหลบ CI
- ทำให้ implementation ตรงกับ `AGENTS.md`, `.schema.md` และ collaboration policy ที่มีอยู่แล้ว

## 8. ขั้นตอนถัดไป

1. เปิด stacked PR จาก `fix/shared-vault-receipt-ownership` โดยใช้ base `docs/idea2-current-state-audit`
2. ตั้ง policy metadata เป็น `area: shared`, `owner: kla`, `integration-review: yes`
3. ให้ Kla ทำ integration review และให้ Pub ตรวจว่ากฎ IDEA2 ยังคงเป็น `pub`
4. เมื่อ fix เข้า Task 1 branch แล้ว ให้รัน GitHub Actions ของ PR #19 ใหม่
5. ยืนยันว่า `Validate Obsidian ownership and links` ผ่าน
6. ห้าม merge อัตโนมัติ และห้ามเปลี่ยน Task 1 receipt เป็น `kla`

## 9. วิธี rollback

หากพบว่าการแก้ไขขัดกับ policy ที่ได้รับอนุมัติใหม่ ให้ revert commit ที่แก้ validator และ tests ผ่าน Pull Request ห้าม rollback ด้วยการเปลี่ยน owner ของ IDEA2 receipt จาก `pub` เป็น `kla`

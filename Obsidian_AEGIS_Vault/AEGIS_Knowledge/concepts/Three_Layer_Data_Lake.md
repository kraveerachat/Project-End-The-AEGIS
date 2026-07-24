---
title: Three-Layer Edge Data Lake Architecture
tags: [aegis, concept, bigdata, datalake, nas, storage]
type: concept
created: 2026-07-20
updated: 2026-07-20
sources: ["[[raw/AEGIS_System_Design_extracted]]", "[[raw/AEGIS_Project_Knowledge_v7]]"]
---

# 🌊 Three-Layer Edge Data Lake Architecture

> **แนวคิดหลัก (จากรายงานหลัก Section 3.1)**: การประยุกต์ใช้ความรู้จากชุดวิชา Big Data Technology มาจำลองคลังข้อมูลบน Edge NAS แยกออกเป็น 3 ชั้นอิสระ เพื่อการคุมสิทธิ์แบบเป็นลำดับขั้น (Layered Access Control)

---

## 🏛️ โครงสร้าง 3 ชั้นของ Data Lake

```mermaid
graph TD
    subgraph AppLayer [Application Layer (แนวคิด Google Drive)]
        DriveGUI["AEGIS Drive Web GUI (:8001 / :5174)"]
        MonitorGUI["AEGIS Monitor Web GUI (:8002 / :5176)"]
    end

    subgraph MetaLayer [Metadata Layer (แนวคิด HIVE)]
        PostgresDB[("PostgreSQL Database<br/>(พอร์ต 10002 / DBA Confirm)")]
    end

    subgraph StorageLayer [Storage Layer (แนวคิด HDFS)]
        LinuxFS["Linux File System + 1TB HDD<br/>(พอร์ต 9870 / Basic Auth)"]
    end

    AppLayer -->|Query Metadata| MetaLayer
    AppLayer -->|Store/Retrieve Raw Files| StorageLayer

    classDef appStyle fill:#1e293b,stroke:#0284c7,color:#fff;
    classDef metaStyle fill:#334155,stroke:#64748b,color:#fff;
    classDef storeStyle fill:#0f172a,stroke:#38bdf8,color:#fff;

    class AppLayer appStyle;
    class MetaLayer metaStyle;
    class StorageLayer storeStyle;
```

---

## 📋 รายละเอียดแต่ละชั้น

1. **Storage Layer (แนวคิด HDFS)**: จัดเก็บไฟล์ดิบ (รูปภาพ, เอกสาร, คลิป Replay 10 นาทีจากกล้อง) ลงบน HDD 1TB ควบคุมด้วย NGINX Basic Auth (พอร์ต 9870)
2. **Metadata Layer (แนวคิด HIVE)**: จัดเก็บข้อมูลเชิงโครงสร้างใน PostgreSQL (เวลาอัปโหลด, ขนาดไฟล์, พิกัดกล้อง, Audit Log) ค้นหาได้รวดเร็วโดยไม่ต้องกวนฮาร์ดดิสก์
3. **Application Layer (แนวคิด Google Drive)**: หน้าเว็บ GUI ที่ผู้ใช้เข้าถึงผ่านเบราว์เซอร์ ทั้งแอป AEGIS Drive และ AEGIS Monitor อ่าน/เขียนผ่านชั้นนี้โดยไม่มีที่เก็บข้อมูลเป็นของตัวเอง

---

## 🔗 ความสัมพันธ์กับโน้ตอื่น
* [[02 - 💾 IDEA1 AEGIS Drive LC]]
* [[entities/Beelink_Mini_S_NAS]]
* [[concepts/Mnemonic_Recovery_and_Zero_Knowledge]]

---
title: Three-Layer Edge Data Lake Architecture
tags: [aegis, concept, bigdata, datalake, nas, storage]
type: concept
created: 2026-07-20
updated: 2026-07-20
sources: ["[[raw/AEGIS_System_Design_extracted]]", "[[raw/AEGIS_Project_Knowledge_v7]]"]
owner: kla
edit_policy: owner-writable
---

# 🌊 Three-Layer Edge Data Lake Architecture

> **Core Concept (Section 3.1)**: Applying Big Data Technology principles to simulate a 3-layer data repository on an Edge NAS for layered access control.

---

## 🏛️ Data Lake 3-Layer Structure

```mermaid
graph TD
    subgraph AppLayer [Application Layer (Google Drive Concept)]
        DriveGUI["AEGIS Drive Web GUI (:8001 / :5174)"]
        MonitorGUI["AEGIS Monitor Web GUI (:8002 / :5176)"]
    end

    subgraph MetaLayer [Metadata Layer (HIVE Concept)]
        PostgresDB[("PostgreSQL Database<br/>(Port 10002 / DBA Confirm)")]
    end

    subgraph StorageLayer [Storage Layer (HDFS Concept)]
        LinuxFS["Linux File System + 1TB HDD<br/>(Port 9870 / Basic Auth)"]
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

## 📋 Layer Details

1. **Storage Layer (HDFS Concept)**: Stores raw files (images, documents, 10-minute CCTV replay clips) directly on a 1TB HDD via Linux File System, protected by NGINX Basic Auth (Port 9870).
2. **Metadata Layer (HIVE Concept)**: Stores structured metadata in PostgreSQL (upload timestamps, file sizes, camera coordinates, audit logs) for fast querying without disturbing disk I/O.
3. **Application Layer (Google Drive Concept)**: Browser Web GUI accessed by users. Both AEGIS Drive and AEGIS Monitor interface through this layer without maintaining independent storage hardware.

---

## 🔗 Related Notes
* [[idea1/idea1-status]]
* [[entities/Beelink_Mini_S_NAS]]
* [[concepts/Mnemonic_Recovery_and_Zero_Knowledge]]

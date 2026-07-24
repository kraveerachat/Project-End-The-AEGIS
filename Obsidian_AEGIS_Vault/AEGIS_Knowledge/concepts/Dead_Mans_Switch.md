---
title: Dead Man's Switch (Heartbeat Watchdog)
tags: [aegis, concept, security, hardware, esp32, fail-secure]
type: concept
created: 2026-07-20
updated: 2026-07-20
sources: ["[[raw/AEGIS_Project_Knowledge_v7]]"]
---

# ⏱️ Dead Man's Switch & Fail-Secure Mechanism

> **แนวคิดหลัก**: การเปลี่ยนตรรกะจากการสั่งตัดเมื่อถูกโจมตี มาเป็นการให้เซิร์ฟเวอร์ [[entities/Beelink_Mini_S_NAS|NAS]] **ต้องส่งสัญญาณ Heartbeat (ลายเซ็น HMAC) อย่างต่อเนื่อง** หากสัญญาณเงียบหายไป อุปกรณ์ [[entities/ESP32_Relay_Module|ESP32]] จะตัดสาย Uplink ทันที (Fail-Secure)

---

## 🧩 ปัญหาเดิม vs ตรรกะกลับด้าน (Inverted Logic)

* **ปัญหาเดิม (Single Point of Trust)**: หากแฮกเกอร์ได้สิทธิ์ Root บน NAS สามารถสั่งปิด Service สั่งตัดวงจร (`systemctl stop mosquitto`) ทำให้คำสั่งตัดวงจรส่งไปไม่ถึง ESP32
* **วิธีแก้ปัญหา (Dead Man's Switch)**: ESP32 ตั้งเวลา Watchdog Timer (~60-120 วินาที) หากไม่ได้รับ Heartbeat HMAC จาก NAS ตามกำหนดเวลา ESP32 จะถือว่าระบบโดนควบคุม และสั่งตัดวงจร Uplink ทันที

```mermaid
flowchart TD
    NAS["Beelink NAS Server"] -->|Every N seconds: Signed HMAC Heartbeat| ESP32["ESP32 Controller"]
    
    alt Signal Received Normally
        ESP32 -->|Reset Timer| NormalState["Relay Status: NC (Connected)"]
    else Heartbeat Lost / Service Stopped
        ESP32 -->|Timer Expired| CutState["Relay Status: NO (CUT UPLINK)"]
    end
```

---

## ⚡ ข้อพิจารณาและ Trade-off
* **Security over Availability**: ยอมตัดสายเคเบิลโดยไม่จำเป็นชั่วคราว (เช่น กรณี NAS Reboot) เพื่อแลกกับการรับประกันว่าระบบจะไม่เปิดโอกาสให้แฮกเกอร์เชื่อมต่อค้างไว้
* **WAN vs LAN Scope**: การตัดวงจรมีผลเฉพาะ **WAN Uplink** เท่านั้น เครือข่าย **Management VLAN (VLAN 30)** และ **Local LAN** ยังทำงานได้ตามปกติ

---

## 🔗 ความสัมพันธ์กับโน้ตอื่น
* [[04 - 🔒 IDEA3 AEGIS Lockdown]]
* [[entities/ESP32_Relay_Module]]
* [[concepts/Contain_Before_Notify]]

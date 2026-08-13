---
title: Team Roles & Responsibilities
tags: [aegis, entity, team, responsibilities]
type: entity
created: 2026-07-20
updated: 2026-08-13
sources: ["[[raw/AEGIS_Project_Knowledge_v7]]"]
owner: kla
edit_policy: owner-writable
---

# 👥 Team Structure & Responsibilities

> **Course**: 1101911 Digital Technology Project 1 (Semester 1 / Academic Year 2026)  
> **Program**: Digital Technology, Institute of Social Technology, Suranaree University of Technology  
> **Advisor**: Asst. Prof. Dr. Songyut Pimpan

---

## 📋 Member List & Scope of Responsibility

| Student ID | Name | Nickname | Primary Role in Project |
| :--- | :--- | :--- | :--- |
| **B6701635** | Mr. Kittiphat Chanthasila | **Music** | **IDEA3 owner**: Lockdown firmware, ESP32 relay, signed MQTT command, watchdog/heartbeat and physical fail-secure behavior |
| **B6702861** | Mr. Naruebet Saengprathum | **Pub** | **IDEA2 owner**: AEGIS Monitor, CCTV Operator, camera ingest, Detection Engine integration and IDEA2 ethics notes |
| **B6703370** | Mr. Weerachat Jinaparivataporn | **Kla** | **Main coordinator / integration owner**: IDEA1 Drive, HUB, shared architecture/security, infrastructure/network/server/deployment and final integration |

---

---

## 🧭 Ownership map — which member owns which knowledge area

| Member | Owns these notes |
|---|---|
| **Music — IDEA3** | [[idea3/idea3-moc]] · [[idea3/idea3-status]] · [[entities/ESP32_Relay_Module]] · [[concepts/Dead_Mans_Switch]] · [[concepts/Contain_Before_Notify]] · [[concepts/Cyber-Physical_Defense]] |
| **Pub — IDEA2** | [[idea2/idea2-moc]] · [[idea2/idea2-status]] · [[entities/Detection_Engine_Service]] · [[ethics/Participant_Information_Sheet_IDEA2]] · [[ethics/Informed_Consent_Form_IDEA2]] |
| **Kla — core, IDEA1, infrastructure** | [[core/system-overview]] · [[core/integration-points]] · [[idea1/idea1-moc]] · [[idea1/idea1-status]] · [[infrastructure/infrastructure-moc]] · [[core/security-architecture]] |

## 🔀 Collaboration contract

| Work | Branch area | Canonical note | Receipt owner |
|---|---|---|---|
| IDEA1 | `idea1` | [[idea1/idea1-status]] | `kla` |
| IDEA2 | `idea2` | [[idea2/idea2-status]] | `pub` |
| IDEA3 | `idea3` | [[idea3/idea3-status]] | `music` |
| Infrastructure | `infrastructure` | [[infrastructure/infrastructure-moc]] and its subfolders | `kla` |
| Shared integration | `shared` | [[core/integration-points]] / [[90-Status/integration-queue]] | `kla` with affected-owner review |

Each task uses one branch, one Pull Request and one new immutable receipt. Nobody edits another owner's status fragment merely to record that their own task finished.

The team is also the participant group for the ethics submission — see [[ethics/Participant_Information_Sheet_IDEA2]], since face enrolment requires consent from the same "authorized internal personnel" who built the system.

---

## 🔗 Related Notes
* [[START_HERE]]
* [[core/system-overview]]
* [[concepts/Identity_Decoupling]]
* [[ethics/Informed_Consent_Form_IDEA2]]
* [[summaries/07_Ethics_and_Compliance]]

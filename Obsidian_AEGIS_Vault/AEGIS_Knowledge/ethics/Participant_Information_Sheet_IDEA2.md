---
Document: Participant Information Sheet
Project: AEGIS System — IDEA 2 (AEGIS AI Monitoring / Facial Recognition)
Status: Draft for submission to Suranaree University of Technology Human Research Ethics Committee (HREC-SUT)
Version: v1.0 — Date [____/____/2026]
owner: pub
edit_policy: owner-writable
---

# Participant Information Sheet

> **Usage Note:** This document is drafted according to the standard structure of the Human Research Ethics Committee of Suranaree University of Technology (HREC-SUT). Please fill out the official AF form of the office and complete all `[ ]` fields before formal submission.

---

**Research Project Title (Thai Translation):** Edge-Centric Cyber-Physical Security System with Integrated IoT and Local Data Center (AEGIS) — AI Monitoring & Facial Recognition Module (IDEA 2)

**Research Project Title (English):** Edge-Centric Cyber-Physical Security System with Integrated IoT and Local Data Center (AEGIS) — AI Monitoring & Facial Recognition Module

**Course:** 1101911 Digital Technology Project 1 · Digital Technology Program, Institute of Social Technology, Suranaree University of Technology

**Researchers (Students):**
- Mr. Kittiphat Chanthasila (B6701635)
- Mr. Naruebet Saengprathum (B6702861)
- Mr. Weerachat Jinaparivataporn (B6703370)

**Project Advisor:** Asst. Prof. Dr. Songyut Pimpan

**Research Location:** [Specify test area, e.g., Laboratory/Simulated Server Room, Building ____ SUT]

**Sponsor:** None (Academic Educational Project)

---

### 1. Invitation and Introduction
Dear prospective research participants, the research team invites you to voluntarily participate in this research study. Before deciding, please read this document carefully to understand the background, procedures, benefits, and potential risks. You are welcome to ask the research team questions at any time. Whether you choose to participate or not will have no impact on your status, work, or entitled benefits in the organization.

### 2. Purpose of Research Project
The objective of this project is to develop and test a prototype physical security surveillance system for server room entry using facial recognition technology processed locally at the edge (Local Edge Processing). The system distinguishes whether a person appearing in front of the camera is an "authorized internal personnel" or an "external intruder" and alerts responsible personnel in real-time. This system is a supporting component of the overall project, not a new facial recognition algorithm development.

### 3. Reason for Invitation
You are invited as a team member/personnel authorized to access the monitored area. The system needs to learn the faces of "authorized internal personnel" in advance to accurately identify external individuals. You have full freedom to decline participation without providing a reason.

### 4. Participant Count and Duration
Approximately [___] participants are involved in this project. The collection and usage period for face data testing is between [____] and [____] or until the end of the academic semester.

### 5. Research Procedures
1. The research team will record a set of facial images of yourself (using a webcam) to construct reference datasets for model enrollment (Face Enrollment).
2. The system converts facial images into mathematical encodings (Face Embedding/Encoding) and stores them **only inside the local server on a closed network (Local LAN)**.
3. During testing, when you walk past the camera, the system compares your face against the database and records the result in the Detection Log.
4. The system stores **only your "name" and "access role (RBAC Role)"**.

### 6. Privacy & Personal Data Protection (PDPA)
The research team places the highest priority on protecting your personal data under the Personal Data Protection Act B.E. 2562 (PDPA):

- **100% Local Edge Processing:** Capture, recognition, and storage occur entirely within the local hardware and local area network (LAN) of the AEGIS system. **No facial images or data are ever transmitted to public cloud services or the external internet.**
- **Data Minimization:** The system stores **only name and access role (RBAC Role)**. **No national ID numbers, employee IDs, job positions, departments, phone numbers, or other personal identifiers are stored.**
- **Data Retention Policy:** Snapshots, detection logs, and face encodings are retained only as long as necessary for testing (maximum retention period [___] days) and will be **permanently destroyed** upon project completion or upon withdrawal of consent.
- **Access Control:** Data is accessible only to authorized research team members and Administrators under the Principle of Least Privilege, with audit logging enabled.
- Results presented or published will be in aggregate form without identifying individual participants.

### 7. Potential Risks and Discomforts
Participation carries minimal risk. The primary concern may be facial image recording, which the team mitigates through the measures in Section 6. There are no physical risks involved.

### 8. Expected Benefits
You will not receive direct financial compensation, but your participation helps create a privacy-preserving security prototype beneficial for academic research and SME security designs.

### 9. Remuneration
[ ] No financial compensation / [ ] Compensation provided: [___]

### 10. Voluntary Participation and Withdrawal
Participation is entirely voluntary. You may **decline or withdraw from the project at any time without providing a reason and without penalty**. Upon withdrawal, the team will permanently delete all facial images and associated data from the system.

### 11. Participant Rights under PDPA
You hold the right to request access, copies, corrections, deletion, suspension, or withdrawal of consent regarding your personal data at any time by contacting the research team below.

### 12. Contact Information
- **Lead Researchers:** [Primary Coordinator Name] Tel. [___] Email [___]
- **Project Advisor:** Asst. Prof. Dr. Songyut Pimpan Email [___]
- **Human Research Ethics Committee:** Suranaree University of Technology (HREC-SUT) Tel. [___] Email [___]

---
*This document is prepared in [___] copies: 1 copy for the participant and 1 copy for the research team.*

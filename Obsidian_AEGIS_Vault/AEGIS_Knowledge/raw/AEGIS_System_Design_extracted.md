---
title: AEGIS System Design extracted
tags: [aegis, raw, source]
type: raw-source
created: 2026-07-20
updated: 2026-08-13
owner: kla
edit_policy: immutable-source
---

# Raw Source: AEGIS_System_Design.docx

Project Details
Project Title
Edge-Centric Cyber-Physical Security System with Integrated IoT and Local Data Center
(Edge-Centric Cyber-Physical Security System with Integrated IoT and Local Data Center)
Team Members
B6701635
B6702861
B6703370
Submitted to
. .
This report is part of course 1101911Project Title -1 1 2569
Project Title
Google Drive, iCloud (Terms of Service) (AI Training)
(Local NAS Server)
Project Title AEGIS NAS NAS (Layered Authentication) (Network Segmentation) (Intrusion Detection) Cyber-Physical
AEGIS (SME) ( PDPA) AEGIS (On-premise) -
/ Project Title (Problem Statement)
Google Drive, Google Photos, iCloud (Terms of Service) (AI Training)
(NAS) DDoS Brute-force
Firewall Project Title
Objectives
Project Title (Local NAS Server) Cyber-Physical
Local NAS Server
(Defense in Depth) NAS (Layered Authentication) VLAN
(Physical Air-Gap)
(Prototype) Cyber-Physical Security
Expected Benefits (Expected Benefits)
Project Title
Cyber-Physical
Project Title Big Data, Cybersecurity AI
Project Title IoT (Failure Analysis)
1. (Project Overview)
AEGIS (Physical) (Cyber) "Cyber-Physical Defense" (Edge Computing) Cloud
(Core) NAS Server AI (ESP32) (Supporting Components) NAS (Ecosystem) Submitted to (Positioning): Network Architecture Security Big Data (Data Lake) AI (Facial Recognition) Project Title
2. (System Architecture)
AEGIS 3 LAN 3 :
LAN / VLAN — -
MQTT (Local Broker) — NAS ESP32 LAN
Telegram Alerting — : (1) (Direct) CCTV-Operator camera_assignment (2) SOC AI Admin/SOC-Responder
2.1 (Logical Topology)
:
2.1 (Logical Topology) :
[ WiFi (ISP) ] ←
│ ( 1 )
▼
[ Edge Router — MikroTik hEX lite ] ← (NAT/Firewall)
│
▼
[ Managed Switch — TL-SG105E ] ← VLAN 802.1Q
│
├── VLAN 10 (Server) ──► [ NAS — Beelink Mini S ] ◄── (Core)
│ │ 3 Layer + (Suricata/UFW)
│ │ MQTT (HMAC + nonce)
│ ▼
│ [ ESP32 + Relay ] ──► / Uplink NAS
│
├── VLAN 20 (User/IoT — ) ──► [ + Laptop (Edge AI) ] ──► /Log + Telegram
│
└── VLAN 30 (Mgmt) ──► [ ] ← Relay
2.2 (Tech Stack)
/
NAS Server (Core)
Beelink Mini S — CPU N5095, RAM 8GB, ROM 128GB + HDD 1TB
3 Layer
Edge AI Node
Laptop + Webcam
/ NAS
Physical Cutoff
ESP32 + Relay Module
/ Uplink (Air-Gap) MQTT
Intrusion Detection
Suricata (IDS/IPS) + UFW Firewall
Secure Transport
MQTT + HMAC SHA-256 + nonce/timestamp
Replay Attack
Database
PostgreSQL
Metadata Log /
Alerting
Telegram Bot ( SOC)
Real-time
Access Control
NGINX + VPN + VLAN ( Managed Switch)
Login
Edge Router (Gateway)
MikroTik hEX lite (RB750r2)
AEGIS NAT/Firewall Rogue DHCP/Broadcast Routing VLAN
Managed Switch
TP-Link TL-SG105E
VLAN 802.1Q User / Server / Management
Liveness Watchdog
Heartbeat Signal (HMAC) + Watchdog Timer ESP32
NAS (NAS / ) Uplink Fail-Secure
2.3 VLAN/IP/Port (Network Infrastructure Setup) " (Internal LAN Core)" IP WAN ether1 MikroTik VLAN 3 IDEA ( 6 3 ) Submitted to IDEA 2.1–2.2 (Proof of Implementation)
2.3.1 VLAN (VLAN & Subnet Architecture) 3 MikroTik hEX lite Gateway :
VLAN ID
(Zone)
Network / Subnet
Gateway
(Devices)
VLAN 1
Native/Default
(IP 192.168.30.2)
-
VLAN 10
Server Zone
192.168.10.0/24
192.168.10.1
Beelink Mini S (NAS) + Docker Container (AEGIS Drive, AEGIS Monitor Web App)
VLAN 20
Detector Zone
192.168.20.0/24
192.168.20.1
Laptop (Webcam + Detection Engine, IDEA 2)
VLAN 30
Management Zone
192.168.30.0/24
192.168.30.1
Laptop Admin (Arch Linux) / OpenVPN Client Pool
2.3.2 Managed Switch (802.1Q Port Mapping) TP-Link TL-SG105E (5 ) 802.1Q VLAN :
(Type)
PVID
VLAN
Port 1
Trunk (Tagged)
1
VLAN 10, 20, 30
MikroTik (ether2)
Port 2
Access (Untagged)
10
VLAN 10
Beelink Mini S (NAS)
Port 3
Access (Untagged)
20
VLAN 20
Laptop (Webcam/USB cam + Detection Engine)
Port 4
Access (Untagged)
1
VLAN 1 (Native)
( )
Port 5
Access (Untagged)
30
VLAN 30
Laptop
(Port 2), (Port 3) (Port 5) (VLAN 1) Not Member IP 192.168.30.2 Easy Smart VLAN 1 (Port 4) 5 wired ( /ESP32) Unmanaged Switch Port 3 VLAN 20 Managed Switch
2.3.3 IP Docker (IP Allocation & Docker Networking) Beelink Docker Container **Macvlan** Bridge + Reverse Proxy IP VLAN 10 Log Firewall IP :
IP Address
/
VLAN
192.168.10.10
Beelink Host (Ubuntu Server)
10
SSH
192.168.10.11
IDEA 1 — AEGIS Drive
10
-
192.168.10.12
IDEA 2 — AEGIS Monitor
10
Database AI
192.168.10.13
MQTT Broker ( ESP32/IDEA 3)
10
IDEA 3
192.168.20.x
Laptop (Detection Engine, IDEA 2)
20
Static IP
192.168.30.10
Laptop Admin
30
Static NetworkManager
192.168.30.100–200
OpenVPN Client Pool
30
2.3.4 (Remote Access — OpenVPN) 2 Least Privilege : ** 1 — (OpenVPN → VLAN 30):** OpenVPN Client /Laptop OpenVPN Server MikroTik IP 192.168.30.100–200 Laptop Admin Port 5 " " VLAN 30 SSH Terminal Beelink (192.168.10.10) Web App IDEA 1 (192.168.10.11) IDEA 2 (192.168.10.12) Inter-VLAN Routing
** 2 — (Twingate ZTNA → Scoped Access):** OpenVPN VPN LAN (Broad Network Access) ( 3.5.6) Twingate Web App 2 — Terminal Out-of-band Management ( 6)2.3.5 IP (Device IP Addressing Table) VLAN : DNS Server (Closed LAN) Static IP DNS Resolution
Server Zone — VLAN 10 (192.168.10.0/24)
Device
Interface
IP Address
Subnet Mask
Gateway
DNS Server
Beelink Mini S (NAS Host)
LAN (Wired) — Switch Port 2
192.168.10.10
255.255.255.0
192.168.10.1
-
AEGIS Drive (Docker Macvlan)
Virtual (Macvlan Port 2)
192.168.10.11
255.255.255.0
192.168.10.1
-
AEGIS Monitor (Docker Macvlan)
Virtual (Macvlan Port 2)
192.168.10.12
255.255.255.0
192.168.10.1
-
Detector Zone — VLAN 20 (192.168.20.0/24)
Device
Interface
IP Address
Subnet Mask
Gateway
DNS Server
Laptop (Detection Engine + Webcam, IDEA 2
LAN (Wired) — Switch Port 3
192.168.20.x ( Static)
255.255.255.0
192.168.20.1
-
Management Zone — VLAN 30 (192.168.30.0/24)
Device
Interface
IP Address
Subnet Mask
Gateway
DNS Server
Laptop Admin (Arch Linux)
LAN (Wired) — Switch Port 5
192.168.30.10
255.255.255.0
192.168.30.1
-
TP-Link TL-SG105E (Switch Mgmt)
Native VLAN 1 — Switch Port 4
192.168.30.2
255.255.255.0
-
-
OpenVPN Client ( )
Virtual (VPN Tunnel)
192.168.30.100–200
255.255.255.0
192.168.30.1
-
3. IDEA 1 — AEGIS Drive (NAS Server)
: (Core) · : +
3.1 : Data Lake 3 Edge
NAS Data Lake 3 :
Storage Layer ( HDFS): Replay HDD 1TB Linux
Metadata Layer ( HIVE): PostgreSQL Log
Application Layer ( Google Drive): GUI /
Application Layer " " AEGIS AEGIS Drive ( IDEA 1 ) AEGIS Monitor ( IDEA 2 ) - LAN Storage Layer Metadata Layer NAS (Hub) (Storage Metadata Layer) / 3.3
Beelink Mini S (x86) CPU N5095 (x86-64) RAM 8GB (upgrade ) Docker, PostgreSQL, NGINX ARM Core 24 ( 3.5)
3.2 : Layered Authentication (Defense in Depth)
VPN VLAN Login NGINX:
/
0-A
VPN + VLAN ( Admin/ PC )
VPN VLAN 80/443, 9870, 10002 — (L3)
0-B
ZTNA (Twingate) /
(NAS 443) policy IP:port LAN DataLake-User
1
Application Layer — 80/443
Login
2
Storage Layer (HDFS) — 9870
NGINX Basic Auth Admin
3
Metadata Layer (HIVE) — 10002
Database Admin (DBA)
0 client (Device-to-Privilege Mapping) Least Privilege Management VLAN VPN ZTNA " 0 " Login Network Network Isolation Edge Router (MikroTik hEX lite) AEGIS NAT/Firewall DHCP , VLAN Segmentation Managed Switch VLAN / Server / Management traffic Redundancy backup RAID 1 Single Point of Failure HDD
3.3 IDEA 1 (Access Control)NAS AEGIS Drive 2 Least Privilege :
(Role)
Admin ( 3 )
+ user + DBA + sudo
Least Privilege
DataLake-User
Data Lake 3
AEGIS IDEA IP UFW ( 6) Admin IDEA 1 UFW NAS
3.4 IDEA 1 (Roadmap) Pre-Hardware Beelink " (Logic)" " (Hardware)" Docker ( 3 Container: Storage / Metadata / Application) Software Architecture Data Lake container (Portability) 3 :
1
Docker: container 3 layer, NGINX Layered Auth, PostgreSQL schema + query
2
Migrate : container Beelink + 24 .
3
Network/Redundancy: VLAN + Edge Router , RAID 1 / auto-backup, VPN 0
3.5 (Application Layer GUI)Application Layer IDEA 1 "AEGIS Control Panel" Google Drive + + (RBAC) + (Audit) + IDEA 2 IDEA 3 (DataLake-User) (Admin) Audit Log Access Control Dashboard, Files Explorer, Uploads/Recent, Secure Shares, Snapshots & Recovery, Storage & Backup, Audit Log, Access Control Settings / (Role) Least Privilege " " " "
3.5.1 VLAN-Aware Secure Share ( ) ( ) AEGIS (Network Access Control) VLAN Subnet ( VLAN Subnet 192.168.1.0/24) 4G UFW (Firewall) Network Layer UFW (Data Access Control) IDEA 3 UFW IP (Threat Response) Network Segmentation Defense in Depth
3.5.2 Zero-Knowledge Private Vault ( ) NAS (Encryption at Rest) NAS File Integrity Monitoring (FIM), (Thumbnail) Private Vault AES-256 (Client-side) LAN NAS NAS " (Ciphertext)" (Admin) NAS (Zero-Knowledge) NAS FIM, IDEA 2 Vault (Data Security) PDPA
3.5.3 Storage & Backup ( ) Storage & Backup Storage Layer ( Data Lake) HDD ( / / / /Vault), RAID 1 ( 2 1 ) 2 RAID 1 ( ) Snapshots & Recovery (Rollback) Ransomware ( IDEA 2 ) NAS
3.5.4 (Settings & Accessibility) Settings (Appearance), (Account), (Security & Privacy), (Storage & Data) (Administration)
(Light) (Dark) ( IP, Hash, )
3.5.5 Privacy-Preserving Audit Log AEGIS (PDPA) Zero-Knowledge Architecture (Audit Log) (Admin) (Insider Threat) (Information Disclosure) (DataLake-User) (Metadata) " " (Cryptographic Hash / UUID) PostgreSQL (Metadata Layer) Audit Log ( Upload, Download) IP ( [Encrypted_Blob_7F2A9B...])
3.5.6 Zero Trust Network Access (ZTNA) Twingate — ( ) VPN LAN (Broad Network Access) AEGIS AEGIS Zero Trust Network Access (ZTNA) Twingate Connector AEGIS Policy IP Port DataLake-User NAS 443 ( ) Ping (ICMP), , Twingate Connector Twingate Outbound-only NAS Inbound Edge Router Public IP VPN Forward Port Attack Surface Twingate 0-B ( / ) VPN 0-A ( Admin PC) AEGIS "VPN " Zero Trust (Security Monitoring)
3.5.7 End-to-End Encryption Mnemonic ( ) 3.5.2 (Private Vault) AES-256 Zero-Knowledge (Key Management) Vault ( Admin) Zero-Knowledge AEGIS Mnemonic Recovery Phrase Vault 12 ( BIP-39 ) (Master Key) 12 (Zero-Knowledge ) NAS Admin Private Vault (3.5.2) Private Vault " " Mnemonic Recovery " Zero-Knowledge"
3.6 (Screen & Feature Mapping) (Role-Based Access Control) Principle of Least Privilege (GUI) AEGIS Drive (IDEA 1) 9 (Screens) (Features/Functions) :
1: (Files) ( Admin DataLake-User)
Dashboard: (Storage Quota), , (Personal Security Status), Recent Activity
Files Explorer: (Hierarchical) "Private Vault" (Client-Side Encryption)
Uploads / Recent: (Encryption at rest) Real-time
Secure Shares: (VLAN/Subnet Scope)
2: (Data) ( Admin DataLake-User)
Snapshots & Recovery: (Rollback) Snapshot Ransomware
Storage & Backup: (RAID Status), (Documents, Images, Video, Vault),
3: (Admin Only) ( Admin )
Audit Log: Privacy-Preserving ( ) Action, Timestamp, Result, Source IP Forensics
Access Control: (Role Assignment) Active Sessions
Settings: ( Encryption Key Management Firewall Zone Definitions)
4. IDEA 2 — AEGIS AI Monitoring
: (Supporting) : +
4.1
Laptop AI (Edge) Webcam Server Real-time Log Laptop IoT Data Pipeline
" " " " (Access Authorization)
4.2 (Workflow)
: Webcam Real-time Server
Edge: Laptop
NAS: Laptop 10 (Interval-based Segmentation) Log LAN HDD NAS Laptop (flag)
: Laptop API + Snapshot Telegram CCTV-Operator ( camera_assignment IDEA 2) (critical) SOC Admin/SOC-Responder
: NAS
Data Pipeline (Access Control ) ( face_recognition) Latency LAN (PDPA) Consent Submitted to
3 :
Consent Management:
Data Privacy: LAN AEGIS Cloud
Retention Policy: Log Snapshot
Detection log IDEA 2 PDPA Monitor Web App IDEA 2
4.3 Data Pipeline ( NAS) LAN 5 :
1
AI Detection
→ → Telegram Snapshot ( camera_assignment)
2
Trigger Record
Segment Record | Laptop ~10 Folder Local Disk flag
3
Post-Record Sync
rsync / scp NAS LAN
4
Cleanup
Integrity Check NAS → → Laptop
5
Log
timestamp, (Camera ID), , , —
Network 3–4 rsync/scp Integrity Check sync AI
4.4 IDEA 2 LAN:
100% Local Processing — AI Edge Cloud
< 2 Alert Latency — Telegram
24/7 Physical Monitoring —
Monitoring Web App , NAS, Log HDD IDEA 2 IDEA 1 CCTV-Operator ( ) SOC-Responder ( ) (camera_assignment) IDEA 2
4.4.1 (Role-Scoped View)
Monitor Web App Least Privilege " / ":
Aggregate View (Admin / SOC-Responder): Live view (Live view, Recorded clips, Alerts, Detection log, Cameras)
Scoped View (CCTV-Operator): Live view camera_assignment Alerts Detection log ( Admin/SOC-Responder ) Live view, Recorded clips Cameras
RBAC IDEA 2 " " " " (Attack Surface) Principle of Least Privilege IDEA 2
4.4.2 : Detection Engine Monitoring
IDEA 2 Inter-VLAN Routing (Detection Engine VLAN 20, Monitoring Web App VLAN 10 — VLAN 2.3) Edge Node 1 — Detection Engine ( Edge Node): Laptop (Capture) (Face Recognition) ~10 (Event) Snapshot, Log LAN NAS (IDEA 1) Telegram
2 — Monitoring Web App ( ): Docker Container NAS (Beelink, VLAN 10, IP 192.168.10.12) Edge Node URL VLAN 30 ( Inter-VLAN Routing) VLAN 10 (Aggregate View Scoped View 4.4.1) AI (Edge Node) Attack Surface Endpoint ( )
Live view Average Latency (LAN edge → NAS) LAN Data Pipeline ( 4.3) linked alert ID stored on NAS NAS IDEA 1 (Traceability)
Telegram CCTV-Operator camera_assignment SOC Admin SOC-Responder (one-way) Telegram
4.5 (Failure Analysis)
(Resiliency)
Telegram
Log NAS LAN
NAS Server
Laptop Local Cache NAS
AI
IR Motion Sensor
IDEA 3: "NAS " Heartbeat IDEA 3 Heartbeat Uplink (WAN) LAN Laptop IDEA 2 sync NAS LAN NAS
4.6 (Screen & Feature Mapping)AEGIS Monitor (IDEA 2) ( 4.4.1) IDEA 2 (v4) Detection Engine (Read-only consumer)
4.6.1 — Aggregate View (Admin / SOC-Responder)
Live canvas
+ AI auto-focus
, (Authorized/Unknown), , Event stream
Archival footage
~10 archive NAS
thumbnail, , , (Authorized/Unknown), timeline marker Unknown
Detection stream
(log Alert)
timestamp, , , , , confidence, sync NAS; tailgating
Alerts
(review-only)
, , , , snapshot, Telegram ( / SOC-Team ), Acknowledge
Nodes & routing
assignment
/ / / online-offline + operator (Assigned to)
4.6.2 — Scoped View (CCTV-Operator) CCTV-Operator Detection stream Alerts ( Admin/SOC-Responder) :
Live canvas
( )
, + , Event stream , (Faces/Authorized/Unknown/Avg latency)
Archival footage
(filter )
Aggregate
Camera diagnostics
(self-diagnostics)
Operational/Degraded/Offline, heartbeat , latency, fps, uptime, , sync NAS, Self-check log
Settings
(personal preference)
( / / ), Light/Dark, , session , Sign out
4.6.3
IDEA 2 (monitoring) ( IDEA 1), / armed-disarmed ( IDEA 3) / ( Access Control) Settings IDEA 2 ( / / ) Settings 5 IDEA 1
5. IDEA 3 — Cyber-Physical Lockdown
: Security (Active Defense) · :
5.1 : (Contain before Notify)
NAS (DDoS Brute-force) Incident Response ( NIST SP 800-61) (Containment) (Notification)
Workflow Telegram (paradox): DDoS Telegram timeout ( MQTT LAN DDoS )
(Threat Scope): IDEA 3 (External Attacker) DDoS Brute-force (Worst Case) (Root/Privilege Escalation) NAS " " Core
5.2 Workflow (Failure-Resilient)
Failure Case :
(Happy Path)
(Resilient)
1
Suricata/WAF
Suricata/WAF ( )
2
Log + Telegram ( )
Log PostgreSQL (local )
3
UFW
MQTT ( nonce) ESP32 Contain
4
Payload + HMAC MQTT
Telegram async + timeout 3 ( )
5
ESP32 Relay (Air-Gap)
ESP32 Uplink + ACK
3 UFW MQTT Containment
5.3 Failure Case
:
#
1
Telegram DDoS →
Contain-before-Notify: MQTT ( LAN) async + timeout
2
LAN = Admin ( )
Relay Uplink Internet Management VLAN Admin
3
ESP32 / MQTT Broker → NAS
MQTT QoS 1-2 + ESP32 ACK X retry/ Admin + Watchdog ESP32 ( Fail-Secure)
4
Uplink Telegram retry
Telegram (timeout ) PostgreSQL Admin Management VLAN Log
5
HMAC Replay Attack → " "
nonce/timestamp payload HMAC; ESP32
6
Root NAS Stop Service MQTT ( HMAC Key ) → Contain Bypass
Dead Man's Switch (Heartbeat): NAS Heartbeat HMAC ESP32 " " Timeout ( Stop Service) ESP32 Uplink (Fail-Secure)
3 Fail-Secure ( = WiFi ) Fail-Open ( = )
5.3.1 : Single Point of Trust Heartbeat
Failure Case 5 " " Case 6 NAS (Detector) (Commander) Single Point of Trust NAS Replay Attack (HMAC + nonce) Case 5 (Secret Key)
(Inverted Logic) "NAS " ( NAS = ) "NAS (Heartbeat) " ( NAS = ) Stop Service " Heartbeat" trigger ESP32 Uplink Watchdog Timer Embedded Fail-Secure Case 3
(Trade-off): Availability Security NAS ( ) Heartbeat ESP32 (False Positive) " " Timeout ( 60 boot Beelink x86 90–120 Contain ) Heartbeat (Passive/Backup Trigger) NAS (Active Trigger 5.2) Core
5.4 (Incident Recovery)
:
(Out-of-band): Management VLAN NAS
IP : IP Telegram/Log UFW
: MQTT ( nonce ) ESP32 Uplink
: UFW
: Log PostgreSQL (Closed-Loop) IDEA 1
5.5 Pre-Hardware (Pre-Hardware Strategy)
IDEA 1 “ (Logic)” “ (Hardware)” IDEA 3 (Software Simulation) ESP32 HMAC/nonce ESP32 Relay Module (Portability)
5 Failure Case 5.3 :
( )
1
Uplink HMAC nonce
ACK
2
(Replay)
nonce
3
HMAC (Tamper)
4
timestamp
5
Heartbeat ( NAS )
Uplink Timeout (Dead Man’s Switch)
6. 3 (Ecosystem)
AEGIS 3 3 :
NAS (Hub): (IDEA 2) Log (IDEA 3) NAS (IDEA 1) NAS
Telegram SOC : " " " "
VLAN : IDEA 1 , IDEA 2 , IDEA 3 Management —
: (IDEA 2) Server Snapshot Telegram NAS DDoS NAS Suricata (IDEA 3) Log ESP32 Uplink Telegram Management VLAN
7.
AEGIS Submitted to Cyber-Physical NAS AI NAS, Telegram SOC VLAN
(Failure-Resilient) 6 Contain-before-Notify, Uplink, ACK Replay Attack Network Security
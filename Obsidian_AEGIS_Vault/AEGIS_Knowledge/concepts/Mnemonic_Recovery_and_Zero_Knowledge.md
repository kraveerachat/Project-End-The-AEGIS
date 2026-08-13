---
title: Mnemonic Recovery & Zero Knowledge Architecture
tags: [aegis, concept, security, zero-knowledge, encryption, pdpa]
type: concept
created: 2026-07-20
updated: 2026-07-20
sources: ["[[raw/AEGIS_System_Design_extracted]]", "[[raw/AEGIS_Project_Knowledge_v7]]"]
owner: kla
edit_policy: owner-writable
---

# 🔐 Mnemonic Recovery & Zero-Knowledge Architecture

> **Core Principle (Section 3.5.2 & 3.5.7)**: Balancing **Zero-Knowledge Encryption** with **organizational usability**.

---

## 💡 Two-Mode Encryption Structure in AEGIS Drive

```mermaid
graph TD
    subgraph Mode1 [Mode 1: Standard Encryption at Rest]
        ServerEnc["Server-Side Encryption"] --> FIM["Supports FIM, File Search, and Thumbnails"]
        ServerEnc --> NormalFiles["General files in Data Lake"]
    end

    subgraph Mode2 [Mode 2: Private Vault (Zero-Knowledge) — Built Implementation]
        Pass["Vault Passphrase<br/>(Separate from account password)"] -->|Argon2id m=64MiB t=3| KEK["KEK 256-bit<br/>(Memory only)"]
        DEK["DEK 256-bit randomly generated per file"] -->|AES-256-GCM| CipherText["File Ciphertext"]
        KEK -->|Wrap with AES-GCM| WrappedDEK["Wrapped DEK"]
        CipherText --> NASVault[".aegisenc on NAS<br/>NAS stores unreadable blobs only"]
        WrappedDEK --> Meta["vault_blobs (Postgres)"]
    end
```

---

## 🛠️ Actual Status of Recovery Mechanism (Crucial Context)

> ⚠️ **Reconcile 2026-07-26**: Previous notes described a **12-word BIP-39 Mnemonic** mechanism. In implementation, **passphrase recovery is intentionally omitted** to preserve pure Zero-Knowledge properties.

**Verified Implementation Details (See [[idea1/idea1-status]]):**
1. **Passphrase Decoupled from Account Password**: Users configure a dedicated vault passphrase during initial setup (minimum 12 characters).
2. **Zero-Knowledge Principle**: Passphrases, KEKs, and unwrapped DEKs **never leave the browser**, never appear in request bodies, and are never logged.
3. **Insider Threat / Admin Abuse Protection**: Even if an administrator inspects server files or database rows, they cannot decrypt contents or derive keys.
4. **PDPA Compliance**: Audit logs record action metadata (*who/when/what*) without file names or plaintext contents.
5. **Forgotten Passphrase = Permanent Data Loss**: There is no reset endpoint. The UI explicitly communicates this (`vaultWarning`, `vaultSetupAck`).
6. **Zero-Knowledge Trade-off: Search Disabled**:
   System search is available across all screens **except Private Vault where it is disabled** with a descriptive tooltip `searchUnavailableVault`:
   > "Search unavailable in Private Vault — contents are encrypted with zero-knowledge encryption."

---

## 🗑️ Removal of Mock "12-word Recovery Key" UI Card (2026-07-26)

* Previous mock UI cards displayed a 12-word mnemonic generated via `Math.random()`. Because these words had zero mathematical relationship to encryption keys and misled users into believing recovery was possible, the mock cards were permanently removed from `Settings.jsx`.
* For forgotten passphrases, the strict architectural rule remains: **Forgotten passphrase = Permanent data loss**.

---

## 🔗 Related Notes
* [[idea1/idea1-status]]
* [[concepts/OWASP_Security_Defense]]
* [[concepts/Identity_Decoupling]]

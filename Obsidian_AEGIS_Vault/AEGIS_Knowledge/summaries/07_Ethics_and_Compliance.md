---
title: Work Summary — Ethics & Compliance
tags: [aegis, summary, ethics, compliance, hrec-sut, pdpa]
type: summary
created: 2026-08-06
updated: 2026-08-06
sources: ["[[log]]", "[[ethics/Participant_Information_Sheet_IDEA2]]", "[[ethics/Informed_Consent_Form_IDEA2]]"]
---

# 📑 Ethics & Compliance — Consolidated

> Only one session in `[[log]]` falls into this category (2026-07-22), but it's tracked separately because it's the only work driven by an external institutional requirement (HREC-SUT) rather than by code correctness — worth keeping distinct from the engineering categories.

---

## HREC-SUT ethics forms for IDEA 2 (2026-07-22)

Two new documents drafted for submission to the Suranaree University of Technology Human Research Ethics Committee, covering IDEA 2's facial-recognition module specifically (not the whole AEGIS system):

- [[ethics/Participant_Information_Sheet_IDEA2]] — describes the research purpose (a prototype physical-security surveillance system for server-room entry using **locally-processed, edge-only** facial recognition to distinguish authorized personnel from intruders), researcher/advisor identities, and participant rights.
- [[ethics/Informed_Consent_Form_IDEA2]] — the accompanying consent instrument.

Both were drafted against the standard HREC-SUT template structure, with `[ ]` placeholder fields left for the office's official AF form completion before formal submission.

### Three compliance principles the drafts commit to
1. **100% local edge processing** — no facial data leaves the device/edge tier.
2. **Name + RBAC role only** — the system stores identity as a name tied to a role, not raw biometric templates exposed beyond what's needed for the access decision.
3. **PDPA-aligned data retention policy** — retention scoped and time-bound per Thailand's Personal Data Protection Act, rather than indefinite.

### Outstanding — flagged, not yet resolved
A cross-check against the underlying `AEGIS_System_Design.docx` (§19 pages) surfaced a documentation discrepancy that **blocked further alignment work pending a decision from the report's actual source**, not from code:
- Section numbering inconsistency around §5.5–5.7 (BOM) — the section appears renumbered inconsistently across the document.
- §2.3.4 "Terminal Account" naming does not match how the term is used elsewhere in the report.
- A duplicated "§2.1 Logical Topology" section appears twice.

This was reported back rather than guessed at or silently corrected, since it touches the source-of-truth report document, not vault content the agent owns. Syllabus alignment (course requirement §.3) against SUT's ethics templates was otherwise completed.

**Status**: ethics forms complete and ready for the office's official fields; the §5.6/§2.3.4 documentation discrepancy remains open — see [[summaries/08_Outstanding_Items_Consolidated]].

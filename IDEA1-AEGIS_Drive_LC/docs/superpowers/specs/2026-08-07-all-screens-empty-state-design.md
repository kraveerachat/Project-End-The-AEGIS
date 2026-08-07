# AEGIS Drive LC — Complete empty-state design

## Goal

Keep every non-Dashboard route structurally complete when its collection is empty or its backend capability is not connected. Only the data region changes state; page chrome, actions, table headers, explanatory content, and navigation remain stable.

## State model

Each data surface has four states inside its existing container:

1. Loading: compact skeleton in the data region.
2. Genuine fetch failure: retry UI in the data region.
3. Empty/not connected: muted inline copy, zero values, or a neutral unavailable marker.
4. Populated: current real API-backed content.

No screen-level early return may replace the route with a blank skeleton or error card.

## Screen decisions

- Files keeps the breadcrumb and complete toolbar. An empty folder shows a quiet prompt and a real New Folder action.
- Vault keeps the zero-knowledge/AES identity and controls visible. The empty action maps to setup, unlock, or file selection according to the real vault state.
- Uploads keeps the drop zone and uses a compact empty row in Recent Uploads.
- Secure Shares keeps creation, filters, table header, and an inline empty row.
- File History remains the truthful per-file version system. The removed fake Snapshot API is not restored; the empty history uses a dotted track and disabled Restore action.
- Storage keeps a zeroed partition bar and every legend label. SMART/RAID remain neutral because host telemetry is unavailable. Backup keeps table chrome and links to Settings instead of pretending to schedule a job.
- Audit keeps filters, export control, ledger header, and an inline empty row.
- Access always shows the authenticated Admin as the real current-session row. Additional accounts come only from the identity API; if none exist, the table contains an inline empty row and Add User action.
- Settings keeps all form sections renderable. Remote Access is Twingate-only and Inactive because there is no connector health integration. Mnemonic recovery is shown as not connected with a disabled Generate control; generating decorative words that cannot decrypt the Vault is explicitly forbidden.

## Non-goals

- Do not modify Dashboard.
- Do not restore `/api/snapshots` or fake rollback.
- Do not invent RAID, SMART, backup, connector, or mnemonic telemetry.
- Do not redesign the dark HUD visual system.

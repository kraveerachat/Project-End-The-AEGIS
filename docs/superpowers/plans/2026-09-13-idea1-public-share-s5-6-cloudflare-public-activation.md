# S5.6 Cloudflare Public Activation Plan

## Objective
Activate named-tunnel hostname route and DNS; verify public TLS.

Target hostname: share.aegistk-pb.com
Target public URL form: https://share.aegistk-pb.com/s/[REDACTED]

## Phases

### S5.6-A
Bootstrap / fresh read-only baseline / Cloudflare inventory

### S5.6-B
Restore accepted S5.5 connector + firewall + lifecycle runtime
WITHOUT a public hostname route

### S5.6-C
Pre-exposure isolation re-verification

### S5.6-D
Activate the single approved Cloudflare hostname route

### S5.6-E
Public DNS verification

### S5.6-F
Public TLS / HTTPS verification

### S5.6-G
Immediate public default-deny smoke verification

### S5.6-H
S5.6 evidence reconciliation / closeout / rollback readiness


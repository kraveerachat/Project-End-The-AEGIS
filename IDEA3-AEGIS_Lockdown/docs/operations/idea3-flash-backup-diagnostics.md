# IDEA3 offline flash-backup diagnostics

This diagnostic is a repository-only evidence check for an owner-supplied ESP32
flash backup. It is not a provisioning, flashing, erasing, restore, serial, or
hardware-acceptance tool.

## Evidence contract

The JSON record must state:

- `flash_size_bytes = 4194304`;
- `read_mode = rom/no-stub` and `baud = 115200`;
- `sha256_verification = PASS`, `bootloader_header = EXPECTED`, and
  `partition_header = EXPECTED`;
- `firmware_writing = NO`, `flash_erasing = NO`, and
  `backup_restoration_tested = NO`; and
- a historical attempt with `baud = 460800` and `result = FAIL`, so the earlier
  failure is preserved rather than silently replaced.

The binary must be exactly 4 MiB, match the recorded SHA-256, contain ESP32
bootloader magic `0xE9` at offset `0x1000`, and contain partition-table magic
`0x50AA` (little-endian bytes `AA 50`) at offset `0x8000`. This matches the
repository's ESP32 flash layout used by the L8 hardware backend.

## Offline invocation

Keep the JSON record and binary outside Git. Run:

```bash
python3 deploy/pr11-phase4/flash-backup-diagnostics.py \
  --evidence /path/to/owner-backup-evidence.json \
  --backup /path/to/flash-backup.bin
```

The command emits machine-readable JSON. `verdict = PASS` supports only the
read-only backup claims above. It does not prove board identity, firmware
provenance, electrical relay behavior, restoration, or production readiness.

## Safety boundary

The validator reads local files only. It never opens `/dev/ttyUSB*`, invokes
`esptool`, writes flash, erases flash, resets the board, or tests restoration.
The F2 relay-supply-loss finding remains **FAIL-OPEN** pending a separate
hardware decision and physical validation; this diagnostic does not weaken that
blocker.

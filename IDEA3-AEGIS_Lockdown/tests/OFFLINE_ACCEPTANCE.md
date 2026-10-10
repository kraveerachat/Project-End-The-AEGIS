# IDEA3 offline Core acceptance (SIMULATED_OFFLINE)

Deterministic local/offline software acceptance of the existing Core control pipeline:

`detection event -> Core validation/policy -> authenticated command -> MQTT transport contract -> simulated device ACK/STATUS -> correlation -> audit/incident evidence`

```bash
cd IDEA3-AEGIS_Lockdown
python3 tests/offline_acceptance.py --json offline-acceptance.json      # exit 0 only when every requirement is PASS
python3 -m pytest -q -p no:cacheprovider tests/test_offline_core_acceptance.py    # the integrated scenarios alone
```

The JSON has no timestamps or durations (same tree, same bytes) and always states `evidence_class=SIMULATED_OFFLINE`,
`production_acceptance=false`, `physical_acceptance=false`, `hardware_executed=false`, `production_mutation=false`,
`recovery_executed=false`. A requirement whose mapped tests fail, are skipped, or no longer exist makes the run FAIL.

What runs for real: supervisor, controller, Protocol v1 codec/store/inbound verifier, MQTT adapter, dispatch worker and ledger,
alert ingress, and the hash-chained audit database. What is simulated: the paho client, the web dispatch client, and the relay
device (`offline_device_sim.py`, which mirrors `firmware/src/main.cpp` rules, is pinned to them by a source-order test, and uses only the
Core's own codec). A simulated LOCKDOWN is **not** relay, GPIO, hardware or Production acceptance, and says nothing about Recovery R2-R8.

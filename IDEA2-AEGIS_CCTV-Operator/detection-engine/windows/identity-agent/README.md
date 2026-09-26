# Windows Identity Agent lifecycle

These repository-native scripts prepare the dedicated Windows Identity Agent
without changing the Detection Engine's interactive webcam ownership. One-time
administrator operations may use PowerShell; normal boot/login operation does
not require the end user to open a terminal.

The Agent runs automatically as `NT SERVICE\AEGISIdentityAgent`, owns no camera,
and exposes only the fixed browser-association listener at `127.0.0.1:8078`.
Its Ed25519 key is protected with DPAPI `CurrentUser` under that exact service
identity and exact service/SYSTEM filesystem ACLs. The camera remains off when
the service starts, authenticates, renews, or reports physical availability.

## One-time administrator sequence

1. Prepare a non-secret Agent configuration outside the repository. Include the
   canonical Monitor URL/audience, Node ID, key version, Engine user SID,
   allowed browser origins, and stable physical stream URL. Do not put an API
   key, private key, password, token, or logical camera alias in this file.
2. Compute the exact source-manifest SHA-256 with the repository helper, then
   pass it to the installer:

   ```powershell
   $sourceHash = & .\windows\identity-agent\get_identity_agent_source_hash.ps1 `
       -SourceRoot (Get-Location).Path
   & .\windows\identity-agent\install_identity_agent.ps1 `
       -SourceRoot (Get-Location).Path `
       -ExpectedSourceSha256 $sourceHash `
       -ConfigurationFile C:\AEGIS-Local\identity-agent.env
   ```
3. Keep the Agent service stopped and run `invoke_dpapi_preflight.ps1`. It
   proves DPAPI CurrentUser behavior under the service identity without
   generating the application key.
4. While the Agent remains stopped, run `provision_identity_key.ps1` and register only the exported public
   key through the separately reviewed server workflow. The operation is
   resumable: if a service-context interruption happened after the protected
   identity was committed, a retry validates that same identity and recreates
   only identical public evidence; it never rotates the key.
5. Use `status_identity_agent.ps1`, then start the service only when status and
   registration are valid.
6. After reboot, run `verify_machine_a_no_powershell.ps1` as the human
   acceptance evidence collector.

Pinned Agent dependencies, including pywin32, are installed into the separate
`%ProgramFiles%\AEGIS\IdentityAgent\.venv`; the Engine environment is not
modified. The installer requires 64-bit CPython 3.12 and uses the reviewed,
fully transitive Windows wheel lock with `--require-hashes` and binary-only
resolution.

The runtime and non-secret management configuration deliberately remain
administrator-maintainable. Only `%ProgramData%\AEGIS\IdentityAgent`, which
contains the DPAPI-protected identity, is owned exclusively by the Agent service
and SYSTEM. This separation permits repeat repair and normal uninstall without
widening private-key access.

## Repair and uninstall

`repair_identity_agent.ps1` refreshes the reviewed runtime, dependencies,
configuration ACL, and service registration. It does not open, hash, copy,
delete, generate, or rotate the existing protected identity; preservation is
enforced by keeping all key mutation outside the repair path. A missing service
can be recreated from the bound installation marker. If `agent.env` is missing
or invalid, pass a reviewed `-ReplacementConfigurationFile`; repair validates
and installs it without reading the private key.

`uninstall_identity_agent.ps1` removes only Task-12-managed Agent service,
runtime, active configuration, and non-secret provisioning evidence. The
machine identity is preserved by default, together with the small non-secret
`install.json` ownership marker that binds the preserved identity to its exact
managed roots. Permanent key removal requires the explicit `-DestroyIdentity`
switch, a matching ownership marker, and normal PowerShell confirmation
semantics. Broad, overlapping, source-tree, or reparse-point roots fail before
any service or filesystem mutation.

Run the final no-PowerShell verifier elevated. It requires a fresh, non-secret
key-presence and exact-ACL attestation from the running service process, the sole
HKCU Engine startup owner, and the reviewed SYSTEM AtStartup tunnel task before
it can report PASS.

The scripts do not own or remove the Engine startup entry, tunnel task, camera
data, recordings, model assets, Production configuration, or other services.

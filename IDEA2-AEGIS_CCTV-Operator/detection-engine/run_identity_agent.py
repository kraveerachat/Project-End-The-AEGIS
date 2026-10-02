"""Entry point for the dedicated AEGIS Identity Agent runtime."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from aegis_identity_agent.config import AgentConfig
from aegis_identity_agent.browser_server import BrowserAssertionApplication, BrowserAssociationServer
from aegis_identity_agent.key_store import DpapiCurrentUserProtector, IdentityKeyStore
from aegis_identity_agent.pipe_server import (
    PipeRequestHandler,
    WindowsNamedPipeServer,
    resolve_account_sid,
)
from aegis_identity_agent.session_client import AgentSessionClient
from aegis_identity_agent.transport import AgentTransport
from aegis_identity_agent.windows_service import IdentityAgentServiceHost, build_pywin32_service


def _store(config):
    return IdentityKeyStore(
        config.protected_key_path,
        node_id=config.node_id,
        key_version=config.key_version,
        protector=DpapiCurrentUserProtector(),
    )


def _host():
    config = AgentConfig.from_env()
    if config.engine_user_sid is None:
        raise RuntimeError("AEGIS_AGENT_ENGINE_USER_SID is required for the pipe ACL")
    store = _store(config)
    signer = store.load()

    def key_store_health():
        store.validate_acl(require_key=True)
        return {
            "status": "ok",
            "processId": os.getpid(),
            "keyState": "PRESENT",
            "keyAcl": "VALID",
            "dataRootAcl": "VALID",
            "privateKeyRead": False,
        }

    browser_server = BrowserAssociationServer(
        BrowserAssertionApplication(
            signer,
            allowed_origins=config.browser_allowed_origins,
            expected_audience=config.audience,
            health_check=key_store_health,
        )
    )
    client = AgentSessionClient(config, signer)
    transport = AgentTransport(config, client, signer)
    handler = PipeRequestHandler(
        transport,
        allowed_caller_sids={config.engine_user_sid},
    )
    pipe_server = WindowsNamedPipeServer(
        handler,
        service_sid=resolve_account_sid(r"NT SERVICE\AEGISIdentityAgent"),
        engine_sid=config.engine_user_sid,
        pipe_name=config.pipe_name,
        read_timeout_s=config.pipe_timeout_s,
    )

    def close_owned_surfaces():
        try:
            pipe_server.close()
        finally:
            browser_server.close()

    return IdentityAgentServiceHost(
        run_once=pipe_server.serve_once,
        interval_s=0.05,
        retry_max_s=config.retry_max_s,
        wait_after_success=False,
        on_start=browser_server.start,
        on_stop=close_owned_surfaces,
    )


def _atomic_public_write(path, content, *, allow_identical=False):
    target = Path(path)
    if target.exists():
        if allow_identical and target.read_text(encoding="ascii") == content:
            return
        raise RuntimeError(f"refusing to overwrite {target}")
    target.write_text(content, encoding="ascii", newline="\n")


def _atomic_json_write(path, value, *, allow_identical=False):
    target = Path(path)
    temporary = target.with_suffix(target.suffix + ".tmp")
    encoded = json.dumps(value, sort_keys=True)
    if target.exists():
        if allow_identical and target.read_text(encoding="utf-8") == encoded:
            return
        raise RuntimeError(f"refusing to overwrite {target}")
    if temporary.exists():
        raise RuntimeError(f"refusing to overwrite {target}")
    temporary.write_text(encoded, encoding="utf-8", newline="\n")
    os.rename(temporary, target)


def _dpapi_preflight(output_path=None):
    protector = DpapiCurrentUserProtector()
    marker = bytearray(os.urandom(32))
    entropy = b"AEGIS-DPAPI-CURRENTUSER-PREFLIGHT-V1"
    try:
        protected = protector.protect(marker, entropy)
        restored = protector.unprotect(protected, entropy)
        if restored != bytes(marker):
            raise RuntimeError("DPAPI CurrentUser round trip failed")
    finally:
        for index in range(len(marker)):
            marker[index] = 0
    evidence = {
        "result": "PASS",
        "protectionScope": "CurrentUser",
        "serviceAccount": r"NT SERVICE\AEGISIdentityAgent",
        "keyGenerated": False,
    }
    if output_path:
        _atomic_json_write(output_path, evidence)
    print("DPAPI_CURRENTUSER_PREFLIGHT=PASS")


def _identity_store_from_args(args):
    if not args.node_id or not args.key_version or not args.key_path:
        raise RuntimeError(
            "identity key modes require --node-id, --key-version, and --key-path"
        )
    return IdentityKeyStore(
        args.key_path,
        node_id=args.node_id,
        key_version=args.key_version,
        protector=DpapiCurrentUserProtector(),
    )


def _validate_key_store_acl(args):
    config = AgentConfig.from_env()
    _store(config).validate_acl(require_key=args.require_key)
    result = {
        "result": "PASS",
        "serviceAccount": r"NT SERVICE\AEGISIdentityAgent",
        "dataRootAcl": "VALID",
        "keyAcl": "VALID" if args.require_key else "NOT_REQUIRED",
        "privateKeyRead": False,
    }
    if args.result_output:
        _atomic_json_write(args.result_output, result)
    print(json.dumps(result, sort_keys=True))


def _provision_key(args):
    store = _identity_store_from_args(args)
    if not args.public_key_export or not args.result_output:
        raise RuntimeError("--provision-key requires --public-key-export and --result-output")
    public = store.generate_signer().public_identity
    _atomic_public_write(
        args.public_key_export, public.public_key_pem, allow_identical=True,
    )
    result = {
        "nodeId": public.node_id,
        "keyVersion": public.key_version,
        "fingerprintSha256": public.fingerprint_sha256,
        "publicKeyExport": args.public_key_export,
        "privateKeyExported": False,
    }
    _atomic_json_write(args.result_output, result, allow_identical=True)
    print(json.dumps(result, sort_keys=True))


def _maintenance_action(args):
    if args.dpapi_preflight:
        return lambda: _dpapi_preflight(args.preflight_output)
    if args.provision_key:
        return lambda: _provision_key(args)
    if args.validate_key_store_acl:
        return lambda: _validate_key_store_acl(args)
    return None


def main(argv=None):
    parser = argparse.ArgumentParser()
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--service", action="store_true")
    modes.add_argument("--console", action="store_true")
    modes.add_argument("--generate-key", action="store_true")
    modes.add_argument("--export-public-key", action="store_true")
    maintenance_modes = parser.add_mutually_exclusive_group()
    maintenance_modes.add_argument("--dpapi-preflight", action="store_true")
    maintenance_modes.add_argument("--provision-key", action="store_true")
    maintenance_modes.add_argument("--validate-key-store-acl", action="store_true")
    parser.add_argument("--preflight-output")
    parser.add_argument("--result-output")
    parser.add_argument("--public-key-export")
    parser.add_argument("--node-id")
    parser.add_argument("--key-version", type=int)
    parser.add_argument("--key-path")
    parser.add_argument("--require-key", action="store_true")
    args = parser.parse_args(argv)
    maintenance_action = _maintenance_action(args)
    if maintenance_action is not None and not args.service:
        parser.error("maintenance modes require --service")
    if not any((args.service, args.console, args.generate_key, args.export_public_key)):
        parser.error("one execution mode is required")
    if args.generate_key or args.export_public_key:
        store = _identity_store_from_args(args)
    if args.generate_key:
        public = store.generate()
        if args.public_key_export:
            _atomic_public_write(args.public_key_export, public.public_key_pem)
        result = {
            "nodeId": public.node_id,
            "keyVersion": public.key_version,
            "fingerprintSha256": public.fingerprint_sha256,
            "publicKeyExport": args.public_key_export,
            "privateKeyExported": False,
        }
        if args.result_output:
            _atomic_json_write(args.result_output, result)
        print(json.dumps(result, sort_keys=True))
        return 0
    if args.export_public_key:
        public = store.load().public_identity
        output = Path(args.public_key_export or os.environ["AEGIS_AGENT_PUBLIC_KEY_EXPORT_PATH"])
        _atomic_public_write(output, public.public_key_pem)
        print(f"PUBLIC_KEY_EXPORT={output}")
        print(f"FINGERPRINT_SHA256={public.fingerprint_sha256}")
        return 0
    if args.console:
        _host().run()
        return 0
    service_class = build_pywin32_service(
        _host,
        maintenance_action=maintenance_action,
    )
    import servicemanager
    servicemanager.Initialize()
    servicemanager.PrepareToHostSingle(service_class)
    servicemanager.StartServiceCtrlDispatcher()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

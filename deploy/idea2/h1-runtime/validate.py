"""Read-only fail-closed validation of the rendered H1 N1 Compose contract.

The normal path captures `docker compose config --format json` in memory. Never
print that JSON: it contains interpolated lab secrets. --config-json is only for
disposable static fixtures and must not point at a live rendered configuration.
"""

import argparse
import json
import os
from pathlib import Path
import re
import stat
import subprocess
from urllib.parse import unquote, urlsplit

from docker_exec import docker_command


ROOT = Path(__file__).resolve().parents[3]
COMPOSE = Path(__file__).with_name("compose.yml")
PROJECT = "aegis-h1-lab"
POSTGRES_IMAGE = "postgres:15-alpine@sha256:25d430274d8a31184f9435cc5b2f56aff254952065bbbcac0c51acedb5a1d1e7"
MEMORY_LIMIT = {"postgres": 1073741824, "migrate": 1073741824, "monitor": 1073741824, "gateway": 268435456}
EXPECTED_RESTART = {"postgres": "unless-stopped", "migrate": "no", "monitor": "unless-stopped", "gateway": "no"}
MONITOR_HEALTH = ["CMD", "node", "-e", "fetch('http://127.0.0.1:8002/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
EXPECTED_BIND_SOURCES = {
    "/docker-entrypoint-initdb.d/10-h1-role.sh": COMPOSE.with_name("init-role.sh"),
    "/aegis-h1/migrate.sh": COMPOSE.with_name("migrate.sh"),
    "/aegis-h1/schema.sql": ROOT / "IDEA2-AEGIS_Monitor/server/db/schema.sql",
    "/aegis-h1/migrations": ROOT / "IDEA2-AEGIS_Monitor/server/db/migrations",
}


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def ensure_unprivileged_python():
    get_euid = getattr(os, "geteuid", None)
    require(get_euid is None or get_euid() != 0, "N1 validator Python must not run as root")


def check_mount(mount, target):
    require(mount.get("target") == target, "mount target drift")
    require(mount.get("type") == "bind" and mount.get("read_only") is True, "unsafe bind mount")
    actual = Path(mount.get("source", "")).resolve()
    expected = EXPECTED_BIND_SOURCES[target].resolve()
    require(actual == expected and actual.exists(), "unreviewed or missing bind source")
    if target == "/aegis-h1/migrations":
        require(actual.is_dir(), "migration directory missing")
    else:
        require(actual.is_file(), "migration/init file missing")


def check_reviewed_checkout(expected_sha):
    require(not os.environ.get("COMPOSE_PROFILES"), "Compose profiles must be unset for N1")
    require(not os.environ.get("DOCKER_HOST") and not os.environ.get("DOCKER_CONTEXT"), "remote Docker override forbidden")
    commands = [
        (["git", "rev-parse", "HEAD"], "source revision unavailable"),
        (["git", "status", "--porcelain", "--untracked-files=all"], "source checkout is dirty"),
        (["git", "ls-files", "--others", "--ignored", "--exclude-standard", "--", "IDEA2-AEGIS_Monitor"], "ignored files in Monitor build context"),
    ]
    for index, (command, error) in enumerate(commands):
        result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, check=False, timeout=30)
        require(result.returncode == 0, error)
        if index == 0:
            require(result.stdout.strip() == expected_sha, "reviewed source SHA differs from Git HEAD")
        else:
            require(not result.stdout.strip(), error)


def check(rendered, expected_sha):
    require(re.fullmatch(r"[0-9a-f]{40}", expected_sha) is not None, "invalid reviewed source SHA")
    require(rendered.get("name") == PROJECT, "wrong Compose project")
    services = rendered.get("services", {})
    require(set(services) in ({"postgres", "migrate", "monitor"}, {"postgres", "migrate", "monitor", "gateway"}), "unexpected service set")
    networks = rendered.get("networks", {})
    require(set(networks) == {"lab_backend", "lab_ingress"}, "unexpected network set")
    for name, network in networks.items():
        require(network.get("internal") is True and not network.get("external"), f"unsafe {name} network")
        require(network.get("name", f"{PROJECT}_{name}") == f"{PROJECT}_{name}", f"wrong {name} network name")
    volumes = rendered.get("volumes", {})
    require(set(volumes) == {"postgres_data"}, "unexpected volume set")
    require(volumes["postgres_data"].get("name") == f"{PROJECT}_postgres_data", "wrong PostgreSQL volume")
    require(not volumes["postgres_data"].get("external"), "external volume forbidden")
    # A Production-looking project/resource name is rejected even if a future
    # Compose renderer changes its normalization.
    require(all("aegis-prod" not in value.get("name", "") for value in [*networks.values(), *volumes.values()]), "Production resource reference forbidden")

    for name, service in services.items():
        require(not service.get("ports") and not service.get("expose"), f"{name} publishes/exposes ports")
        require("container_name" not in service and "network_mode" not in service, f"{name} escapes project naming")
        require(not service.get("privileged"), f"{name} is privileged")
        for forbidden in ("devices", "device_cgroup_rules", "cap_add", "pid", "ipc", "userns_mode", "extra_hosts", "volumes_from", "secrets", "configs"):
            require(not service.get(forbidden), f"{name} has unreviewed {forbidden}")
        require(str(service.get("mem_limit")) == str(MEMORY_LIMIT[name]), f"{name} exceeds approved memory ceiling")
        require(service.get("restart") == EXPECTED_RESTART[name], f"{name} restart policy drift")
        require(service.get("security_opt") == ["no-new-privileges:true"], f"{name} lacks security option")
        require(service.get("logging", {}).get("driver") == "json-file", f"{name} logging driver drift")
        require(service.get("logging", {}).get("options") == {"max-size": "10m", "max-file": "2"}, f"{name} log cap drift")
        if name != "migrate":
            require(not service.get("entrypoint") and not service.get("command"), f"{name} startup override forbidden")
        else:
            require(not service.get("command"), "migrator command override forbidden")

    pg = services["postgres"]
    require(pg.get("image") == POSTGRES_IMAGE, "PostgreSQL digest mismatch")
    require(not pg.get("build"), "PostgreSQL must not build a local image")
    pg_env = pg.get("environment", {})
    require(set(pg_env) == {"POSTGRES_DB", "POSTGRES_USER", "POSTGRES_PASSWORD", "H1_APP_PASSWORD"}, "PostgreSQL environment drift")
    require(pg_env.get("POSTGRES_DB") == "aegis_h1_lab", "wrong lab database")
    require(pg_env.get("POSTGRES_USER") == "postgres_h1_admin", "wrong lab admin role")
    password = pg_env.get("POSTGRES_PASSWORD", "")
    require(bool(password), "missing lab PostgreSQL secret")
    app_password = pg_env.get("H1_APP_PASSWORD", "")
    require(bool(app_password) and app_password != password, "missing/reused lab application secret")
    require(set(pg.get("networks", [])) == {"lab_backend"}, "PostgreSQL network drift")
    require(pg.get("healthcheck", {}).get("test") == ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U postgres_h1_admin -d aegis_h1_lab"], "PostgreSQL final-server healthcheck drift")
    pg_mounts = pg.get("volumes", [])
    require(len(pg_mounts) == 2, "PostgreSQL mount set drift")
    data_mount = next((mount for mount in pg_mounts if mount.get("target") == "/var/lib/postgresql/data"), {})
    require(data_mount.get("type") == "volume" and data_mount.get("source") in {"postgres_data", f"{PROJECT}_postgres_data"} and not data_mount.get("read_only"), "PostgreSQL volume drift")
    check_mount(next((mount for mount in pg_mounts if mount.get("target") == "/docker-entrypoint-initdb.d/10-h1-role.sh"), {}), "/docker-entrypoint-initdb.d/10-h1-role.sh")

    migrate = services["migrate"]
    require(migrate.get("image") == POSTGRES_IMAGE, "migrator image mismatch")
    require(not migrate.get("build"), "migrator must not build a local image")
    require(migrate.get("entrypoint") == ["/bin/sh", "/aegis-h1/migrate.sh"], "migrator entrypoint drift")
    require(set(migrate.get("environment", {})) == {"PGPASSWORD"}, "migrator environment drift")
    require(migrate.get("environment", {}).get("PGPASSWORD") == password, "migrator credential mismatch")
    require(migrate.get("depends_on", {}).get("postgres", {}).get("condition") == "service_healthy", "migrator readiness drift")
    require(set(migrate.get("networks", [])) == {"lab_backend"}, "migrator network drift")
    mounts = migrate.get("volumes", [])
    targets = {mount.get("target") for mount in mounts}
    require(targets == {"/aegis-h1/migrate.sh", "/aegis-h1/schema.sql", "/aegis-h1/migrations"}, "migration source drift")
    require(len(mounts) == 3, "migration mount count drift")
    for mount in mounts:
        check_mount(mount, mount["target"])

    monitor = services["monitor"]
    require(monitor.get("image") == f"aegis-h1-lab-monitor:{expected_sha}", "Monitor source SHA mismatch")
    require(monitor.get("depends_on", {}).get("migrate", {}).get("condition") == "service_completed_successfully", "Monitor migration gate missing")
    require(set(monitor.get("networks", [])) == {"lab_ingress", "lab_backend"}, "Monitor network drift")
    require(monitor.get("healthcheck", {}).get("test") == MONITOR_HEALTH, "Monitor healthcheck drift")
    build = monitor.get("build", {})
    require(set(build) == {"context", "dockerfile", "args"}, "Monitor build option drift")
    require(Path(build.get("context", "")).resolve() == ROOT / "IDEA2-AEGIS_Monitor", "Monitor build context drift")
    require(build.get("dockerfile") == "Dockerfile", "Monitor Dockerfile drift")
    require(set(build.get("args", {})) == {"NODE_BASE_IMAGE"}, "Monitor build argument drift")
    require(build.get("args", {}).get("NODE_BASE_IMAGE") == "node:20-alpine@sha256:afdf98210b07b586eb71fa22ba2e432e058e4cd1304d31ed60888755b8c865fb", "Monitor base digest mismatch")
    environment = monitor.get("environment", {})
    require(set(environment) == {"NODE_ENV", "PORT", "DATABASE_URL", "SESSION_SECRET", "AGENT_AUTH_REQUIRED", "AGENT_AUTH_AUDIENCE"}, "Monitor environment drift")
    require(environment.get("NODE_ENV") == "production" and str(environment.get("PORT")) == "8002", "Monitor runtime mode drift")
    require(not monitor.get("volumes"), "Monitor bind/volume mount forbidden")
    require(environment.get("AGENT_AUTH_REQUIRED") == "true", "Agent proof must be required")
    require(environment.get("AGENT_AUTH_AUDIENCE") == "https://idea2-h1.aegis-lab.internal:18443", "Agent audience drift")
    require(bool(environment.get("SESSION_SECRET")) and environment["SESSION_SECRET"] not in {password, app_password}, "missing/reused lab session secret")
    database_url = urlsplit(environment.get("DATABASE_URL", ""))
    require(database_url.scheme in {"postgres", "postgresql"}, "invalid lab DATABASE_URL")
    require(database_url.hostname == "postgres" and database_url.port in {None, 5432}, "non-lab database host")
    require(database_url.path == "/aegis_h1_lab" and database_url.username == "monitor_h1_app", "non-lab database identity")
    require(unquote(database_url.password or "") == app_password, "database password mismatch")

    if "gateway" in services:
        gateway = services["gateway"]
        require(gateway.get("profiles") == ["n2"], "gateway must remain excluded from N1")
        require(set(gateway.get("networks", [])) == {"lab_ingress"}, "gateway network drift")
        require(not gateway.get("volumes"), "gateway TLS material is not an N1 input")
        require(not gateway.get("environment"), "gateway environment is not an N1 input")
        require(gateway.get("image") == "aegis-h1-lab-gateway:source-only", "gateway image drift")
        gateway_build = gateway.get("build", {})
        require(set(gateway_build) == {"context", "dockerfile", "args"}, "gateway build option drift")
        require(Path(gateway_build.get("context", "")).resolve() == ROOT / "deploy/idea2/h1-gateway", "gateway build context drift")
        require(gateway_build.get("dockerfile") == "Dockerfile", "gateway Dockerfile drift")
        require(gateway_build.get("args") == {"NGINX_BASE_IMAGE": "nginx:alpine@sha256:0530961ff0592b58c10f767535cc0abdfccf9e389ff7cc90f87320c1bc7e8506"}, "gateway base digest mismatch")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--env-file", type=Path, help="owner-only lab env file outside the repository")
    parser.add_argument("--config-json", type=Path, help="static test fixture only; never a live rendered config")
    args = parser.parse_args()
    try:
        if args.config_json:
            require(not args.env_file, "choose one input")
            rendered = json.loads(args.config_json.read_text(encoding="utf-8"))
        else:
            ensure_unprivileged_python()
            check_reviewed_checkout(args.source_sha)
            require(args.env_file is not None and args.env_file.is_absolute(), "absolute env-file path required")
            env_path = args.env_file.resolve(strict=True)
            require(not env_path.is_relative_to(ROOT), "lab secrets must be outside repository")
            require(env_path.is_file() and not env_path.is_symlink(), "invalid lab secret file")
            if os.name == "posix":
                mode = stat.S_IMODE(env_path.stat().st_mode)
                require(mode & 0o077 == 0 and env_path.stat().st_uid == os.getuid(), "lab secret file must be owner-only")
            result = subprocess.run(
                docker_command("compose", "--project-name", PROJECT, "--env-file", str(env_path), "-f", str(COMPOSE), "config", "--format", "json"),
                capture_output=True, text=True, check=False, timeout=30,
            )
            require(result.returncode == 0, "Docker Compose render failed (details withheld to protect secrets)")
            rendered = json.loads(result.stdout)
        check(rendered, args.source_sha)
    except (ValueError, OSError, subprocess.TimeoutExpired):
        # Rendered values may be embedded in parser/URL errors; never echo them.
        print("H1_N1_CONFIG_VALIDATION=FAIL reason=invalid input or unavailable Docker CLI")
        return 2
    print("H1_N1_CONFIG_VALIDATION=PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

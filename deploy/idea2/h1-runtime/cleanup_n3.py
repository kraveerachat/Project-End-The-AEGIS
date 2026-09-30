"""Print, never execute, the gateway-only N3 rollback for owner review."""

from pathlib import Path

from docker_exec import docker_command


BASE = Path(__file__).with_name("compose.yml")
OVERLAY = Path(__file__).with_name("compose.n3.yml")


def main():
    prefix = " ".join(docker_command())
    common = f'{prefix} compose --project-name aegis-h1-lab --env-file "$H1_ENV_FILE" -f "{BASE}" -f "{OVERLAY}" --profile n3'
    print("H1_N3_CLEANUP_PLAN=REVIEW_ONLY")
    print("After evidence review, stop/remove only the candidate gateway:")
    print(f"{common} stop gateway")
    print(f"{common} rm --force gateway")
    print("N1 Monitor, PostgreSQL, networks, and postgres_data remain untouched.")
    print("No project down, volume removal, prune, or Production operation.")


if __name__ == "__main__":
    main()

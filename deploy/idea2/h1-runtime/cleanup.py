"""Print (never execute) the exact N1 rollback sequence for owner review."""

from pathlib import Path

from docker_exec import docker_command


COMPOSE = Path(__file__).with_name("compose.yml")


def main():
    prefix = " ".join(docker_command())
    print("H1_N1_CLEANUP_PLAN=REVIEW_ONLY")
    print("Stop only the reviewed aegis-h1-lab project after evidence capture:")
    print(f"{prefix} compose --project-name aegis-h1-lab --env-file \"$H1_ENV_FILE\" -f '{COMPOSE}' down")
    print("Only after separate data-loss approval and exact volume identity check:")
    print(f"{prefix} volume rm aegis-h1-lab_postgres_data")
    print("No prune, no Production project, no automatic volume removal.")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""AEGIS Drive (IDEA1) — Day-0 admin password hasher.

Generates a bcrypt hash for the initial Admin account WITHOUT the plaintext
password ever touching disk, shell history, or a process argument list.

Why this exists: docker-compose.yml boots `drive` with
ADMIN_BOOTSTRAP_USERNAME / ADMIN_BOOTSTRAP_PASSWORD_HASH (see
server/db/bootstrapAdmin.js). Those variables must carry an already-computed
bcrypt HASH, never a raw password — env vars are visible to `docker inspect`,
`docker compose config`, and anyone with read access to /proc/<pid>/environ
inside the container. A leaked bcrypt hash is not reversible; a leaked
plaintext password is game over.

Usage:
    pip install -r scripts/requirements.txt
    python scripts/hash_password.py

The password is read via getpass (never echoed, never in argv/history) and
confirmed once. Only the resulting hash is printed to stdout — copy it into
a git-ignored .env next to docker-compose.yml as ADMIN_BOOTSTRAP_PASSWORD_HASH.
"""
import getpass
import sys

import bcrypt

MIN_LENGTH = 12
BCRYPT_COST = 12  # matches the cost used by server/db/connection.js for server-created accounts


def read_password() -> str:
    while True:
        pw1 = getpass.getpass("New admin password (min 12 chars, never echoed): ")
        if len(pw1) < MIN_LENGTH:
            print(f"  too short — need at least {MIN_LENGTH} characters", file=sys.stderr)
            continue
        pw2 = getpass.getpass("Confirm: ")
        if pw1 != pw2:
            print("  did not match — try again", file=sys.stderr)
            continue
        return pw1


def main() -> None:
    password = read_password()
    # bcrypt truncates input at 72 bytes silently — fail loudly instead of
    # producing a hash that only checks the first 72 bytes of a longer password
    if len(password.encode("utf-8")) > 72:
        print("error: password exceeds bcrypt's 72-byte limit", file=sys.stderr)
        sys.exit(1)

    hashed = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt(rounds=BCRYPT_COST))
    del password  # not that it helps much in CPython, but don't hold it longer than needed

    print("\nADMIN_BOOTSTRAP_PASSWORD_HASH=" + hashed.decode("ascii"))
    print("\nPut this in a git-ignored .env next to docker-compose.yml, together with:")
    print("  ADMIN_BOOTSTRAP_USERNAME=admin")
    print("\nAfter the first successful `docker compose up`, remove both vars from .env —")
    print("the account is force-reset on first login, and bootstrapAdmin.js is a Day-0-only")
    print("path that no-ops once any Admin row exists.")


if __name__ == "__main__":
    main()

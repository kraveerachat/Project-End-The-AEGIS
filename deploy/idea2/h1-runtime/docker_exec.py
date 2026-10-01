"""Construct the reviewed N1 Docker command without elevating Python."""

import os


MODE_ENV = "AEGIS_H1_N1_DOCKER_MODE"
LOCAL_SOCKET = "unix:///var/run/docker.sock"


def docker_command(*arguments):
    mode = os.environ.get(MODE_ENV, "direct")
    if mode == "direct":
        prefix = ["docker"]
    elif mode == "sudo-noninteractive":
        prefix = ["sudo", "-n", "env", "-u", "DOCKER_HOST", "docker"]
    else:
        raise ValueError(f"{MODE_ENV} must be direct or sudo-noninteractive")
    return [*prefix, "--host", LOCAL_SOCKET, *arguments]

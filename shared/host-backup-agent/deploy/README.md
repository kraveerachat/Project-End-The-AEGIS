# AEGIS host backup agent — deployment

**Status: prepared, not installed.** Nothing in this directory has been run on
any host. Installation is a separate, reviewed step, and it changes the
production Drive Compose file (see `production-delta.md`).

## Identity and boundary

```
User / Group     aegis-backup
Numeric UID/GID  29102        (fixed — Drive joins the GID via group_add)
Capability       CAP_DAC_READ_SEARCH only (read the Docker volume; write nothing in it)
Socket           /run/aegis-backup/backup.sock   0660  (RuntimeDirectory 0750)
State            /var/lib/aegis-backup           0750  policy.json · jobs.json · dump/ · verify/
Cache            /var/cache/aegis-backup         0750  restic cache
Writable         the three directories above + ReadWritePaths=/mnt/aegis-backup
Network          AF_UNIX + AF_INET/6, IPAddressAllow=localhost,172.16.0.0/12 (Docker bridge for pg_dump)
```

Credential files (root-owned, group-readable by the agent only):

```
/etc/aegis/backup-agent.json              0640 root:aegis-backup   static config (no secrets inside)
/etc/aegis/backup-agent.pgpass            0640 root:aegis-backup   host:port:aegis_drive:drive_backup:<password>
/etc/aegis/backup-agent.restic-password   0640 root:aegis-backup   one line
```

## Prerequisites on the host

```bash
apt-get install restic postgresql-client       # /usr/bin/restic, /usr/bin/pg_dump, /usr/bin/pg_restore
restic version                                 # 0.16+ recommended
```

## Database role (integration review: infrastructure / postgres)

`pg_dump` needs read access to every table in `aegis_drive`. Use a dedicated
read-only role rather than `drive_app`, so the backup credential cannot write:

```sql
CREATE ROLE drive_backup LOGIN PASSWORD '<generated>';
GRANT CONNECT ON DATABASE aegis_drive TO drive_backup;
GRANT USAGE ON SCHEMA public TO drive_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO drive_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO drive_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE <migration-role> IN SCHEMA public GRANT SELECT ON TABLES TO drive_backup;
```

The `REVOKE CONNECT` isolation between `aegis_drive` and `aegis_monitor` is
untouched: `drive_backup` is granted CONNECT on `aegis_drive` only.

PostgreSQL reachability: the host reaches the container over the Docker bridge
(`docker network inspect aegis_internal` → the postgres container IP). Pin a
static `ipv4_address` for postgres or publish `127.0.0.1:5432` — either is a
Compose change and needs integration review. Set `postgres.host` accordingly.

## Install (as root, after review)

```bash
# 1. identity
install -m 0644 aegis-backup.sysusers.conf /usr/lib/sysusers.d/
systemd-sysusers
getent group aegis-backup            # expect gid 29102

# 2. code
install -d -m 0755 /opt/aegis/host-backup-agent
cp -r ../src ../package.json /opt/aegis/host-backup-agent/

# 3. configuration and credentials
install -d -m 0750 -o root -g aegis-backup /etc/aegis
install -m 0640 -o root -g aegis-backup backup-agent.example.json /etc/aegis/backup-agent.json   # then edit
# write the two credential files by hand; never via a command line that echoes them

# 4. external target (example: a USB SSD)
mkdir -p /mnt/aegis-backup
# add the fstab entry for the disk (by UUID) and mount it; the agent refuses a
# path that is not a mount point (NOT_MOUNTED) and one on the same disk as the
# Data Lake (SAME_FAILURE_DOMAIN)

# 5. unit
install -m 0644 aegis-backup.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now aegis-backup.service
```

## Verification on the Linux host (REQUIRED)

```bash
systemd-analyze verify /etc/systemd/system/aegis-backup.service
systemd-analyze security aegis-backup.service
stat -c '%U:%G %a' /run/aegis-backup /run/aegis-backup/backup.sock       # 750 / 660
curl --unix-socket /run/aegis-backup/backup.sock http://localhost/internal/backup/status
#   expect state NOT_CONFIGURED and targets[].protection classified
ss -lntp | grep -i backup                                                # expect: nothing
sudo -u nobody cat /run/aegis-backup/backup.sock                         # Permission denied

# the read-only grant is enough to read the volume and NOT enough to write it
sudo -u aegis-backup systemd-run --pipe --property=AmbientCapabilities=CAP_DAC_READ_SEARCH \
  ls /var/lib/docker/volumes/aegis_drive_storage/_data/uploads | head -1
sudo -u aegis-backup touch /var/lib/docker/volumes/aegis_drive_storage/_data/x   # Permission denied

# credentials never appear in process listings
ps -o args= -C restic -C pg_dump   # during a job: no password, only --password-file / PGPASSFILE-less argv
```

Then, from Drive as Admin: select the target → *Back up now* → watch
`/api/storage` move `RUNNING → READY`, and `history[0].status` become
`SUCCESS` with `integrityCheck: PASS`; then *Verify restore* → `restoreVerification: PASS`.

## Rollback

`systemctl disable --now aegis-backup.service` and revert the Drive Compose
delta. The restic repository on the external disk is inert data; leaving it in
place is harmless. Nothing in the production volume or database was modified
by the agent at any point (it only ever reads them).

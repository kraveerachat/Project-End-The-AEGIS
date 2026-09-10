# PUBLIC-SHARE-7 S5.4 Production Overlay

This directory contains the repository-side S5.4 Drive State B and dedicated
gateway network contract, reconciled with completed owner-run Production runtime
acceptance. S5.4 is strictly pre-Internet:
`cloudflared`: absent; DNS: absent; TLS route: absent; host-published listener:
absent; Public Share UI: off; egress network: absent.

The existing nginx-only gateway under `gateway/public-share/` is reused. Its
source tree is `2025eb0873a4e7f8d3d2b00b02fc3dfca02b91df` at both revision
`50ce6e1638c6bcdb2a378a3cee660050b9cb41d8` and S5.4 base
`dc673992b4c474716c4a14d2d375b3c9dd583feb`. No second share backend exists.

## Compose order

The reviewed future model uses exactly these files, in order:

1. `/opt/aegis/runtime/docker-compose.production.yml`
2. `/opt/aegis/runtime/public-share/drive-s5-3.yml`
3. `/opt/aegis/runtime/public-share/drive-gateway-s5-4.yml`, copied byte-for-byte
   from `docker-compose.s5-4.yml` after merge

Validate the merged model before any service operation:

```bash
sudo docker compose \
  --env-file /opt/aegis/Project-End-The-AEGIS/.env \
  --project-name aegis-prod \
  -f /opt/aegis/runtime/docker-compose.production.yml \
  -f /opt/aegis/runtime/public-share/drive-s5-3.yml \
  -f /opt/aegis/runtime/public-share/drive-gateway-s5-4.yml \
  config --quiet
```

The future service-scoped order is Drive first and gateway second:

```bash
sudo docker compose \
  --env-file /opt/aegis/Project-End-The-AEGIS/.env \
  --project-name aegis-prod \
  -f /opt/aegis/runtime/docker-compose.production.yml \
  -f /opt/aegis/runtime/public-share/drive-s5-3.yml \
  -f /opt/aegis/runtime/public-share/drive-gateway-s5-4.yml \
  up -d --no-deps --no-build drive

sudo docker compose \
  --env-file /opt/aegis/Project-End-The-AEGIS/.env \
  --project-name aegis-prod \
  -f /opt/aegis/runtime/docker-compose.production.yml \
  -f /opt/aegis/runtime/public-share/drive-s5-3.yml \
  -f /opt/aegis/runtime/public-share/drive-gateway-s5-4.yml \
  up -d --no-deps --no-build public-share-gateway
```

These commands reflect the exact sequence executed during owner-run Production
acceptance. Production Drive State B and dedicated Gateway are active on isolated
internal networks.

## Exact S5.3 rollback

Rollback removes the gateway first, then restores Drive by omitting the S5.4
overlay:

```bash
sudo docker compose \
  --env-file /opt/aegis/Project-End-The-AEGIS/.env \
  --project-name aegis-prod \
  -f /opt/aegis/runtime/docker-compose.production.yml \
  -f /opt/aegis/runtime/public-share/drive-s5-3.yml \
  -f /opt/aegis/runtime/public-share/drive-gateway-s5-4.yml \
  rm -s -f public-share-gateway

sudo docker compose \
  --env-file /opt/aegis/Project-End-The-AEGIS/.env \
  --project-name aegis-prod \
  -f /opt/aegis/runtime/docker-compose.production.yml \
  -f /opt/aegis/runtime/public-share/drive-s5-3.yml \
  up -d --no-deps --no-build drive

sudo docker network rm aegis_public_share_edge aegis_public_share_upstream
```

The two networks may be removed only after inspection proves they have no
members. The accepted S5.3 state is:

- Drive image
  `sha256:04d2f81478fdb0d4284433cfd2d07197c9175d61425216565405a46f914766df`;
- S5.3 override SHA-256
  `324fb5126b2f13f7b1c529ef1391131ef37f81acc8c3921b9b50f649b179de62`;
- `aegis_drive_proxy=172.19.255.3`;
- `aegis_internal=172.18.0.3`;
- `aegis_vlan10_macvlan=192.168.10.11`;
- `TRUSTED_PROXY_CIDRS=172.19.255.2/32`;
- `PUBLIC_SHARE_GATEWAY_CIDR=unset`;
- `PUBLIC_SHARE_UI_ENABLED=false`;
- protected volumes and unrelated services unchanged.

No Compose-wide stop, recreate, rebuild, or prune operation is permitted.

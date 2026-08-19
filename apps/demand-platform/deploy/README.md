# Deployment reference

English | [中文](README.zh.md)

`compose.pilot.example.yml` is a single-host reference deployment for company testing or a small pilot, not a production HA architecture for 3,000 employees. It starts one API process and one outbox worker that share a SQLite WAL database on a local Docker volume.

## Before use

1. Copy `.env.production.example` to `.env.production`, inject separate random secrets for every purpose through the company key-management system, and never commit that file.
2. Scan `node:24-bookworm-slim` in the company artifact registry, pin an immutable digest, and select the internal image through the `NODE_IMAGE` build argument.
3. Deploy the company gateway, TLS, and WAF in front of the API. Only the trusted identity gateway may inject signed employee identity.
4. Confirm that the volume is local to one host and does not use a shared network filesystem without SQLite locking semantics.
5. Configure daily backups, off-site replication, integrity verification, restore drills, and disk-capacity alerts.
6. Allow only the company monitoring collector to access `/internal/metrics` with a separate `METRICS_API_KEY`, and import `prometheus-alerts.example.yml` only after formal threshold review.

Example:

```powershell
Set-Location deploy
Copy-Item .env.production.example .env.production
# 使用密钥系统或安全编辑方式填值
docker compose -f compose.pilot.example.yml config
docker compose -f compose.pilot.example.yml up -d --build
```

Docker and Podman are not installed in the current work environment, so no claim is made that the image has been built. Before release, company CI must build and scan the image, start the container, and run health checks.

## Production evolution

Do not copy this Compose deployment directly for company-wide production:

- Refactor SQLite and direct SQL access to a company-approved HA relational database.
- Migrate or bridge local outbox polling to the company message queue or task platform.
- Run stateless API replicas and scale workers independently.
- Integrate unified SSO/RBAC, KMS, gateway rate limiting, logs, metrics, alerts, and SIEM.
- Store attachments in object storage with malware and content-security scanning.
- Complete capacity, failure, backup-restore, and rollback drills before company-wide release.

The company P0-07 infrastructure input determines the target architecture, avoiding premature coupling to a platform that does not yet exist.

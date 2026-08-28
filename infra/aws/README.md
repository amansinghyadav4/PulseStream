# AWS Deployment Runbook (Phase 8)

Target topology: **one EC2 instance running the production compose stack**
(self-contained: PostgreSQL, Kafka, Redis, api, frontend, 2 workers).

Why this shape: PulseStream's dev stack is already compose-defined, so a
single Docker host reproduces the exact tested topology with zero managed-service
surface area. It is a real deployment (public HTTP entrypoint, restart policies,
log rotation, healthchecks) — but it is NOT highly available. The upgrade path to
managed services is documented at the bottom; do not present single-host as HA.

## 1. Provision

| Item | Recommendation |
|---|---|
| AMI | Ubuntu Server 24.04 LTS (amd64) |
| Instance | t3.large (2 vCPU / 8 GB). Kafka+PG+api+2 workers on one host needs headroom; t3.medium works but swaps under load |
| Disk | 30 GB gp3 minimum (pgdata grows with event volume; Phase 7 run added ~120 MB per ~330K events incl. indexes) |
| Key pair | your own |
| User data | `infra/aws/user-data.sh` (installs Docker, clones repo). Set `REPO_URL` at the top first |

Security group (principle of least exposure):

| Port | Source | Purpose |
|---|---|---|
| 22 | your IP /32 | SSH admin |
| 80 | 0.0.0.0/0 or restricted | dashboard (nginx container) |
| 8000 | optional — restrict to your IP | direct API access for load tests |
| none for 5432/6379/9092 | — | Postgres/Redis/Kafka have no published host ports in prod compose |

## 2. First boot

```bash
ssh -i <key>.pem ubuntu@<instance-ip>
# user-data already installed docker + cloned /opt/pulsestream
cd /opt/pulsestream
```

## 3. Secrets & environment

user-data deliberately contains NO secrets (instance metadata is readable by
anything on the box). Create them over SSH:

```bash
cp infra/aws/env.production.template .env.production
chmod 600 .env.production
# edit: POSTGRES_PASSWORD (long random), CORS_ORIGINS (real origin), ports
```

## 4. Build & launch

```bash
docker build -t pulsestream-backend:latest .
docker build -t pulsestream-frontend:latest ./frontend
sudo docker compose -f infra/docker-compose.prod.yml --env-file .env.production up -d
sudo docker compose -f infra/docker-compose.prod.yml ps   # all healthy?
```

## 5. Smoke checks

```bash
curl -s localhost:8000/api/v1/health          # {"status":"ok"}
curl -s localhost:8000/api/v1/ready           # status:"ready", all deps healthy
curl -s -X POST localhost:8000/api/v1/events \
  -H 'content-type: application/json' \
  -d '{"event_type":"deploy.check","source":"runbook","payload":{}}'   # 201
curl -s localhost:8000/api/v1/metrics | grep consumer_lag
```

Dashboard at `http://<instance-ip>/`.

## 6. Upgrades & rollback

```bash
git pull
docker build -t pulsestream-backend:latest .
sudo docker compose -f infra/docker-compose.prod.yml --env-file .env.production up -d
```

Suggested rollback discipline: tag images with git SHAs (`pulsestream-backend:<sha>`)
and keep `latest` as a symlink-style retag; rolling back = retag previous SHA +
`up -d`. Schema changes currently rely on `create_all` being skipped in prod
(tables created manually once via a dev migration dump); Alembic is the tracked
follow-up before any multi-version deployment.

## 7. Honest limitations of this topology

- Single host: no HA. Host down = platform down.
- Kafka runs PLAINTEXT inside the Docker network only; never expose 9092.
- Secrets live in `.env.production` on the host (chmod 600, root-readable).
- No TLS termination in this path — front it with an ALB/CloudFront or add a TLS proxy if serving publicly.
- Logs are json-file rotated locally (`max-size/max-file` per service); no centralized log sink yet.
- Metrics are scrape-ready at `/api/v1/metrics`; wiring Prometheus/CloudWatch is future work.

## Upgrade path to managed services (when justified)

| Self-hosted now | Managed replacement |
|---|---|
| postgres container | RDS PostgreSQL (backup retention, Multi-AZ) |
| redis container | ElastiCache Redis |
| kafka container | MSK (or keep Kafka on host until scale demands it) |
| single EC2 api/workers | ECS Fargate services + ALB; workers as separate services |

Each swap changes only connection URLs + network paths (all configurable via env),
which is exactly why every dependency endpoint is environment-driven.

# infra

Infrastructure assets for the B2B Operations Suite.

- Local development services are defined in the root
  [`docker-compose.yml`](../docker-compose.yml): PostgreSQL, Redis, MinIO (with
  bucket initialization) and Mailpit.
- Deployment manifests (production database, object storage, mail, the
  api/web/worker containers and their Dockerfiles) are added in later
  milestones. Production secrets are never committed — see the
  "Production secret management" section of [`.env.example`](../.env.example).

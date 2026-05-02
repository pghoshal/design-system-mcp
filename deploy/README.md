# Sample deployment manifests

These are **starter templates**, not production manifests. Copy and adapt.

| Target | File | Notes |
|---|---|---|
| Fly.io | `fly/fly.toml` | Volume-mounted Git cache; single machine |
| Kubernetes | `k8s/deployment.yaml` | Single replica, `Recreate` strategy, PDB allows drain |
| Kubernetes (secret template) | `k8s/secret.example.yaml` | DO NOT commit a populated copy — use SealedSecrets / ESO / cloud secret manager |

## Single-instance is intentional

This server is designed for one running process per environment. Do not raise replica counts; multi-instance is a fresh design proposal, not a config change.

## Image tagging

Always pin to an immutable tag (git SHA short or semver). Never `:latest` in production. The CI pipeline at `.github/workflows/ci.yml` builds and pushes tagged images on git tag.

## What lives where

- Operating procedures: `docs/runbook.md`
- Client (IDE) configuration: `docs/client-setup.md`

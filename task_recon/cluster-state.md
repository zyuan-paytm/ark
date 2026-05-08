# Phase 2 Recon: pai-risk-mlops Cluster State
Date: 2026-05-06  
Account: 880170353725 | Region: ap-south-1 | Cluster: pai-risk-mlops-platform

---

## AWS Prerequisites (verifiable without kubectl)

| Item | Status | Detail |
|---|---|---|
| AWS profile `pai-risk-mlops` | READY | zineng.yuan@paytm.com via `PaiRiskSRE` role |
| kubectl context | CONFIGURED (BLOCKED) | `pai-risk-mlops-platform` is the current-context; EKS API is private-only (see below) |
| Secrets Manager `pai-risk-mlops/platform/ark` | READY | All 10 keys SET, Terraform-managed, last accessed 2026-05-05 |
| IRSA role `platform-ark` | READY | Correct OIDC trust for `system:serviceaccount:ark:ark`; S3 policy attached |
| GHCR image `ghcr.io/ytarasova/ark:latest` | READY | amd64 manifest confirmed |
| RDS rotating secret | READY | Exists, rotating every 7 days, last rotated 2026-05-05 |
| ECR repo `pai-mlops-platform/ark` | EXISTS (empty) | Values use GHCR, not ECR -- this is fine for now |
| Helm chart renders | CLEAN | No template errors with pai-risk-mlops values |

---

## kubectl Blocked: EKS Private Endpoint + Zscaler DNS Hijack

The EKS cluster API server has `endpointPublicAccess: false` (private-only). DNS resolves the endpoint to `100.64.1.24` -- a Zscaler VPN proxy IP, not the real ENI. This causes TLS handshake timeout on every `kubectl` call.

**This blocks direct inspection of:** namespace state, ArgoCD Application sync, ESO ClusterSecretStore existence, pod status, ExternalSecret sync status, `ark` DB existence in foundry RDS.

**Options to unblock kubectl:**
1. Enable cluster public endpoint temporarily: `aws eks update-cluster-config --name pai-risk-mlops-platform --resources-vpc-config endpointPublicAccess=true` (requires cluster admin, reverts after use)
2. Add host overrides to `/etc/hosts` using real ENI IPs (need VPC access to find them)
3. Use SSM Session Manager to exec into a cluster node and run kubectl from there

---

## Cluster State: UNKNOWN

All of the following could not be verified -- requires kubectl access:

- `ark` namespace -- created by Helm, but unknown if chart has been applied
- `ClusterSecretStore: aws-secretstore` -- ESO pre-requisite that must exist before ExternalSecret can sync
- ArgoCD Application `ark` -- unknown if added to pi-risk-mlops gitops repo (see runbook Step 5)
- `ark` database in foundry RDS -- must be created by DBA (runbook Step 1), not verifiable remotely
- Pods running, ExternalSecret synced, ingress active

---

## Helm Chart Bugs Found (must fix before first working deploy)

### BUG-1: Wrong auth env var name -- auth not enforced (CRITICAL security)

**File:** `.infra/helm/ark/templates/configmap.yaml`

The ConfigMap emits `ARK_AUTH_ENABLED: "true"`. The codebase reads `ARK_AUTH_REQUIRE_TOKEN` (see `packages/core/config/env-source.ts:108`). `ARK_AUTH_ENABLED` is unused -- grep returns zero hits.

**Impact:** The control plane will boot without auth token enforcement, regardless of the values file setting. Any caller can hit the API without a Bearer token.

**Fix:**
```yaml
# configmap.yaml -- replace the phantom var
ARK_AUTH_REQUIRE_TOKEN: "true"   # was ARK_AUTH_ENABLED
```

---

### BUG-2: ARK_PROFILE not set -- affects profile-gated behavior (MEDIUM)

**File:** `.infra/helm/ark/templates/configmap.yaml`

`config.profile: control-plane` in values is never wired to any env var. `detectProfile()` falls through to `"local"` (no `DATABASE_URL` literal, no `ARK_PROFILE`).

The **mode** (local vs hosted) is correctly determined by `buildAppMode()` via DB_* parts assembling to a postgres URL, so the app does boot with Postgres and multi-tenant wiring. But the profile being "local" affects other defaults (e.g. `requireToken` base value, logging, future profile-gated flags).

**Fix:**
```yaml
# configmap.yaml -- add alongside other ARK_* vars
ARK_PROFILE: "control-plane"
```

---

### BUG-3: TensorZero hardcoded enabled (MEDIUM)

**File:** `.infra/helm/ark/templates/control-plane-deployment.yaml` (lines 82-85)

```yaml
- name: ARK_TENSORZERO_URL
  value: "http://localhost:3000"
- name: ARK_TENSORZERO_ENABLED
  value: "1"
```

These are hardcoded regardless of `tensorZero.enabled: false` in values. `ARK_TENSORZERO_ENABLED=1` makes `config.tensorZero.enabled = true`, causing the app to try to connect to `localhost:3000` -- which has no sidecar. Depending on whether the tensorzero client has a connection timeout, this may slow startup or cause errors.

**Fix:** Guard these two env vars behind `{{- if .Values.tensorZero.enabled }}`.

---

## Documentation Discrepancy

Runbook (`docs/DEPLOY-PAI-RISK-MLOPS.md`, Step 3) says to create IAM role named `platform-ark-service`. The actual role created is `platform-ark` (matching `values.yaml` annotation). The runbook is stale on this name; values.yaml is correct.

---

## What Needs Doing Before First Deploy Can Succeed

### Must-do (blockers):
1. **Fix chart BUG-1** -- add `ARK_AUTH_REQUIRE_TOKEN: "true"` to ConfigMap, remove `ARK_AUTH_ENABLED`
2. **Fix chart BUG-2** -- add `ARK_PROFILE: "control-plane"` to ConfigMap
3. **Fix chart BUG-3** -- gate tensorzero env vars on `tensorZero.enabled`
4. **Verify `ark` DB exists** in foundry RDS -- DBA may need to run `CREATE DATABASE ark; CREATE SCHEMA code_intel;`
5. **Verify ESO ClusterSecretStore `aws-secretstore` exists** -- pre-installed by platform team; needs kubectl access to confirm
6. **Wire ArgoCD Application** in pi-risk-mlops gitops repo (runbook Step 5) -- `k8s/infra-applications/application-bootstrap/pai-risk-mlops-platform-values.yaml`

### Nice-to-have for first deploy:
7. Tag image with a version SHA instead of `latest` for rollback capability
8. Update runbook Step 3 to use correct role name `platform-ark`

### After first deploy, verify:
```bash
# Confirm pods are up (once kubectl works)
kubectl --context pai-risk-mlops-platform -n ark get pods
kubectl --context pai-risk-mlops-platform -n ark logs -l app.kubernetes.io/component=control-plane --tail=50
kubectl --context pai-risk-mlops-platform -n ark get externalsecret ark-secrets -o yaml

# Health endpoint (once ingress is up)
curl https://ark.internal.ap-south-1.platform.mlops.pai.mypaytm.com/health
```

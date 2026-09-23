---
status: accepted
---

# Automated host scripts distribution, provenance verification, and fail-safe execution

Issue #1325 addresses a critical data recovery failure where the nightly backup produced nothing for 22 days on the production host. The root cause was twofold: (1) operational scripts on the host (`~/scripts/`) were manually copied and lagged behind repository revisions, leaving `postgres-backup.sh` reading an outdated bot `.env` file that had its credentials removed during the Vault-only migration (#654/#655); and (2) `set -euo pipefail` caused `grep` to exit with non-zero status before emitting any log or error banner.

## Decision

- **Automated Distribution Ownership**:
  Host operational scripts are automatically deployed to `/home/ngoc_anh/scripts/` during the preflight/bootstrap phase of the `messenger-bot` deployment in `vps-deploy.sh`. Because Messenger bot owns DB schema migrations and host-level `backup-bootstrap.env` installation, centralizing host script distribution in this step prevents duplicate installs across bot workflows.

- **Fail-Safe Script Execution**:
  All operational bash scripts running on the host (`postgres-backup.sh`, `backup-monitor.sh`, `postgres-offsite-sync.sh`, `postgres-restore-verify.sh`, `vps-hardening-check.sh`) must adhere to fail-safe execution standards:
  - **Immediate Startup Banner**: Echo a timestamped startup banner (`[$(date -Iseconds)] [script-name] Starting...`) before variable resolution or parameter parsing so that a run attempt is always distinguishable from a missed cron tick.
  - **Safe Config Extraction**: Replace unshielded `grep` calls with safe extraction functions (`grep -E "^KEY=" "$FILE" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true`). Missing environment variables fall through to explicit, human-readable validation blocks instead of silently terminating the shell.
  - **ERR Trap & Alerting**: Trap `ERR` to log the failure line number and exit code, and send an alert (`postgres_backup_failed`) to Alertmanager when an unhandled runtime error aborts execution before the success marker is written.

- **Atomic Installation & Deprecated Script Purge**:
  Host scripts are installed using atomic file replacement (`mktemp` in the target directory -> `chmod 750` -> `mv -f`). Deprecated scripts—specifically `postgres-restore-test.sh`—are explicitly removed during the deployment pass to prevent unsafe operator use.

- **Provenance Tracking via Host Script Manifest**:
  Every script distribution generates a machine-readable manifest at `/home/ngoc_anh/scripts/.installed-manifest.json` containing:
  ```json
  {
    "commit_sha": "<git_sha>",
    "installed_at": "<iso_timestamp>",
    "scripts": {
      "postgres-backup.sh": "<sha256>",
      "postgres-offsite-sync.sh": "<sha256>",
      "postgres-restore-verify.sh": "<sha256>",
      "backup-monitor.sh": "<sha256>",
      "vps-hardening-check.sh": "<sha256>"
    }
  }
  ```
  This proves the exact repository commit SHA from which each script originated without manual code inspection.

- **Hourly Drift Detection & Critical Alerting**:
  `backup-monitor.sh` reads `.installed-manifest.json` on its hourly cron schedule. It checks each registered script for existence, executable bit, and SHA256 checksum agreement. If any script is missing, unexecutable, or modified out-of-band:
  - It immediately posts a `host_scripts_drift_detected` alert with severity `critical` to Alertmanager (fan-out to Discord `@here`, Pushover emergency, and Telegram).
  - When all scripts match their manifest checksums, it posts a resolved notification.

- **Dual-Path Deploy Pipeline Integration**:
  - Direct SSH deploy (`deploy-bot-reusable.yml`): Packages `deploy/*.sh` into `upload-bundle/scripts/` when `inputs.app == 'messenger-bot'`, passing `DEPLOY_SHA=${{ github.sha }}`.
  - Self-pull deploy (`vps-self-pull-deploy.sh`): Copies scripts from the active repository checkout into the deploy bundle and passes `DEPLOY_SHA="$NEW_SHA"`.

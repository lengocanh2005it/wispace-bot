## Problem Statement

As a platform operator and engineering team, our production database backups ceased running silently for 22 consecutive days, leaving all learner study logs, active conversation records, quota usages, and account linkings completely unrecoverable in the event of hardware or host loss.

When database credentials were transitioned to a centralized secret management system, the host environment was updated but the operational scripts executing on the host were not updated because they were deployed through manual copying rather than automated pipelines. Because of aggressive shell error handling combined with unshielded pattern matching, the backup script encountered an exit code failure during variable resolution and terminated before outputting a single line of log or error message. The nightly cron executed every night as scheduled, but each attempt died silently. Concurrently, secondary replication and restore verification automation were never transferred to the production host, leaving obsolete and unsafe restore testing utilities in place and leaving offsite disaster recovery completely inactive.

## Solution

From the operator's perspective, disaster recovery automation is transformed into an automated, fail-safe, and self-auditing subsystem:

1. Operational host scripts are deployed, updated, and permission-locked automatically on every release by the primary deployment orchestrator without manual operator intervention, and retired scripts are automatically purged from the host.
2. Every host script is fail-safe: it immediately announces its execution with a timestamped startup banner, extracts environment settings without panicking on missing values, validates inputs with explicit human-readable error messages, and traps unexpected runtime failures to dispatch critical alerts.
3. Every release automatically writes a machine-readable Host Script Manifest that locks the git commit provenance and cryptographic checksum of every deployed script.
4. The hourly health monitor continuously audits the integrity of host scripts against the manifest, immediately sounding a critical alert if any script is missing, modified, or corrupted, and automatically resolving the alert once parity is confirmed.

## User Stories

1. As a platform operator, I want host operational scripts to be distributed automatically by the deployment pipeline, so that host scripts never drift from repository code due to forgotten manual copying.
2. As a platform operator, I want retired operational scripts to be automatically purged from the host by the deployment pipeline, so that no team member accidentally runs obsolete or dangerous procedures.
3. As a platform operator, I want every host operational script to print an immediate startup timestamp banner, so that I can immediately distinguish between a script that never triggered and a script that terminated early.
4. As a platform operator, I want configuration resolution in host scripts to handle absent environment variables gracefully without crashing under shell error flags, so that missing variables fall through to explicit validation checks with actionable error messages.
5. As an on-call engineer, I want any unexpected exit or unhandled error in the host backup runner to trigger an immediate alert to Alertmanager, so that backup crashes never happen silently.
6. As a platform operator, I want each deployment to record an authoritative Host Script Manifest containing the git commit SHA, deployment timestamp, and cryptographic checksums of every operational script, so that the provenance of host automation is always verifiable.
7. As a health monitor, I want to inspect the filesystem hourly to verify that all required operational scripts exist, possess executable permissions, and match their manifest checksums, so that accidental tampering or missing files are detected rapidly.
8. As an on-call engineer, I want the health monitor to fire a critical alert to all emergency paging channels whenever script drift or tampering is detected, so that the team can remediate operational divergence before backups become stale.
9. As an on-call engineer, I want the health monitor to automatically resolve the script drift alert once checksum parity is restored, so that our monitoring plane accurately reflects resolved states.
10. As a deployment runner, I want operational scripts to be installed atomically using temporary staging and rename operations, so that running cron jobs never execute partially written script files during an active deploy.
11. As a deployment runner, I want host script permissions to be strictly enforced at mode 0750 with restricted directory permissions, so that unprivileged processes cannot read or modify operational automation.
12. As a platform learner, I want daily database backups to execute reliably and verifiably every single night, so that my learning milestones, feedback records, and exercise history are safe against datacenter disasters.
13. As a platform operator, I want offsite replication automation to adhere to the same non-panicking execution and early-logging standards, so that secondary offsite backups do not suffer from silent early failures.
14. As a release engineer, I want script packaging to be integrated into both the remote CI/CD workflow and the local VPS self-pull runner, so that whichever deployment mechanism is used, host scripts are guaranteed to be updated.
15. As a compliance auditor, I want a clear audit trail connecting the scripts executing on the host to exact git commits in the version control system, so that infrastructure changes are fully traceable.

## Implementation Decisions

- **Centralized Deployment Ownership**:
  The distribution of operational host scripts is assigned exclusively to the primary deployment orchestrator during the preflight stage of the migration-owner application rollout. This mirrors the database migration barrier and ensures host scripts and the dedicated backup environment are updated before container deployment begins.

- **Canonical Host Directory Consolidation**:
  All operational scripts executing outside containers are consolidated into a single dedicated scripts directory on the host user's path. All scheduling entries and documentation are aligned to this single location.

- **Fail-Safe Script Execution Discipline**:
  - Scripts must output a startup banner immediately upon invocation, prior to reading external configuration or validating arguments.
  - Configuration parsing must isolate pattern matching commands so that a non-zero exit status from an unmatched line does not trigger shell termination under pipefail rules.
  - An error signal trap must be registered to capture unexpected termination codes and trigger a failure alert payload to the central alerting endpoint before exiting.

- **Host Script Manifest Schema**:
  The deployment orchestrator generates a manifest artifact structured as follows (shape validated from architecture design):
  ```json
  {
    "commit_sha": "string",
    "installed_at": "ISO-8601 timestamp",
    "scripts": {
      "backup_runner": "sha256 hex string",
      "offsite_sync": "sha256 hex string",
      "restore_verifier": "sha256 hex string",
      "health_monitor": "sha256 hex string",
      "hardening_checker": "sha256 hex string"
    }
  }
  ```

- **Continuous Manifest Auditing**:
  The hourly health monitor incorporates a manifest audit procedure. For each entry in the manifest, the monitor checks file presence, executable permission bits, and calculates the SHA256 digest to compare against the manifest. Discrepancies generate a critical alert routed to the emergency fan-out receiver; full alignment dispatches an alert cancellation.

- **Atomic Staging and Deprecation Purging**:
  The deployment orchestrator writes scripts to temporary files in the target directory before atomically moving them into their canonical names. Obsolete script files designated for retirement are explicitly unlinked during this stage.

## Testing Decisions

- **Testing Philosophy**:
  Tests must evaluate external behavior only, treating operational scripts and deployment runners as black boxes. Assertions are made on exit codes, standard output/error content, filesystem properties (file existence, permission bits, checksum equivalence), and HTTP webhook payloads sent to mock alert endpoints. Internal bash function implementations must not be tested directly.

- **Modules Tested**:
  1. **Deployment Orchestration Module**: Tested by running the deployment flow in an isolated directory tree with mock inputs, asserting that all operational scripts are properly placed with mode 0750, the manifest is generated with valid commit and checksum values, and designated retired scripts are purged.
  2. **Health Monitor Module**: Tested by executing the monitor against simulated clean, tampered, and missing script scenarios, asserting that critical alerts are dispatched to the mock alert receiver upon drift and resolved upon restoration.
  3. **Host Backup Runner Module**: Tested in a clean subshell with empty or invalid configuration files, asserting that an immediate startup banner is emitted, descriptive errors are written to standard error, an error exit code is returned, and execution does not abort silently.

- **Prior Art**:
  - The repository's existing deployment script regression tests that verify environment validation, container configuration, and exit traps.
  - The repository's existing backup monitor tests that verify freshness calculation and mock Alertmanager webhook dispatch.

## Out of Scope

- Performing live database backup restoration on the production host (covered by dedicated operational drill runbooks).
- Implementing continuous WAL archiving (tracked under a separate architectural issue).
- Redesigning the notification channels or alerting routing topology (existing critical severity routing is used as-is).
- Deploying host scripts during secondary bot application deployments (handled solely by the migration owner).

## Further Notes

- Aligns directly with Architecture Decision Record 0039 (*Automated host scripts distribution, provenance verification, and fail-safe execution*).
- Vocabulary and naming conventions conform strictly to the Disaster Recovery & Host Scripts section in the project domain glossary.

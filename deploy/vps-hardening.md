# VPS Hardening Baseline

Production VPS host hardening baseline for the WISPACE bot deployment.
This document defines the expected security posture and approved exceptions.

## VPS Identity

| Field | Value |
|-------|-------|
| **OS** | Ubuntu 22.04 LTS (Jammy Jellyfish) |
| **Provider** | Hostinger |
| **Deploy user** | `ngoc_anh` |
| **SSH port** | Configurable via `VPS_SSH_PORT` (default 22) |
| **Public hostname** | `aiassist.aihubproduction.com` |

## Hardening Baseline

### 1. SSH Access

| Check | Expected | Critical |
|-------|----------|----------|
| Password authentication | `no` | Yes |
| Root login | `prohibit-password` or `no` | Yes |
| Pubkey authentication | `yes` | Yes |
| Max auth tries | ≤ 3 | No |
| Login grace time | ≤ 60s | No |
| AllowTcpForwarding | `no` | No |
| X11Forwarding | `no` | No |

**Remediation:** Edit `/etc/ssh/sshd_config`, set the values above, run `sudo systemctl restart sshd`.

### 2. Host Firewall (UFW)

| Rule | Direction | Port | Source | Purpose |
|------|-----------|------|--------|---------|
| HTTP | In | 80/tcp | 0.0.0.0/0 | Let's Encrypt + redirect |
| HTTPS | In | 443/tcp | 0.0.0.0/0 | Public webhooks |
| SSH | In | $VPS_SSH_PORT/tcp | Restrict if possible | Deploy access |
| All other | In | — | — | DENY (default incoming deny) |

**Remediation:** `sudo ufw default deny incoming && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw allow $VPS_SSH_PORT/tcp && sudo ufw enable`

### 3. Automatic Security Updates

| Check | Expected | Critical |
|-------|----------|----------|
| `unattended-upgrades` installed | Yes | Yes |
| `Unattended-Upgrade::Automatic-Reboot` | `false` | No |
| `apt` auto-update timer active | Yes | No |

**Remediation:** `sudo apt install -y unattended-upgrades && sudo dpkg-reconfigure -plow unattended-upgrades`

### 4. Time Synchronization

| Check | Expected | Critical |
|-------|----------|----------|
| `chrony` or `systemd-timesyncd` active | Yes | Yes |
| `timedatectl` shows `NTP synchronized: yes` | Yes | Yes |

**Remediation:** `sudo apt install -y chrony && sudo systemctl enable --now chrony`

### 5. Docker Daemon

| Check | Expected | Critical |
|-------|----------|----------|
| Docker socket ownership | `root:docker` | No |
| Docker socket permissions | `660` or stricter | Yes |
| TCP socket exposure (`-H tcp://`) | Disabled | Yes |
| `live-restore` | `true` | No |
| `userns-remap` | Configured or default | No |
| `no-new-privileges` default | `true` | No |

**Remediation:** Edit `/etc/docker/daemon.json`, remove TCP bind, set `"live-restore": true`, restart Docker.

### 6. Container Runtime Defaults

| Check | Expected | Critical |
|-------|----------|----------|
| Bot containers: `cap_drop: ALL` | Yes | Yes |
| Bot containers: `security_opt: no-new-privileges` | Yes | Yes |
| Bot containers: non-root user (`USER app`) | Yes | Yes |
| Bot containers: read-only rootfs where possible | Preferred | No |
| PgBouncer: `read_only: true` | Yes | Yes |
| No `--privileged` containers running | Yes | Yes |

**Remediation:** Update `docker-compose.pgbouncer.yml` or `docker run` flags.

### 7. Host Filesystem Permissions

| Path | Expected Mode | Critical |
|------|--------------|----------|
| `<app>/.env` | `600` | Yes |
| `backups/` directory | `700` | Yes |
| Backup files `*.sql.gz.gpg` | `600` | Yes |
| `deploy/*.sh` scripts | `755` | No |
| `/etc/nginx/sites-available/*` | `644` | No |

**Remediation:** `chmod 600 <file> && chown ngoc_anh:ngoc_anh <file>`

### 8. Exposed Ports

| Port | Binding | Expected | Critical |
|------|---------|----------|----------|
| 80 | `0.0.0.0` | Yes (HTTP) | No |
| 443 | `0.0.0.0` | Yes (HTTPS) | No |
| 5007 | `127.0.0.1` | Yes (Messenger) | Yes |
| 5008 | `127.0.0.1` | Yes (Messenger standby) | Yes |
| 3001 | `127.0.0.1` | Yes (Discord) | Yes |
| 3002 | `127.0.0.1` | Yes (Zalo) | Yes |
| 3003 | `127.0.0.1` | Yes (Zalo standby) | Yes |
| 3004 | `127.0.0.1` | Yes (Discord standby) | Yes |
| 6432 | `127.0.0.1` | Yes (PgBouncer) | Yes |
| 9093 | `127.0.0.1` | Yes (Alertmanager) | Yes |
| 5432 | `127.0.0.1` | Yes (PostgreSQL) | Yes |
| 9090 | `127.0.0.1` | Yes (Prometheus) | Yes |

**Any port bound to `0.0.0.0` other than 80/443 is a CRITICAL drift.**

**Remediation:** Update container `docker run -p` flags or nginx config to bind to `127.0.0.1`.

### 9. Security Updates

| Check | Expected | Critical |
|-------|----------|----------|
| Pending security updates | 0 | Yes |
| Last `apt upgrade` | < 7 days | No |

**Remediation:** `sudo apt update && sudo apt upgrade -y`

## Approved Exceptions

| Exception | Reason | Approved by |
|-----------|--------|-------------|
| SSH on non-standard port | Hostinger edge network stability | Team |
| `ufw` not enforcing (if applicable) | Hostinger default firewall may interfere | Team |
| PgBouncer in session mode | Advisory locks require session affinity | Team |

## Evidence

Check results are stored locally at:
- `/home/ngoc_anh/vps-hardening/evidence/YYYY-MM-DD.log`
- `/home/ngoc_anh/vps-hardening/evidence/latest.log` (symlink)

Critical failures trigger Telegram alerts via Alertmanager.

## Cron Setup

Install the daily hardening check on the VPS:

```bash
# Create evidence directory
mkdir -p /home/ngoc_anh/vps-hardening/evidence

# Add cron job (daily at 06:00 ICT = 23:00 UTC previous day)
(crontab -l 2>/dev/null; echo "0 23 * * * bash /home/ngoc_anh/infra/scripts/vps-hardening-check.sh >> /home/ngoc_anh/vps-hardening/evidence/cron.log 2>&1") | crontab -
```

To run manually:
```bash
bash deploy/vps-hardening-check.sh
```

Exit codes:
- `0` — all checks passed or warnings only
- `1` — critical drift detected (fail-closed)

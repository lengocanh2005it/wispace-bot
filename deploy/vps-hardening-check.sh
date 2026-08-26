#!/usr/bin/env bash
# vps-hardening-check.sh
#
# Non-destructive VPS host hardening baseline check for issue #379.
# Runs all 9 checks from deploy/vps-hardening.md, reports drift,
# and fails closed for critical exposures.
#
# Evidence is stored locally (no secrets collected).
# Critical failures exit with code 1.
#
# Usage:
#   bash deploy/vps-hardening-check.sh
#
# Cron (daily at 06:00 ICT):
#   0 23 * * * bash /home/ngoc_anh/infra/scripts/vps-hardening-check.sh >> /home/ngoc_anh/vps-hardening/evidence/cron.log 2>&1

set -uo pipefail

EVIDENCE_DIR="${EVIDENCE_DIR:-/home/ngoc_anh/vps-hardening/evidence}"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
TODAY=$(date -u +"%Y-%m-%d")
CRITICAL_FAILURES=0
WARNINGS=0
PASSED=0

mkdir -p "$EVIDENCE_DIR"

LOG_FILE="${EVIDENCE_DIR}/${TODAY}.log"
LATEST_LINK="${EVIDENCE_DIR}/latest.log"

# Redirect all output to log file + stdout
exec > >(tee -a "$LOG_FILE") 2>&1

log_header() {
  echo ""
  echo "═══════════════════════════════════════════════════════════════"
  echo "  VPS Hardening Check — $TIMESTAMP"
  echo "═══════════════════════════════════════════════════════════════"
}

log_check() {
  local name="$1"
  echo ""
  echo "── Check: $name ──"
}

log_pass() {
  PASSED=$((PASSED + 1))
  echo "  ✓ PASS: $1"
}

log_warn() {
  WARNINGS=$((WARNINGS + 1))
  echo "  ⚠ WARN: $1"
  echo "    Remediation: $2"
}

log_critical() {
  CRITICAL_FAILURES=$((CRITICAL_FAILURES + 1))
  echo "  ✗ CRITICAL: $1"
  echo "    Remediation: $2"
}

# ─── Check 1: SSH Configuration ──────────────────────────────────────────────
check_ssh() {
  log_check "1. SSH Configuration"

  if [ ! -f /etc/ssh/sshd_config ]; then
    log_warn "sshd_config not found" "Install openssh-server"
    return
  fi

  # Password authentication
  if grep -qi '^PasswordAuthentication\s\+yes' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf 2>/dev/null; then
    log_critical "Password authentication is enabled" "Set PasswordAuthentication no in /etc/ssh/sshd_config"
  else
    log_pass "Password authentication disabled"
  fi

  # Root login
  if grep -qi '^PermitRootLogin\s\+yes' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf 2>/dev/null; then
    log_critical "Root login is permitted" "Set PermitRootLogin prohibit-password or no"
  else
    log_pass "Root login restricted"
  fi

  # Pubkey authentication
  if grep -qi '^PubkeyAuthentication\s\+no' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf 2>/dev/null; then
    log_critical "Pubkey authentication is disabled" "Set PubkeyAuthentication yes"
  else
    log_pass "Pubkey authentication enabled"
  fi

  # Max auth tries
  local max_auth
  max_auth=$(grep -i '^MaxAuthTries' /etc/ssh/sshd_config 2>/dev/null | awk '{print $2}' || echo "6")
  if [ "${max_auth:-6}" -gt 3 ]; then
    log_warn "MaxAuthTries is ${max_auth:-6} (recommended ≤ 3)" "Set MaxAuthTries 3"
  else
    log_pass "MaxAuthTries = ${max_auth:-6}"
  fi

  # X11 forwarding
  if grep -qi '^X11Forwarding\s\+yes' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf 2>/dev/null; then
    log_warn "X11 forwarding is enabled" "Set X11Forwarding no"
  else
    log_pass "X11 forwarding disabled"
  fi
}

# ─── Check 2: Host Firewall ──────────────────────────────────────────────────
check_firewall() {
  log_check "2. Host Firewall (UFW)"

  if ! command -v ufw &>/dev/null; then
    log_warn "UFW not installed" "Install ufw: sudo apt install -y ufw"
    return
  fi

  local status
  status=$(ufw status 2>/dev/null | head -1 || echo "inactive")

  if echo "$status" | grep -qi "inactive"; then
    log_warn "UFW is inactive" "Enable: sudo ufw enable"
    return
  fi

  log_pass "UFW is active"

  # Check for overly permissive rules (0.0.0.0 on non-80/443)
  ufw status numbered 2>/dev/null | grep -E '\[.*\].*0\.0\.0\.0/0' | grep -v -E ':80\b|:443\b' | while read -r line; do
    log_warn "Potentially permissive rule: $line" "Review and restrict to 127.0.0.1 if internal-only"
  done

  # Check default incoming policy
  if ufw status verbose 2>/dev/null | grep -qi "Default:.*allow.*incoming"; then
    log_critical "Default incoming policy is ALLOW" "Set: sudo ufw default deny incoming"
  else
    log_pass "Default incoming policy is deny"
  fi
}

# ─── Check 3: Automatic Security Updates ─────────────────────────────────────
check_auto_updates() {
  log_check "3. Automatic Security Updates"

  if dpkg -l unattended-upgrades 2>/dev/null | grep -q "^ii"; then
    log_pass "unattended-upgrades installed"
  else
    log_warn "unattended-upgrades not installed" "Install: sudo apt install -y unattended-upgrades"
    return
  fi

  # Check if the service/timer is active
  if systemctl is-active --quiet unattended-upgrades 2>/dev/null || \
     systemctl is-active --quiet apt-daily-upgrade.timer 2>/dev/null; then
    log_pass "Automatic update service active"
  else
    log_warn "Automatic update service not active" "Enable: sudo systemctl enable --now unattended-upgrades"
  fi
}

# ─── Check 4: Time Synchronization ───────────────────────────────────────────
check_time_sync() {
  log_check "4. Time Synchronization"

  if command -v timedatectl &>/dev/null; then
    local ntp_status
    ntp_status=$(timedatectl show --property=NTPSynchronized --value 2>/dev/null || echo "unknown")
    if [ "$ntp_status" = "yes" ]; then
      log_pass "NTP synchronized"
    else
      log_critical "NTP not synchronized" "Enable chrony: sudo apt install -y chrony && sudo systemctl enable --now chrony"
    fi
  elif systemctl is-active --quiet chrony 2>/dev/null; then
    log_pass "chrony is active"
  elif systemctl is-active --quiet systemd-timesyncd 2>/dev/null; then
    log_pass "systemd-timesyncd is active"
  else
    log_critical "No time synchronization service found" "Install chrony: sudo apt install -y chrony && sudo systemctl enable --now chrony"
  fi
}

# ─── Check 5: Docker Daemon ──────────────────────────────────────────────────
check_docker_daemon() {
  log_check "5. Docker Daemon"

  if ! command -v docker &>/dev/null; then
    log_warn "Docker not installed" "Install Docker Engine"
    return
  fi

  log_pass "Docker installed: $(docker --version 2>/dev/null | head -1)"

  # Check TCP socket exposure
  local docker_config="/etc/docker/daemon.json"
  if [ -f "$docker_config" ]; then
    if grep -q '"hosts"' "$docker_config" && grep -q 'tcp://' "$docker_config"; then
      log_critical "Docker TCP socket is exposed" "Remove tcp:// from hosts in $docker_config"
    else
      log_pass "Docker TCP socket not exposed"
    fi
  else
    log_pass "No daemon.json with TCP exposure"
  fi

  # Check socket permissions
  local sock="/var/run/docker.sock"
  if [ -S "$sock" ]; then
    local perms
    perms=$(stat -c '%a' "$sock" 2>/dev/null || echo "unknown")
    if [ "$perms" = "666" ]; then
      log_warn "Docker socket permissions are 666 (world-readable)" "Restrict to 660: sudo chmod 660 $sock"
    else
      log_pass "Docker socket permissions: $perms"
    fi
  fi

  # Check live-restore
  if [ -f "$docker_config" ]; then
    if grep -q '"live-restore"' "$docker_config" && grep -q 'true' "$docker_config"; then
      log_pass "Docker live-restore enabled"
    else
      log_warn "Docker live-restore not enabled" "Set live-restore: true in $docker_config"
    fi
  fi
}

# ─── Check 6: Container Runtime Defaults ─────────────────────────────────────
check_container_runtime() {
  log_check "6. Container Runtime Defaults"

  if ! command -v docker &>/dev/null; then
    log_warn "Docker not available, skipping container checks"
    return
  fi

  # Check for privileged containers
  local privileged
  privileged=$(docker ps --format '{{.Names}}' 2>/dev/null | while read -r name; do
    docker inspect --format '{{.HostConfig.Privileged}}' "$name" 2>/dev/null | grep -q "true" && echo "$name"
  done)

  if [ -n "$privileged" ]; then
    log_critical "Privileged container(s) running: $privileged" "Remove --privileged flag from container run commands"
  else
    log_pass "No privileged containers running"
  fi

  # Check no-new-privileges on bot containers
  local bots=("messenger-bot" "discord-bot" "zalo-bot")
  for bot in "${bots[@]}"; do
    if docker inspect --format '{{.HostConfig.SecurityOpt}}' "$bot" 2>/dev/null | grep -q "no-new-privileges"; then
      log_pass "$bot: no-new-privileges set"
    elif docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${bot}$"; then
      log_warn "$bot: no-new-privileges not set" "Add --security-opt no-new-privileges to docker run"
    fi
  done

  # Check non-root user on bot containers
  for bot in "${bots[@]}"; do
    local user
    user=$(docker inspect --format '{{.Config.User}}' "$bot" 2>/dev/null || echo "")
    if [ -n "$user" ] && [ "$user" != "root" ] && [ "$user" != "" ]; then
      log_pass "$bot: running as non-root ($user)"
    elif docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${bot}$"; then
      log_warn "$bot: running as root" "Add USER app (UID 1001) to Dockerfile"
    fi
  done
}

# ─── Check 7: Host Filesystem Permissions ────────────────────────────────────
check_file_permissions() {
  log_check "7. Host Filesystem Permissions"

  local home="/home/ngoc_anh"
  local deploy_user="ngoc_anh"

  # .env files
  for app_dir in "$home/messenger-bot" "$home/discord-bot" "$home/zalo-bot"; do
    local env_file="$app_dir/.env"
    if [ -f "$env_file" ]; then
      local perms
      perms=$(stat -c '%a' "$env_file" 2>/dev/null || echo "unknown")
      local owner
      owner=$(stat -c '%U' "$env_file" 2>/dev/null || echo "unknown")
      if [ "$perms" = "600" ] && [ "$owner" = "$deploy_user" ]; then
        log_pass "$env_file: $perms $owner"
      else
        log_critical "$env_file: permissions=$perms owner=$owner (expected 600:$deploy_user)" "chmod 600 $env_file && chown $deploy_user:$deploy_user $env_file"
      fi
    fi
  done

  # Backup directory
  local backup_dir="$home/backups"
  if [ -d "$backup_dir" ]; then
    local perms
    perms=$(stat -c '%a' "$backup_dir" 2>/dev/null || echo "unknown")
    if [ "$perms" = "700" ]; then
      log_pass "$backup_dir: $perms"
    else
      log_warn "$backup_dir: permissions=$perms (expected 700)" "chmod 700 $backup_dir"
    fi
  fi

  # Backup files
  find "$backup_dir" -maxdepth 1 -name "*.gpg" 2>/dev/null | head -5 | while read -r f; do
    local perms
    perms=$(stat -c '%a' "$f" 2>/dev/null || echo "unknown")
    if [ "$perms" != "600" ]; then
      log_warn "$f: permissions=$perms (expected 600)" "chmod 600 $f"
    fi
  done

  # Deploy scripts
  find "$home/infra" -name "*.sh" -maxdepth 3 2>/dev/null | head -10 | while read -r f; do
    local perms
    perms=$(stat -c '%a' "$f" 2>/dev/null || echo "unknown")
    if [ "$perms" != "755" ] && [ "$perms" != "644" ]; then
      log_warn "$f: permissions=$perms" "chmod 755 $f"
    fi
  done
}

# ─── Check 8: Exposed Ports ──────────────────────────────────────────────────
check_exposed_ports() {
  log_check "8. Exposed Ports"

  # Expected public ports
  local public_ports=("80" "443")

  # Check for unexpected 0.0.0.0 bindings
  local unexpected
  unexpected=$(ss -tlnp 2>/dev/null | grep '0\.0\.0\.0:' | grep -v -E ':80\b|:443\b' | grep -v 'Local Address' || true)

  if [ -n "$unexpected" ]; then
    log_critical "Unexpected public port bindings detected:" "$unexpected"
    echo "$unexpected" | sed 's/^/    /'
    echo "    Bind all internal services to 127.0.0.1"
  else
    log_pass "No unexpected public port bindings"
  fi

  # Verify critical services are localhost-only
  local critical_ports=("5007" "5008" "3001" "3002" "3003" "3004" "6432" "9093" "5432" "9090")
  for port in "${critical_ports[@]}"; do
    local binding
    binding=$(ss -tlnp 2>/dev/null | grep ":${port}\b" | awk '{print $4}' | head -1 || echo "")
    if [ -n "$binding" ]; then
      if echo "$binding" | grep -q "^127\.0\.0\.1:"; then
        log_pass "Port $port: bound to 127.0.0.1"
      elif echo "$binding" | grep -q "^0\.0\.0\.0:"; then
        log_critical "Port $port: bound to 0.0.0.0 (should be 127.0.0.1)" "Update docker run -p 127.0.0.1:$port:$port"
      fi
    fi
  done
}

# ─── Check 9: Security Updates ───────────────────────────────────────────────
check_security_updates() {
  log_check "9. Pending Security Updates"

  if command -v apt &>/dev/null; then
    local pending
    pending=$(apt list --upgradable 2>/dev/null | grep -c "security" || echo "0")
    if [ "$pending" -gt 0 ]; then
      log_warn "$pending pending security update(s)" "Run: sudo apt update && sudo apt upgrade -y"
    else
      log_pass "No pending security updates"
    fi
  else
    log_warn "apt not available" "Check updates manually"
  fi
}

# ─── Main ────────────────────────────────────────────────────────────────────
main() {
  log_header

  check_ssh
  check_firewall
  check_auto_updates
  check_time_sync
  check_docker_daemon
  check_container_runtime
  check_file_permissions
  check_exposed_ports
  check_security_updates

  # Update latest symlink
  ln -sf "$LOG_FILE" "$LATEST_LINK"

  # Summary
  echo ""
  echo "═══════════════════════════════════════════════════════════════"
  echo "  SUMMARY: $PASSED passed, $WARNINGS warnings, $CRITICAL_FAILURES critical"
  echo "  Evidence: $LOG_FILE"
  echo "═══════════════════════════════════════════════════════════════"

  if [ "$CRITICAL_FAILURES" -gt 0 ]; then
    echo ""
    echo "  ✗ $CRITICAL_FAILURES CRITICAL drift(s) detected — failing closed."
    echo "    Review remediation steps above."
    exit 1
  fi

  if [ "$WARNINGS" -gt 0 ]; then
    echo ""
    echo "  ⚠ $WARNINGS warning(s) — review recommended."
    exit 0
  fi

  echo ""
  echo "  ✓ All checks passed."
  exit 0
}

main

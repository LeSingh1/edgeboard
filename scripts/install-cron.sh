#!/usr/bin/env bash
# scripts/install-cron.sh
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

mkdir -p "$HOME/Library/LaunchAgents"
mkdir -p "$PROJECT_DIR/data/training/meta"

# Escape any "/" in PROJECT_DIR so sed doesn't trip on them.
ESC="${PROJECT_DIR//\//\\/}"

# Install one agent: substitute the PROJECT_DIR placeholder, then (re)bootstrap.
# `launchctl bootstrap` is the modern path-based load command (replaces the
# deprecated `launchctl load`). On older macOS, fall back to:
#   launchctl load -w "$DST"
install_agent() {
  local label="$1"
  local src="$PROJECT_DIR/scripts/$label.plist"
  local dst="$HOME/Library/LaunchAgents/$label.plist"
  sed "s/PROJECT_DIR/$ESC/g" "$src" > "$dst"
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$dst"
  echo "Installed $label"
}

# Nightly retrain + post-train model check (3:15 AM).
install_agent "com.edgeboard.train"
# 24/7 watchdog: health check every 30 minutes.
install_agent "com.edgeboard.watchdog"

echo "Done. Verify with: launchctl list | grep edgeboard"
echo "Manual retrain:  launchctl kickstart gui/\$(id -u)/com.edgeboard.train"
echo "Manual watchdog: launchctl kickstart gui/\$(id -u)/com.edgeboard.watchdog"

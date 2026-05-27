#!/usr/bin/env bash
# scripts/install-cron.sh
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST_SRC="$PROJECT_DIR/scripts/com.edgeboard.train.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.edgeboard.train.plist"

mkdir -p "$HOME/Library/LaunchAgents"
mkdir -p "$PROJECT_DIR/data/training/meta"

# Substitute PROJECT_DIR placeholder. Escape any "/" in PROJECT_DIR so sed doesn't trip on them.
ESC="${PROJECT_DIR//\//\\/}"
sed "s/PROJECT_DIR/$ESC/g" "$PLIST_SRC" > "$PLIST_DST"

# Bootstrap into launchd (replaces existing if loaded).
# Note: `launchctl bootstrap` is the modern path-based load command (replaces the
# deprecated `launchctl load`). If you are on an older macOS where bootstrap is
# unavailable, fall back to: launchctl load -w "$PLIST_DST"
launchctl bootout "gui/$(id -u)/com.edgeboard.train" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"

echo "Installed. Next fire: 3:15 AM. Verify with: launchctl list | grep edgeboard"
echo "Manually trigger: launchctl kickstart gui/\$(id -u)/com.edgeboard.train"

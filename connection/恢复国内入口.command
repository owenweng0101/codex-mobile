#!/bin/zsh
if ! launchctl print "gui/$(id -u)/com.owen.codex-cpolar" >/dev/null 2>&1; then
  launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.owen.codex-cpolar.plist"
fi
open 'http://127.0.0.1:8798/'

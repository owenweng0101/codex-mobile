#!/bin/sh
# Compatibility shortcut: open the unified QR, never an independent app page.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repository=${MOBILE_CHATS_ROOT:-$(dirname -- "$here")}
if [ -x "$repository/打开手机连接.command" ]; then
  exec "$repository/打开手机连接.command"
fi
exec open "$HOME/Desktop/手机连接"

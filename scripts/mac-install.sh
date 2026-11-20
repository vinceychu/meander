#!/bin/sh
# Install or repair Meander on a Mac (latest release), keeping your data and
# your Dock icon. After this, Meander updates itself.
#   curl -fsSL https://raw.githubusercontent.com/vinceychu/meander/main/scripts/mac-install.sh | sh
set -e
BASE=https://github.com/vinceychu/meander/releases/latest/download
case "$(uname -m)" in arm64) PICK='arm64-mac.zip' ;; *) PICK='[0-9]-mac.zip' ;; esac
ZIP=$(curl -fsSL "$BASE/latest-mac.yml" | sed -n 's/^  - url: //p' | grep -e "$PICK\$" | head -1)
[ -n "$ZIP" ] || { echo "Couldn't find the Mac download."; exit 1; }
echo "Installing $ZIP …"
osascript -e 'quit app "Meander"' 2>/dev/null || true
osascript -e 'quit app "LearnHarness"' 2>/dev/null || true
sleep 3
T=$(mktemp -d)
curl -fL --progress-bar -o "$T/m.zip" "$BASE/$ZIP"
ditto -x -k "$T/m.zip" "$T/x"
A=/Applications/Meander.app
[ -d "$A" ] || { [ -d /Applications/LearnHarness.app ] && A=/Applications/LearnHarness.app; }
if [ -d "$A" ]; then
  rsync -a --delete "$T/x/Meander.app/" "$A/"
  [ "$A" = /Applications/Meander.app ] || mv "$A" /Applications/Meander.app
else
  mv "$T/x/Meander.app" /Applications/Meander.app
fi
xattr -cr /Applications/Meander.app
codesign --force --deep --sign - /Applications/Meander.app
touch /Applications/Meander.app
killall Dock 2>/dev/null || true
rm -rf "$T"
open /Applications/Meander.app
echo "Done — Meander is installed and will update itself from now on."

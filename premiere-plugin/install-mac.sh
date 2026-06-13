#!/bin/bash
# One-shot installer for the Adaptive Color Agent CEP panel on macOS.
# Enables CEP debug mode and symlinks this folder into Premiere's extensions dir.

set -e

PLUGIN_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET="$HOME/Library/Application Support/Adobe/CEP/extensions/com.aca.panel"

echo "Plugin source: $PLUGIN_DIR"
echo "Install target: $TARGET"

# 1) Enable CEP debug mode for several CEP versions (Premiere 2020-2024+).
for v in 9 10 11 12; do
  defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1
  echo "Enabled CSXS.$v PlayerDebugMode"
done

# 2) Symlink the plugin folder.
mkdir -p "$(dirname "$TARGET")"
if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
  echo "Removing existing $TARGET"
  rm -rf "$TARGET"
fi
ln -s "$PLUGIN_DIR" "$TARGET"
echo "Symlinked."

echo ""
echo "Done. Restart Premiere Pro, then open: Window > Extensions > Adaptive Color Agent"

#!/bin/bash
set -e

PKG=org.flaxandteal.greasan
INDEX=index-goidelic
SRC_DIR="$(dirname "$0")/../public/$INDEX"

if [ ! -d "$SRC_DIR" ]; then
  echo "Error: $SRC_DIR not found" >&2
  exit 1
fi

echo "Creating tarball (excluding pagefind)..."
tar czf /tmp/greasan-core.tar.gz -C "$(dirname "$SRC_DIR")" \
  --exclude='pagefind*' "$INDEX/"

echo "Pushing to device (~$(du -sh /tmp/greasan-core.tar.gz | cut -f1))..."
adb push /tmp/greasan-core.tar.gz /data/local/tmp/

echo "Extracting on device..."
adb shell "run-as $PKG sh -c 'mkdir -p files && cd files && tar xzf /data/local/tmp/greasan-core.tar.gz'"

echo "Cleaning up..."
rm -f /tmp/greasan-core.tar.gz
adb shell rm -f /data/local/tmp/greasan-core.tar.gz

echo "Done. Core index cached on device."
echo "Restart 'npx tauri android dev --host 127.0.0.1' — data loads from device storage."

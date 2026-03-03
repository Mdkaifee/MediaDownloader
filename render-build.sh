#!/usr/bin/env bash
set -euo pipefail

echo "Installing system dependencies..."
if command -v apt-get >/dev/null 2>&1; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y ffmpeg curl ca-certificates
else
  echo "apt-get not available; expecting ffmpeg/curl preinstalled."
fi

echo "Installing yt-dlp binary..."
mkdir -p server/bin
curl -fsSL \
  https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
  -o server/bin/yt-dlp
chmod +x server/bin/yt-dlp

echo "Installing npm dependencies..."
npm install

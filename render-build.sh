#!/usr/bin/env bash
set -euo pipefail

echo "Installing npm dependencies..."
npm install

echo "Installing yt-dlp binary..."
mkdir -p server/bin
if command -v curl >/dev/null 2>&1; then
  curl -fsSL \
    https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    -o server/bin/yt-dlp
elif command -v wget >/dev/null 2>&1; then
  wget -q -O server/bin/yt-dlp \
    https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp
else
  echo "Error: neither curl nor wget is available to download yt-dlp." >&2
  exit 1
fi
chmod +x server/bin/yt-dlp

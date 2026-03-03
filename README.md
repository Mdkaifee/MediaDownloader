# Media Downloader Starter (React + Node)

Starter project for this flow:
- Paste URL
- Choose output (`mp3` or `mp4`)
- Fetch multiple quality/bitrate options
- Click Download

## Important note
This starter includes:
- A working provider for direct media file links (`.mp3`, `.mp4`)
- A `yt-dlp + ffmpeg` provider for YouTube/Facebook/Instagram URLs with real extraction/transcoding

Platform media extraction behavior can change based on site-side updates, account restrictions, geo restrictions, and installed binary versions.

## Project structure

```text
media-downloader-starter/
  client/    # React (Vite)
  server/    # Express API
```

## Run locally

From `media-downloader-starter`:

```bash
npm install
npm run dev
```

## Prerequisites

Install these binaries and keep them on your `PATH`:
- `yt-dlp`
- `ffmpeg`

Note: Render deploy uses `ffmpeg-static` from npm and downloads `yt-dlp` into `server/bin`.

## Deploy on Render

Backend (Web Service):
- Root Directory: `.`
- Build Command: `bash ./render-build.sh`
- Start Command: `npm run start -w server`
- Environment variables:
  - `CORS_ORIGINS=https://<your-frontend-domain>`
  - Optional `PUBLIC_BASE_URL=https://<your-backend-domain>`
  - Optional `YT_DLP_BIN=/opt/render/project/src/server/bin/yt-dlp`
  - Optional `YT_DLP_COOKIES_FILE=/opt/render/project/src/server/cookies.txt`
  - Optional `YT_DLP_COOKIES_B64=<base64 of Netscape cookies.txt>`

Frontend (Static Site):
- Root Directory: `client`
- Build Command: `npm install && npm run build`
- Publish Directory: `dist`
- Environment variables:
  - `VITE_API_BASE_URL=https://<your-backend-domain>`

This starts:
- Frontend: `http://localhost:5173`
- Backend: `http://localhost:8787`

## API

### `POST /api/analyze`
Body:

```json
{
  "url": "https://example.com/file.mp4",
  "format": "mp4"
}
```

Response:

```json
{
  "jobId": "...",
  "source": "Direct URL",
  "title": "file.mp4",
  "options": [
    {
      "id": "mp4-original",
      "label": "MP4 Original",
      "ext": "mp4",
      "bitrate": "Original",
      "resolution": "Source",
      "fileSize": "Unknown"
    }
  ]
}
```

### `POST /api/download-link`
Body:

```json
{
  "jobId": "...",
  "optionId": "mp4-original"
}
```

Response:

```json
{
  "downloadUrl": "http://localhost:8787/api/download/<token>",
  "filename": "file.mp4"
}
```

### `GET /api/download/:token`
Downloads a generated local file and then invalidates the token.

## Provider details

File:
- `server/src/providers/platformStubProvider.js`

Current behavior:
- Detects YouTube/Facebook/Instagram URLs
- Uses `yt-dlp -J` to inspect available formats
- Returns real bitrate/resolution options
- Downloads/transcodes media using `yt-dlp` and `ffmpeg`
- Returns one-time API download links for generated files

## Legal and compliance
Only download content you own or have permission to download. Respect each platform's Terms of Service and applicable copyright laws.

## YouTube bot-check note
If YouTube returns `Sign in to confirm you're not a bot`, provide auth cookies to yt-dlp:
- Preferred on Render: set `YT_DLP_COOKIES_B64` (base64-encoded Netscape cookies file contents)
- Alternative: set `YT_DLP_COOKIES_FILE` to an existing cookie file path

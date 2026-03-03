import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegStatic from 'ffmpeg-static';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const downloadsRoot = path.resolve(__dirname, '../../tmp-downloads/platform');
const runtimeConfigRoot = path.resolve(__dirname, '../../tmp-downloads/config');
const localYtDlpBinary = path.resolve(__dirname, '../../bin/yt-dlp');
const ytDlpBinary =
  process.env.YT_DLP_BIN || (existsSync(localYtDlpBinary) ? localYtDlpBinary : 'yt-dlp');
const ffmpegBinary = process.env.FFMPEG_BIN || ffmpegStatic || 'ffmpeg';

const platformRules = [
  { id: 'youtube', source: 'YouTube', hostContains: ['youtube.com', 'youtu.be'] },
  { id: 'facebook', source: 'Facebook', hostContains: ['facebook.com', 'fb.watch'] },
  { id: 'instagram', source: 'Instagram', hostContains: ['instagram.com'] }
];

let toolchainChecked = false;
let cachedCookiesFilePath = '';

function detectPlatform(url) {
  const hostname = new URL(url).hostname.toLowerCase();
  return platformRules.find((rule) =>
    rule.hostContains.some((domain) => hostname.includes(domain))
  );
}

function runCommand(binary, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(
        new Error(
          `${binary} exited with code ${code}. ${stderr.trim() || stdout.trim() || ''}`.trim()
        )
      );
    });
  });
}

async function resolveCookiesFilePath() {
  if (process.env.YT_DLP_COOKIES_FILE) {
    return process.env.YT_DLP_COOKIES_FILE;
  }

  if (cachedCookiesFilePath) {
    return cachedCookiesFilePath;
  }

  const cookiesBase64 = process.env.YT_DLP_COOKIES_B64;
  const cookiesText = process.env.YT_DLP_COOKIES_TXT;
  if (!cookiesBase64 && !cookiesText) {
    return '';
  }

  await fs.mkdir(runtimeConfigRoot, { recursive: true });
  const cookiesFilePath = path.join(runtimeConfigRoot, 'yt-dlp-cookies.txt');
  const content = cookiesBase64
    ? Buffer.from(cookiesBase64, 'base64').toString('utf8')
    : cookiesText;

  await fs.writeFile(cookiesFilePath, content, { mode: 0o600 });
  cachedCookiesFilePath = cookiesFilePath;
  return cookiesFilePath;
}

async function buildYtDlpBaseArgs() {
  const args = ['--no-playlist', '--no-warnings'];
  const cookiesFilePath = await resolveCookiesFilePath();
  if (cookiesFilePath) {
    args.push('--cookies', cookiesFilePath);
  }
  return args;
}

function normalizeYtDlpError(error) {
  const message = String(error?.message || error || '');
  if (
    message.includes('Sign in to confirm you’re not a bot') ||
    message.includes('Use --cookies-from-browser or --cookies')
  ) {
    return new Error(
      'YouTube currently requires auth cookies for this request. Set YT_DLP_COOKIES_FILE or YT_DLP_COOKIES_B64 on the backend service and redeploy.'
    );
  }
  if (message.includes('Requested format is not available')) {
    return new Error(
      'Selected quality is not available right now. Please fetch options again and try another quality.'
    );
  }
  return error instanceof Error ? error : new Error(message);
}

async function assertBinary(binary, checkArgs, installHint) {
  try {
    await runCommand(binary, checkArgs);
  } catch (error) {
    if (error.code === 'ENOENT' || String(error.message).includes('ENOENT')) {
      throw new Error(`${binary} is required but not installed. ${installHint}`);
    }

    throw new Error(`Failed to execute ${binary}. ${error.message}`);
  }
}

async function ensureToolchain() {
  if (toolchainChecked) return;

  await assertBinary(
    ytDlpBinary,
    ['--version'],
    'Install yt-dlp and restart the server.'
  );
  await assertBinary(
    ffmpegBinary,
    ['-version'],
    'Install ffmpeg and restart the server.'
  );
  toolchainChecked = true;
}

function parseMetadata(stdout) {
  const direct = stdout.trim();
  if (!direct) {
    throw new Error('No metadata was returned by yt-dlp.');
  }

  try {
    return JSON.parse(direct);
  } catch {
    const candidate = direct
      .split('\n')
      .map((line) => line.trim())
      .reverse()
      .find((line) => line.startsWith('{') && line.endsWith('}'));

    if (!candidate) {
      throw new Error('Could not parse yt-dlp metadata output.');
    }

    return JSON.parse(candidate);
  }
}

function formatBitrateKbps(tbr) {
  if (!tbr || !Number.isFinite(Number(tbr))) return null;
  return `${Math.round(Number(tbr))} kbps`;
}

function formatFileSize(bytes) {
  if (!bytes || !Number.isFinite(Number(bytes))) return 'Unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes);
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unitIndex]}`;
}

function estimateAudioSize(durationSec, bitrateKbps) {
  if (!durationSec || !Number.isFinite(Number(durationSec))) return 'Unknown';
  const bytes = (Number(durationSec) * bitrateKbps * 1000) / 8;
  return formatFileSize(bytes);
}

function sanitizeBaseName(input) {
  return String(input || 'media')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
}

function buildMp3Options(duration) {
  const bitrates = [128, 192, 320];
  return bitrates.map((kbps) => ({
    id: `audio-${kbps}`,
    label: `Audio ${kbps} kbps`,
    ext: 'mp3',
    bitrate: `${kbps} kbps`,
    resolution: null,
    fileSize: estimateAudioSize(duration, kbps),
    audioBitrateKbps: kbps
  }));
}

function buildMp4Options(formats) {
  const candidates = (formats || [])
    .filter(
      (format) =>
        format &&
        format.format_id &&
        format.vcodec &&
        format.vcodec !== 'none' &&
        format.height &&
        Number.isFinite(Number(format.height))
    )
    .sort((a, b) => {
      const heightDelta = Number(b.height) - Number(a.height);
      if (heightDelta !== 0) return heightDelta;
      return Number(b.tbr || 0) - Number(a.tbr || 0);
    });

  const byHeight = new Map();
  for (const format of candidates) {
    const height = Number(format.height);
    if (!byHeight.has(height)) {
      byHeight.set(height, format);
    }
  }

  const options = Array.from(byHeight.values())
    .slice(0, 6)
    .map((format) => ({
      id: `video-${format.format_id}`,
      label: `Video ${format.height}p`,
      ext: 'mp4',
      bitrate: formatBitrateKbps(format.tbr),
      resolution: `${format.height}p`,
      fileSize: formatFileSize(format.filesize || format.filesize_approx),
      formatId: String(format.format_id),
      videoHeight: Number(format.height)
    }));

  if (options.length > 0) {
    return options;
  }

  return [
    {
      id: 'video-best',
      label: 'Video Best Available',
      ext: 'mp4',
      bitrate: null,
      resolution: 'Best',
      fileSize: 'Unknown',
      formatId: null,
      videoHeight: null
    }
  ];
}

async function fetchMetadata(url) {
  const args = await buildYtDlpBaseArgs();
  args.push('-J', url);
  const { stdout } = await runCommand(ytDlpBinary, args);

  return parseMetadata(stdout);
}

async function collectOutputFile(workDir, preferredExt) {
  const entries = await fs.readdir(workDir, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);

  if (files.length === 0) {
    throw new Error('No output file produced by yt-dlp.');
  }

  const preferred = files.filter((fileName) =>
    fileName.toLowerCase().endsWith(`.${preferredExt.toLowerCase()}`)
  );
  const candidates = preferred.length > 0 ? preferred : files;

  const withStats = await Promise.all(
    candidates.map(async (fileName) => {
      const filePath = path.join(workDir, fileName);
      const stat = await fs.stat(filePath);
      return { fileName, filePath, size: stat.size };
    })
  );

  withStats.sort((a, b) => b.size - a.size);
  return withStats[0].filePath;
}

async function runDownload(sourceUrl, option, workDir) {
  const baseArgs = await buildYtDlpBaseArgs();
  const ffmpegLocation =
    ffmpegBinary.includes('/') ? path.dirname(ffmpegBinary) : null;

  if (option.ext === 'mp3') {
    const bitrate = Number(option.audioBitrateKbps || 192);
    const args = [
      ...baseArgs,
      '-f',
      'bestaudio/best',
      '--extract-audio',
      '--audio-format',
      'mp3',
      '--audio-quality',
      `${bitrate}K`,
      '-P',
      workDir,
      '-o',
      '%(title).120s.%(ext)s',
      sourceUrl
    ];
    if (ffmpegLocation) {
      args.splice(2, 0, '--ffmpeg-location', ffmpegLocation);
    }
    await runCommand(ytDlpBinary, args);
    return;
  }

  const targetHeight = Number(option.videoHeight || 0);
  const makeArgs = (formatExpr, sortExpr, mergeToMp4 = true) => {
    const args = [
      ...baseArgs,
      '-f',
      formatExpr
    ];
    if (mergeToMp4) {
      args.push('--merge-output-format', 'mp4');
    }
    if (sortExpr) {
      args.push('-S', sortExpr);
    }
    args.push('-P', workDir, '-o', '%(title).120s.%(ext)s', sourceUrl);
    if (ffmpegLocation) {
      args.splice(2, 0, '--ffmpeg-location', ffmpegLocation);
    }
    return args;
  };

  const attempts = [];
  if (targetHeight > 0) {
    attempts.push(
      makeArgs('bv*+ba/b', `res:${targetHeight},ext:mp4:m4a`),
      makeArgs(`bv*[height<=${targetHeight}]+ba/b[height<=${targetHeight}]/b`, 'ext:mp4:m4a')
    );
  }
  attempts.push(
    makeArgs('bv*+ba/b', 'ext:mp4:m4a'),
    makeArgs('bestvideo+bestaudio/best', null),
    makeArgs('best', null),
    makeArgs('b/bv*+ba', null, false),
    makeArgs('best', null, false)
  );

  let lastError = null;
  for (const args of attempts) {
    try {
      await runCommand(ytDlpBinary, args);
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('Unable to download media with available formats.');
}

const platformStubProvider = {
  id: 'platform-stub',
  supports(url) {
    return Boolean(detectPlatform(url));
  },
  async analyze(url, format) {
    const platform = detectPlatform(url);
    if (!platform) {
      throw new Error('Unsupported platform URL.');
    }

    await ensureToolchain();
    let metadata;
    try {
      metadata = await fetchMetadata(url);
    } catch (error) {
      throw normalizeYtDlpError(error);
    }
    const title = metadata.title || `${platform.source} media`;
    const options =
      format === 'mp3'
        ? buildMp3Options(metadata.duration)
        : buildMp4Options(metadata.formats);

    return {
      source: `${platform.source} (yt-dlp)`,
      title,
      options
    };
  },
  async resolveDownload({ sourceUrl, option, title }) {
    await ensureToolchain();
    const jobDir = path.join(downloadsRoot, randomUUID());
    await fs.mkdir(jobDir, { recursive: true });

    try {
      await runDownload(sourceUrl, option, jobDir);
    } catch (error) {
      throw normalizeYtDlpError(error);
    }
    const localFilePath = await collectOutputFile(jobDir, option.ext);
    const baseName = sanitizeBaseName(title || path.basename(localFilePath)) || 'media';
    const actualExt = path.extname(localFilePath).replace('.', '') || option.ext;

    return {
      localFilePath,
      filename: `${baseName}.${actualExt}`,
      deleteAfterSend: true
    };
  }
};

export default platformStubProvider;

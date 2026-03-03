import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const downloadsRoot = path.resolve(__dirname, '../../tmp-downloads/platform');

const platformRules = [
  { id: 'youtube', source: 'YouTube', hostContains: ['youtube.com', 'youtu.be'] },
  { id: 'facebook', source: 'Facebook', hostContains: ['facebook.com', 'fb.watch'] },
  { id: 'instagram', source: 'Instagram', hostContains: ['instagram.com'] }
];

let toolchainChecked = false;

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

  await assertBinary('yt-dlp', ['--version'], 'Install yt-dlp and restart the server.');
  await assertBinary('ffmpeg', ['-version'], 'Install ffmpeg and restart the server.');
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
      formatId: String(format.format_id)
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
      formatId: null
    }
  ];
}

async function fetchMetadata(url) {
  const { stdout } = await runCommand('yt-dlp', [
    '--no-playlist',
    '--no-warnings',
    '-J',
    url
  ]);

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
  if (option.ext === 'mp3') {
    const bitrate = Number(option.audioBitrateKbps || 192);
    await runCommand('yt-dlp', [
      '--no-playlist',
      '--no-warnings',
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
    ]);
    return;
  }

  const withSelectedFormat = [
    '--no-playlist',
    '--no-warnings',
    '-f',
    option.formatId ? `${option.formatId}+bestaudio/best` : 'bestvideo+bestaudio/best',
    '--merge-output-format',
    'mp4',
    '-P',
    workDir,
    '-o',
    '%(title).120s.%(ext)s',
    sourceUrl
  ];

  try {
    await runCommand('yt-dlp', withSelectedFormat);
  } catch (error) {
    if (!option.formatId) {
      throw error;
    }

    await runCommand('yt-dlp', [
      '--no-playlist',
      '--no-warnings',
      '-f',
      'bestvideo+bestaudio/best',
      '--merge-output-format',
      'mp4',
      '-P',
      workDir,
      '-o',
      '%(title).120s.%(ext)s',
      sourceUrl
    ]);
  }
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
    const metadata = await fetchMetadata(url);
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

    await runDownload(sourceUrl, option, jobDir);
    const localFilePath = await collectOutputFile(jobDir, option.ext);
    const baseName = sanitizeBaseName(title || path.basename(localFilePath)) || 'media';

    return {
      localFilePath,
      filename: `${baseName}.${option.ext}`,
      deleteAfterSend: true
    };
  }
};

export default platformStubProvider;

import cors from 'cors';
import express from 'express';
import { nanoid } from 'nanoid';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  deleteDownloadToken,
  getDownloadToken,
  getJob,
  setDownloadToken,
  setJob
} from './jobStore.js';
import { findProvider, getPlatformRuntimeStatus } from './providers/index.js';

const app = express();
const port = Number(process.env.PORT || 8787);
const publicBaseUrl = process.env.PUBLIC_BASE_URL?.replace(/\/$/, '');
const originConfig =
  process.env.CORS_ORIGINS ||
  process.env.CORS_ORIGIN ||
  'https://mediadownloaderapp-k3zo.onrender.com,http://localhost:5173';
const allowedOrigins = originConfig
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
const allowAllOrigins = allowedOrigins.includes('*');
const enableServerLogs = process.env.SERVER_LOGS !== 'false';

function logServer(event, details) {
  if (!enableServerLogs) return;
  const payload = details ? ` ${JSON.stringify(details)}` : '';
  console.log(`[MediaDownloader][server][${event}]${payload}`);
}

function isCookieAuthMessage(message) {
  return String(message || '').includes('requires auth cookies');
}

function summarizeToolchain(platform) {
  if (!platform) return null;
  return {
    cookieMode: platform.cookieMode,
    cookiesResolved: platform.cookiesResolved,
    cookiesFileExists: platform.cookiesFileExists,
    hasCookieError: Boolean(platform.cookieError),
    cookieError: platform.cookieError || null
  };
}

app.set('trust proxy', 1);
app.use(
  cors({
    origin(origin, callback) {
      if (allowAllOrigins || !origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error('CORS blocked for this origin.'));
    }
  })
);
app.use(express.json());

function safeFilename(input, fallbackExt) {
  const cleaned = (input || 'media')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_{2,}/g, '_');

  if (cleaned.includes('.')) return cleaned;
  return `${cleaned}.${fallbackExt}`;
}

function buildBaseUrl(req) {
  if (publicBaseUrl) return publicBaseUrl;
  const host = req.get('host');
  if (host) {
    return `${req.protocol}://${host}`;
  }
  return `http://localhost:${port}`;
}

app.get('/api/health', (req, res) => {
  logServer('health', { path: req.path });
  res.json({ ok: true });
});

app.get('/api/debug/toolchain', async (req, res) => {
  const platform = await getPlatformRuntimeStatus();
  logServer('debug:toolchain', {
    cookieMode: platform?.cookieMode,
    cookiesResolved: platform?.cookiesResolved,
    cookiesFileExists: platform?.cookiesFileExists,
    hasCookieError: Boolean(platform?.cookieError)
  });
  res.json({
    ok: true,
    platform
  });
});

app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'media-downloader-backend',
    health: '/api/health'
  });
});

app.post('/api/analyze', async (req, res) => {
  const requestId = nanoid(8);
  try {
    const { url, format } = req.body || {};
    logServer('analyze:start', {
      requestId,
      format,
      hasUrl: Boolean(url)
    });

    if (!url || typeof url !== 'string') {
      logServer('analyze:invalid-url', { requestId });
      return res.status(400).json({ error: 'URL is required.' });
    }

    if (!['mp3', 'mp4'].includes(format)) {
      logServer('analyze:invalid-format', { requestId, format });
      return res.status(400).json({ error: 'Format must be mp3 or mp4.' });
    }

    let normalizedUrl;
    try {
      normalizedUrl = new URL(url).toString();
    } catch {
      logServer('analyze:url-parse-failed', { requestId });
      return res.status(400).json({ error: 'Invalid URL.' });
    }

    const provider = findProvider(normalizedUrl);
    if (!provider) {
      logServer('analyze:no-provider', { requestId, hostname: new URL(normalizedUrl).hostname });
      return res.status(400).json({
        error:
          'No provider found for this URL. Add a provider in server/src/providers for this domain.'
      });
    }

    logServer('analyze:provider-selected', {
      requestId,
      provider: provider.id,
      hostname: new URL(normalizedUrl).hostname
    });
    const analysis = await provider.analyze(normalizedUrl, format);
    const jobId = nanoid();

    setJob(jobId, {
      provider,
      title: analysis.title,
      options: analysis.options,
      sourceUrl: normalizedUrl
    });

    return res.json({
      jobId,
      source: analysis.source,
      title: analysis.title,
      options: analysis.options.map(({ downloadUrl, ...publicOption }) => publicOption)
    });
  } catch (error) {
    logServer('analyze:error', { requestId, message: error.message || 'Unexpected error' });
    if (isCookieAuthMessage(error.message)) {
      const platform = await getPlatformRuntimeStatus();
      logServer('analyze:cookie-diagnostics', {
        requestId,
        platform: summarizeToolchain(platform)
      });
    }
    return res.status(500).json({ error: error.message || 'Unexpected error.' });
  }
});

app.post('/api/download-link', async (req, res) => {
  const requestId = nanoid(8);
  try {
    const { jobId, optionId } = req.body || {};
    logServer('download-link:start', { requestId, jobId, optionId });

    if (!jobId || !optionId) {
      logServer('download-link:invalid-body', { requestId });
      return res.status(400).json({ error: 'jobId and optionId are required.' });
    }

    const job = getJob(jobId);
    if (!job) {
      logServer('download-link:job-missing', { requestId, jobId });
      return res.status(404).json({ error: 'Job not found or expired.' });
    }

    const option = job.options.find((item) => item.id === optionId);
    if (!option) {
      logServer('download-link:option-missing', { requestId, optionId });
      return res.status(404).json({ error: 'Option not found.' });
    }

    if (typeof job.provider.resolveDownload === 'function') {
      const resolved = await job.provider.resolveDownload({
        sourceUrl: job.sourceUrl,
        option,
        title: job.title
      });

      if (resolved.localFilePath) {
        const token = nanoid();
        const filename = safeFilename(resolved.filename || job.title, option.ext);
        setDownloadToken(token, {
          filePath: resolved.localFilePath,
          filename,
          deleteAfterSend: resolved.deleteAfterSend !== false
        });

        return res.json({
          downloadUrl: `${buildBaseUrl(req)}/api/download/${token}`,
          filename
        });
      }

      return res.json({
        downloadUrl: resolved.downloadUrl,
        filename: safeFilename(resolved.filename, option.ext)
      });
    }

    if (!option.downloadUrl) {
      return res.status(500).json({
        error: 'Provider did not return a downloadable URL for this option.'
      });
    }

    return res.json({
      downloadUrl: option.downloadUrl,
      filename: safeFilename(job.title, option.ext)
    });
  } catch (error) {
    logServer('download-link:error', { requestId, message: error.message || 'Unexpected error' });
    if (isCookieAuthMessage(error.message)) {
      const platform = await getPlatformRuntimeStatus();
      logServer('download-link:cookie-diagnostics', {
        requestId,
        platform: summarizeToolchain(platform)
      });
    }
    return res.status(500).json({ error: error.message || 'Unexpected error.' });
  }
});

async function cleanupTokenDownload(token, payload) {
  deleteDownloadToken(token);

  if (!payload?.deleteAfterSend || !payload.filePath) {
    return;
  }

  await fs.unlink(payload.filePath).catch(() => {});
  await fs.rm(path.dirname(payload.filePath), { recursive: false }).catch(() => {});
}

app.get('/api/download/:token', async (req, res) => {
  const { token } = req.params;
  const payload = getDownloadToken(token);
  logServer('download:start', { token });

  if (!payload) {
    logServer('download:token-missing', { token });
    return res.status(404).json({ error: 'Download link not found or expired.' });
  }

  try {
    await fs.access(payload.filePath);
  } catch {
    await cleanupTokenDownload(token, payload);
    logServer('download:file-missing', { token });
    return res.status(404).json({ error: 'Generated file no longer exists.' });
  }

  return res.download(payload.filePath, payload.filename, async () => {
    logServer('download:sent', { token, filename: payload.filename });
    await cleanupTokenDownload(token, payload);
  });
});

app.listen(port, () => {
  logServer('startup', {
    port,
    allowAllOrigins,
    allowedOriginsCount: allowedOrigins.length
  });
  console.log(`API listening on port ${port}`);
});

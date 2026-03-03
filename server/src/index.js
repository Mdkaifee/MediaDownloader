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
import { findProvider } from './providers/index.js';

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
  res.json({ ok: true });
});

app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'media-downloader-backend',
    health: '/api/health'
  });
});

app.post('/api/analyze', async (req, res) => {
  try {
    const { url, format } = req.body || {};

    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'URL is required.' });
    }

    if (!['mp3', 'mp4'].includes(format)) {
      return res.status(400).json({ error: 'Format must be mp3 or mp4.' });
    }

    let normalizedUrl;
    try {
      normalizedUrl = new URL(url).toString();
    } catch {
      return res.status(400).json({ error: 'Invalid URL.' });
    }

    const provider = findProvider(normalizedUrl);
    if (!provider) {
      return res.status(400).json({
        error:
          'No provider found for this URL. Add a provider in server/src/providers for this domain.'
      });
    }

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
    return res.status(500).json({ error: error.message || 'Unexpected error.' });
  }
});

app.post('/api/download-link', async (req, res) => {
  try {
    const { jobId, optionId } = req.body || {};

    if (!jobId || !optionId) {
      return res.status(400).json({ error: 'jobId and optionId are required.' });
    }

    const job = getJob(jobId);
    if (!job) {
      return res.status(404).json({ error: 'Job not found or expired.' });
    }

    const option = job.options.find((item) => item.id === optionId);
    if (!option) {
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

  if (!payload) {
    return res.status(404).json({ error: 'Download link not found or expired.' });
  }

  try {
    await fs.access(payload.filePath);
  } catch {
    await cleanupTokenDownload(token, payload);
    return res.status(404).json({ error: 'Generated file no longer exists.' });
  }

  return res.download(payload.filePath, payload.filename, async () => {
    await cleanupTokenDownload(token, payload);
  });
});

app.listen(port, () => {
  console.log(`API listening on port ${port}`);
});

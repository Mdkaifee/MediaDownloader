import { useMemo, useState } from 'react';

const API_BASE = 'http://localhost:8787';

const initialState = {
  url: '',
  format: 'mp4'
};

function App() {
  const [form, setForm] = useState(initialState);
  const [analysis, setAnalysis] = useState(null);
  const [loading, setLoading] = useState(false);
  const [downloadLoadingId, setDownloadLoadingId] = useState('');
  const [error, setError] = useState('');

  const selectedSummary = useMemo(() => {
    if (!analysis) return '';
    return `${analysis.title} • ${analysis.source}`;
  }, [analysis]);

  async function handleAnalyze(event) {
    event.preventDefault();
    setLoading(true);
    setError('');
    setAnalysis(null);

    try {
      const response = await fetch(`${API_BASE}/api/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: form.url.trim(), format: form.format })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Analyze failed');
      }

      setAnalysis(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleDownload(optionId) {
    if (!analysis?.jobId) return;

    setDownloadLoadingId(optionId);
    setError('');

    try {
      const response = await fetch(`${API_BASE}/api/download-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: analysis.jobId, optionId })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Download link generation failed');
      }

      const anchor = document.createElement('a');
      anchor.href = data.downloadUrl;
      anchor.download = data.filename || 'media';
      anchor.rel = 'noopener noreferrer';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } catch (err) {
      setError(err.message);
    } finally {
      setDownloadLoadingId('');
    }
  }

  return (
    <div className="page-shell">
      <div className="ambient" />
      <main className="panel">
        <header>
          <p className="eyebrow">React + Node Starter</p>
          <h1>Media Fetch and Download</h1>
          <p className="subtext">
            Paste a URL, choose output format, then pick bitrate/resolution options.
          </p>
        </header>

        <form className="controls" onSubmit={handleAnalyze}>
          <label>
            Source URL
            <input
              type="url"
              required
              placeholder="https://example.com/video.mp4"
              value={form.url}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, url: event.target.value }))
              }
            />
          </label>

          <label>
            Output
            <select
              value={form.format}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, format: event.target.value }))
              }
            >
              <option value="mp4">MP4 (Video)</option>
              <option value="mp3">MP3 (Audio)</option>
            </select>
          </label>

          <button type="submit" disabled={loading}>
            {loading ? 'Analyzing...' : 'Fetch Options'}
          </button>
        </form>

        {error ? <p className="error">{error}</p> : null}

        {analysis ? (
          <section className="results">
            <div className="results-head">
              <h2>Available Options</h2>
              <p>{selectedSummary}</p>
            </div>

            <div className="cards">
              {analysis.options.map((option) => (
                <article className="card" key={option.id}>
                  <h3>{option.label}</h3>
                  <p className="pill-row">
                    <span>{option.ext.toUpperCase()}</span>
                    {option.bitrate ? <span>{option.bitrate}</span> : null}
                    {option.resolution ? <span>{option.resolution}</span> : null}
                    {option.fileSize ? <span>{option.fileSize}</span> : null}
                  </p>
                  <button
                    type="button"
                    onClick={() => handleDownload(option.id)}
                    disabled={downloadLoadingId === option.id}
                  >
                    {downloadLoadingId === option.id
                      ? 'Preparing...'
                      : 'Download'}
                  </button>
                </article>
              ))}
            </div>
          </section>
        ) : (
          <section className="hint">
            <p>
              Note: Only direct-file provider is implemented in this starter.
              Platform adapters are scaffolded in the backend.
            </p>
          </section>
        )}
      </main>
    </div>
  );
}

export default App;

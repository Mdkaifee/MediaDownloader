function getFileExtension(url) {
  const path = new URL(url).pathname.toLowerCase();
  if (path.endsWith('.mp4')) return 'mp4';
  if (path.endsWith('.mp3')) return 'mp3';
  return '';
}

function buildMp4Options(url) {
  return [
    {
      id: 'mp4-original',
      label: 'MP4 Original',
      ext: 'mp4',
      resolution: 'Source',
      bitrate: 'Original',
      fileSize: 'Unknown',
      downloadUrl: url
    },
    {
      id: 'mp4-480',
      label: 'MP4 480p (Starter Placeholder)',
      ext: 'mp4',
      resolution: '480p',
      bitrate: 'Auto',
      fileSize: 'Unknown',
      downloadUrl: url
    }
  ];
}

function buildMp3Options(url) {
  return [
    {
      id: 'mp3-original',
      label: 'MP3 Original',
      ext: 'mp3',
      bitrate: 'Original',
      resolution: null,
      fileSize: 'Unknown',
      downloadUrl: url
    },
    {
      id: 'mp3-128',
      label: 'MP3 128 kbps (Starter Placeholder)',
      ext: 'mp3',
      bitrate: '128 kbps',
      resolution: null,
      fileSize: 'Unknown',
      downloadUrl: url
    }
  ];
}

const directFileProvider = {
  id: 'direct-file',
  supports(url) {
    const ext = getFileExtension(url);
    return ext === 'mp4' || ext === 'mp3';
  },
  async analyze(url, format) {
    const ext = getFileExtension(url);

    if (format === 'mp4' && ext !== 'mp4') {
      throw new Error('Direct URL is not an MP4 file.');
    }

    if (format === 'mp3' && ext !== 'mp3') {
      throw new Error('Direct URL is not an MP3 file.');
    }

    const options = format === 'mp4' ? buildMp4Options(url) : buildMp3Options(url);

    return {
      source: 'Direct URL',
      title: new URL(url).pathname.split('/').pop() || 'media-file',
      options
    };
  }
};

export default directFileProvider;

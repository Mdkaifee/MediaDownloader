const jobs = new Map();
const downloads = new Map();

export function setJob(jobId, payload) {
  jobs.set(jobId, payload);
}

export function getJob(jobId) {
  return jobs.get(jobId);
}

export function setDownloadToken(token, payload) {
  downloads.set(token, payload);
}

export function getDownloadToken(token) {
  return downloads.get(token);
}

export function deleteDownloadToken(token) {
  downloads.delete(token);
}

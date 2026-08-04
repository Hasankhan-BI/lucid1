// Local-disk storage for uploaded files and their parsed row cache.
// Every function here is the seam you'd replace with S3 / Cloudflare R2 in
// production — routes never touch the filesystem directly, only this module.
//
// ROOT defaults to a folder inside the project for local dev, but should be
// set via UPLOADS_DIR to a mounted persistent volume in any real deployment
// (see README.md, "Deploying with persistent storage") — otherwise every
// uploaded file is lost on redeploy or restart.

const fs = require('fs');
const path = require('path');

const ROOT = process.env.UPLOADS_DIR || path.join(__dirname, '..', 'uploads');
fs.mkdirSync(ROOT, { recursive: true });

function userDir(userId) {
  const dir = path.join(ROOT, userId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function rowsPath(userId, datasetId) {
  return path.join(userDir(userId), `${datasetId}.rows.json`);
}

function rawPath(userId, datasetId, originalName) {
  const ext = path.extname(originalName) || '.csv';
  return path.join(userDir(userId), `${datasetId}${ext}`);
}

function saveRaw(userId, datasetId, originalName, buffer) {
  const p = rawPath(userId, datasetId, originalName);
  fs.writeFileSync(p, buffer);
  return p;
}

// Rows can include Date objects from parsing; store as ISO strings so JSON
// round-trips cleanly, and revive them on read.
function saveRows(userId, datasetId, rows) {
  fs.writeFileSync(rowsPath(userId, datasetId), JSON.stringify(rows));
}

function loadRows(userId, datasetId) {
  const p = rowsPath(userId, datasetId);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

module.exports = { saveRaw, saveRows, loadRows, rowsPath, rawPath };

// Lightweight persistence layer built on Node's built-in SQLite module.
// No native binary downloads required, which makes local setup a single
// `npm install`. For production at real scale, swap this file for a
// Postgres client (e.g. `pg` or Prisma with a postgresql datasource) —
// every other file in the app talks to this module's functions, not to
// SQL directly, so that swap is contained here.

const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const dbPath = process.env.DATABASE_PATH || path.join(__dirname, '..', 'dev.db');
const db = new DatabaseSync(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    passwordHash TEXT NOT NULL,
    createdAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS datasets (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    name TEXT NOT NULL,
    filePath TEXT,
    rowCount INTEGER NOT NULL,
    columnsJson TEXT NOT NULL,
    numericColsJson TEXT NOT NULL,
    categoricalColsJson TEXT NOT NULL,
    dateColsJson TEXT NOT NULL,
    correlationsJson TEXT NOT NULL,
    insightsJson TEXT NOT NULL,
    forecastJson TEXT,
    joinInfoJson TEXT,
    createdAt TEXT NOT NULL,
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    datasetId TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    FOREIGN KEY (datasetId) REFERENCES datasets(id) ON DELETE CASCADE
  );
`);

// Migration for databases created before joinInfoJson existed (CREATE TABLE
// IF NOT EXISTS above only applies to brand-new tables, not existing ones).
// Safe to run every startup — ALTER TABLE throws if the column is already
// there, which we just ignore.
try {
  db.exec('ALTER TABLE datasets ADD COLUMN joinInfoJson TEXT');
} catch (e) {
  // Column already exists — expected on every startup after the first.
}

function id() {
  return crypto.randomBytes(12).toString('hex');
}

/* ---------------- users ---------------- */
function createUser({ email, passwordHash }) {
  const userId = id();
  db.prepare('INSERT INTO users (id, email, passwordHash, createdAt) VALUES (?, ?, ?, ?)')
    .run(userId, email, passwordHash, new Date().toISOString());
  return { id: userId, email };
}
function findUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email) || null;
}
function findUserById(userId) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId) || null;
}

/* ---------------- datasets ---------------- */
function createDataset(userId, profile, name, joinInfo = null) {
  const datasetId = id();
  db.prepare(`INSERT INTO datasets
    (id, userId, name, filePath, rowCount, columnsJson, numericColsJson, categoricalColsJson, dateColsJson, correlationsJson, insightsJson, forecastJson, joinInfoJson, createdAt)
    VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`)
    .run(
      datasetId, userId, name, profile.rowCount,
      JSON.stringify(profile.columns), JSON.stringify(profile.numericCols),
      JSON.stringify(profile.categoricalCols), JSON.stringify(profile.dateCols),
      JSON.stringify(profile.correlations), JSON.stringify(profile.insights),
      joinInfo ? JSON.stringify(joinInfo) : null,
      new Date().toISOString()
    );
  return datasetId;
}
function setDatasetFilePath(datasetId, filePath) {
  db.prepare('UPDATE datasets SET filePath = ? WHERE id = ?').run(filePath, datasetId);
}
function setDatasetForecast(datasetId, forecastJson) {
  db.prepare('UPDATE datasets SET forecastJson = ? WHERE id = ?').run(forecastJson, datasetId);
}
function listDatasets(userId) {
  return db.prepare('SELECT id, name, rowCount, createdAt FROM datasets WHERE userId = ? ORDER BY createdAt DESC').all(userId);
}
function getDataset(datasetId, userId) {
  return db.prepare('SELECT * FROM datasets WHERE id = ? AND userId = ?').get(datasetId, userId) || null;
}

/* ---------------- chat messages ---------------- */
function addChatMessages(datasetId, messages) {
  const stmt = db.prepare('INSERT INTO chat_messages (id, datasetId, role, content, createdAt) VALUES (?, ?, ?, ?, ?)');
  messages.forEach(m => stmt.run(id(), datasetId, m.role, m.content, new Date().toISOString()));
}
function listChatMessages(datasetId) {
  return db.prepare('SELECT role, content FROM chat_messages WHERE datasetId = ? ORDER BY createdAt ASC').all(datasetId);
}

module.exports = {
  createUser, findUserByEmail, findUserById,
  createDataset, setDatasetFilePath, setDatasetForecast, listDatasets, getDataset,
  addChatMessages, listChatMessages
};

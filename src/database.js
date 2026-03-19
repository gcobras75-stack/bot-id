/**
 * src/database.js
 * Base de datos SQLite con better-sqlite3
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'botid.db');

let db;

/**
 * Inicializa la base de datos y crea las tablas si no existen
 */
export function initDatabase() {
  db = new Database(DB_PATH);

  // Optimizaciones de rendimiento SQLite
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    -- Cuentas analizadas
    CREATE TABLE IF NOT EXISTS accounts_analyzed (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      handle        TEXT NOT NULL,
      did           TEXT,
      score         INTEGER NOT NULL,
      nivel         TEXT NOT NULL,
      señales       TEXT NOT NULL,       -- JSON
      analyzed_at   TEXT NOT NULL,
      requested_by  TEXT,                -- handle de quien pidió el análisis
      post_uri      TEXT                 -- URI del post publicado con el resultado
    );

    CREATE INDEX IF NOT EXISTS idx_accounts_handle ON accounts_analyzed(handle);
    CREATE INDEX IF NOT EXISTS idx_accounts_analyzed_at ON accounts_analyzed(analyzed_at);

    -- Escaneos semanales por hashtag
    CREATE TABLE IF NOT EXISTS weekly_scans (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      hashtag         TEXT NOT NULL,
      accounts_found  INTEGER NOT NULL DEFAULT 0,
      bots_detected   INTEGER NOT NULL DEFAULT 0,
      percentage      REAL NOT NULL DEFAULT 0,
      week_start      TEXT NOT NULL,
      week_end        TEXT NOT NULL,
      created_at      TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_scans_hashtag ON weekly_scans(hashtag);
    CREATE INDEX IF NOT EXISTS idx_scans_week ON weekly_scans(week_start);

    -- Menciones ya procesadas (para evitar duplicados)
    CREATE TABLE IF NOT EXISTS processed_mentions (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      mention_uri      TEXT NOT NULL UNIQUE,
      requester_handle TEXT,
      target_handle    TEXT,
      processed_at     TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_mentions_uri ON processed_mentions(mention_uri);
  `);

  console.log('✅ Base de datos inicializada:', DB_PATH);
  return db;
}

/**
 * Guarda el análisis de una cuenta
 * @param {object} data
 */
export function saveAccount({ handle, did, score, nivel, señales, requestedBy = null, postUri = null }) {
  const stmt = db.prepare(`
    INSERT INTO accounts_analyzed (handle, did, score, nivel, señales, analyzed_at, requested_by, post_uri)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    handle,
    did || null,
    score,
    nivel,
    JSON.stringify(señales),
    new Date().toISOString(),
    requestedBy,
    postUri
  );

  return result.lastInsertRowid;
}

/**
 * Obtiene el historial de análisis de una cuenta
 * @param {string} handle
 * @param {number} limit
 */
export function getAccountHistory(handle, limit = 10) {
  const stmt = db.prepare(`
    SELECT * FROM accounts_analyzed
    WHERE handle = ?
    ORDER BY analyzed_at DESC
    LIMIT ?
  `);

  return stmt.all(handle, limit).map((row) => ({
    ...row,
    señales: JSON.parse(row.señales),
  }));
}

/**
 * Guarda un escaneo semanal de hashtag
 * @param {object} data
 */
export function saveWeeklyScan({ hashtag, accountsFound, botsDetected, percentage, weekStart, weekEnd }) {
  const stmt = db.prepare(`
    INSERT INTO weekly_scans (hashtag, accounts_found, bots_detected, percentage, week_start, week_end, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    hashtag,
    accountsFound,
    botsDetected,
    percentage,
    weekStart,
    weekEnd,
    new Date().toISOString()
  );

  return result.lastInsertRowid;
}

/**
 * Obtiene estadísticas de la semana actual para el reporte
 * @param {string} weekStart - fecha inicio (ISO)
 * @param {string} weekEnd   - fecha fin (ISO)
 */
export function getWeeklyStats(weekStart, weekEnd) {
  const scansStmt = db.prepare(`
    SELECT
      hashtag,
      SUM(accounts_found) as accountsFound,
      SUM(bots_detected) as botsDetected,
      ROUND(AVG(percentage), 1) as botPct
    FROM weekly_scans
    WHERE week_start >= ? AND week_end <= ?
    GROUP BY hashtag
    ORDER BY botsDetected DESC
  `);

  const accountsStmt = db.prepare(`
    SELECT COUNT(*) as total,
           SUM(CASE WHEN score >= 75 THEN 1 ELSE 0 END) as bots
    FROM accounts_analyzed
    WHERE analyzed_at >= ? AND analyzed_at <= ?
  `);

  const topHashtags = scansStmt.all(weekStart, weekEnd);
  const totales = accountsStmt.get(weekStart, weekEnd);

  return {
    weekStart,
    weekEnd,
    totalAnalyzadas: totales?.total || 0,
    totalBots: totales?.bots || 0,
    porcentaje: totales?.total > 0
      ? Math.round((totales.bots / totales.total) * 100)
      : 0,
    topHashtags: topHashtags.map((h) => ({
      hashtag: h.hashtag,
      accountsFound: h.accountsFound,
      botsDetected: h.botsDetected,
      botPct: h.botPct,
    })),
  };
}

/**
 * Verifica si una mención ya fue procesada
 * @param {string} mentionUri
 */
export function isProcessed(mentionUri) {
  const stmt = db.prepare('SELECT id FROM processed_mentions WHERE mention_uri = ?');
  return !!stmt.get(mentionUri);
}

/**
 * Marca una mención como procesada
 * @param {object} data
 */
export function markProcessed({ mentionUri, requesterHandle, targetHandle }) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO processed_mentions (mention_uri, requester_handle, target_handle, processed_at)
    VALUES (?, ?, ?, ?)
  `);

  stmt.run(mentionUri, requesterHandle || null, targetHandle || null, new Date().toISOString());
}

/**
 * Cuenta análisis realizados en la última hora (rate limiting)
 */
export function countAnalysesLastHour() {
  const unaHoraAtras = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const stmt = db.prepare(`
    SELECT COUNT(*) as count FROM accounts_analyzed WHERE analyzed_at >= ?
  `);
  return stmt.get(unaHoraAtras)?.count || 0;
}

/**
 * Obtiene las cuentas más sospechosas detectadas
 * @param {number} limit
 */
export function getTopBots(limit = 10) {
  const stmt = db.prepare(`
    SELECT handle, did, score, nivel, señales, analyzed_at
    FROM accounts_analyzed
    WHERE score >= 75
    ORDER BY score DESC, analyzed_at DESC
    LIMIT ?
  `);

  return stmt.all(limit).map((row) => ({
    ...row,
    señales: JSON.parse(row.señales),
  }));
}

export function getDb() {
  return db;
}

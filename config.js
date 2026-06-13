'use strict';

/**
 * Zentrale Konfiguration — die EINE Quelle für Pfade, Defaults und Version.
 *
 * Warum diese Datei existiert: DB, Backups, Logs und Modell-Cache hingen früher
 * an drei verschiedenen Stellen (db.js, server.js) und teils fest am Repo-Pfad.
 * Damit Brain wirklich portabel ist (fremder Host, Docker, anderer Nutzer),
 * leitet sich jetzt ALLES aus BRAIN_DATA_DIR ab — ein Verzeichnis, ein Volume.
 *
 * .env wird optional geladen: Läuft der Dienst ohne .env (z.B. via systemd mit
 * EnvironmentFile oder mit purem `node server.js`), greifen die Defaults unten.
 */

const path = require('path');
const fs = require('fs');

// dotenv ist optional — fehlt es, gelten die Defaults / bereits gesetzte Env-Vars.
try { require('dotenv').config(); } catch { /* optional dependency */ }

const ROOT = __dirname;

// Basis für alle veränderlichen Daten. Default: ./data im Repo (bisheriges Verhalten).
const DATA_DIR = path.resolve(process.env.BRAIN_DATA_DIR || path.join(ROOT, 'data'));

// Abgeleitete Pfade — BRAIN_DB darf den DB-Ort explizit überschreiben (Kompat).
const DB_FILE = process.env.BRAIN_DB || path.join(DATA_DIR, 'brain.db');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'brain.log');
// Modell-Cache (bge-m3 etc.). Opt-in, um die bestehende Installation NICHT zu
// brechen: nur wenn BRAIN_MODEL_CACHE oder BRAIN_DATA_DIR gesetzt ist, lenken wir
// den Cache ins Daten-Verzeichnis (für Docker-Volume-Persistenz). Sonst bleibt der
// Transformers.js-Default (node_modules/.cache) — kein Re-Download nach Update.
const MODEL_CACHE_DIR = process.env.BRAIN_MODEL_CACHE
  || (process.env.BRAIN_DATA_DIR ? path.join(DATA_DIR, 'models') : null);

// Zeichen-pro-Token-Schätzer für die Recall-Budgetierung. KEINE exakte Messung,
// nur eine Heuristik — Clients können sie pro Request via ?charsPerToken kalibrieren.
// Default 4 ≈ englischer/deutscher Durchschnitt vieler Tokenizer.
const CHARS_PER_TOKEN = (() => {
  const v = parseFloat(process.env.BRAIN_CHARS_PER_TOKEN);
  return Number.isFinite(v) && v > 0 ? v : 4;
})();

// Optionaler Einstiegsknoten (ID oder Label). Leer = automatische Auflösung
// (siehe db.getStartNodeId): Tag `start` → Legacy-Labels.
const START_NODE = (process.env.BRAIN_START_NODE || '').trim();

const PORT = parseInt(process.env.PORT, 10) || 3000;

// Auto-Capture: TTL (Sekunden) für Inbox-Kandidaten aus Sessions. Nie reviewte
// Kandidaten laufen automatisch ab (vorhandene TTL-Maschinerie) → kein Müll.
// Default 14 Tage. 0/negativ = kein Ablauf (dauerhaft im Inbox bis Review).
const INBOX_TTL = (() => {
  const v = parseInt(process.env.BRAIN_INBOX_TTL, 10);
  if (Number.isFinite(v)) return v > 0 ? v : null;
  return 14 * 24 * 60 * 60; // 14 Tage
})();

// Action-Log-Aufbewahrung (Tage) — Basis für Metrik-Trends. War fest 7;
// für /api/metrics-Trends auf 30 angehoben, per Env überschreibbar.
const LOG_RETENTION_DAYS = (() => {
  const v = parseInt(process.env.BRAIN_LOG_RETENTION_DAYS, 10);
  return Number.isFinite(v) && v > 0 ? v : 30;
})();

// Version aus package.json — die EINE Quelle, von /api/health und MCP geteilt.
let VERSION = '0.0.0';
try { VERSION = require('./package.json').version || VERSION; } catch { /* keep default */ }

// Verzeichnisse anlegen (idempotent), damit der erste Start nie an fehlenden Ordnern scheitert.
for (const dir of [DATA_DIR, BACKUP_DIR, LOG_DIR, MODEL_CACHE_DIR]) {
  if (!dir) continue; // MODEL_CACHE_DIR kann null sein (Transformers-Default)
  try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch { /* best effort */ }
}

module.exports = {
  ROOT, DATA_DIR, DB_FILE, BACKUP_DIR, LOG_DIR, LOG_FILE, MODEL_CACHE_DIR,
  CHARS_PER_TOKEN, START_NODE, PORT, VERSION, INBOX_TTL, LOG_RETENTION_DAYS,
};

'use strict';

/**
 * Brain storage layer — SQLite-Hybrid (Graph + FTS5 + sqlite-vec).
 *
 * Hält denselben Graphen wie früher die JSON-Datei (Knoten + Kanten) und ist
 * gleichzeitig Volltext- (FTS5) und Vektor-DB (sqlite-vec). Die öffentlichen
 * Funktionen geben exakt die bisherigen Shapes zurück, damit Frontend, REST
 * und CLAUDE.md-Workflows unverändert funktionieren.
 *
 * Token-Disziplin: getBrain()/Subgraph-Ausgaben enthalten nur die Minimalfelder
 * (id,label,type,content,tags,created). Lifecycle-/Embedding-Felder gibt es nur
 * über gezielte Endpunkte (Phase 2/3).
 */

const { randomUUID } = require('crypto');
const Database = require('better-sqlite3');
const config = require('./config');

const DB_FILE = config.DB_FILE; // aus config (BRAIN_DATA_DIR / BRAIN_DB) — eine Quelle
const EMBED_DIM = parseInt(process.env.BRAIN_EMBED_DIM || '1024', 10); // bge-m3 = 1024

// Datenverzeichnisse legt config.js bereits an.
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000'); // mehrere Prozesse (Server + MCP/Backfill) sicher
db.pragma('synchronous = NORMAL'); // mit WAL crash-sicher; Verlustfenster nur bei Stromausfall
db.pragma('cache_size = -8000');   // 8 MB Page-Cache
db.pragma('mmap_size = 268435456'); // 256 MB memory-mapped I/O
db.pragma('temp_store = MEMORY');

// sqlite-vec laden (optional — Fallback ohne Vektorsuche, falls Extension fehlt)
let vecEnabled = false;
try {
  require('sqlite-vec').load(db);
  vecEnabled = true;
} catch (err) {
  console.error('[db] sqlite-vec nicht geladen, Vektorsuche deaktiviert:', err.message);
}

// ── Schema (idempotent) ───────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS nodes (
    id              TEXT PRIMARY KEY,
    label           TEXT NOT NULL,
    type            TEXT NOT NULL DEFAULT 'note',
    content         TEXT NOT NULL DEFAULT '',
    summary         TEXT,
    created         TEXT NOT NULL,
    updated_at      TEXT,
    accessed_at     TEXT,
    access_count    INTEGER NOT NULL DEFAULT 0,
    source          TEXT,
    version         INTEGER NOT NULL DEFAULT 1,
    embedding_model TEXT
  );

  CREATE TABLE IF NOT EXISTS node_tags (
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    tag     TEXT NOT NULL,
    PRIMARY KEY (node_id, tag)
  );
  CREATE INDEX IF NOT EXISTS idx_node_tags_tag ON node_tags(tag COLLATE NOCASE);

  CREATE TABLE IF NOT EXISTS links (
    source   TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    target   TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    label    TEXT NOT NULL DEFAULT '',
    rel_type TEXT,
    created  TEXT,
    PRIMARY KEY (source, target)
  );
  CREATE INDEX IF NOT EXISTS idx_links_target ON links(target);

  CREATE TABLE IF NOT EXISTS node_history (
    node_id    TEXT NOT NULL,
    version    INTEGER NOT NULL,
    label      TEXT,
    type       TEXT,
    content    TEXT,
    tags       TEXT,
    changed_at TEXT NOT NULL,
    op         TEXT NOT NULL,
    PRIMARY KEY (node_id, version)
  );

  CREATE TABLE IF NOT EXISTS action_log (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    labels TEXT NOT NULL DEFAULT '[]',
    ts     TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_action_log_ts ON action_log(ts);

  CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
    DELETE FROM nodes_fts WHERE node_id = old.id;
  END;
`);

// A3: FTS-Migration — nodes_fts um tags-Spalte erweitern (idempotent via Rebuild).
{
  const ftsSql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'nodes_fts'").get()?.sql || '';
  if (!ftsSql.includes('tags')) {
    // FTS5 unterstützt kein ALTER TABLE → Tabelle und abhängige Trigger neu aufbauen.
    db.exec('DROP TABLE IF EXISTS nodes_fts');
    db.exec('CREATE VIRTUAL TABLE nodes_fts USING fts5(node_id UNINDEXED, label, content, tags)');
    // Vorhandene Knoten + Tags einspielen.
    const allNodes = db.prepare('SELECT n.id, n.label, n.content FROM nodes n').all();
    const insStmt = db.prepare('INSERT INTO nodes_fts(node_id, label, content, tags) VALUES (?, ?, ?, ?)');
    const tagStmt = db.prepare('SELECT tag FROM node_tags WHERE node_id = ?');
    const fill = db.transaction(() => {
      for (const n of allNodes) {
        const tags = tagStmt.all(n.id).map(r => r.tag).join(' ');
        insStmt.run(n.id, n.label, n.content, tags);
      }
    });
    fill();
    console.log('[db] Migration: nodes_fts um tags-Spalte erweitert und neu befüllt');
  }
  // Trigger neu erstellen (DROP + CREATE, damit bestehende Trigger mit altem 3-Spalten-Body ersetzt werden).
  db.exec(`
    DROP TRIGGER IF EXISTS nodes_ai;
    DROP TRIGGER IF EXISTS nodes_au;
    CREATE TRIGGER nodes_ai AFTER INSERT ON nodes BEGIN
      INSERT INTO nodes_fts(node_id, label, content, tags) VALUES (new.id, new.label, new.content, '');
    END;
    CREATE TRIGGER nodes_au AFTER UPDATE ON nodes BEGIN
      UPDATE nodes_fts SET label = new.label, content = new.content WHERE node_id = new.id;
    END;
  `);
}

// Vektor-Index (Cosine) — nur wenn Extension verfügbar.
if (vecEnabled) {
  // Dim-Migration: bestehende vec_nodes mit abweichender Dimension verwerfen (Re-Embed nötig).
  const existing = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'vec_nodes'").get();
  if (existing && !new RegExp(`float\\[${EMBED_DIM}\\]`).test(existing.sql)) {
    db.exec('DROP TABLE IF EXISTS vec_nodes');
    console.error(`[db] vec_nodes Dimension != ${EMBED_DIM} → neu erstellt (Re-Embed via backfill nötig)`);
  }
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_nodes USING vec0(
      node_id TEXT PRIMARY KEY,
      embedding float[${EMBED_DIM}] distance_metric=cosine
    );
  `);
}

// ── Schema-Migration: TTL-Unterstützung (idempotent) ─────────────────
{
  const cols = db.prepare('PRAGMA table_info(nodes)').all().map(c => c.name);
  if (!cols.includes('ttl')) {
    db.exec('ALTER TABLE nodes ADD COLUMN ttl        INTEGER');
    db.exec('ALTER TABLE nodes ADD COLUMN expires_at TEXT');
    console.log('[db] Migration: ttl + expires_at hinzugefügt');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_nodes_expires ON nodes(expires_at) WHERE expires_at IS NOT NULL');
}

// ── Schema-Migration: History vollständig (summary/source/ttl) ────────
{
  const cols = db.prepare('PRAGMA table_info(node_history)').all().map(c => c.name);
  if (!cols.includes('summary')) {
    db.exec('ALTER TABLE node_history ADD COLUMN summary    TEXT');
    db.exec('ALTER TABLE node_history ADD COLUMN source     TEXT');
    db.exec('ALTER TABLE node_history ADD COLUMN ttl        INTEGER');
    db.exec('ALTER TABLE node_history ADD COLUMN expires_at TEXT');
    console.log('[db] Migration: node_history um summary/source/ttl/expires_at erweitert');
  }
}

// ── Schema-Migration: Usage-Feedback (used_count/used_at) ─────────────
{
  const cols = db.prepare('PRAGMA table_info(nodes)').all().map(c => c.name);
  if (!cols.includes('used_count')) {
    db.exec('ALTER TABLE nodes ADD COLUMN used_count INTEGER NOT NULL DEFAULT 0');
    db.exec('ALTER TABLE nodes ADD COLUMN used_at    TEXT');
    console.log('[db] Migration: used_count + used_at hinzugefügt');
  }
}

// Verworfene Link-Vorschläge (GUI-Reject) — suggestLinks/Gärtner überspringen diese Paare.
db.exec(`
  CREATE TABLE IF NOT EXISTS dismissed_suggestions (
    pair_key TEXT PRIMARY KEY,
    created  TEXT NOT NULL
  )
`);

// ── Mapper ────────────────────────────────────────────────────────────
function tagsFor(ids) {
  // Map<node_id, string[]> für eine Knotenmenge
  const map = new Map();
  if (ids && ids.length === 0) return map;
  const rows = ids
    ? db.prepare(`SELECT node_id, tag FROM node_tags WHERE node_id IN (${ids.map(() => '?').join(',')})`).all(...ids)
    : db.prepare('SELECT node_id, tag FROM node_tags').all();
  for (const r of rows) {
    if (!map.has(r.node_id)) map.set(r.node_id, []);
    map.get(r.node_id).push(r.tag);
  }
  return map;
}

// Minimal-Shape (token-lean, = bisherige API)
function toPublicNode(row, tagMap) {
  return {
    id: row.id,
    label: row.label,
    type: row.type,
    content: row.content,
    tags: tagMap.get(row.id) || [],
    created: row.created,
  };
}

function toPublicLink(row) {
  const out = { source: row.source, target: row.target, label: row.label };
  if (row.rel_type) out.rel_type = row.rel_type; // nur wenn gesetzt → token-lean
  return out;
}

// ── Lese-Operationen ──────────────────────────────────────────────────
function getBrain() {
  const nodeRows = db.prepare(
    "SELECT id, label, type, content, created FROM nodes WHERE (expires_at IS NULL OR julianday(expires_at) > julianday('now'))"
  ).all();
  const tagMap = tagsFor(null);
  const linkRows = db.prepare('SELECT source, target, label, rel_type FROM links').all();
  return {
    nodes: nodeRows.map(n => toPublicNode(n, tagMap)),
    links: linkRows.map(toPublicLink),
  };
}

function buildSubgraph(idList) {
  const ids = [...new Set(idList)];
  if (ids.length === 0) return { nodes: [], links: [] };
  const ph = ids.map(() => '?').join(',');
  const nodeRows = db.prepare(
    `SELECT id, label, type, content, created FROM nodes WHERE id IN (${ph}) AND (expires_at IS NULL OR julianday(expires_at) > julianday('now'))`
  ).all(...ids);
  const tagMap = tagsFor(ids);
  const linkRows = db.prepare(
    `SELECT source, target, label, rel_type FROM links WHERE source IN (${ph}) AND target IN (${ph})`
  ).all(...ids, ...ids);
  return {
    nodes: nodeRows.map(n => toPublicNode(n, tagMap)),
    links: linkRows.map(toPublicLink),
  };
}

function getByTags(tagList) {
  const tags = tagList.map(t => t.trim()).filter(Boolean);
  if (tags.length === 0) return { nodes: [], links: [] };
  const ph = tags.map(() => '?').join(',');
  const ids = db.prepare(
    `SELECT DISTINCT node_id FROM node_tags WHERE tag COLLATE NOCASE IN (${ph})`
  ).all(...tags).map(r => r.node_id);
  return buildSubgraph(ids);
}

// Substring-Suche (case-insensitive) — verhält sich wie die bisherige Suche.
function searchNodes(query) {
  const like = `%${query}%`;
  const ids = db.prepare(
    "SELECT id FROM nodes WHERE (label LIKE ? COLLATE NOCASE OR content LIKE ? COLLATE NOCASE) AND (expires_at IS NULL OR julianday(expires_at) > julianday('now'))"
  ).all(like, like).map(r => r.id);
  return buildSubgraph(ids);
}

// Startknoten-Auflösung — deterministische Reihenfolge, damit JEDE KI denselben
// Einstiegspunkt bekommt (kein Claude-Sonderfall mehr):
//   1. BRAIN_START_NODE (config.START_NODE): exakte ID, sonst exaktes Label
//   2. Knoten mit Tag `start` (ältester zuerst — stabil)
//   3. Legacy-Labels „Claude – Startpunkt" / „Start" (Rückwärtskompatibilität)
//   4. null
function getStartNodeId() {
  const pref = config.START_NODE;
  if (pref) {
    const byId = db.prepare('SELECT id FROM nodes WHERE id = ?').get(pref);
    if (byId) return byId.id;
    const byLabel = db.prepare('SELECT id FROM nodes WHERE label = ?').get(pref);
    if (byLabel) return byLabel.id;
  }
  const tagged = db.prepare(
    `SELECT n.id FROM nodes n JOIN node_tags t ON t.node_id = n.id
     WHERE t.tag = 'start' COLLATE NOCASE ORDER BY n.created ASC LIMIT 1`
  ).get();
  if (tagged) return tagged.id;
  for (const label of ['Claude – Startpunkt', 'Start']) {
    const row = db.prepare('SELECT id FROM nodes WHERE label = ?').get(label);
    if (row) return row.id;
  }
  return null;
}

// Smart-Mode: Startknoten + erreichbare Knoten bis Tiefe `depth` (BFS).
function getSmart(depth = Infinity) {
  const brain = getBrain();
  const startId = getStartNodeId();
  const start = startId ? brain.nodes.find(n => n.id === startId) : null;
  if (!start) return brain;

  const visited = new Set();
  const queue = [{ id: start.id, d: 0 }];
  const keep = new Set();
  while (queue.length) {
    const { id, d } = queue.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    keep.add(id);
    if (d < depth) {
      for (const l of brain.links) {
        if (l.source === id && !visited.has(l.target)) queue.push({ id: l.target, d: d + 1 });
        if (l.target === id && !visited.has(l.source)) queue.push({ id: l.source, d: d + 1 });
      }
    }
  }
  return {
    nodes: brain.nodes.filter(n => keep.has(n.id)),
    links: brain.links.filter(l => keep.has(l.source) && keep.has(l.target)),
  };
}

function countNodes() {
  return db.prepare('SELECT COUNT(*) AS c FROM nodes').get().c;
}

function findByLabel(label) {
  const row = db.prepare('SELECT * FROM nodes WHERE label = ?').get(label);
  return row || null;
}

// ── Schreib-Operationen ───────────────────────────────────────────────
// Kein db.transaction() — wird immer aus einer Transaktion heraus gerufen (createNode/updateNode/revertNode).
function setTags(nodeId, tags) {
  db.prepare('DELETE FROM node_tags WHERE node_id = ?').run(nodeId);
  const ins = db.prepare('INSERT OR IGNORE INTO node_tags(node_id, tag) VALUES (?, ?)');
  for (const t of tags) ins.run(nodeId, t);
  // A3: FTS-tags-Spalte synchron halten.
  db.prepare('UPDATE nodes_fts SET tags = ? WHERE node_id = ?').run(tags.join(' '), nodeId);
}

function currentTags(id) {
  return db.prepare('SELECT tag FROM node_tags WHERE node_id = ?').all(id).map(r => r.tag);
}

// Snapshot des aktuellen Knoten-Stands in die History (vor Änderung/Löschung).
function recordHistory(row, op) {
  db.prepare(
    `INSERT OR REPLACE INTO node_history (node_id, version, label, type, content, tags, changed_at, op,
                                          summary, source, ttl, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(row.id, row.version, row.label, row.type, row.content,
        JSON.stringify(currentTags(row.id)), new Date().toISOString(), op,
        row.summary ?? null, row.source ?? null, row.ttl ?? null, row.expires_at ?? null);
}

const createNode = db.transaction(({ label, type = 'note', content = '', tags = [], summary = null, source = null, ttl = null }) => {
  const id = randomUUID();
  const created = new Date().toISOString();
  const expires_at = ttl ? new Date(Date.now() + ttl * 1000).toISOString() : null;
  db.prepare(
    `INSERT INTO nodes (id, label, type, content, summary, created, source, version, ttl, expires_at)
     VALUES (@id, @label, @type, @content, @summary, @created, @source, 1, @ttl, @expires_at)`
  ).run({ id, label, type, content, summary, created, source, ttl, expires_at });
  setTags(id, tags);
  return toPublicNode({ id, label, type, content, created }, new Map([[id, tags]]));
});

const updateNode = db.transaction((id, updates) => {
  const existing = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);
  if (!existing) return null;

  // TTL: explizit null setzt expires_at zurück (Upgrade zu dauerhaft)
  let ttl = existing.ttl;
  let expires_at = existing.expires_at;
  if ('ttl' in updates) {
    ttl = updates.ttl ?? null;
    expires_at = ttl ? new Date(Date.now() + ttl * 1000).toISOString() : null;
  }

  const next = {
    label: updates.label !== undefined ? updates.label : existing.label,
    type: updates.type !== undefined ? updates.type : existing.type,
    content: updates.content !== undefined ? updates.content : existing.content,
    summary: updates.summary !== undefined ? updates.summary : existing.summary,
    source: updates.source !== undefined ? updates.source : existing.source,
    ttl,
    expires_at,
  };
  // Vorherigen Stand versionieren, dann Version hochzählen.
  recordHistory(existing, 'update');
  const version = existing.version + 1;
  db.prepare(
    `UPDATE nodes SET label=@label, type=@type, content=@content, summary=@summary,
       source=@source, version=@version, updated_at=@updated_at, ttl=@ttl, expires_at=@expires_at WHERE id=@id`
  ).run({ ...next, version, updated_at: new Date().toISOString(), id });

  if (updates.tags !== undefined) setTags(id, updates.tags);

  const tagRows = currentTags(id);
  return toPublicNode({ id, ...next, created: existing.created }, new Map([[id, tagRows]]));
});

const deleteNode = db.transaction((id) => {
  const row = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);
  if (!row) return null;
  // Stand für mögliche Wiederherstellung (undelete) sichern.
  recordHistory(row, 'delete');
  if (vecEnabled) db.prepare('DELETE FROM vec_nodes WHERE node_id = ?').run(id);
  // node_tags + links via ON DELETE CASCADE, FTS via Trigger
  db.prepare('DELETE FROM nodes WHERE id = ?').run(id);
  return { label: row.label };
});

function linkExists(a, b) {
  return !!db.prepare(
    'SELECT 1 FROM links WHERE (source=? AND target=?) OR (source=? AND target=?)'
  ).get(a, b, b, a);
}

function nodeExists(id) {
  return !!db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(id);
}

function createLink(source, target, label = '', relType = null) {
  if (!nodeExists(source)) return { error: 'source' };
  if (!nodeExists(target)) return { error: 'target' };
  if (linkExists(source, target)) return { created: false, link: { source, target, label } };
  db.prepare('INSERT INTO links(source, target, label, rel_type, created) VALUES (?, ?, ?, ?, ?)')
    .run(source, target, label, relType, new Date().toISOString());
  return { created: true, link: { source, target, label } };
}

function deleteLink(source, target) {
  const res = db.prepare('DELETE FROM links WHERE source = ? AND target = ?').run(source, target);
  return { deleted: res.changes > 0 };
}

// ── Lifecycle: Einzelknoten, Zugriff, History, Revert, Health ─────────
// Voller Knoten inkl. Lifecycle-Felder (Drill-down; null-Felder weggelassen).
function getNodeFull(id) {
  const row = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);
  if (!row) return null;
  const out = {
    id: row.id, label: row.label, type: row.type, content: row.content,
    summary: row.summary, tags: currentTags(id), created: row.created,
    updated_at: row.updated_at, accessed_at: row.accessed_at,
    access_count: row.access_count, source: row.source, version: row.version,
    ttl: row.ttl, expires_at: row.expires_at,
    used_count: row.used_count, used_at: row.used_at,
  };
  for (const k of Object.keys(out)) if (out[k] === null) delete out[k];
  return out;
}

// Abgelaufene Ephemeral-Knoten löschen. Gibt Anzahl zurück.
// vec_nodes hat kein ON DELETE CASCADE → explizit mitlöschen.
const deleteExpired = db.transaction(() => {
  const expired = db.prepare(
    "SELECT id FROM nodes WHERE expires_at IS NOT NULL AND julianday(expires_at) < julianday('now')"
  ).all().map(r => r.id);
  if (expired.length === 0) return 0;
  if (vecEnabled) {
    const ph = expired.map(() => '?').join(',');
    db.prepare(`DELETE FROM vec_nodes WHERE node_id IN (${ph})`).run(...expired);
  }
  return db.prepare(
    "DELETE FROM nodes WHERE expires_at IS NOT NULL AND julianday(expires_at) < julianday('now')"
  ).run().changes;
});

// ── Action-Log (persistent, Standard-Aufbewahrung 7 Tage) ──────────────
function logAction(action, labels = []) {
  const ts = new Date().toISOString();
  db.prepare('INSERT INTO action_log (action, labels, ts) VALUES (?, ?, ?)')
    .run(action, JSON.stringify(labels), ts);
  return { action, labels, ts };
}

// Letzte Einträge der vergangenen `days` Tage (älteste zuerst, max `limit`).
function getRecentLog(days = 7, limit = 500) {
  const rows = db.prepare(
    `SELECT action, labels, ts FROM action_log
     WHERE julianday(ts) > julianday('now', ?)
     ORDER BY ts DESC LIMIT ?`
  ).all(`-${days} days`, limit);
  return rows.reverse().map(r => ({ action: r.action, labels: JSON.parse(r.labels || '[]'), ts: r.ts }));
}

// Einträge älter als `days` Tage löschen. Gibt Anzahl gelöschter Zeilen zurück.
function pruneLog(days = 7) {
  return db.prepare(
    `DELETE FROM action_log WHERE julianday(ts) < julianday('now', ?)`
  ).run(`-${days} days`).changes;
}

// Zugriffs-Zähler (für „gezielten Recall" — search/tags/Einzelknoten).
const touchAccess = db.transaction((ids) => {
  if (!ids || ids.length === 0) return;
  const now = new Date().toISOString();
  const stmt = db.prepare('UPDATE nodes SET access_count = access_count + 1, accessed_at = ? WHERE id = ?');
  for (const id of ids) stmt.run(now, id);
});

function getHistory(id) {
  return db.prepare(
    `SELECT version, label, type, content, tags, changed_at, op,
            summary, source, ttl, expires_at
     FROM node_history WHERE node_id = ? ORDER BY version`
  ).all(id).map(h => ({ ...h, tags: JSON.parse(h.tags || '[]') }));
}

// Knoten auf einen History-Stand zurücksetzen (oder gelöschten wiederherstellen).
// Gibt { node } zurück (Re-Embedding macht operations.revertNode in JS).
const revertNode = db.transaction((id, version) => {
  const h = db.prepare('SELECT * FROM node_history WHERE node_id = ? AND version = ?').get(id, version);
  if (!h) return null;
  const tags = JSON.parse(h.tags || '[]');
  const existing = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);

  if (existing) {
    recordHistory(existing, 'revert-from');
    db.prepare(
      `UPDATE nodes SET label=?, type=?, content=?, summary=?, source=?, ttl=?, expires_at=?,
                        version=?, updated_at=? WHERE id=?`
    ).run(h.label, h.type, h.content, h.summary ?? null, h.source ?? null,
          h.ttl ?? null, h.expires_at ?? null,
          existing.version + 1, new Date().toISOString(), id);
  } else {
    // undelete
    db.prepare(
      `INSERT INTO nodes (id, label, type, content, summary, source, ttl, expires_at, created, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, h.label, h.type, h.content, h.summary ?? null, h.source ?? null,
          h.ttl ?? null, h.expires_at ?? null,
          new Date().toISOString(), (h.version ?? 0) + 1);
  }
  setTags(id, tags);
  return getNodeFull(id);
});

// Entfernt Codeblöcke (``` … ```) und Inline-Code (`…`) — damit [[…]] in
// Code-Beispielen nicht als Wikilink zählt (genutzt von getHealthReport und
// operations.resolveWikilinks).
function stripCode(content) {
  return String(content || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`\n]*`/g, '');
}

// Graph-Hygiene-Report (read-only).
function getHealthReport() {
  const brain = getBrain();
  const linked = new Set();
  for (const l of brain.links) { linked.add(l.source); linked.add(l.target); }
  const orphans = brain.nodes.filter(n => !linked.has(n.id)).map(n => n.label);

  const counts = {};
  for (const n of brain.nodes) counts[n.label] = (counts[n.label] || 0) + 1;
  const duplicateLabels = Object.entries(counts).filter(([, c]) => c > 1).map(([label, count]) => ({ label, count }));

  const labelSet = new Set(brain.nodes.map(n => n.label));
  const deadWikilinks = [];
  for (const n of brain.nodes) {
    for (const m of stripCode(n.content).matchAll(/\[\[([^\]]+)\]\]/g)) {
      const t = m[1].trim();
      if (!labelSet.has(t)) deadWikilinks.push({ node: n.label, missing: t });
    }
  }

  const neverAccessed = db.prepare('SELECT label FROM nodes WHERE access_count = 0').all().map(r => r.label);

  const expiringSoon = db.prepare(
    "SELECT label, expires_at FROM nodes WHERE expires_at IS NOT NULL AND julianday(expires_at) > julianday('now') AND julianday(expires_at) < julianday('now', '+24 hours') ORDER BY expires_at"
  ).all();

  return {
    totals: { nodes: brain.nodes.length, links: brain.links.length },
    orphans,
    duplicateLabels,
    deadWikilinks,
    neverAccessed,
    expiringSoon,
  };
}

// ── Semantik: Embeddings (vec_nodes) + Hybrid-Bausteine ───────────────
function toBuf(vec) {
  const f = vec instanceof Float32Array ? vec : Float32Array.from(vec);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

function upsertEmbedding(id, vec, model) {
  if (!vecEnabled) return false;
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM vec_nodes WHERE node_id = ?').run(id);
    db.prepare('INSERT INTO vec_nodes(node_id, embedding) VALUES (?, ?)').run(id, toBuf(vec));
    db.prepare('UPDATE nodes SET embedding_model = ? WHERE id = ?').run(model, id);
  });
  tx();
  return true;
}

function deleteEmbedding(id) {
  if (!vecEnabled) return;
  db.prepare('DELETE FROM vec_nodes WHERE node_id = ?').run(id);
}

// Reine Vektor-KNN: [{ node_id, distance }] (Cosine-Distanz, klein = ähnlich).
function searchSemantic(vec, limit = 10) {
  if (!vecEnabled) return [];
  const k = Math.max(1, Math.min(parseInt(limit, 10) || 10, 100));
  return db.prepare(
    `SELECT node_id, distance FROM vec_nodes WHERE embedding MATCH ? ORDER BY distance LIMIT ${k}`
  ).all(toBuf(vec));
}

// Keyword-Ranking über FTS5 (bm25): [{ node_id, rank }] (rank klein = besser).
function searchKeywordRanked(query, limit = 30) {
  const terms = String(query || '').trim().split(/\s+/)
    .map(t => t.replace(/["()*:^]/g, ''))
    .filter(Boolean)
    .map(t => t + '*');
  if (terms.length === 0) return [];
  const k = Math.max(1, Math.min(parseInt(limit, 10) || 30, 200));
  try {
    return db.prepare(
      `SELECT node_id, rank FROM nodes_fts WHERE nodes_fts MATCH ? ORDER BY rank LIMIT ${k}`
    ).all(terms.join(' OR '));
  } catch {
    return [];
  }
}

function nodesNeedingEmbedding() {
  if (!vecEnabled) return [];
  return db.prepare(
    "SELECT id, content FROM nodes WHERE id NOT IN (SELECT node_id FROM vec_nodes) AND (expires_at IS NULL OR julianday(expires_at) > julianday('now'))"
  ).all();
}

// Access-Statistiken (access_count, accessed_at, used_count) für eine Knotenmenge.
function getAccessStats(ids) {
  const map = new Map();
  if (!ids || ids.length === 0) return map;
  const ph = ids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT id, access_count, accessed_at, used_count, used_at FROM nodes WHERE id IN (${ph})`
  ).all(...ids);
  for (const r of rows) {
    map.set(r.id, {
      access_count: r.access_count || 0, accessed_at: r.accessed_at,
      used_count: r.used_count || 0, used_at: r.used_at,
    });
  }
  return map;
}

// Usage-Feedback: vom Agenten als „wirklich genutzt" gemeldete Knoten.
const markUsed = db.transaction((ids) => {
  if (!ids || ids.length === 0) return 0;
  const now = new Date().toISOString();
  const stmt = db.prepare('UPDATE nodes SET used_count = used_count + 1, used_at = ? WHERE id = ?');
  let n = 0;
  for (const id of ids) n += stmt.run(now, id).changes;
  return n;
});

// Verworfene Link-Vorschläge: sortierter Paar-Schlüssel als Sperre.
function dismissSuggestion(a, b) {
  const key = [a, b].sort().join('|');
  db.prepare('INSERT OR IGNORE INTO dismissed_suggestions(pair_key, created) VALUES (?, ?)')
    .run(key, new Date().toISOString());
  return key;
}

function getDismissedPairs() {
  return new Set(db.prepare('SELECT pair_key FROM dismissed_suggestions').all().map(r => r.pair_key));
}

// 1-Hop-Nachbarn einer Knotenmenge (aus links-Tabelle, beide Richtungen).
function getNeighborIds(ids) {
  if (!ids || ids.length === 0) return [];
  const ph = ids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT CASE WHEN source IN (${ph}) THEN target ELSE source END AS neighbor_id
     FROM links WHERE source IN (${ph}) OR target IN (${ph})`
  ).all(...ids, ...ids, ...ids);
  const idSet = new Set(ids);
  return [...new Set(rows.map(r => r.neighbor_id).filter(id => !idSet.has(id)))];
}

// Link-Zeilen zu einer Knotenmenge (für Subgraph/Nachbar-Abfragen).
// direction: 'out' (ids als source), 'in' (ids als target), 'both'.
function getNeighborLinks(ids, direction = 'both') {
  if (!ids || ids.length === 0) return [];
  const ph = ids.map(() => '?').join(',');
  let where, params;
  if (direction === 'out')      { where = `source IN (${ph})`; params = ids; }
  else if (direction === 'in')  { where = `target IN (${ph})`; params = ids; }
  else                          { where = `source IN (${ph}) OR target IN (${ph})`; params = [...ids, ...ids]; }
  return db.prepare(`SELECT source, target, label, rel_type FROM links WHERE ${where}`).all(...params);
}

// Alle gespeicherten Embeddings als Map<node_id, Float32Array>
// (für paarweise Ähnlichkeit in suggestLinks — kein Re-Embedding nötig).
function getAllEmbeddings() {
  const map = new Map();
  if (!vecEnabled) return map;
  for (const r of db.prepare('SELECT node_id, embedding FROM vec_nodes').all()) {
    const buf = r.embedding;
    map.set(r.node_id, new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
  }
  return map;
}

// Alle Links als Set sortierter "a|b"-Schlüssel (Existenz-Checks in O(1)).
function getAllLinkPairs() {
  const set = new Set();
  for (const r of db.prepare('SELECT source, target FROM links').all()) {
    set.add([r.source, r.target].sort().join('|'));
  }
  return set;
}

// Label/rel_type einer bestehenden Kante ändern (beide Orientierungen akzeptiert).
function updateLink(source, target, { label, relType } = {}) {
  const row = db.prepare(
    'SELECT source, target FROM links WHERE (source=? AND target=?) OR (source=? AND target=?)'
  ).get(source, target, target, source);
  if (!row) return { error: 'not_found' };
  const sets = [];
  const params = { s: row.source, t: row.target };
  if (label !== undefined)   { sets.push('label = @label');      params.label = label; }
  if (relType !== undefined) { sets.push('rel_type = @relType'); params.relType = relType; }
  if (sets.length === 0) return { error: 'no_changes' };
  db.prepare(`UPDATE links SET ${sets.join(', ')} WHERE source = @s AND target = @t`).run(params);
  return { link: db.prepare('SELECT source, target, label, rel_type FROM links WHERE source = ? AND target = ?').get(row.source, row.target) };
}

// Preview-Daten (id,label,type,summary,content) für eine Knotenmenge.
function getNodesPreview(ids) {
  const map = new Map();
  if (!ids.length) return map;
  const ph = ids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT id, label, type, summary, content FROM nodes WHERE id IN (${ph}) AND (expires_at IS NULL OR julianday(expires_at) > julianday('now'))`
  ).all(...ids);
  for (const r of rows) map.set(r.id, r);
  return map;
}

// ── Export / Restore (für JSON-Snapshot-Backups) ──────────────────────
// Vollständige Felder OHNE Embeddings (lesbar, klein, verlustfrei restorebar).
function exportGraph() {
  const nodeRows = db.prepare(
    `SELECT id, label, type, content, summary, created, updated_at, accessed_at,
            access_count, used_count, used_at, source, version, ttl, expires_at FROM nodes`
  ).all();
  const tagMap = tagsFor(null);
  const nodes = nodeRows.map(n => {
    const out = { ...n, tags: tagMap.get(n.id) || [] };
    // null-Felder weglassen, damit Snapshots schlank/lesbar bleiben
    for (const k of Object.keys(out)) if (out[k] === null) delete out[k];
    return out;
  });
  const links = db.prepare('SELECT source, target, label, rel_type, created FROM links').all()
    .map(l => { for (const k of Object.keys(l)) if (l[k] === null) delete l[k]; return l; });
  return { nodes, links };
}

// Komplett ersetzen (Restore eines Snapshots oder Migration).
const replaceAll = db.transaction((graph) => {
  db.prepare('DELETE FROM links').run();
  db.prepare('DELETE FROM node_tags').run();
  if (vecEnabled) db.prepare('DELETE FROM vec_nodes').run();
  db.prepare('DELETE FROM nodes').run();

  const insNode = db.prepare(
    `INSERT INTO nodes (id, label, type, content, summary, created, updated_at, accessed_at,
        access_count, used_count, used_at, source, version)
     VALUES (@id, @label, @type, @content, @summary, @created, @updated_at, @accessed_at,
        @access_count, @used_count, @used_at, @source, @version)`
  );
  for (const n of graph.nodes || []) {
    insNode.run({
      id: n.id || randomUUID(),
      label: n.label,
      type: n.type || 'note',
      content: n.content || '',
      summary: n.summary ?? null,
      created: n.created || new Date().toISOString(),
      updated_at: n.updated_at ?? null,
      accessed_at: n.accessed_at ?? null,
      access_count: n.access_count ?? 0,
      used_count: n.used_count ?? 0,
      used_at: n.used_at ?? null,
      source: n.source ?? null,
      version: n.version ?? 1,
    });
    setTags(n.id, Array.isArray(n.tags) ? n.tags : []);
  }
  const insLink = db.prepare('INSERT OR IGNORE INTO links(source, target, label, rel_type, created) VALUES (?, ?, ?, ?, ?)');
  for (const l of graph.links || []) {
    insLink.run(l.source, l.target, l.label || '', l.rel_type ?? null, l.created ?? null);
  }
});

module.exports = {
  db,
  vecEnabled,
  EMBED_DIM,
  // Lesen
  getBrain,
  getByTags,
  searchNodes,
  getSmart,
  buildSubgraph,
  countNodes,
  findByLabel,
  getStartNodeId,
  // Schreiben
  createNode,
  updateNode,
  deleteNode,
  createLink,
  deleteLink,
  // Lifecycle
  getNodeFull,
  touchAccess,
  getHistory,
  revertNode,
  getHealthReport,
  stripCode,
  deleteExpired,
  logAction,
  getRecentLog,
  pruneLog,
  // Semantik
  upsertEmbedding,
  deleteEmbedding,
  searchSemantic,
  searchKeywordRanked,
  nodesNeedingEmbedding,
  getNodesPreview,
  getAccessStats,
  getNeighborIds,
  getNeighborLinks,
  getAllEmbeddings,
  getAllLinkPairs,
  updateLink,
  markUsed,
  dismissSuggestion,
  getDismissedPairs,
  // Backup/Restore/Migration
  exportGraph,
  replaceAll,
};

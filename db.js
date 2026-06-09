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

const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = process.env.BRAIN_DB || path.join(DATA_DIR, 'brain.db');
const EMBED_DIM = parseInt(process.env.BRAIN_EMBED_DIM || '1024', 10); // bge-m3 = 1024

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000'); // mehrere Prozesse (Server + MCP/Backfill) sicher

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

  CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(node_id UNINDEXED, label, content);

  CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
    INSERT INTO nodes_fts(node_id, label, content) VALUES (new.id, new.label, new.content);
  END;
  CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
    DELETE FROM nodes_fts WHERE node_id = old.id;
  END;
  CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
    UPDATE nodes_fts SET label = new.label, content = new.content WHERE node_id = new.id;
  END;
`);

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

// Smart-Mode: Startknoten + erreichbare Knoten bis Tiefe `depth` (BFS).
function getSmart(depth = Infinity) {
  const brain = getBrain();
  const start = brain.nodes.find(n => n.label === 'Claude – Startpunkt' || n.label === 'Start');
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
const setTags = db.transaction((nodeId, tags) => {
  db.prepare('DELETE FROM node_tags WHERE node_id = ?').run(nodeId);
  const ins = db.prepare('INSERT OR IGNORE INTO node_tags(node_id, tag) VALUES (?, ?)');
  for (const t of tags) ins.run(nodeId, t);
});

function currentTags(id) {
  return db.prepare('SELECT tag FROM node_tags WHERE node_id = ?').all(id).map(r => r.tag);
}

// Snapshot des aktuellen Knoten-Stands in die History (vor Änderung/Löschung).
function recordHistory(row, op) {
  db.prepare(
    `INSERT OR REPLACE INTO node_history (node_id, version, label, type, content, tags, changed_at, op)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(row.id, row.version, row.label, row.type, row.content,
        JSON.stringify(currentTags(row.id)), new Date().toISOString(), op);
}

const createNode = db.transaction(({ label, type, content, tags = [], summary = null, source = null, ttl = null }) => {
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
  };
  for (const k of Object.keys(out)) if (out[k] === null) delete out[k];
  return out;
}

// Abgelaufene Ephemeral-Knoten löschen. Gibt Anzahl zurück.
function deleteExpired() {
  return db.prepare(
    "DELETE FROM nodes WHERE expires_at IS NOT NULL AND julianday(expires_at) < julianday('now')"
  ).run().changes;
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
    'SELECT version, label, type, content, tags, changed_at, op FROM node_history WHERE node_id = ? ORDER BY version'
  ).all(id).map(h => ({ ...h, tags: JSON.parse(h.tags || '[]') }));
}

// Knoten auf einen History-Stand zurücksetzen (oder gelöschten wiederherstellen).
const revertNode = db.transaction((id, version) => {
  const h = db.prepare('SELECT * FROM node_history WHERE node_id = ? AND version = ?').get(id, version);
  if (!h) return null;
  const tags = JSON.parse(h.tags || '[]');
  const existing = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);

  if (existing) {
    recordHistory(existing, 'revert-from');
    db.prepare('UPDATE nodes SET label=?, type=?, content=?, version=?, updated_at=? WHERE id=?')
      .run(h.label, h.type, h.content, existing.version + 1, new Date().toISOString(), id);
  } else {
    // undelete
    db.prepare('INSERT INTO nodes (id, label, type, content, created, version) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, h.label, h.type, h.content, new Date().toISOString(), h.version + 1);
  }
  setTags(id, tags);
  return getNodeFull(id);
});

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
    for (const m of (n.content || '').matchAll(/\[\[([^\]]+)\]\]/g)) {
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
            access_count, source, version, ttl, expires_at FROM nodes`
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
        access_count, source, version)
     VALUES (@id, @label, @type, @content, @summary, @created, @updated_at, @accessed_at,
        @access_count, @source, @version)`
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
  deleteExpired,
  // Semantik
  upsertEmbedding,
  deleteEmbedding,
  searchSemantic,
  searchKeywordRanked,
  nodesNeedingEmbedding,
  getNodesPreview,
  // Backup/Restore/Migration
  exportGraph,
  replaceAll,
};

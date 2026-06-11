'use strict';

/**
 * Geteilte Schreib-Operationen (create/update/revert inkl. Embedding + semantischer Dedup)
 * für REST (server.js) und MCP (mcp/tools.js). Eine Quelle → kein Drift.
 *
 * Gibt Ergebnis-Objekte mit `error`-Code statt HTTP-Status zurück; der Aufrufer
 * mappt auf Status/Tool-Antwort.
 */

const db = require('./db');
const { embed, MODEL } = require('./embeddings');

const DEDUP_DISTANCE = parseFloat(process.env.BRAIN_DEDUP_DISTANCE || '0.12');

// A1: Zusammengesetzter Text für Embeddings (Label + Summary + Content).
// Wird auch im backfill genutzt (eine Quelle).
function embeddingText({ label = '', summary = '', content = '' }) {
  const parts = [label.trim()];
  if (summary && summary.trim()) parts.push(summary.trim());
  if (content && content.trim()) parts.push(content.trim());
  return parts.join('\n');
}

async function createNode({ label, type = 'note', content = '', tags = [], summary = null, source = null, ttl = null, force = false }) {
  const lbl = String(label || '').trim();
  if (!lbl) return { error: 'label_required' };

  const existing = db.findByLabel(lbl);
  if (existing) return { error: 'label_exists', existing: { id: existing.id, label: existing.label } };

  // A1: Embedding-Text enthält Label + Summary + Content.
  let vec = null;
  if (db.vecEnabled) {
    try {
      vec = await embed(embeddingText({ label: lbl, summary: summary || '', content }), 'passage');
      if (!force) {
        const near = db.searchSemantic(vec, 1)[0];
        if (near && near.distance < DEDUP_DISTANCE) {
          const sim = db.getNodeFull(near.node_id);
          // C2: Preview mitliefern → Agent spart den separaten brain_get vor der Merge-Entscheidung.
          return {
            error: 'similar_exists',
            similarity: +(1 - near.distance).toFixed(3),
            similar: sim
              ? { id: sim.id, label: sim.label, type: sim.type, preview: require('./retrieval').previewText(sim) }
              : { id: near.node_id },
          };
        }
      }
    } catch { /* Embedding optional — Write nicht blockieren */ }
  }

  const node = db.createNode({ label: lbl, type, content, tags, summary, source, ttl });
  if (vec) db.upsertEmbedding(node.id, vec, MODEL);

  // B1: [[Wikilinks]] im content zu Kanten auflösen.
  if (content) resolveWikilinks(node.id, content);

  return { node };
}

async function updateNode(id, updates) {
  const node = db.updateNode(id, updates);
  if (!node) return { error: 'not_found' };

  // A1: Re-Embed wenn label, summary oder content geändert wurde.
  const needsReembed = db.vecEnabled &&
    ('content' in updates || 'label' in updates || 'summary' in updates);
  if (needsReembed) {
    try {
      const full = db.getNodeFull(id);
      if (full) {
        const vec = await embed(embeddingText(full), 'passage');
        db.upsertEmbedding(id, vec, MODEL);
      }
    } catch { /* Embedding optional */ }
  }

  // B1: Bei Content-Änderung Wikilinks re-auflösen.
  if (updates.content !== undefined) resolveWikilinks(id, updates.content);

  return { node };
}

// C1: Revert-Orchestrierung mit Re-Embedding (db.revertNode ändert den Inhalt,
// aber nicht den Vektor — das passiert hier in JS).
async function revertNode(id, version) {
  const node = db.revertNode(id, version);
  if (!node) return { error: 'not_found' };
  if (db.vecEnabled) {
    try {
      const vec = await embed(embeddingText(node), 'passage');
      db.upsertEmbedding(id, vec, MODEL);
    } catch { /* Embedding optional */ }
  }
  return { node };
}

// B1: [[Wikilinks]] im content zu Kanten auflösen (idempotent dank createLink).
// [[…]] in Codeblöcken/Inline-Code wird ignoriert (db.stripCode).
function resolveWikilinks(nodeId, content) {
  if (!content) return;
  const matches = [...db.stripCode(content).matchAll(/\[\[([^\]]+)\]\]/g)];
  for (const m of matches) {
    const target = db.findByLabel(m[1].trim());
    if (!target || target.id === nodeId) continue;
    db.createLink(nodeId, target.id, '');
  }
}

// C4: Bulk — mehrere Knoten + Kanten in einem Aufruf (Import/Aufräumen).
// Teilerfolge werden pro Eintrag gemeldet; Links dürfen IDs ODER Labels referenzieren
// (frisch erstellte Knoten sind nach createNode bereits per Label auflösbar).
async function bulkCreate({ nodes = [], links = [] } = {}) {
  const results = [];
  let created = 0, failed = 0;
  for (const spec of nodes) {
    try {
      const r = await createNode(spec);
      if (r.node) { created++; results.push({ label: spec.label, ok: true, id: r.node.id }); }
      else { failed++; results.push({ label: spec.label, ok: false, error: r.error, similar: r.similar, existing: r.existing }); }
    } catch (e) {
      failed++; results.push({ label: spec.label, ok: false, error: e.message });
    }
  }

  const resolve = (ref) => {
    if (!ref) return null;
    if (db.db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(ref)) return ref;
    const byLabel = db.findByLabel(String(ref).trim());
    return byLabel ? byLabel.id : null;
  };

  const linkResults = [];
  let linksCreated = 0;
  for (const l of links) {
    const s = resolve(l.source), t = resolve(l.target);
    if (!s || !t) { linkResults.push({ source: l.source, target: l.target, error: !s ? 'source_unresolved' : 'target_unresolved' }); continue; }
    const r = db.createLink(s, t, l.label || '', l.type ?? null);
    if (r.error) linkResults.push({ source: l.source, target: l.target, error: r.error });
    else if (r.created) { linksCreated++; linkResults.push({ source: l.source, target: l.target, created: true }); }
    else linkResults.push({ source: l.source, target: l.target, skipped: true });
  }

  return { created, failed, linksCreated, results, linkResults };
}

module.exports = { embeddingText, createNode, updateNode, revertNode, resolveWikilinks, bulkCreate, DEDUP_DISTANCE };

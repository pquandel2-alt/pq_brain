'use strict';

/**
 * Geteilte Schreib-Operationen (create/update inkl. Embedding + semantischer Dedup)
 * für REST (server.js) und MCP (mcp/tools.js). Eine Quelle → kein Drift.
 *
 * Gibt Ergebnis-Objekte mit `error`-Code statt HTTP-Status zurück; der Aufrufer
 * mappt auf Status/Tool-Antwort.
 */

const db = require('./db');
const { embed, MODEL } = require('./embeddings');

const DEDUP_DISTANCE = parseFloat(process.env.BRAIN_DEDUP_DISTANCE || '0.12');

async function createNode({ label, type = 'note', content = '', tags = [], summary = null, source = null, ttl = null, force = false }) {
  const lbl = String(label || '').trim();
  if (!lbl) return { error: 'label_required' };

  const existing = db.findByLabel(lbl);
  if (existing) return { error: 'label_exists', existing: { id: existing.id, label: existing.label } };

  // Embedding + semantische Dedup (außer force).
  let vec = null;
  if (db.vecEnabled && content) {
    try {
      vec = await embed(content, 'passage');
      if (!force) {
        const near = db.searchSemantic(vec, 1)[0];
        if (near && near.distance < DEDUP_DISTANCE) {
          const sim = db.getNodeFull(near.node_id);
          return {
            error: 'similar_exists',
            similarity: +(1 - near.distance).toFixed(3),
            similar: sim ? { id: sim.id, label: sim.label } : { id: near.node_id },
          };
        }
      }
    } catch { /* Embedding optional — Write nicht blockieren */ }
  }

  const node = db.createNode({ label: lbl, type, content, tags, summary, source, ttl });
  if (vec) db.upsertEmbedding(node.id, vec, MODEL);
  return { node };
}

async function updateNode(id, updates) {
  const node = db.updateNode(id, updates);
  if (!node) return { error: 'not_found' };
  if (updates.content !== undefined && db.vecEnabled) {
    try { db.upsertEmbedding(id, await embed(updates.content, 'passage'), MODEL); }
    catch { /* Embedding optional */ }
  }
  return { node };
}

module.exports = { createNode, updateNode, DEDUP_DISTANCE };

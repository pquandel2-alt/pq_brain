'use strict';

/**
 * Erzeugt Embeddings für Knoten ohne (oder alle mit --all).
 * Idempotent — kann jederzeit erneut laufen.
 *
 *   node backfill-embeddings.js          # nur fehlende
 *   node backfill-embeddings.js --all    # A1: alle re-embedden (Label+Summary+Content)
 */

const db = require('./db');
const { embed, MODEL } = require('./embeddings');
const { embeddingText } = require('./operations');

const forceAll = process.argv.includes('--all');

(async () => {
  if (!db.vecEnabled) {
    console.error('sqlite-vec nicht verfügbar — Abbruch.');
    process.exit(1);
  }

  let todo;
  if (forceAll) {
    todo = db.db.prepare('SELECT id, label, content, summary FROM nodes').all();
    console.log(`${todo.length} Knoten werden re-embeddet (--all, Modell: ${MODEL})`);
  } else {
    todo = db.nodesNeedingEmbedding().map(r => ({ ...r, label: '', summary: '' }));
    console.log(`${todo.length} Knoten ohne Embedding (Modell: ${MODEL})`);
  }

  let done = 0;
  for (const node of todo) {
    try {
      const text = embeddingText({ label: node.label || '', summary: node.summary || '', content: node.content || '' });
      const vec = await embed(text, 'passage');
      db.upsertEmbedding(node.id, vec, MODEL);
      done++;
      if (done % 5 === 0 || done === todo.length) console.log(`  ${done}/${todo.length}`);
    } catch (e) {
      console.error('  Fehler bei', node.id, e.message);
    }
  }
  console.log(`Fertig: ${done} Embeddings erzeugt.`);
})();

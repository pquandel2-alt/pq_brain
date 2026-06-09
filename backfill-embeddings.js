'use strict';

/**
 * Erzeugt Embeddings für alle Knoten, die noch keines haben.
 * Idempotent — kann jederzeit erneut laufen.
 *
 *   node backfill-embeddings.js
 */

const db = require('./db');
const { embed, MODEL } = require('./embeddings');

(async () => {
  if (!db.vecEnabled) {
    console.error('sqlite-vec nicht verfügbar — Abbruch.');
    process.exit(1);
  }
  const todo = db.nodesNeedingEmbedding();
  console.log(`${todo.length} Knoten ohne Embedding (Modell: ${MODEL})`);
  let done = 0;
  for (const node of todo) {
    try {
      const vec = await embed(node.content || '', 'passage');
      db.upsertEmbedding(node.id, vec, MODEL);
      done++;
      if (done % 5 === 0 || done === todo.length) console.log(`  ${done}/${todo.length}`);
    } catch (e) {
      console.error('  Fehler bei', node.id, e.message);
    }
  }
  console.log(`Fertig: ${done} Embeddings erzeugt.`);
})();

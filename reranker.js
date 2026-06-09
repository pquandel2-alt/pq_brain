'use strict';

/**
 * Cross-Encoder Re-Ranking (bge-reranker-base, multilingual DE+EN).
 * Bewertet (Query, Passage)-Paare gemeinsam → präziser als bi-encoder-Cosine.
 *
 * Wichtig: NICHT die `text-classification`-Pipeline nutzen — die wendet bei
 * 1-Label-Reranker-Modellen Sigmoid an und kollabiert alle Scores auf ~1.
 * Stattdessen Modell direkt ansteuern und die rohen Relevanz-Logits lesen.
 *
 * Lazy-geladen, dann im Speicher warm gehalten. q8-quantisiert (267 MB statt 1,1 GB).
 */

const MODEL = process.env.BRAIN_RERANK_MODEL || 'Xenova/bge-reranker-base';
const DTYPE = process.env.BRAIN_RERANK_DTYPE || 'q8';
const MAX_LENGTH = 512;

let _tok = null;
let _model = null;
let _ready = false;
let _loading = null;

function isReady() { return _ready; }

async function ensureLoaded() {
  if (_ready) return true;
  if (_loading) { await _loading; return _ready; }
  _loading = (async () => {
    try {
      const { AutoTokenizer, AutoModelForSequenceClassification } = await import('@huggingface/transformers');
      _tok = await AutoTokenizer.from_pretrained(MODEL);
      _model = await AutoModelForSequenceClassification.from_pretrained(MODEL, { dtype: DTYPE });
      _ready = true;
      console.log(`[reranker] ${MODEL} (${DTYPE}) bereit`);
    } catch (err) {
      console.error('[reranker] Laden fehlgeschlagen:', err.message);
      _loading = null; // Retry erlauben
    }
  })();
  await _loading;
  return _ready;
}

// Opt-in-Feature (Default aus): NICHT eager laden. Das Modell (~267 MB) wird erst
// beim ersten Recall mit rerank=true geladen → kein RAM/Startup-Aufwand im Normalbetrieb.

/**
 * Rerankt passages für eine Query.
 * @param {string} query
 * @param {{id: string, text: string}[]} passages
 * @returns {Promise<{id: string, score: number}[]>} absteigend nach Relevanz (höher = relevanter)
 */
async function rerank(query, passages) {
  if (passages.length === 0) return [];
  await ensureLoaded();
  // Fallback: Reihenfolge beibehalten (abnehmender Score), wenn Modell fehlt.
  if (!_ready) return passages.map((p, i) => ({ id: p.id, score: -(i + 1) }));
  try {
    const queries = passages.map(() => query);
    const docs = passages.map(p => p.text);
    const inputs = _tok(queries, { text_pair: docs, padding: true, truncation: true, max_length: MAX_LENGTH });
    const { logits } = await _model(inputs);
    const scores = Array.from(logits.data); // [N, 1] → N rohe Relevanz-Logits
    return passages
      .map((p, i) => ({ id: p.id, score: scores[i] }))
      .sort((a, b) => b.score - a.score);
  } catch (err) {
    console.error('[reranker] Fehler:', err.message);
    return passages.map((p, i) => ({ id: p.id, score: -(i + 1) }));
  }
}

module.exports = { rerank, isReady, MODEL };

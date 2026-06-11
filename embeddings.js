'use strict';

/**
 * Lokale Embeddings (in-process, Transformers.js) — keine Daten verlassen den Host.
 * Default-Modell: Xenova/bge-m3 (mehrsprachig DE+EN, 1024 Dim, retrieval-tuned, CLS-Pooling).
 * Über BRAIN_EMBED_MODEL umstellbar; e5-Modelle nutzen "query:"/"passage:"-Prefixe.
 *
 * Modell-Cache: liegt unter config.MODEL_CACHE_DIR (Teil von BRAIN_DATA_DIR), damit
 * der einmalige Download im Daten-Volume persistiert und ein Container-Neustart das
 * Modell nicht erneut zieht.
 */

const config = require('./config');
// Transformers.js-Cache nur umlenken, wenn explizit konfiguriert (BRAIN_MODEL_CACHE/
// BRAIN_DATA_DIR). Sonst Default-Cache (node_modules/.cache) — kein Re-Download.
if (config.MODEL_CACHE_DIR) {
  try {
    const { env } = require('@huggingface/transformers');
    env.cacheDir = config.MODEL_CACHE_DIR;
  } catch { /* Bibliothek wird lazy geladen; Fallback auf Default-Cache */ }
}

const MODEL = process.env.BRAIN_EMBED_MODEL || 'Xenova/bge-m3';
const DIM = parseInt(process.env.BRAIN_EMBED_DIM || '1024', 10);
const DTYPE = process.env.BRAIN_EMBED_DTYPE || 'q8'; // q8 = klein/RAM-schonend; 'fp32' = max. Qualität

// Modell-spezifische Konventionen:
const IS_BGE = /bge/i.test(MODEL);
const POOLING = IS_BGE ? 'cls' : 'mean';      // BGE: CLS-Token, e5: mean
const USE_E5_PREFIX = /e5/i.test(MODEL);      // e5 will "query:"/"passage:" Prefixe

let extractorPromise = null;

// Lazy laden + warm halten (einmal pro Prozess).
async function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = import('@huggingface/transformers').then(({ pipeline }) =>
      pipeline('feature-extraction', MODEL, { dtype: DTYPE })
    );
  }
  return extractorPromise;
}

// Modell vorab laden (z.B. beim Serverstart), damit der erste Request schnell ist.
async function warmup() {
  await embed('warmup', 'query');
}

/**
 * @param {string} text
 * @param {'query'|'passage'} kind
 * @returns {Promise<Float32Array>} normalisiertes Embedding (Länge DIM)
 */
async function embed(text, kind = 'passage') {
  const extractor = await getExtractor();
  let input = String(text || '');
  if (USE_E5_PREFIX) input = (kind === 'query' ? 'query: ' : 'passage: ') + input;
  const out = await extractor(input, { pooling: POOLING, normalize: true });
  return Float32Array.from(out.data);
}

module.exports = { embed, warmup, MODEL, DIM };

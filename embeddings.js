'use strict';

/**
 * Lokale Embeddings (in-process, Transformers.js) — keine Daten verlassen die VM.
 * Modell: multilingual-e5-small (DE+EN, 384 Dim, retrieval-tuned).
 * e5-Konvention: Query mit "query: ", gespeicherte Texte mit "passage: " prefixen.
 */

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

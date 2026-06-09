'use strict';

/**
 * Geteilte Retrieval-Logik für REST (server.js) und MCP (mcp/tools.js).
 * Token-Disziplin: liefert gerankte IDs/Kurzfassungen, nicht ganze Dumps.
 */

const db = require('./db');
const { embed } = require('./embeddings');
const reranker = require('./reranker');

const estTokens = (s) => Math.ceil((s || '').length / 4); // schneller Schätzer (Zeichen/4)

function previewText(row) {
  if (row.summary) return row.summary;
  const firstLine = (row.content || '').split('\n').find(l => l.trim()) || '';
  return firstLine.length > 240 ? firstLine.slice(0, 240) + '…' : firstLine;
}

// Kompakte, prosa-fokussierte Passage fürs Re-Ranking.
// Cross-Encoder arbeiten am besten mit einer KURZEN repräsentativen Passage, nicht
// mit einem Dokument-Dump: lange Hub-/Index-Knoten mit Aufzählungstabellen (die jedes
// Item nennen) würden sonst jede Item-Anfrage breit „treffen" und die spezifischen
// Knoten verdrängen. Darum: Markdown-Tabellen + -Lärm raus, Label-Dublette raus,
// auf die ersten ~400 Zeichen Prosa kappen.
function rerankText(row) {
  if (row.summary) return (row.label + '. ' + row.summary).slice(0, 400);
  const prose = (row.content || '')
    .split('\n')
    .filter(l => !l.includes('|'))     // Markdown-Tabellenzeilen raus (Hub-Aufzählungen)
    .join('\n')
    .replace(/^#+\s*/gm, '')           // Header-Markierungen
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // Links → nur Linktext
    .replace(/[*_`>]/g, '')            // Betonung/Code/Quote-Marker
    .replace(/\n{2,}/g, '\n')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .filter(l => l.toLowerCase() !== row.label.toLowerCase()) // Label-Dublette raus
    .join('. ')
    .trim();
  return (row.label + '. ' + prose).slice(0, 400);
}

// Reciprocal Rank Fusion mehrerer gerankter ID-Listen → [[id, score], ...]
function rrf(lists, k = 60) {
  const scores = new Map();
  for (const list of lists) {
    list.forEach((id, idx) => scores.set(id, (scores.get(id) || 0) + 1 / (k + idx + 1)));
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]);
}

/**
 * Gerankte [[id, score], ...] für eine Query.
 * mode: 'hybrid' (Default) | 'semantic' | 'keyword'
 */
async function rankedIds({ q, mode = 'hybrid', limit = 10 }) {
  const lim = Math.max(1, Math.min(parseInt(limit, 10) || 10, 100));

  if (mode === 'keyword' || !db.vecEnabled && mode === 'semantic') {
    return db.searchKeywordRanked(q, lim).map((r, i) => [r.node_id, +(1 / (i + 1)).toFixed(4)]);
  }
  if (mode === 'semantic') {
    return db.searchSemantic(await embed(q, 'query'), lim).map(h => [h.node_id, +(1 - h.distance).toFixed(4)]);
  }
  // hybrid: Semantik + Keyword über RRF
  let sem = [];
  if (db.vecEnabled) {
    try { sem = db.searchSemantic(await embed(q, 'query'), 40).map(r => r.node_id); } catch { /* degr. */ }
  }
  const kw = db.searchKeywordRanked(q, 40).map(r => r.node_id);
  return rrf([sem, kw]).slice(0, lim).map(([id, s]) => [id, +s.toFixed(4)]);
}

// Kompakte gerankte Trefferliste [{id,label,type,score}] (token-lean, für Suche).
async function searchCompact({ q, mode = 'hybrid', limit = 10 }) {
  const ranked = await rankedIds({ q, mode, limit });
  const preview = db.getNodesPreview(ranked.map(([id]) => id));
  return ranked
    .filter(([id]) => preview.has(id))
    .map(([id, score]) => {
      const r = preview.get(id);
      return { id, label: r.label, type: r.type, score };
    });
}

/**
 * Token-Budget-Recall: gerankte Kurzfassungen bis zum Budget. Der KI-Einstieg.
 * rerank: Opt-in (Default aus). Cross-Encoder hilft erst bei vielen ähnlichen
 * Kandidaten; auf dem heutigen Korpus ist Hybrid-RRF bereits optimal und schneller.
 */
async function recall({ q, budget = 4000, limit = 8, rerank: doRerank = false }) {
  const lim = Math.max(1, Math.min(parseInt(limit, 10) || 8, 50));
  const bud = Math.max(200, parseInt(budget, 10) || 4000);

  const useRerank = doRerank === true || doRerank === 'true';
  const poolSize = useRerank ? Math.max(lim * 3, 24) : lim;

  const ranked = await rankedIds({ q, mode: 'hybrid', limit: poolSize });
  const preview = db.getNodesPreview(ranked.map(([id]) => id));

  let orderedPairs; // [[id, score], ...]
  if (useRerank && ranked.length > 0) {
    try {
      const passages = ranked
        .filter(([id]) => preview.has(id))
        .map(([id]) => ({ id, text: rerankText(preview.get(id)) }));
      const reranked = await reranker.rerank(q, passages);
      orderedPairs = reranked.map(r => [r.id, r.score]);
    } catch {
      orderedPairs = ranked;
    }
  } else {
    orderedPairs = ranked;
  }

  const results = [];
  let used = 0;
  for (const [id, score] of orderedPairs) {
    if (results.length >= lim) break;
    const row = preview.get(id);
    if (!row) continue;
    const text = previewText(row);
    const cost = estTokens(row.label) + estTokens(text) + 4;
    if (used + cost > bud && results.length > 0) break;
    results.push({ id, label: row.label, type: row.type, preview: text, score: +Number(score).toFixed(4) });
    used += cost;
    if (used >= bud) break;
  }
  return { query: q, budget: bud, usedTokensEst: used, count: results.length, results };
}

module.exports = { estTokens, previewText, rerankText, rrf, rankedIds, searchCompact, recall };

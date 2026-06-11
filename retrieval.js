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
function rerankText(row) {
  if (row.summary) return (row.label + '. ' + row.summary).slice(0, 400);
  const prose = (row.content || '')
    .split('\n')
    .filter(l => !l.includes('|'))
    .join('\n')
    .replace(/^#+\s*/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`>]/g, '')
    .replace(/\n{2,}/g, '\n')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .filter(l => l.toLowerCase() !== row.label.toLowerCase())
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

// A2: Frecency-Boost — milder multiplikativer Faktor, damit Relevanz dominiert.
const FREQ_WEIGHT  = 0.02; // Gewicht des Zugriffszählers (reduziert nach Eval 2026-06-11: 0.1 boostete Brain zu aggressiv)
const USED_WEIGHT  = 0.06; // Gewicht des Usage-Signals (brain_mark_used) — stärker als bloßer Zugriff
const RECENCY_WEIGHT = 0.05; // Gewicht der Aktualität
const RECENCY_HALF   = 30;   // Halbwertszeit in Tagen

const FRECENCY_MAX = 1.1; // Gesamtboost nie mehr als 10% — verhindert Dominanz hochfrequenter Knoten

function frecencyBoost(accessCount, accessedAt, usedCount) {
  const freqBoost = 1 + FREQ_WEIGHT * Math.log1p(accessCount || 0);
  const usedBoost = 1 + USED_WEIGHT * Math.log1p(usedCount || 0);
  let recencyBoost = 1;
  if (accessedAt) {
    const ageDays = (Date.now() - new Date(accessedAt).getTime()) / 86_400_000;
    recencyBoost = 1 + RECENCY_WEIGHT * Math.exp(-ageDays / RECENCY_HALF);
  }
  return Math.min(freqBoost * usedBoost * recencyBoost, FRECENCY_MAX);
}

/**
 * Gerankte [[id, score], ...] für eine Query.
 * mode: 'hybrid' (Default) | 'semantic' | 'keyword'
 * frecency: A2-Boost an/aus (Default an; `false` nur fürs Eval-Harness).
 */
async function rankedIds({ q, mode = 'hybrid', limit = 10, frecency = true }) {
  const lim = Math.max(1, Math.min(parseInt(limit, 10) || 10, 100));

  if (mode === 'keyword' || !db.vecEnabled && mode === 'semantic') {
    return db.searchKeywordRanked(q, lim).map((r, i) => [r.node_id, +(1 / (i + 1)).toFixed(4)]);
  }
  if (mode === 'semantic') {
    return db.searchSemantic(await embed(q, 'query'), lim).map(h => [h.node_id, +(1 - h.distance).toFixed(4)]);
  }

  // hybrid: Semantik + Keyword über RRF, dann A2 Frecency-Boost
  let sem = [];
  if (db.vecEnabled) {
    try { sem = db.searchSemantic(await embed(q, 'query'), 40).map(r => r.node_id); } catch { /* degr. */ }
  }
  const kw = db.searchKeywordRanked(q, 40).map(r => r.node_id);
  const fused = rrf([sem, kw]).slice(0, lim);

  // A2: Frecency-Boost nur im hybrid-Modus anwenden (abschaltbar fürs Eval).
  if (!frecency) return fused.map(([id, score]) => [id, +score.toFixed(4)]);
  const ids = fused.map(([id]) => id);
  const accessStats = db.getAccessStats(ids);
  return fused.map(([id, score]) => {
    const stats = accessStats.get(id) || {};
    const boosted = score * frecencyBoost(stats.access_count, stats.accessed_at, stats.used_count);
    return [id, +boosted.toFixed(4)];
  }).sort((a, b) => b[1] - a[1]);
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
 * Token-Budget-Recall: gerankte Kurzfassungen bis zum Budget.
 * rerank: Opt-in (Cross-Encoder, Default aus).
 * expand: Opt-in (A4 — 1-Hop-Graph-Expansion, Default aus).
 */
async function recall({ q, budget = 4000, limit = 8, rerank: doRerank = false, expand = false, frecency = true }) {
  const lim = Math.max(1, Math.min(parseInt(limit, 10) || 8, 50));
  const bud = Math.max(200, parseInt(budget, 10) || 4000);

  const useRerank = doRerank === true || doRerank === 'true';
  const useExpand = expand === true || expand === 'true';
  const poolSize = useRerank ? Math.max(lim * 3, 24) : lim;

  const ranked = await rankedIds({ q, mode: 'hybrid', limit: poolSize, frecency });

  // A4: Graph-Expansion — 1-Hop-Nachbarn der Top-3 mit abgewertetem Score anhängen.
  let expandedRanked = ranked;
  let viaMeta = new Map(); // id → label des Treffers, über den expandiert wurde
  if (useExpand && ranked.length > 0) {
    const topIds = ranked.slice(0, 3).map(([id]) => id);
    const topPreview = db.getNodesPreview(topIds);
    const neighborIds = db.getNeighborIds(topIds);
    const existingIds = new Set(ranked.map(([id]) => id));
    const newNeighbors = neighborIds.filter(id => !existingIds.has(id));
    if (newNeighbors.length > 0) {
      // Score = 0.5 × score des besten Top-Treffers der diesen Nachbar verbindet.
      const topScoreMap = new Map(ranked.slice(0, 3));
      // Für jeden Nachbar: link zum höchstgewerteten Top-Knoten finden.
      const links = db.db.prepare(
        `SELECT source, target FROM links WHERE (source IN (${topIds.map(() => '?').join(',')}) AND target IN (${newNeighbors.map(() => '?').join(',')}))
         OR (target IN (${topIds.map(() => '?').join(',')}) AND source IN (${newNeighbors.map(() => '?').join(',')}))`
      ).all(...topIds, ...newNeighbors, ...topIds, ...newNeighbors);
      for (const link of links) {
        const neighborId = topIds.includes(link.source) ? link.target : link.source;
        const topId = topIds.includes(link.source) ? link.source : link.target;
        if (!viaMeta.has(neighborId)) {
          viaMeta.set(neighborId, topPreview.get(topId)?.label ?? topId);
        }
        if (!existingIds.has(neighborId)) {
          expandedRanked = [...expandedRanked, [neighborId, +((topScoreMap.get(topId) || 0) * 0.5).toFixed(4)]];
          existingIds.add(neighborId);
        }
      }
    }
  }

  const preview = db.getNodesPreview(expandedRanked.map(([id]) => id));

  let orderedPairs;
  if (useRerank && ranked.length > 0) {
    try {
      const passages = ranked
        .filter(([id]) => preview.has(id))
        .map(([id]) => ({ id, text: rerankText(preview.get(id)) }));
      const reranked = await reranker.rerank(q, passages);
      orderedPairs = reranked.map(r => [r.id, r.score]);
    } catch {
      orderedPairs = expandedRanked;
    }
  } else {
    orderedPairs = expandedRanked;
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
    const entry = { id, label: row.label, type: row.type, preview: text, score: +Number(score).toFixed(4) };
    if (viaMeta.has(id)) entry.via = viaMeta.get(id);
    results.push(entry);
    used += cost;
    if (used >= bud) break;
  }
  return { query: q, budget: bud, usedTokensEst: used, count: results.length, results };
}

// B2: Link-Vorschläge — semantisch ähnliche, noch unverlinkte Knotenpaare.
// Paarweise Cosine-Similarity über die GESPEICHERTEN Vektoren (normalisiert →
// Dot-Product) statt Re-Embedding pro Knoten. Für bge-m3 mathematisch identisch
// (kein query/passage-Prefix); bei Wechsel auf z.B. e5-Modelle prüfen!
async function suggestLinks({ limit = 20 } = {}) {
  if (!db.vecEnabled) return [];
  const embeddings = db.getAllEmbeddings();
  if (embeddings.size < 2) return [];
  const linked = db.getAllLinkPairs();
  const dismissed = db.getDismissedPairs();
  // Nur lebende (nicht abgelaufene) Knoten — liefert auch gleich die Labels.
  const preview = db.getNodesPreview([...embeddings.keys()]);

  const ids = [...embeddings.keys()].filter(id => preview.has(id));
  const suggestions = [];
  for (let i = 0; i < ids.length; i++) {
    const a = embeddings.get(ids[i]);
    for (let j = i + 1; j < ids.length; j++) {
      const b = embeddings.get(ids[j]);
      let dot = 0;
      for (let k = 0; k < a.length; k++) dot += a[k] * b[k];
      if (dot < 0.75) continue;
      const pairKey = [ids[i], ids[j]].sort().join('|');
      if (linked.has(pairKey) || dismissed.has(pairKey)) continue;
      suggestions.push({
        source: { id: ids[i], label: preview.get(ids[i]).label },
        target: { id: ids[j], label: preview.get(ids[j]).label },
        similarity: +dot.toFixed(3),
      });
    }
  }
  return suggestions.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
}

// C1: Nachbar-Subgraph eines Knotens (BFS bis depth, token-schlank).
function neighbors({ id, depth = 1, direction = 'both' }) {
  const root = db.getNodeFull(id);
  if (!root) return null;
  const d = Math.max(1, Math.min(parseInt(depth, 10) || 1, 3));
  const dir = ['in', 'out', 'both'].includes(direction) ? direction : 'both';

  const seen = new Set([id]);
  const links = [];
  const linkKeys = new Set();
  let frontier = [id];
  for (let hop = 0; hop < d && frontier.length > 0; hop++) {
    const rows = db.getNeighborLinks(frontier, dir);
    const next = [];
    for (const l of rows) {
      const key = `${l.source}|${l.target}`;
      if (!linkKeys.has(key)) { linkKeys.add(key); links.push(l); }
      for (const nid of [l.source, l.target]) {
        if (!seen.has(nid)) { seen.add(nid); next.push(nid); }
      }
    }
    frontier = next;
  }

  const preview = db.getNodesPreview([...seen]);
  const nodes = [...seen].filter(nid => preview.has(nid)).map(nid => {
    const r = preview.get(nid);
    const out = { id: r.id, label: r.label, type: r.type };
    if (r.summary) out.summary = r.summary;
    return out;
  });
  const liveIds = new Set(nodes.map(n => n.id));
  return {
    root: { id: root.id, label: root.label },
    depth: d,
    direction: dir,
    count: nodes.length,
    nodes,
    links: links
      .filter(l => liveIds.has(l.source) && liveIds.has(l.target))
      .map(l => {
        const out = { source: l.source, target: l.target };
        if (l.label) out.label = l.label;
        if (l.rel_type) out.rel_type = l.rel_type;
        return out;
      }),
  };
}

module.exports = { estTokens, previewText, rerankText, rrf, frecencyBoost, rankedIds, searchCompact, recall, suggestLinks, neighbors };

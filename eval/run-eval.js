'use strict';

/**
 * Eval-Harness: misst Retrieval-Qualität gegen kuratierte Gold-Queries (eval/gold.json).
 *
 * Läuft in-process gegen die Live-DB (rein lesend — retrieval.js ruft nie touchAccess;
 * ein Guard prüft das zusätzlich). Vergleicht Varianten (keyword/semantic/hybrid/
 * rerank/expand/frecency) und persistiert Ergebnisse nach eval/results/.
 *
 * Aufruf:
 *   node eval/run-eval.js [--variants hybrid,hybrid+rerank] [--gold pfad]
 *                         [--no-save] [--verbose]
 */

const fs = require('fs');
const path = require('path');

const db = require('../db');
const { rankedIds, recall } = require('../retrieval');
const embeddings = require('../embeddings');
const reranker = require('../reranker');
const { perQuery, aggregate } = require('./metrics');

const LIMIT = 10;          // Top-10 → MRR@10 wohldefiniert
const HUGE_BUDGET = 100000; // Token-Budget-Schleife in recall() darf nie kürzen

// ── Varianten: Name → async (q) => geordnete Knoten-IDs ─────────────────────
const VARIANTS = {
  'keyword':              async (q) => (await rankedIds({ q, mode: 'keyword', limit: LIMIT })).map(([id]) => id),
  'semantic':             async (q) => (await rankedIds({ q, mode: 'semantic', limit: LIMIT })).map(([id]) => id),
  'hybrid':               async (q) => (await rankedIds({ q, mode: 'hybrid', limit: LIMIT })).map(([id]) => id),
  'hybrid-nofrec':        async (q) => (await rankedIds({ q, mode: 'hybrid', limit: LIMIT, frecency: false })).map(([id]) => id),
  'hybrid+rerank':        async (q) => (await recall({ q, budget: HUGE_BUDGET, limit: LIMIT, rerank: true })).results.map(r => r.id),
  'hybrid+expand':        async (q) => (await recall({ q, budget: HUGE_BUDGET, limit: LIMIT, expand: true })).results.map(r => r.id),
  'hybrid+rerank+expand': async (q) => (await recall({ q, budget: HUGE_BUDGET, limit: LIMIT, rerank: true, expand: true })).results.map(r => r.id),
};

// ── CLI-Argumente ────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { variants: Object.keys(VARIANTS), gold: path.join(__dirname, 'gold.json'), save: true, verbose: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--variants') args.variants = (argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--gold') args.gold = path.resolve(argv[++i] || '');
    else if (a === '--no-save') args.save = false;
    else if (a === '--verbose') args.verbose = true;
    else { console.error(`Unbekanntes Argument: ${a}`); process.exit(1); }
  }
  const unknown = args.variants.filter(v => !VARIANTS[v]);
  if (unknown.length) {
    console.error(`Unbekannte Variante(n): ${unknown.join(', ')}\nVerfügbar: ${Object.keys(VARIANTS).join(', ')}`);
    process.exit(1);
  }
  return args;
}

// ── Gold-Set laden + Labels zu IDs auflösen (harter Fehler bei Lücken) ──────
function loadGold(goldPath) {
  if (!fs.existsSync(goldPath)) {
    console.error(`Gold-Set fehlt: ${goldPath}\nBootstrap: npm run eval:suggest > vorschlaege.txt, dann kuratieren.`);
    process.exit(1);
  }
  const gold = JSON.parse(fs.readFileSync(goldPath, 'utf8'));
  const unresolved = [];
  const queries = (gold.queries || []).map(q => {
    const expected = new Map(); // id → label (für verbose-Ausgabe)
    for (const e of q.expected || []) {
      const id = e.nodeId || db.findByLabel(e.label)?.id;
      if (!id) { unresolved.push(`${q.id}: "${e.label}"`); continue; }
      expected.set(id, e.label || id);
    }
    return { id: q.id, query: q.query, expected };
  });
  if (unresolved.length) {
    console.error('Gold-Set referenziert unbekannte Labels (Datei mit dem Graph synchron halten!):');
    for (const u of unresolved) console.error(`  - ${u}`);
    process.exit(1);
  }
  return { version: gold.version || 1, queries };
}

// ── Side-Effect-Guard: Eval darf access_count nie verändern ─────────────────
function accessFingerprint() {
  return db.db.prepare('SELECT COALESCE(SUM(access_count),0) AS s, MAX(accessed_at) AS m FROM nodes').get();
}

// ── Ausgabe-Helfer ───────────────────────────────────────────────────────────
const pad = (s, w) => String(s).padEnd(w);
const num = (v, w = 6) => v.toFixed(2).padStart(w);

function printTable(rows) {
  console.log('\n' + pad('Variante', 22) + ['S@1', 'S@3', 'S@5', 'R@5', 'MRR'].map(h => h.padStart(7)).join('') + 'ms/q'.padStart(8));
  console.log('─'.repeat(22 + 5 * 7 + 8));
  for (const r of rows) {
    console.log(
      pad(r.variant, 22) + num(r.agg.s1, 7) + num(r.agg.s3, 7) + num(r.agg.s5, 7) +
      num(r.agg.r5, 7) + num(r.agg.mrr, 7) + String(Math.round(r.msPerQuery)).padStart(8)
    );
  }
}

function latestResultFile(resultsDir) {
  if (!fs.existsSync(resultsDir)) return null;
  const files = fs.readdirSync(resultsDir).filter(f => f.endsWith('.json')).sort();
  return files.length ? path.join(resultsDir, files[files.length - 1]) : null;
}

function printDeltas(rows, prev) {
  console.log(`\nΔ gegenüber ${path.basename(prev.file)}:`);
  for (const r of rows) {
    const old = prev.data.variants?.[r.variant]?.aggregate;
    if (!old) { console.log(`  ${r.variant}: (neu)`); continue; }
    const parts = ['s1', 's3', 's5', 'r5', 'mrr'].map(k => {
      const d = r.agg[k] - (old[k] || 0);
      const sign = d > 0 ? '+' : '';
      return `${k.toUpperCase()} ${r.agg[k].toFixed(2)} (${sign}${d.toFixed(2)})`;
    });
    console.log(`  ${pad(r.variant, 22)}${parts.join('  ')}`);
  }
}

// ── Hauptlauf ────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv);
  const gold = loadGold(args.gold);
  console.log(`Gold-Set: ${gold.queries.length} Queries (v${gold.version}) · Graph: ${db.countNodes()} Knoten · Varianten: ${args.variants.join(', ')}`);

  const fpBefore = accessFingerprint();

  // Embedding-Modell vor der Zeitmessung laden (Reranker lazy-loadet beim ersten rerank-Query, ~267 MB).
  if (db.vecEnabled) {
    process.stdout.write('Embedding-Warmup… ');
    await embeddings.warmup();
    console.log('ok');
  }

  const rows = [];
  for (const variant of args.variants) {
    const run = VARIANTS[variant];
    const perQueryResults = [];
    const misses = [];
    const t0 = Date.now();
    for (const q of gold.queries) {
      const ids = await run(q.query);
      const m = perQuery(ids, new Set(q.expected.keys()));
      // Ränge der erwarteten Knoten (1-basiert, null = nicht in Top-10) fürs Result-JSON.
      const ranks = {};
      for (const [id, label] of q.expected) {
        const idx = ids.indexOf(id);
        ranks[label] = idx === -1 ? null : idx + 1;
      }
      perQueryResults.push({ id: q.id, query: q.query, metrics: m, ranks });
      if (m.s5 === 0) misses.push({ q, ids });
    }
    const msPerQuery = (Date.now() - t0) / gold.queries.length;
    const agg = aggregate(perQueryResults.map(r => r.metrics));
    rows.push({ variant, agg, msPerQuery, perQueryResults });

    if (args.verbose && misses.length) {
      console.log(`\n[${variant}] ${misses.length} Miss(es) (kein erwarteter Knoten in Top-5):`);
      for (const { q, ids } of misses) {
        const preview = db.getNodesPreview(ids.slice(0, 5));
        const got = ids.slice(0, 5).map(id => preview.get(id)?.label || id).join(' · ');
        console.log(`  ${q.id} "${q.query}"\n    erwartet: ${[...q.expected.values()].join(', ')}\n    top-5:    ${got}`);
      }
    }
  }

  printTable(rows);

  // Guard: Eval muss rein lesend gewesen sein.
  const fpAfter = accessFingerprint();
  if (fpAfter.s !== fpBefore.s || fpAfter.m !== fpBefore.m) {
    console.error('\nFEHLER: access_count/accessed_at haben sich während des Evals geändert.');
    console.error('Entweder schreibt der Eval-Pfad (Bug — retrieval.js muss rein lesend bleiben),');
    console.error('oder der laufende Server hatte parallel Zugriffe (dann einfach erneut laufen lassen).');
    process.exit(2);
  }

  // Persistenz + Delta zum jüngsten Vorlauf.
  const resultsDir = path.join(__dirname, 'results');
  const prevFile = latestResultFile(resultsDir);
  if (prevFile) {
    try { printDeltas(rows, { file: prevFile, data: JSON.parse(fs.readFileSync(prevFile, 'utf8')) }); } catch { /* defekte Datei ignorieren */ }
  }
  if (args.save) {
    fs.mkdirSync(resultsDir, { recursive: true });
    const out = {
      ts: new Date().toISOString(),
      goldVersion: gold.version,
      queryCount: gold.queries.length,
      nodeCount: db.countNodes(),
      accessSum: fpBefore.s,
      embedModel: embeddings.MODEL,
      rerankModel: reranker.MODEL,
      variants: Object.fromEntries(rows.map(r => [r.variant, {
        aggregate: r.agg,
        msPerQuery: +r.msPerQuery.toFixed(1),
        perQuery: r.perQueryResults,
      }])),
    };
    const file = path.join(resultsDir, out.ts.replace(/[:.]/g, '-') + '.json');
    fs.writeFileSync(file, JSON.stringify(out, null, 2));
    console.log(`\nGespeichert: ${path.relative(process.cwd(), file)}`);
  }
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });

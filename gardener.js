'use strict';

/**
 * Gärtner — tägliche Selbstpflege ohne Token-Kosten.
 *
 * Rein deterministischer Code (keine KI-Inferenz): misst den Graphen,
 * legt optional Auto-Links bei sehr hoher Ähnlichkeit an und schreibt die
 * Befunde als „Wartungsbericht"-Knoten ins Brain. Das Urteilen (Duplikate
 * mergen, Summaries formulieren) übernimmt Claude on-demand in ohnehin
 * offenen Sessions — der Bericht ist dafür die Arbeitsliste.
 *
 * Auto-Links: Schwelle per Env BRAIN_AUTO_LINK_SIM (Default 0.9, 0 = aus);
 * alle automatisch angelegten Kanten tragen rel_type='auto' → nachvollziehbar
 * und jederzeit rückbaubar.
 */

const db = require('./db');
const retrieval = require('./retrieval');
const operations = require('./operations');

const REPORT_LABEL = 'Wartungsbericht';
const AUTO_LINK_SIM = parseFloat(process.env.BRAIN_AUTO_LINK_SIM || '0.9'); // 0 = aus
const STALE_DAYS = 90;

// Pure: Vorschläge oberhalb der Auto-Link-Schwelle (0 = Feature aus).
function pickAutoLinks(suggestions, threshold = AUTO_LINK_SIM) {
  if (!(threshold > 0)) return [];
  return suggestions.filter(s => s.similarity >= threshold);
}

// Befunde sammeln (read-only bis auf Auto-Links).
async function collectFindings() {
  const health = db.getHealthReport();
  // Der Bericht selbst zählt nicht als Pflegefall — und nicht im Bestand
  // (sonst änderte sich der Bericht durch seine eigene Erstanlage).
  if (db.findByLabel(REPORT_LABEL)) health.totals.nodes -= 1;
  health.orphans = health.orphans.filter(l => l !== REPORT_LABEL);
  health.neverAccessed = health.neverAccessed.filter(l => l !== REPORT_LABEL);

  let suggestions = [];
  try {
    suggestions = await retrieval.suggestLinks({ limit: 20 });
  } catch { /* Embeddings optional — Bericht trotzdem bauen */ }
  suggestions = suggestions.filter(
    s => s.source.label !== REPORT_LABEL && s.target.label !== REPORT_LABEL
  );

  // Auto-Linking: sehr ähnliche Paare direkt verbinden (markiert als 'auto').
  const autoLinked = [];
  for (const s of pickAutoLinks(suggestions)) {
    const r = db.createLink(s.source.id, s.target.id, '', 'auto');
    if (r && r.created) autoLinked.push(s);
  }
  const remaining = suggestions.filter(s => !autoLinked.includes(s));

  const missingSummaries = db.db.prepare(
    "SELECT label FROM nodes WHERE (summary IS NULL OR TRIM(summary) = '') AND label != ? ORDER BY label"
  ).all(REPORT_LABEL).map(r => r.label);

  const staleNodes = db.db.prepare(
    `SELECT label, COALESCE(updated_at, created) AS last FROM nodes
     WHERE julianday(COALESCE(updated_at, created)) < julianday('now', ?) AND label != ?
     ORDER BY last`
  ).all(`-${STALE_DAYS} days`, REPORT_LABEL).map(r => ({ label: r.label, last: (r.last || '').slice(0, 10) }));

  return { health, autoLinked, suggestions: remaining, missingSummaries, staleNodes };
}

// Pure Function: Befunde → Markdown (bewusst ohne Zeitstempel, damit der
// Upsert-Vergleich „nur schreiben wenn geändert" greift; updated_at des
// Knotens zeigt den letzten Lauf).
function buildReport(f) {
  const lines = [];
  const section = (title, items, render) => {
    if (!items.length) return;
    lines.push(`## ${title} (${items.length})`);
    for (const it of items) lines.push(`- ${render(it)}`);
    lines.push('');
  };

  lines.push(`**Bestand:** ${f.health.totals.nodes} Knoten, ${f.health.totals.links} Links`);
  lines.push('');

  section('Auto-Links neu angelegt (rel_type=auto)', f.autoLinked,
    s => `${s.source.label} ↔ ${s.target.label} (${s.similarity})`);
  section('Link-Vorschläge — bitte prüfen', f.suggestions,
    s => `${s.source.label} ↔ ${s.target.label} (${s.similarity})`);
  section('Knoten ohne Summary', f.missingSummaries, l => l);
  section('Waisen (keine Verbindungen)', f.health.orphans, l => l);
  section('Doppelte Labels', f.health.duplicateLabels,
    d => `${d.label} (${d.count}×)`);
  section('Tote Wikilinks', f.health.deadWikilinks,
    w => `[[${w.missing}]] in „${w.node}"`);
  section(`Lange unverändert (>${STALE_DAYS} Tage) — noch aktuell?`, f.staleNodes,
    n => `${n.label} (zuletzt ${n.last})`);

  if (lines.length <= 2) lines.push('Keine Auffälligkeiten — alles gepflegt. ✅');
  return lines.join('\n').trimEnd();
}

// Kompakte Zusammenfassung für API-Antwort/Logging.
function summarize(f, changed) {
  return {
    changed,
    nodes: f.health.totals.nodes,
    links: f.health.totals.links,
    autoLinked: f.autoLinked.length,
    suggestions: f.suggestions.length,
    missingSummaries: f.missingSummaries.length,
    orphans: f.health.orphans.length,
    duplicateLabels: f.health.duplicateLabels.length,
    deadWikilinks: f.health.deadWikilinks.length,
    staleNodes: f.staleNodes.length,
  };
}

// Lauf: Befunde → Bericht → „Wartungsbericht"-Knoten upserten.
// Schreibt nur bei inhaltlicher Änderung (kein Versions-Spam).
async function runMaintenance() {
  const findings = await collectFindings();
  const content = buildReport(findings);
  const summary =
    `Gärtner-Befunde: ${findings.autoLinked.length} Auto-Links, ` +
    `${findings.suggestions.length} Link-Vorschläge, ` +
    `${findings.missingSummaries.length} ohne Summary, ` +
    `${findings.health.orphans.length} Waisen.`;

  const existing = db.findByLabel(REPORT_LABEL);
  let changed = false;
  if (!existing) {
    await operations.createNode({
      label: REPORT_LABEL, type: 'note', content, summary,
      tags: ['maintenance', 'brain'], force: true,
    });
    changed = true;
  } else if ((db.getNodeFull(existing.id)?.content || '') !== content) {
    await operations.updateNode(existing.id, { content, summary });
    changed = true;
  }
  return summarize(findings, changed);
}

module.exports = { collectFindings, buildReport, runMaintenance, summarize, pickAutoLinks, REPORT_LABEL, AUTO_LINK_SIM, STALE_DAYS };

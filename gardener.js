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
  // orphans/neverAccessed/missingSummaries/staleNodes sind jetzt {id,label}-Objekte.
  if (db.findByLabel(REPORT_LABEL)) health.totals.nodes -= 1;
  const notReport = (x) => (x.label || x) !== REPORT_LABEL;
  health.orphans = health.orphans.filter(notReport);
  health.neverAccessed = health.neverAccessed.filter(notReport);

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

  // Auto-Capture: offene Inbox-Kandidaten (Tag `inbox`). Sie sind transient und
  // sollen die übrigen Pflege-Sektionen nicht verrauschen → eigene Sektion +
  // Ausschluss aus Waisen/Summary-Lücken (sie sind ohnehin noch nicht reviewt).
  const inbox = db.db.prepare(
    `SELECT n.label FROM nodes n JOIN node_tags t ON t.node_id = n.id
     WHERE t.tag = 'inbox' COLLATE NOCASE
       AND (n.expires_at IS NULL OR julianday(n.expires_at) > julianday('now'))
     ORDER BY n.created DESC`
  ).all().map(r => r.label);
  const inboxSet = new Set(inbox);
  const keep = (x) => notReport(x) && !inboxSet.has(x.label || x);
  health.orphans = health.orphans.filter(keep);

  // missingSummaries/staleNodes kommen jetzt aus dem Health-Report (eine Quelle);
  // hier nur noch um Bericht + Inbox bereinigt.
  const missingSummaries = health.missingSummaries.filter(keep);
  const staleNodes = health.staleNodes.filter(keep);

  return { health, autoLinked, suggestions: remaining, missingSummaries, staleNodes, inbox };
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

  // Schärfung: Schnittmenge Waise ∩ nie-gelesen = dringlichste Kandidaten (weder verlinkt
  // noch je aufgerufen). Aus der allgemeinen Waisen-Liste herausnehmen, damit nichts doppelt steht.
  const orphanIds = new Set(f.health.orphans.map(o => o.id || o));
  const forgotten = (f.health.neverAccessed || []).filter(n => orphanIds.has(n.id));
  const forgottenIds = new Set(forgotten.map(n => n.id));
  const orphansRemaining = f.health.orphans.filter(o => !forgottenIds.has(o.id || o));

  section('📥 Inbox — Auto-Capture-Kandidaten (bitte reviewen)', f.inbox || [], l => l);
  section('⚠️ Vergessen (Waise + nie gelesen) — am ehesten archivieren oder überarbeiten', forgotten, l => l.label || l);
  section('Auto-Links neu angelegt (rel_type=auto)', f.autoLinked,
    s => `${s.source.label} ↔ ${s.target.label} (${s.similarity})`);
  section('Link-Vorschläge — bitte prüfen', f.suggestions,
    s => `${s.source.label} ↔ ${s.target.label} (${s.similarity})`);
  section('Knoten ohne Summary', f.missingSummaries, l => l.label || l);
  section('Waisen (keine Verbindungen)', orphansRemaining, l => l.label || l);
  section('Doppelte Labels', f.health.duplicateLabels,
    d => `${d.label} (${d.count}×)`);
  section('Tote Wikilinks', f.health.deadWikilinks,
    w => `\`${w.missing}\` in „${w.node}"`);
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
    forgotten: (f.health.neverAccessed || []).filter(n => new Set(f.health.orphans.map(o => o.id || o)).has(n.id)).length,
    duplicateLabels: f.health.duplicateLabels.length,
    deadWikilinks: f.health.deadWikilinks.length,
    staleNodes: f.staleNodes.length,
    inbox: (f.inbox || []).length,
  };
}

// DB-Hygiene: veraltete dismissed_suggestions löschen + SQLite optimieren.
// Wird wöchentlich (oder manuell) ausgeführt — keine Einfluss auf Knoten/Links.
function runDbHygiene() {
  try {
    const pruned = db.pruneDismissedSuggestions(90);
    if (pruned > 0) console.log(`[gardener] ${pruned} alte dismissed_suggestions gelöscht`);
    // WAL-Checkpoint: verhindert unbegrenztes Wachstum der WAL-Datei.
    db.db.pragma('wal_checkpoint(TRUNCATE)');
    // SQLite-Statistiken auffrischen (verbessert Query-Planer-Entscheidungen).
    db.db.pragma('optimize');
  } catch (err) {
    console.error('[gardener] DB-Hygiene Fehler:', err.message);
  }
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

  // DB-Hygiene einmal täglich (Wächter-Run findet stündlich statt, aber Hygiene
  // wird nur ausgeführt wenn sich die Stunde im Tages-Modulo ergibt).
  const hour = new Date().getHours();
  if (hour === 3) runDbHygiene(); // 03:xx Uhr — geringer Last-Zeitpunkt

  return summarize(findings, changed);
}

module.exports = { collectFindings, buildReport, runMaintenance, runDbHygiene, summarize, pickAutoLinks, REPORT_LABEL, AUTO_LINK_SIM, STALE_DAYS };

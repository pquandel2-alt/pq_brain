'use strict';

/**
 * Brain Test-Suite (node:test, kein externes Framework).
 * Läuft gegen eine temporäre In-Memory-DB (BRAIN_DB=:memory:).
 * Kein Embedding-Modell — Vektorfunktionen werden via Stub getestet.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// Temp-DB vor dem Laden von db.js setzen.
process.env.BRAIN_DB = ':memory:';

const db = require('../db');
const retrieval = require('../retrieval');
const { rrf, previewText, rerankText, frecencyBoost } = retrieval;
const operations = require('../operations');
const { embeddingText, resolveWikilinks } = operations;
const gardener = require('../gardener');

// ── db CRUD + Tags ────────────────────────────────────────────────────────────
describe('db: CRUD + Tags', () => {
  test('createNode erzeugt Knoten mit Tags', () => {
    const n = db.createNode({ label: 'Test A', type: 'note', content: 'Hallo', tags: ['foo', 'bar'] });
    assert.equal(n.label, 'Test A');
    assert.deepEqual(n.tags.sort(), ['bar', 'foo']);
  });

  test('findByLabel findet Knoten', () => {
    const found = db.findByLabel('Test A');
    assert.ok(found);
    assert.equal(found.label, 'Test A');
  });

  test('updateNode aktualisiert content und Tags', () => {
    const n = db.findByLabel('Test A');
    const updated = db.updateNode(n.id, { content: 'Welt', tags: ['baz'] });
    assert.equal(updated.content, 'Welt');
    assert.deepEqual(updated.tags, ['baz']);
  });

  test('getNodeFull enthält Lifecycle-Felder', () => {
    const n = db.findByLabel('Test A');
    const full = db.getNodeFull(n.id);
    assert.ok(full.version >= 1);
    assert.ok(full.created);
  });

  test('deleteNode entfernt Knoten', () => {
    const n = db.findByLabel('Test A');
    db.deleteNode(n.id);
    assert.equal(db.findByLabel('Test A'), null);
  });
});

// ── History + Revert (C2) ─────────────────────────────────────────────────────
describe('db: History + Revert (C2)', () => {
  test('History speichert summary und source', () => {
    const n = db.createNode({ label: 'Hist Node', type: 'note', content: 'v1', summary: 'Kurzfassung', source: 'https://example.com' });
    db.updateNode(n.id, { content: 'v2' });
    const hist = db.getHistory(n.id);
    assert.ok(hist.length >= 1);
    assert.equal(hist[0].summary, 'Kurzfassung');
    assert.equal(hist[0].source, 'https://example.com');
  });

  test('revertNode stellt summary wieder her', () => {
    const n = db.findByLabel('Hist Node');
    db.updateNode(n.id, { summary: 'geändert' });
    // Auf Version 1 zurück (summary = 'Kurzfassung')
    const reverted = db.revertNode(n.id, 1);
    assert.ok(reverted);
    assert.equal(reverted.summary, 'Kurzfassung');
  });

  test('revertNode kann gelöschten Knoten wiederherstellen (undelete)', () => {
    const n = db.createNode({ label: 'Wird gelöscht', content: 'inhalt', tags: ['x'] });
    db.deleteNode(n.id);
    assert.equal(db.findByLabel('Wird gelöscht'), null);
    const restored = db.revertNode(n.id, 1);
    assert.ok(restored);
    assert.equal(restored.label, 'Wird gelöscht');
  });
});

// ── deleteExpired + vec-Cleanup (C3) ─────────────────────────────────────────
describe('db: TTL-Expiry + vec-Cleanup (C3)', () => {
  test('deleteExpired löscht abgelaufene Knoten', () => {
    // TTL = 1 Sekunde in der Vergangenheit: expires_at direkt in der DB setzen.
    const n = db.createNode({ label: 'Ephemeral', content: 'weg', ttl: 1 });
    // Expires_at auf die Vergangenheit setzen.
    db.db.prepare("UPDATE nodes SET expires_at = datetime('now', '-1 second') WHERE id = ?").run(n.id);
    const deleted = db.deleteExpired();
    assert.ok(deleted >= 1);
    assert.equal(db.findByLabel('Ephemeral'), null);
  });

  test('deleteExpired lässt nicht-abgelaufene Knoten in Ruhe', () => {
    const n = db.createNode({ label: 'Nicht ephemeral', content: 'bleibt' });
    db.deleteExpired();
    assert.ok(db.findByLabel('Nicht ephemeral'));
    db.deleteNode(db.findByLabel('Nicht ephemeral').id);
  });
});

// ── FTS-Suche + Tags (A3) ────────────────────────────────────────────────────
describe('db: FTS-Suche inkl. Tags (A3)', () => {
  test('searchKeywordRanked findet Knoten per Label', () => {
    db.createNode({ label: 'Sonnenblume', content: 'Eine Pflanze', tags: [] });
    const results = db.searchKeywordRanked('Sonnenblume', 5);
    assert.ok(results.some(r => r.node_id && true)); // ID vorhanden
    db.deleteNode(db.findByLabel('Sonnenblume').id);
  });

  test('searchKeywordRanked findet Knoten per Tag (A3)', () => {
    db.createNode({ label: 'Mein Widget', content: 'Details hier', tags: ['homeassistant'] });
    const results = db.searchKeywordRanked('homeassistant', 5);
    assert.ok(results.length >= 1);
    db.deleteNode(db.findByLabel('Mein Widget').id);
  });
});

// ── retrieval pure functions ──────────────────────────────────────────────────
describe('retrieval: pure functions', () => {
  test('rrf fusioniert Listen korrekt', () => {
    const result = rrf([['a', 'b', 'c'], ['b', 'a', 'd']]);
    const ids = result.map(([id]) => id);
    // b und a sollten oben liegen (in beiden Listen)
    assert.ok(ids.indexOf('b') < ids.indexOf('c'));
    assert.ok(ids.indexOf('a') < ids.indexOf('d'));
  });

  test('previewText nutzt summary wenn vorhanden', () => {
    const row = { summary: 'Kurz', content: 'Lang' };
    assert.equal(previewText(row), 'Kurz');
  });

  test('previewText nutzt erste Inhaltszeile ohne summary', () => {
    const row = { content: 'Erste Zeile\nZweite Zeile' };
    assert.equal(previewText(row), 'Erste Zeile');
  });

  test('frecencyBoost gibt >=1 zurück (A2)', () => {
    const boost = frecencyBoost(5, new Date().toISOString());
    assert.ok(boost >= 1);
  });

  test('frecencyBoost mit 0 Zugriffen = 1', () => {
    const boost = frecencyBoost(0, null);
    assert.equal(boost, 1);
  });
});

// ── embeddingText (A1) ────────────────────────────────────────────────────────
describe('operations: embeddingText (A1)', () => {
  test('enthält Label, Summary und Content', () => {
    const text = embeddingText({ label: 'Titel', summary: 'Zusammenfassung', content: 'Inhalt' });
    assert.ok(text.includes('Titel'));
    assert.ok(text.includes('Zusammenfassung'));
    assert.ok(text.includes('Inhalt'));
  });

  test('ohne summary kein Leerzeilen-Gap', () => {
    const text = embeddingText({ label: 'T', summary: '', content: 'C' });
    assert.ok(!text.includes('\n\n'));
  });
});

// ── resolveWikilinks (B1) ────────────────────────────────────────────────────
describe('operations: resolveWikilinks (B1)', () => {
  test('legt Link bei [[Match]] an', () => {
    const src = db.createNode({ label: 'Quelle', content: '[[Ziel]]' });
    const tgt = db.createNode({ label: 'Ziel', content: '' });
    resolveWikilinks(src.id, src.content);
    const linkExists = db.db.prepare(
      'SELECT 1 FROM links WHERE (source=? AND target=?) OR (source=? AND target=?)'
    ).get(src.id, tgt.id, tgt.id, src.id);
    assert.ok(linkExists);
    db.deleteNode(src.id);
    db.deleteNode(tgt.id);
  });

  test('kein Self-Link', () => {
    const n = db.createNode({ label: 'Selbst', content: '[[Selbst]]' });
    resolveWikilinks(n.id, n.content);
    const selfLink = db.db.prepare('SELECT 1 FROM links WHERE source=? AND target=?').get(n.id, n.id);
    assert.equal(selfLink, undefined);
    db.deleteNode(n.id);
  });

  test('fehlende [[Labels]] werden ignoriert', () => {
    const n = db.createNode({ label: 'Lonely', content: '[[GibtsNicht]]' });
    assert.doesNotThrow(() => resolveWikilinks(n.id, n.content));
    db.deleteNode(n.id);
  });

  test('[[…]] in Inline-Code erzeugt keinen Link', () => {
    const tgt = db.createNode({ label: 'EchtesZiel', content: '' });
    const src = db.createNode({ label: 'CodeQuelle', content: 'Nutze `[[EchtesZiel]]` im Code' });
    resolveWikilinks(src.id, src.content);
    const link = db.db.prepare(
      'SELECT 1 FROM links WHERE (source=? AND target=?) OR (source=? AND target=?)'
    ).get(src.id, tgt.id, tgt.id, src.id);
    assert.equal(link, undefined);
    db.deleteNode(src.id);
    db.deleteNode(tgt.id);
  });
});

// ── stripCode + Health-Report-Fehlalarm ──────────────────────────────────────
describe('db: stripCode', () => {
  test('entfernt Codeblöcke und Inline-Code, Rest bleibt', () => {
    const s = db.stripCode('a ```\n[[X]]\n``` b `[[Y]]` c [[Z]]');
    assert.ok(!s.includes('[[X]]'));
    assert.ok(!s.includes('[[Y]]'));
    assert.ok(s.includes('[[Z]]'));
  });

  test('null/undefined → leerer String', () => {
    assert.equal(db.stripCode(null), '');
  });

  test('Health-Report meldet [[…]] in Code nicht als toten Wikilink', () => {
    const n = db.createNode({ label: 'Doku', content: 'Beispiel: `[[Wikilinks]]` und ```\n[[NichtDa]]\n```' });
    const report = db.getHealthReport();
    assert.ok(!report.deadWikilinks.some(w => w.node === 'Doku'));
    db.deleteNode(n.id);
  });
});

// ── Gärtner ──────────────────────────────────────────────────────────────────
describe('gardener: pickAutoLinks (pure)', () => {
  const sugg = [
    { source: { label: 'A' }, target: { label: 'B' }, similarity: 0.95 },
    { source: { label: 'C' }, target: { label: 'D' }, similarity: 0.85 },
  ];

  test('nur Paare >= Schwelle', () => {
    const picked = gardener.pickAutoLinks(sugg, 0.9);
    assert.equal(picked.length, 1);
    assert.equal(picked[0].similarity, 0.95);
  });

  test('Schwelle 0 = Feature aus', () => {
    assert.equal(gardener.pickAutoLinks(sugg, 0).length, 0);
  });
});

describe('gardener: buildReport (pure)', () => {
  const empty = {
    health: { totals: { nodes: 5, links: 3 }, orphans: [], duplicateLabels: [], deadWikilinks: [], neverAccessed: [], expiringSoon: [] },
    autoLinked: [], suggestions: [], missingSummaries: [], staleNodes: [],
  };

  test('leere Befunde → keine Auffälligkeiten', () => {
    const md = gardener.buildReport(empty);
    assert.ok(md.includes('Keine Auffälligkeiten'));
    assert.ok(md.includes('5 Knoten'));
  });

  test('Befunde erscheinen als Sektionen', () => {
    const f = {
      ...empty,
      health: { ...empty.health, orphans: ['Waise'] },
      autoLinked: [{ source: { label: 'A' }, target: { label: 'B' }, similarity: 0.93 }],
      missingSummaries: ['OhneSummary'],
      staleNodes: [{ label: 'Alt', last: '2026-01-01' }],
    };
    const md = gardener.buildReport(f);
    assert.ok(md.includes('A ↔ B (0.93)'));
    assert.ok(md.includes('OhneSummary'));
    assert.ok(md.includes('Waise'));
    assert.ok(md.includes('Alt (zuletzt 2026-01-01)'));
    assert.ok(!md.includes('Keine Auffälligkeiten'));
  });

  test('deterministisch (kein Zeitstempel im Content)', () => {
    assert.equal(gardener.buildReport(empty), gardener.buildReport(empty));
  });
});

describe('gardener: runMaintenance Upsert', () => {
  test('legt Wartungsbericht an; zweiter Lauf ohne Änderung schreibt nicht', async () => {
    const r1 = await gardener.runMaintenance();
    assert.equal(r1.changed, true);
    const node = db.findByLabel(gardener.REPORT_LABEL);
    assert.ok(node);
    const v1 = db.getNodeFull(node.id).version;

    const r2 = await gardener.runMaintenance();
    assert.equal(r2.changed, false);
    assert.equal(db.getNodeFull(node.id).version, v1);
  });
});

// ── C3: Usage-Feedback (markUsed + frecencyBoost) ──────────────────────────────
describe('db: markUsed + getAccessStats (C3)', () => {
  test('markUsed erhöht used_count und setzt used_at', () => {
    const n = db.createNode({ label: 'Used Node', content: 'x' });
    assert.equal(db.markUsed([n.id]), 1);
    const full = db.getNodeFull(n.id);
    assert.equal(full.used_count, 1);
    assert.ok(full.used_at);
    db.markUsed([n.id]);
    assert.equal(db.getNodeFull(n.id).used_count, 2);
    const stats = db.getAccessStats([n.id]).get(n.id);
    assert.equal(stats.used_count, 2);
    db.deleteNode(n.id);
  });

  test('markUsed mit leerer Liste = 0', () => {
    assert.equal(db.markUsed([]), 0);
  });

  test('frecencyBoost: usedCount erhöht Boost, bleibt unter Cap', () => {
    const base = frecencyBoost(0, null, 0);
    const withUsed = frecencyBoost(0, null, 10);
    assert.equal(base, 1);
    assert.ok(withUsed > base);
    assert.ok(frecencyBoost(1000, new Date().toISOString(), 1000) <= 1.1);
  });
});

// ── C0/B1: dismissed_suggestions ───────────────────────────────────────────────
describe('db: dismissSuggestion (B1)', () => {
  test('verworfenes Paar landet sortiert im Set', () => {
    db.dismissSuggestion('zzz', 'aaa');
    const set = db.getDismissedPairs();
    assert.ok(set.has('aaa|zzz'));
  });
});

// ── C1: getNeighborLinks + retrieval.neighbors ─────────────────────────────────
describe('db: getNeighborLinks Richtungen (C1)', () => {
  test('in/out/both filtern korrekt', () => {
    const a = db.createNode({ label: 'NL-A', content: '' });
    const b = db.createNode({ label: 'NL-B', content: '' });
    db.createLink(a.id, b.id, '', 'depends-on');

    const out = db.getNeighborLinks([a.id], 'out');
    assert.equal(out.length, 1);
    assert.equal(out[0].rel_type, 'depends-on');
    assert.equal(db.getNeighborLinks([a.id], 'in').length, 0);
    assert.equal(db.getNeighborLinks([b.id], 'in').length, 1);
    assert.equal(db.getNeighborLinks([a.id], 'both').length, 1);

    db.deleteNode(a.id); db.deleteNode(b.id);
  });

  test('neighbors() liefert root + nodes + links', () => {
    const a = db.createNode({ label: 'N-Root', content: '' });
    const b = db.createNode({ label: 'N-Child', content: '' });
    db.createLink(a.id, b.id, '');
    const sub = retrieval.neighbors({ id: a.id, depth: 1 });
    assert.equal(sub.root.label, 'N-Root');
    assert.equal(sub.count, 2);
    assert.equal(sub.links.length, 1);
    assert.equal(retrieval.neighbors({ id: 'nope' }), null);
    db.deleteNode(a.id); db.deleteNode(b.id);
  });
});

// ── C4: bulkCreate ─────────────────────────────────────────────────────────────
describe('operations: bulkCreate Teilerfolg (C4)', () => {
  test('legt Knoten + Links per Label an, meldet Duplikat', async () => {
    db.createNode({ label: 'Bulk-Existing', content: 'da' });
    const out = await operations.bulkCreate({
      nodes: [
        { label: 'Bulk-New-1', content: 'eins' },
        { label: 'Bulk-Existing', content: 'dup' }, // label_exists
      ],
      links: [{ source: 'Bulk-New-1', target: 'Bulk-Existing' }],
    });
    assert.equal(out.created, 1);
    assert.equal(out.failed, 1);
    assert.ok(out.results.find(r => r.label === 'Bulk-Existing' && r.ok === false));
    assert.equal(out.linksCreated, 1);
    assert.ok(db.findByLabel('Bulk-New-1'));

    db.deleteNode(db.findByLabel('Bulk-New-1').id);
    db.deleteNode(db.findByLabel('Bulk-Existing').id);
  });

  test('unauflösbarer Link wird gemeldet, nicht erstellt', async () => {
    const out = await operations.bulkCreate({ links: [{ source: 'Ghost-A', target: 'Ghost-B' }] });
    assert.equal(out.linksCreated, 0);
    assert.equal(out.linkResults[0].error, 'source_unresolved');
  });
});

// ── C1: updateLink ─────────────────────────────────────────────────────────────
describe('db: updateLink (B3)', () => {
  test('ändert label/rel_type, beide Orientierungen', () => {
    const a = db.createNode({ label: 'UL-A', content: '' });
    const b = db.createNode({ label: 'UL-B', content: '' });
    db.createLink(a.id, b.id, 'alt');
    // Update über vertauschte Reihenfolge ansprechen.
    const r = db.updateLink(b.id, a.id, { label: 'neu', relType: 'supersedes' });
    assert.equal(r.link.label, 'neu');
    assert.equal(r.link.rel_type, 'supersedes');
    assert.equal(db.updateLink('x', 'y', { label: 'z' }).error, 'not_found');
    db.deleteNode(a.id); db.deleteNode(b.id);
  });
});

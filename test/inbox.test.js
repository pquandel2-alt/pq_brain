'use strict';

/**
 * Auto-Capture / Inbox-Tests (node:test, In-Memory-DB).
 * Testet die Intake-/Accept-Logik über operations + db (ohne Express-Layer)
 * sowie die Gärtner- und Briefing-Sichtbarkeit. Kein Embedding-Modell nötig.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

process.env.BRAIN_DB = ':memory:';

const db = require('../db');
const operations = require('../operations');
const retrieval = require('../retrieval');
const gardener = require('../gardener');

const INBOX_TTL = 14 * 24 * 60 * 60;

// Repliziert das Intake-Mapping aus server.js (Tag erzwingen, TTL, source).
async function intake(sessionId, specs) {
  const nodes = specs.map(n => ({
    label: n.label,
    type: n.type || 'note',
    content: n.content || '',
    summary: n.summary ?? null,
    tags: [...new Set([...(n.tags || []), 'inbox'])],
    source: `session:${sessionId}`,
    ttl: INBOX_TTL,
    force: false,
  }));
  return operations.bulkCreate({ nodes });
}

describe('inbox: intake', () => {
  test('Kandidat bekommt inbox-Tag, TTL und session-source', async () => {
    const out = await intake('sess-1', [
      { label: 'Nutzer mag Tabs', content: 'Tabs statt Spaces', summary: 'Tab-Präferenz' },
    ]);
    assert.equal(out.created, 1);
    const node = db.findByLabel('Nutzer mag Tabs');
    assert.ok(node);
    const full = db.getNodeFull(node.id);
    assert.ok(full.tags.includes('inbox'));
    assert.equal(full.source, 'session:sess-1');
    assert.ok(full.expires_at, 'expires_at gesetzt (TTL)');
    assert.ok(full.ttl > 0);
  });

  test('getByTags(inbox) listet offene Kandidaten', () => {
    const sub = db.getByTags(['inbox']);
    assert.ok(sub.nodes.some(n => n.label === 'Nutzer mag Tabs'));
  });

  test('belegtes Label wird abgelehnt (kein Doppel)', async () => {
    const out = await intake('sess-2', [
      { label: 'Nutzer mag Tabs', content: 'nochmal' },
    ]);
    assert.equal(out.created, 0);
    assert.equal(out.failed, 1);
    assert.equal(out.results[0].error, 'label_exists');
  });
});

describe('inbox: accept', () => {
  test('Accept entfernt inbox-Tag und TTL', async () => {
    const node = db.findByLabel('Nutzer mag Tabs');
    const full = db.getNodeFull(node.id);
    const tags = full.tags.filter(t => t !== 'inbox');
    const r = await operations.updateNode(node.id, { tags, ttl: null });
    assert.ok(!r.error);
    const after = db.getNodeFull(node.id);
    assert.ok(!after.tags.includes('inbox'), 'inbox-Tag entfernt');
    assert.ok(!after.expires_at, 'TTL gelöscht (null-Feld entfällt)');
    assert.equal(db.getByTags(['inbox']).nodes.length, 0);
  });
});

describe('inbox: Sichtbarkeit', () => {
  test('Gärtner-Befunde enthalten Inbox-Sektion', async () => {
    await intake('sess-3', [{ label: 'Offener Kandidat', content: 'wartet auf Review' }]);
    const findings = await gardener.collectFindings();
    assert.ok(Array.isArray(findings.inbox));
    assert.ok(findings.inbox.includes('Offener Kandidat'));
    // Inbox-Kandidaten erscheinen nicht zusätzlich als Waisen.
    assert.ok(!findings.health.orphans.includes('Offener Kandidat'));
    const report = gardener.buildReport(findings);
    assert.match(report, /Inbox/);
  });

  test('Briefing zählt offene Inbox-Kandidaten', () => {
    const b = retrieval.buildBriefing({});
    assert.ok(b.inboxCount >= 1);
    const md = retrieval.briefingMarkdown(b);
    assert.match(md, /Inbox-Kandidat/);
  });
});

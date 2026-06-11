'use strict';

/**
 * Tests für das Eval-Harness: Metriken (pure) + Gold-Set-Schema.
 * Kein DB-/Embedding-Zugriff nötig.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { successAtK, recallAtK, mrr, perQuery, aggregate } = require('../eval/metrics');

// ── Metriken ─────────────────────────────────────────────────────────────────
describe('eval: successAtK', () => {
  const exp = new Set(['b', 'd']);

  test('Treffer auf Rang 1', () => {
    assert.equal(successAtK(['b', 'a', 'c'], exp, 1), 1);
  });

  test('Treffer erst auf Rang 2 → S@1=0, S@3=1', () => {
    assert.equal(successAtK(['a', 'b', 'c'], exp, 1), 0);
    assert.equal(successAtK(['a', 'b', 'c'], exp, 3), 1);
  });

  test('kein Treffer', () => {
    assert.equal(successAtK(['x', 'y', 'z'], exp, 5), 0);
  });

  test('leeres Ranking', () => {
    assert.equal(successAtK([], exp, 5), 0);
  });
});

describe('eval: recallAtK', () => {
  test('beide erwarteten in Top-5 → 1.0', () => {
    assert.equal(recallAtK(['b', 'x', 'd'], new Set(['b', 'd']), 5), 1);
  });

  test('einer von zwei in Top-5 → 0.5', () => {
    assert.equal(recallAtK(['b', 'x', 'y', 'z', 'w', 'd'], new Set(['b', 'd']), 5), 0.5);
  });

  test('erwarteter Knoten jenseits von k zählt nicht', () => {
    assert.equal(recallAtK(['x', 'y', 'b'], new Set(['b']), 2), 0);
  });

  test('leere Erwartung → 0 (kein Division-durch-0)', () => {
    assert.equal(recallAtK(['a'], new Set(), 5), 0);
  });
});

describe('eval: mrr', () => {
  test('Rang 1 → 1.0', () => {
    assert.equal(mrr(['b', 'a'], new Set(['b'])), 1);
  });

  test('Rang 3 → 1/3', () => {
    assert.equal(mrr(['x', 'y', 'b'], new Set(['b'])), 1 / 3);
  });

  test('erster erwarteter zählt (nicht der beste)', () => {
    // 'd' kommt vor 'b' → Rang 2
    assert.equal(mrr(['x', 'd', 'b'], new Set(['b', 'd'])), 1 / 2);
  });

  test('jenseits maxRank → 0', () => {
    const ranking = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'b'];
    assert.equal(mrr(ranking, new Set(['b']), 10), 0);
  });
});

describe('eval: perQuery + aggregate', () => {
  test('perQuery liefert alle fünf Kennzahlen', () => {
    const m = perQuery(['a', 'b'], new Set(['b']));
    assert.deepEqual(Object.keys(m).sort(), ['mrr', 'r5', 's1', 's3', 's5']);
    assert.equal(m.s1, 0);
    assert.equal(m.s3, 1);
    assert.equal(m.mrr, 0.5);
  });

  test('aggregate mittelt pro Kennzahl', () => {
    const agg = aggregate([
      { s1: 1, mrr: 1 },
      { s1: 0, mrr: 0.5 },
    ]);
    assert.equal(agg.s1, 0.5);
    assert.equal(agg.mrr, 0.75);
  });

  test('aggregate mit leerer Liste → leeres Objekt', () => {
    assert.deepEqual(aggregate([]), {});
  });
});

// ── Gold-Set-Schema (nur wenn die Datei existiert) ───────────────────────────
describe('eval: gold.json Schema', () => {
  const goldPath = path.join(__dirname, '..', 'eval', 'gold.json');

  test('jede Query hat query-Text und expected-Labels', (t) => {
    if (!fs.existsSync(goldPath)) return t.skip('eval/gold.json existiert noch nicht');
    const gold = JSON.parse(fs.readFileSync(goldPath, 'utf8'));
    assert.ok(Array.isArray(gold.queries) && gold.queries.length > 0);
    const ids = new Set();
    for (const q of gold.queries) {
      assert.ok(q.id && !ids.has(q.id), `doppelte/fehlende id: ${q.id}`);
      ids.add(q.id);
      assert.ok(typeof q.query === 'string' && q.query.trim().length > 0, `${q.id}: query fehlt`);
      assert.ok(Array.isArray(q.expected) && q.expected.length > 0, `${q.id}: expected fehlt`);
      for (const e of q.expected) {
        assert.ok((e.label && e.label.trim()) || e.nodeId, `${q.id}: expected ohne label/nodeId`);
      }
    }
  });
});

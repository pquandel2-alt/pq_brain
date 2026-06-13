'use strict';

/**
 * Phase 4: Kaltstart-Entkopplung. Ist das Embedding-Modell noch nicht warm,
 * legt createNode den Knoten sofort an (ohne Vektor/Dedup) und meldet dedupSkipped.
 * Der Knoten taucht dann in nodesNeedingEmbedding auf (Drain-Loop holt ihn nach).
 *
 * Im Test ist das Modell nie geladen → isWarm() === false, der Kaltstart-Pfad
 * ist also aktiv (sofern sqlite-vec verfügbar ist).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

process.env.BRAIN_DB = ':memory:';

const db = require('../db');
const operations = require('../operations');
const { isWarm } = require('../embeddings');

describe('embedding drain: Kaltstart', { skip: !db.vecEnabled }, () => {
  test('isWarm ist im Test false', () => {
    assert.equal(isWarm(), false);
  });

  test('createNode im Kaltstart: dedupSkipped + kein Vektor + drain-fähig', async () => {
    const r = await operations.createNode({ label: 'Kalt angelegt', content: 'ohne Modell' });
    assert.ok(r.node, 'Knoten wurde angelegt');
    assert.equal(r.dedupSkipped, true, 'Dedup übersprungen (Modell kalt)');
    // Ohne Vektor → erscheint in der Drain-Liste.
    const pending = db.nodesNeedingEmbedding().map(n => n.id);
    assert.ok(pending.includes(r.node.id), 'Knoten wartet auf Embedding');
  });
});

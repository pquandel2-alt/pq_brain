'use strict';

/**
 * Metrik-Registry-Tests (node:test). Reine In-Process-Logik, keine DB nötig.
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const metrics = require('../metrics');

describe('metrics: Registry', () => {
  beforeEach(() => metrics.reset());

  test('counter zählt hoch', () => {
    metrics.counter('foo');
    metrics.counter('foo', 2);
    const snap = metrics.snapshot();
    assert.equal(snap.counters.foo, 3);
  });

  test('observe füllt Histogramm + Buckets', () => {
    metrics.observe('lat', 7);    // Bucket <=10
    metrics.observe('lat', 7);
    metrics.observe('lat', 300);  // Bucket <=500
    metrics.observe('lat', 99999); // Overflow-Bucket (leMs null)
    const h = metrics.snapshot().histograms.lat;
    assert.equal(h.count, 4);
    assert.equal(h.minMs, 7);
    assert.equal(h.maxMs, 99999);
    assert.equal(h.avgMs, +((7 + 7 + 300 + 99999) / 4).toFixed(1));
    const le10 = h.buckets.find(b => b.leMs === 10);
    assert.equal(le10.count, 2);
    const overflow = h.buckets.find(b => b.leMs === null);
    assert.equal(overflow.count, 1);
  });

  test('observe ignoriert ungültige Werte', () => {
    metrics.observe('x', -5);
    metrics.observe('x', NaN);
    assert.equal(metrics.snapshot().histograms.x, undefined);
  });

  test('timed misst und zählt calls', async () => {
    const r = await metrics.timed('op', async () => 42);
    assert.equal(r, 42);
    const snap = metrics.snapshot();
    assert.equal(snap.counters['op.calls'], 1);
    assert.equal(snap.histograms.op.count, 1);
  });

  test('timed zählt errors und wirft weiter', async () => {
    await assert.rejects(metrics.timed('boom', async () => { throw new Error('x'); }));
    assert.equal(metrics.snapshot().counters['boom.errors'], 1);
  });
});

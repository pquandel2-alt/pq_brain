'use strict';

/**
 * Leichtgewichtige In-Process-Metriken — keine externen Abhängigkeiten.
 *
 * Zwei Primitive:
 *   counter(name)      — zählt Ereignisse (z.B. recall.calls)
 *   observe(name, ms)  — Latenz-Histogramm mit festen Buckets + count/sum/min/max
 *
 * snapshot() liefert eine JSON-serialisierbare Momentaufnahme für /api/metrics.
 * Bewusst prozesslokal (kein Persistenz-Overhead): bei Neustart zurückgesetzt —
 * für Live-Beobachtung von Latenzen/Durchsatz völlig ausreichend.
 */

// Latenz-Buckets in ms (obere Grenzen). +Inf wird implizit als „über 5000" geführt.
const BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

const counters = new Map();      // name → int
const histograms = new Map();    // name → { count, sum, min, max, buckets:int[] }

function counter(name, delta = 1) {
  counters.set(name, (counters.get(name) || 0) + delta);
}

function newHist() {
  return { count: 0, sum: 0, min: Infinity, max: 0, buckets: new Array(BUCKETS.length + 1).fill(0) };
}

function observe(name, ms) {
  if (!Number.isFinite(ms) || ms < 0) return;
  let h = histograms.get(name);
  if (!h) { h = newHist(); histograms.set(name, h); }
  h.count++;
  h.sum += ms;
  if (ms < h.min) h.min = ms;
  if (ms > h.max) h.max = ms;
  let idx = BUCKETS.findIndex(b => ms <= b);
  if (idx === -1) idx = BUCKETS.length; // Overflow-Bucket
  h.buckets[idx]++;
}

// Misst die Dauer einer (async) Funktion und schreibt sie unter `name`.
// Zählt zusätzlich `${name}.calls` und bei Fehler `${name}.errors`.
async function timed(name, fn) {
  const t0 = Date.now();
  counter(`${name}.calls`);
  try {
    return await fn();
  } catch (e) {
    counter(`${name}.errors`);
    throw e;
  } finally {
    observe(name, Date.now() - t0);
  }
}

function snapshot() {
  const hist = {};
  for (const [name, h] of histograms) {
    hist[name] = {
      count: h.count,
      avgMs: h.count ? +(h.sum / h.count).toFixed(1) : 0,
      minMs: h.count ? h.min : 0,
      maxMs: h.max,
      buckets: BUCKETS.map((b, i) => ({ leMs: b, count: h.buckets[i] }))
        .concat([{ leMs: null, count: h.buckets[BUCKETS.length] }]),
    };
  }
  return { counters: Object.fromEntries(counters), histograms: hist };
}

// Nur für Tests — Registry leeren.
function reset() {
  counters.clear();
  histograms.clear();
}

module.exports = { counter, observe, timed, snapshot, reset, BUCKETS };

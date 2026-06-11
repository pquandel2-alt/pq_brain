'use strict';

/**
 * Pure Metrik-Funktionen für das Eval-Harness (run-eval.js).
 * Alle Funktionen arbeiten auf (rankedIds: string[], expected: Set<string>)
 * und haben keinerlei Abhängigkeiten — direkt unit-testbar.
 */

/** Success@k: 1 wenn mindestens ein erwarteter Knoten in den Top-k liegt, sonst 0. */
function successAtK(rankedIds, expected, k) {
  return rankedIds.slice(0, k).some(id => expected.has(id)) ? 1 : 0;
}

/** Recall@k: Anteil der erwarteten Knoten, die in den Top-k auftauchen. */
function recallAtK(rankedIds, expected, k) {
  if (expected.size === 0) return 0;
  const top = new Set(rankedIds.slice(0, k));
  let hit = 0;
  for (const id of expected) if (top.has(id)) hit++;
  return hit / expected.size;
}

/** MRR: 1/Rang des ersten erwarteten Knotens innerhalb der Top-maxRank, sonst 0. */
function mrr(rankedIds, expected, maxRank = 10) {
  const idx = rankedIds.slice(0, maxRank).findIndex(id => expected.has(id));
  return idx === -1 ? 0 : 1 / (idx + 1);
}

/** Alle Metriken für eine einzelne Query. */
function perQuery(rankedIds, expected) {
  return {
    s1: successAtK(rankedIds, expected, 1),
    s3: successAtK(rankedIds, expected, 3),
    s5: successAtK(rankedIds, expected, 5),
    r5: recallAtK(rankedIds, expected, 5),
    mrr: mrr(rankedIds, expected, 10),
  };
}

/** Mittelwert pro Kennzahl über alle Query-Ergebnisse. */
function aggregate(perQueryList) {
  if (perQueryList.length === 0) return {};
  const keys = Object.keys(perQueryList[0]);
  const out = {};
  for (const key of keys) {
    const sum = perQueryList.reduce((acc, m) => acc + (m[key] || 0), 0);
    out[key] = +(sum / perQueryList.length).toFixed(4);
  }
  return out;
}

module.exports = { successAtK, recallAtK, mrr, perQuery, aggregate };

'use strict';

/**
 * Bootstrap-Helfer fürs Gold-Set: druckt pro Knoten ein Skelett für eval/gold.json
 * (rein lesend, keine Schreibzugriffe).
 *
 * Kuration: ~15–30 Einträge übernehmen und die TODO-Queries durch echte Fragen
 * ersetzen — auf Deutsch, so formuliert wie man wirklich fragen würde, und bewusst
 * OHNE das Label wörtlich zu zitieren (sonst gewinnt die Keyword-Suche trivial).
 *
 * Aufruf: npm run eval:suggest
 */

const db = require('../db');

const { nodes } = db.getBrain();
const skip = new Set(['Wartungsbericht']); // Pflege-Knoten sind keine sinnvollen Gold-Ziele

const entries = nodes
  .filter(n => !skip.has(n.label))
  .sort((a, b) => a.label.localeCompare(b.label, 'de'))
  .map((n, i) => {
    const full = db.getNodeFull(n.id);
    const hint = full?.summary || (full?.content || '').split('\n').find(l => l.trim()) || '';
    return {
      comment: hint.slice(0, 120),
      entry: {
        id: 'q' + String(i + 1).padStart(3, '0'),
        query: `<TODO — Frage zu: ${n.label}>`,
        expected: [{ label: n.label }],
      },
    };
  });

console.log('// Vorschläge für eval/gold.json — kuratieren, TODO-Queries durch echte Fragen ersetzen.');
console.log('// Hinweis-Kommentare (Summary) beim Übernehmen entfernen, JSON erlaubt keine Kommentare.');
console.log('{');
console.log('  "version": 1,');
console.log('  "queries": [');
entries.forEach(({ comment, entry }, i) => {
  if (comment) console.log(`    // ${comment}`);
  console.log('    ' + JSON.stringify(entry) + (i < entries.length - 1 ? ',' : ''));
});
console.log('  ]');
console.log('}');

'use strict';

/**
 * Contract-Test gegen Schema-Drift: vergleicht die TATSÄCHLICH in Express
 * registrierten Routen mit den in openapi.js dokumentierten Pfaden — in BEIDE
 * Richtungen. Schlägt fehl (Exit 1), wenn eine Route undokumentiert ist oder die
 * Spec einen Pfad listet, den es nicht gibt.
 *
 * Lauf: `node verify-openapi.js` (ohne den Server zu starten).
 *
 * Bewusst statische Routen geprüft; ausgenommen sind reine Infrastruktur-Pfade
 * (statische Dateien, /openapi.*), die nicht Teil des API-Vertrags sind.
 */

process.env.BRAIN_SKIP_LISTEN = '1'; // falls server.js das später respektiert
const path = require('path');

// Express-App OHNE listen laden: wir requiren server nicht (es startet listen),
// sondern bauen die Routenliste aus der Quelle. Einfacher: server.js exportiert
// keine app — daher parsen wir die registrierten Routen über einen Proxy-Trick:
// wir laden express, monkeypatchen Router, und requiren server in einem Child-freien
// Modus ist zu komplex. Stattdessen: leichte statische Extraktion via Regex aus
// server.js-Quelltext (robust genug für app.METHOD('/path', ...)).

const fs = require('fs');
const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

const ROUTE_RE = /app\.(get|post|put|delete)\(\s*(\[[^\]]*\]|'[^']*'|"[^"]*")/g;
const found = new Set();
let m;
while ((m = ROUTE_RE.exec(src))) {
  const method = m[1].toUpperCase();
  let raw = m[2];
  const paths = [];
  if (raw.startsWith('[')) {
    for (const mm of raw.matchAll(/['"]([^'"]+)['"]/g)) paths.push(mm[1]);
  } else {
    paths.push(raw.slice(1, -1));
  }
  for (const p of paths) found.add(method + ' ' + p);
}

// Express-Pfade (:id) → OpenAPI-Pfade ({id}) normalisieren.
const toOpenapi = (p) => p.replace(/:([A-Za-z0-9_]+)/g, '{$1}');

// Nicht Teil des API-Vertrags (Infrastruktur):
// - /openapi.* beschreiben die Spec selbst
// - GET/DELETE /mcp sind reine 405-Handler (stateless); nur POST /mcp ist der echte Endpunkt
const IGNORE = new Set([
  'GET /openapi.json', 'GET /openapi.yaml', 'GET /openapi.yml',
  'GET /mcp', 'DELETE /mcp',
]);

const expressRoutes = new Set(
  [...found]
    .filter(r => !IGNORE.has(r))
    .map(r => { const [method, p] = r.split(' '); return method + ' ' + toOpenapi(p); })
);

const spec = require('./openapi');
const specRoutes = new Set();
for (const [p, item] of Object.entries(spec.paths)) {
  for (const method of ['get', 'post', 'put', 'delete']) {
    if (item[method]) specRoutes.add(method.toUpperCase() + ' ' + p);
  }
}

const undocumented = [...expressRoutes].filter(r => !specRoutes.has(r)).sort();
const phantom = [...specRoutes].filter(r => !expressRoutes.has(r)).sort();

let ok = true;
if (undocumented.length) {
  ok = false;
  console.error('❌ Routen ohne OpenAPI-Eintrag:');
  undocumented.forEach(r => console.error('   ' + r));
}
if (phantom.length) {
  ok = false;
  console.error('❌ OpenAPI-Pfade ohne echte Route:');
  phantom.forEach(r => console.error('   ' + r));
}

if (ok) {
  console.log(`✅ OpenAPI ↔ Express deckungsgleich (${expressRoutes.size} Routen).`);
  process.exit(0);
} else {
  console.error(`\nSchema-Drift erkannt. Express: ${expressRoutes.size}, Spec: ${specRoutes.size}.`);
  process.exit(1);
}

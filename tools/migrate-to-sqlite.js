'use strict';

/**
 * Einmalige Migration: data/brain.json → SQLite (data/brain.db).
 * Idempotent: bricht ab, wenn die DB schon Knoten enthält (außer --force).
 * brain.json bleibt unangetastet (Rollback-Quelle).
 *
 *   node migrate-to-sqlite.js          # migrieren, falls DB leer
 *   node migrate-to-sqlite.js --force  # DB überschreiben
 */

const fs = require('fs');
const path = require('path');
const dbApi = require('./db');

const JSON_FILE = path.join(__dirname, 'data', 'brain.json');
const force = process.argv.includes('--force');

function main() {
  if (!fs.existsSync(JSON_FILE)) {
    console.error('Keine brain.json gefunden:', JSON_FILE);
    process.exit(1);
  }

  const existing = dbApi.countNodes();
  if (existing > 0 && !force) {
    console.log(`DB enthält bereits ${existing} Knoten. Abbruch (mit --force überschreiben).`);
    process.exit(0);
  }

  const graph = JSON.parse(fs.readFileSync(JSON_FILE, 'utf8'));
  const nNodes = (graph.nodes || []).length;
  const nLinks = (graph.links || []).length;

  dbApi.replaceAll(graph);

  const after = dbApi.getBrain();
  console.log(`Migriert: ${after.nodes.length}/${nNodes} Knoten, ${after.links.length}/${nLinks} Links → ${path.join('data', 'brain.db')}`);

  // Konsistenz-Check
  if (after.nodes.length !== nNodes || after.links.length !== nLinks) {
    console.error('WARNUNG: Anzahlen weichen ab (evtl. Links auf fehlende Knoten verworfen).');
  }
}

main();

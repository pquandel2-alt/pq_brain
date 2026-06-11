'use strict';

/**
 * Brain als MCP-Server: dieselben Fähigkeiten wie REST, als native Tools für
 * jede MCP-fähige KI. Wrappt db/retrieval/operations (eine Quelle).
 *
 * buildServer({ onWrite, onAccess, onLog, onMetaWrite }) → McpServer
 *   onWrite() wird nach jeder Mutation aufgerufen (in-process: broadcast+backup;
 *   stdio: no-op).
 *   onAccess(nodeIds) nach Lesezugriffen (in-process: GUI-Glow; stdio: no-op).
 *   onLog(action, labels) für das GUI-Action-Log (stdio: no-op).
 *   onMetaWrite() für Metadaten-Änderungen ohne Graph-Broadcast (z.B. used_count) —
 *   setzt nur das Backup-Dirty-Flag, ohne den vollen Graphen an alle Clients zu pushen.
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { z } = require('zod');

const db = require('../db');
const retrieval = require('../retrieval');
const operations = require('../operations');
const gardener = require('../gardener');

const TYPES = ['memory', 'note', 'idea', 'project', 'reference'];
const json = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const fail = (msg) => ({ content: [{ type: 'text', text: msg }], isError: true });

function buildServer({ onWrite = () => {}, onAccess = () => {}, onLog = () => {}, onMetaWrite = () => {} } = {}) {
  const server = new McpServer({ name: 'brain', version: '1.0.0' });

  // ── Lesen ───────────────────────────────────────────────────────────
  server.registerTool('brain_recall', {
    title: 'Recall (Token-Budget)',
    description: 'Wichtigster Einstieg: liefert die relevantesten Memory-Fakten zu einer Frage als Kurzfassungen innerhalb eines Token-Budgets. Danach bei Bedarf brain_get für den vollen Inhalt.',
    inputSchema: {
      q: z.string().describe('Frage/Stichworte'),
      budget: z.number().int().optional().describe('Token-Budget (Default 4000)'),
      limit: z.number().int().optional().describe('max. Treffer (Default 8)'),
      rerank: z.boolean().optional().describe('Cross-Encoder Re-Ranking (Opt-in, Default false)'),
      expand: z.boolean().optional().describe('A4: Graph-Expansion — 1-Hop-Nachbarn der Top-3 mit anhängen (Default false)'),
    },
  }, async ({ q, budget, limit, rerank, expand }) => {
    const out = await retrieval.recall({ q, budget, limit, rerank: rerank === true, expand: expand === true });
    if (out.results.length) {
      try { db.touchAccess(out.results.map(r => r.id)); } catch {}
      onAccess(out.results.map(r => r.id));
      onLog('read', out.results.slice(0, 3).map(r => r.label));
    }
    return json(out);
  });

  server.registerTool('brain_search', {
    title: 'Suche (hybrid/semantisch/keyword)',
    description: 'Sucht Knoten und gibt eine kompakte gerankte Liste (id, label, type, score) zurück. mode: hybrid (Default), semantic, keyword.',
    inputSchema: { query: z.string(), mode: z.enum(['hybrid', 'semantic', 'keyword']).optional(), limit: z.number().int().optional() },
  }, async ({ query, mode, limit }) => {
    const results = await retrieval.searchCompact({ q: query, mode, limit });
    if (results.length) {
      try { db.touchAccess(results.map(r => r.id)); } catch {}
      onAccess(results.map(r => r.id));
      onLog('read', results.slice(0, 3).map(r => r.label));
    }
    return json({ query, mode: mode || 'hybrid', count: results.length, results });
  });

  server.registerTool('brain_index', {
    title: 'Inhaltsverzeichnis',
    description: 'Schlankes Verzeichnis aller Knoten (id, label, type, tags) ohne Inhalte — günstige Orientierung.',
    inputSchema: {},
  }, async () => {
    const g = db.getBrain();
    return json({ count: g.nodes.length, nodes: g.nodes.map(n => ({ id: n.id, label: n.label, type: n.type, tags: n.tags })) });
  });

  server.registerTool('brain_get', {
    title: 'Knoten lesen (voll)',
    description: 'Vollständiger Knoten inkl. Inhalt und Lifecycle-Feldern (Drill-down nach Recall/Suche).',
    inputSchema: { id: z.string() },
  }, async ({ id }) => {
    const node = db.getNodeFull(id);
    if (!node) return fail('Node not found: ' + id);
    try { db.touchAccess([id]); } catch {}
    onAccess([id]);
    onLog('read', [node.label]);
    return json(node);
  });

  server.registerTool('brain_history', {
    title: 'Versionshistorie',
    description: 'Frühere Versionen eines Knotens.',
    inputSchema: { id: z.string() },
  }, async ({ id }) => json(db.getHistory(id)));

  // C1: Nachbar-Subgraph in einem Aufruf — spart manuelles Link-Parsen via brain_get.
  server.registerTool('brain_neighbors', {
    title: 'Nachbarn / Subgraph',
    description: 'Liefert Nachbarknoten + Kanten eines Knotens in einem Aufruf (depth 1-3, direction in/out/both). Token-schlank: nur id/label/type/summary.',
    inputSchema: {
      id: z.string(),
      depth: z.number().int().min(1).max(3).optional().describe('Hop-Tiefe (Default 1)'),
      direction: z.enum(['in', 'out', 'both']).optional().describe('Kantenrichtung (Default both)'),
    },
  }, async ({ id, depth, direction }) => {
    const out = retrieval.neighbors({ id, depth, direction });
    if (!out) return fail('Node not found: ' + id);
    try { db.touchAccess([id]); } catch {}
    onAccess([id]);
    onLog('read', [out.root.label]);
    return json(out);
  });

  // ── Schreiben ───────────────────────────────────────────────────────
  server.registerTool('brain_create_node', {
    title: 'Knoten anlegen',
    description: 'Legt einen Memory-Knoten an. Lehnt belegte Labels (409) und semantische Duplikate ab (force=true zum Erzwingen).',
    inputSchema: {
      label: z.string(), type: z.enum(TYPES).optional(), content: z.string().optional(),
      tags: z.array(z.string()).optional(), summary: z.string().optional(),
      source: z.string().optional(), force: z.boolean().optional(),
      ttl: z.number().int().optional().describe('Time-to-live in Sekunden (null = dauerhaft)'),
    },
  }, async (args) => {
    const r = await operations.createNode({ ...args, type: args.type || 'note' });
    if (r.error === 'label_required') return fail('label required');
    if (r.error === 'label_exists') return fail('Label existiert bereits: ' + JSON.stringify(r.existing));
    if (r.error === 'similar_exists') return fail(`Ähnlicher Knoten existiert (Similarity ${r.similarity}): ${JSON.stringify(r.similar)} — force=true zum Anlegen.`);
    onWrite();
    onLog('created', [r.node.label]);
    return json(r.node);
  });

  // C3: Usage-Feedback — markiert nach einem Recall TATSÄCHLICH genutzte Knoten.
  server.registerTool('brain_mark_used', {
    title: 'Verwendung melden',
    description: 'Markiert Knoten, deren Inhalt nach einem Recall tatsächlich verwendet wurde — stärkt deren zukünftiges Ranking (stärker als bloßer Lesezugriff). IDs aus brain_recall/brain_search.',
    inputSchema: { ids: z.array(z.string()).min(1).max(50) },
  }, async ({ ids }) => {
    const marked = db.markUsed(ids);
    onMetaWrite(); // nur Backup-Dirty, kein Full-Graph-Broadcast
    onAccess(ids);
    return json({ ok: true, marked });
  });

  // C4: Bulk — mehrere Knoten + Kanten in einem Aufruf (Import/Aufräumen).
  server.registerTool('brain_bulk_create', {
    title: 'Bulk: Knoten + Links anlegen',
    description: 'Legt mehrere Knoten und Kanten in einem Aufruf an (Import/Aufräumen). Teilerfolge werden pro Eintrag gemeldet; Links dürfen Labels ODER IDs referenzieren. Max 50 Knoten / 100 Links (Embedding-Dauer).',
    inputSchema: {
      nodes: z.array(z.object({
        label: z.string(), type: z.enum(TYPES).optional(), content: z.string().optional(),
        tags: z.array(z.string()).optional(), summary: z.string().optional(),
        source: z.string().optional(), force: z.boolean().optional(),
        ttl: z.number().int().optional(),
      })).max(50).optional(),
      links: z.array(z.object({
        source: z.string(), target: z.string(), label: z.string().optional(), type: z.string().optional(),
      })).max(100).optional(),
    },
  }, async ({ nodes = [], links = [] }) => {
    const out = await operations.bulkCreate({ nodes, links });
    if (out.created > 0 || out.linksCreated > 0) {
      onWrite();
      onLog('created', out.results.filter(r => r.ok).slice(0, 3).map(r => r.label));
    }
    return json(out);
  });

  server.registerTool('brain_update_node', {
    title: 'Knoten aktualisieren',
    description: 'Aktualisiert Felder eines Knotens (Versionierung + Re-Embedding automatisch).',
    inputSchema: {
      id: z.string(), label: z.string().optional(), type: z.enum(TYPES).optional(),
      content: z.string().optional(), tags: z.array(z.string()).optional(),
      summary: z.string().optional(), source: z.string().optional(),
    },
  }, async ({ id, ...updates }) => {
    Object.keys(updates).forEach(k => updates[k] === undefined && delete updates[k]);
    const r = await operations.updateNode(id, updates);
    if (r.error === 'not_found') return fail('Node not found: ' + id);
    onWrite();
    onLog('updated', [r.node.label]);
    return json(r.node);
  });

  // Revert (REST-Parität): stellt eine frühere Version wieder her (inkl. Undelete).
  server.registerTool('brain_revert', {
    title: 'Knoten zurücksetzen',
    description: 'Stellt eine frühere Version eines Knotens wieder her (Re-Embedding automatisch). Funktioniert auch für gelöschte Knoten (Undelete).',
    inputSchema: { id: z.string(), version: z.number().int().describe('Zielversion aus brain_history') },
  }, async ({ id, version }) => {
    const r = await operations.revertNode(id, version);
    if (r.error === 'not_found') return fail('Node/Version not found: ' + id + ' v' + version);
    onWrite();
    onLog('updated', [r.node.label]);
    return json(r.node);
  });

  // B2: Link-Vorschläge
  server.registerTool('brain_suggest_links', {
    title: 'Link-Vorschläge',
    description: 'Semantisch ähnliche, noch unverlinkte Knotenpaare — als Vorschläge für brain_link.',
    inputSchema: { limit: z.number().int().optional().describe('max. Vorschläge (Default 20)') },
  }, async ({ limit } = {}) => {
    const suggestions = await retrieval.suggestLinks({ limit });
    return json({ count: suggestions.length, suggestions });
  });

  // B3: Knoten löschen
  server.registerTool('brain_delete_node', {
    title: 'Knoten löschen',
    description: 'Löscht einen Knoten inkl. seiner Kanten und Vektoren (History bleibt für Revert erhalten).',
    inputSchema: { id: z.string() },
  }, async ({ id }) => {
    const result = db.deleteNode(id);
    if (!result) return fail('Node not found: ' + id);
    onWrite();
    onLog('deleted', [result.label]);
    return json({ ok: true, label: result.label });
  });

  // Gärtner: Wartungslauf sofort ausführen (sonst täglich automatisch).
  server.registerTool('brain_maintenance', {
    title: 'Wartungslauf (Gärtner)',
    description: 'Führt den Gärtner-Wartungslauf sofort aus: aktualisiert den Wartungsbericht-Knoten, legt ggf. Auto-Links an und liefert eine Zusammenfassung der Befunde.',
    inputSchema: {},
  }, async () => {
    const result = await gardener.runMaintenance();
    if (result.changed) {
      onWrite();
      onLog('updated', [gardener.REPORT_LABEL]);
    }
    return json(result);
  });

  // B3: Health-Report
  server.registerTool('brain_health_report', {
    title: 'Graph-Hygiene-Report',
    description: 'Gibt Waisen, Duplikate, tote [[Wikilinks]], nie zugegriffene Knoten und bald ablaufende TTL-Knoten zurück.',
    inputSchema: {},
  }, async () => json(db.getHealthReport()));

  server.registerTool('brain_link', {
    title: 'Knoten verbinden',
    description: 'Erstellt eine Kante zwischen zwei Knoten (optional typisiert, z.B. supersedes, depends-on).',
    inputSchema: { source: z.string(), target: z.string(), type: z.string().optional(), label: z.string().optional() },
  }, async ({ source, target, type, label }) => {
    if (source === target) return fail('Cannot link node to itself');
    const r = db.createLink(source, target, label || '', type || null);
    if (r.error === 'source') return fail('Source node not found');
    if (r.error === 'target') return fail('Target node not found');
    if (r.created) {
      onWrite();
      onLog('linked', [source, target].map(id => { try { return db.getNodeFull(id)?.label ?? id; } catch { return id; } }));
    }
    return json({ source, target, type: type || null, created: r.created });
  });

  return server;
}

module.exports = { buildServer };

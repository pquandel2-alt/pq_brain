'use strict';

/**
 * Brain als MCP-Server: dieselben Fähigkeiten wie REST, als native Tools für
 * jede MCP-fähige KI. Wrappt db/retrieval/operations (eine Quelle).
 *
 * EINE Tool-Registry (TOOLS) als Single Source of Truth:
 *   - buildServer(ctx) registriert sie als MCP-Tools.
 *   - listToolSchemas() exportiert dieselben Definitionen als JSON-Schema bzw.
 *     im OpenAI-Function-Calling-Format (für /api/tools) — kein zweiter, leicht
 *     abweichender Schema-Satz, der mit der Zeit driftet.
 *
 * Handler-Signatur: (args, ctx) → MCP-Result. ctx bündelt die Seiteneffekte:
 *   onWrite()      nach Mutationen (in-process: broadcast+backup; stdio: no-op)
 *   onAccess(ids)  nach Lesezugriffen (in-process: GUI-Glow; stdio: no-op)
 *   onLog(action, labels)  fürs GUI-Action-Log (stdio: no-op)
 *   onMetaWrite()  Metadaten-Änderung ohne Graph-Broadcast (z.B. used_count)
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { z } = require('zod');

const db = require('../db');
const retrieval = require('../retrieval');
const operations = require('../operations');
const gardener = require('../gardener');

const TYPES = ['memory', 'note', 'idea', 'project', 'reference', 'session'];
const json = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const text = (s) => ({ content: [{ type: 'text', text: s }] });
const fail = (msg) => ({ content: [{ type: 'text', text: msg }], isError: true });

// ── Tool-Registry (Single Source of Truth) ─────────────────────────────────
const TOOLS = [
  // ── Lesen ───────────────────────────────────────────────────────────
  {
    name: 'brain_recall',
    title: 'Recall (Token-Budget)',
    description: 'Wichtigster Einstieg: liefert die relevantesten Memory-Fakten zu einer Frage als Kurzfassungen innerhalb eines Token-Budgets. Danach bei Bedarf brain_get für den vollen Inhalt.',
    inputSchema: {
      q: z.string().describe('Frage/Stichworte'),
      budget: z.number().int().optional().describe('Token-Budget (Default 4000)'),
      limit: z.number().int().optional().describe('max. Treffer (Default 8)'),
      rerank: z.boolean().optional().describe('Cross-Encoder Re-Ranking (Opt-in, Default false)'),
      expand: z.boolean().optional().describe('A4: Graph-Expansion — 1-Hop-Nachbarn der Top-3 mit anhängen (Default false)'),
      qexpand: z.boolean().optional().describe('Query-Expansion via Pseudo-Relevance-Feedback — hebt Recall bei großen Graphen, verdoppelt aber die Latenz (Default false)'),
      charsPerToken: z.number().optional().describe('Tokenizer-Kalibrierung für die Budget-SCHÄTZUNG (Default 4, geklemmt auf 1–20)'),
      type: z.enum(['memory', 'note', 'idea', 'project', 'reference', 'session']).optional().describe('Nur Knoten dieses Typs zurückgeben'),
    },
    handler: async ({ q, budget, limit, rerank, expand, qexpand, charsPerToken, type }, ctx) => {
      const out = await retrieval.recall({ q, budget, limit, rerank: rerank === true, expand: expand === true, qexpand: qexpand === true, charsPerToken, type });
      if (out.results.length) {
        try { db.touchAccess(out.results.map(r => r.id)); } catch {}
        ctx.onAccess(out.results.map(r => r.id));
        ctx.onLog('read', out.results.slice(0, 3).map(r => r.label));
      }
      return json(out);
    },
  },
  {
    name: 'brain_briefing',
    title: 'Session-Briefing',
    description: 'Generischer Einstiegskontext zu Session-Beginn: Startknoten + verlinkter Kontext + Graph-Eckdaten als kompaktes Markdown. Ein Aufruf statt manuellem recall+get. Budget-begrenzt.',
    inputSchema: {
      budget: z.number().int().optional().describe('Token-Budget für den Startknoten-Inhalt (Default 1500)'),
      charsPerToken: z.number().optional().describe('Tokenizer-Kalibrierung (Default 4, geklemmt auf 1–20)'),
    },
    handler: async ({ budget, charsPerToken }, ctx) => {
      const b = retrieval.buildBriefing({ budget, charsPerToken });
      if (b.start) { try { db.touchAccess([b.start.id]); } catch {} ctx.onAccess([b.start.id]); }
      return text(retrieval.briefingMarkdown(b));
    },
  },
  {
    name: 'brain_search',
    title: 'Suche (hybrid/semantisch/keyword)',
    description: 'Sucht Knoten und gibt eine kompakte gerankte Liste (id, label, type, score) zurück. mode: hybrid (Default), semantic, keyword.',
    inputSchema: { query: z.string(), mode: z.enum(['hybrid', 'semantic', 'keyword']).optional(), limit: z.number().int().optional() },
    handler: async ({ query, mode, limit }, ctx) => {
      const results = await retrieval.searchCompact({ q: query, mode, limit });
      if (results.length) {
        try { db.touchAccess(results.map(r => r.id)); } catch {}
        ctx.onAccess(results.map(r => r.id));
        ctx.onLog('read', results.slice(0, 3).map(r => r.label));
      }
      return json({ query, mode: mode || 'hybrid', count: results.length, results });
    },
  },
  {
    name: 'brain_index',
    title: 'Inhaltsverzeichnis',
    description: 'Schlankes Verzeichnis aller Knoten (id, label, type, tags) ohne Inhalte — günstige Orientierung.',
    inputSchema: {},
    handler: async () => {
      const g = db.getBrain();
      return json({ count: g.nodes.length, nodes: g.nodes.map(n => ({ id: n.id, label: n.label, type: n.type, tags: n.tags })) });
    },
  },
  {
    name: 'brain_get',
    title: 'Knoten lesen (voll)',
    description: 'Vollständiger Knoten inkl. Inhalt und Lifecycle-Feldern (Drill-down nach Recall/Suche).',
    inputSchema: { id: z.string() },
    handler: async ({ id }, ctx) => {
      const node = db.getNodeFull(id);
      if (!node) return fail('Node not found: ' + id);
      try { db.touchAccess([id]); } catch {}
      ctx.onAccess([id]);
      ctx.onLog('read', [node.label]);
      return json(node);
    },
  },
  {
    name: 'brain_history',
    title: 'Versionshistorie',
    description: 'Frühere Versionen eines Knotens.',
    inputSchema: { id: z.string() },
    handler: async ({ id }) => json(db.getHistory(id)),
  },
  {
    // C1: Nachbar-Subgraph in einem Aufruf — spart manuelles Link-Parsen via brain_get.
    name: 'brain_neighbors',
    title: 'Nachbarn / Subgraph',
    description: 'Liefert Nachbarknoten + Kanten eines Knotens in einem Aufruf (depth 1-3, direction in/out/both). Token-schlank: nur id/label/type/summary.',
    inputSchema: {
      id: z.string(),
      depth: z.number().int().min(1).max(3).optional().describe('Hop-Tiefe (Default 1)'),
      direction: z.enum(['in', 'out', 'both']).optional().describe('Kantenrichtung (Default both)'),
    },
    handler: async ({ id, depth, direction }, ctx) => {
      const out = retrieval.neighbors({ id, depth, direction });
      if (!out) return fail('Node not found: ' + id);
      try { db.touchAccess([id]); } catch {}
      ctx.onAccess([id]);
      ctx.onLog('read', [out.root.label]);
      return json(out);
    },
  },

  // ── Schreiben ───────────────────────────────────────────────────────
  {
    name: 'brain_create_node',
    title: 'Knoten anlegen',
    description: 'Legt einen Memory-Knoten an. Lehnt belegte Labels (409) und semantische Duplikate ab (force=true zum Erzwingen).',
    inputSchema: {
      label: z.string(), type: z.enum(TYPES).optional(), content: z.string().optional(),
      tags: z.array(z.string()).optional(), summary: z.string().optional(),
      source: z.string().optional(), force: z.boolean().optional(),
      ttl: z.number().int().optional().describe('Time-to-live in Sekunden (null = dauerhaft)'),
      importance: z.enum(['high', 'medium', 'low']).optional().describe('Wichtigkeit des Knotens für das Ranking (Default medium)'),
    },
    handler: async (args, ctx) => {
      const r = await operations.createNode({ ...args, type: args.type || 'note' });
      if (r.error === 'label_required') return fail('label required');
      if (r.error === 'label_exists') return fail('Label existiert bereits: ' + JSON.stringify(r.existing));
      if (r.error === 'similar_exists') return fail(`Ähnlicher Knoten existiert (Similarity ${r.similarity}): ${JSON.stringify(r.similar)} — force=true zum Anlegen.`);
      ctx.onWrite();
      ctx.onLog('created', [r.node.label]);
      return json(r.node);
    },
  },
  {
    // C3: Usage-Feedback — markiert nach einem Recall TATSÄCHLICH genutzte Knoten.
    name: 'brain_mark_used',
    title: 'Verwendung melden',
    description: 'Markiert Knoten, deren Inhalt nach einem Recall tatsächlich verwendet wurde — stärkt deren zukünftiges Ranking (stärker als bloßer Lesezugriff). IDs aus brain_recall/brain_search.',
    inputSchema: { ids: z.array(z.string()).min(1).max(50) },
    handler: async ({ ids }, ctx) => {
      const marked = db.markUsed(ids);
      ctx.onMetaWrite(); // nur Backup-Dirty, kein Full-Graph-Broadcast
      ctx.onAccess(ids);
      return json({ ok: true, marked });
    },
  },
  {
    // C4: Bulk — mehrere Knoten + Kanten in einem Aufruf (Import/Aufräumen).
    name: 'brain_bulk_create',
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
    handler: async ({ nodes = [], links = [] }, ctx) => {
      const out = await operations.bulkCreate({ nodes, links });
      if (out.created > 0 || out.linksCreated > 0) {
        ctx.onWrite();
        ctx.onLog('created', out.results.filter(r => r.ok).slice(0, 3).map(r => r.label));
      }
      return json(out);
    },
  },
  {
    name: 'brain_update_node',
    title: 'Knoten aktualisieren',
    description: 'Aktualisiert Felder eines Knotens (Versionierung + Re-Embedding automatisch).',
    inputSchema: {
      id: z.string(), label: z.string().optional(), type: z.enum(TYPES).optional(),
      content: z.string().optional(), tags: z.array(z.string()).optional(),
      summary: z.string().optional(), source: z.string().optional(),
      importance: z.enum(['high', 'medium', 'low']).optional().describe('Wichtigkeit des Knotens für das Ranking'),
    },
    handler: async ({ id, ...updates }, ctx) => {
      Object.keys(updates).forEach(k => updates[k] === undefined && delete updates[k]);
      const r = await operations.updateNode(id, updates);
      if (r.error === 'not_found') return fail('Node not found: ' + id);
      ctx.onWrite();
      ctx.onLog('updated', [r.node.label]);
      return json(r.node);
    },
  },
  {
    // Revert (REST-Parität): stellt eine frühere Version wieder her (inkl. Undelete).
    name: 'brain_revert',
    title: 'Knoten zurücksetzen',
    description: 'Stellt eine frühere Version eines Knotens wieder her (Re-Embedding automatisch). Funktioniert auch für gelöschte Knoten (Undelete).',
    inputSchema: { id: z.string(), version: z.number().int().describe('Zielversion aus brain_history') },
    handler: async ({ id, version }, ctx) => {
      const r = await operations.revertNode(id, version);
      if (r.error === 'not_found') return fail('Node/Version not found: ' + id + ' v' + version);
      ctx.onWrite();
      ctx.onLog('updated', [r.node.label]);
      return json(r.node);
    },
  },
  {
    // B2: Link-Vorschläge
    name: 'brain_suggest_links',
    title: 'Link-Vorschläge',
    description: 'Semantisch ähnliche, noch unverlinkte Knotenpaare — als Vorschläge für brain_link.',
    inputSchema: { limit: z.number().int().optional().describe('max. Vorschläge (Default 20)') },
    handler: async ({ limit } = {}) => {
      const suggestions = await retrieval.suggestLinks({ limit });
      return json({ count: suggestions.length, suggestions });
    },
  },
  {
    // B3: Knoten löschen
    name: 'brain_delete_node',
    title: 'Knoten löschen',
    description: 'Löscht einen Knoten inkl. seiner Kanten und Vektoren (History bleibt für Revert erhalten).',
    inputSchema: { id: z.string() },
    handler: async ({ id }, ctx) => {
      const result = db.deleteNode(id);
      if (!result) return fail('Node not found: ' + id);
      ctx.onWrite();
      ctx.onLog('deleted', [result.label]);
      return json({ ok: true, label: result.label });
    },
  },
  {
    // Gärtner: Wartungslauf sofort ausführen (sonst täglich automatisch).
    name: 'brain_maintenance',
    title: 'Wartungslauf (Gärtner)',
    description: 'Führt den Gärtner-Wartungslauf sofort aus: aktualisiert den Wartungsbericht-Knoten, legt ggf. Auto-Links an und liefert eine Zusammenfassung der Befunde.',
    inputSchema: {},
    handler: async (_args, ctx) => {
      const result = await gardener.runMaintenance();
      if (result.changed) {
        ctx.onWrite();
        ctx.onLog('updated', [gardener.REPORT_LABEL]);
      }
      return json(result);
    },
  },
  {
    // B3: Health-Report
    name: 'brain_health_report',
    title: 'Graph-Hygiene-Report',
    description: 'Gibt Waisen, Duplikate, tote [[Wikilinks]], nie zugegriffene Knoten und bald ablaufende TTL-Knoten zurück.',
    inputSchema: {},
    handler: async () => json(db.getHealthReport()),
  },
  {
    // Auto-Capture: Inbox-Kandidaten aus Sessions reviewen.
    name: 'brain_inbox',
    title: 'Inbox (Auto-Capture)',
    description: 'Verwaltet aus Sessions automatisch extrahierte Knoten-Kandidaten (Tag `inbox`). action="list" (Default) zeigt offene Kandidaten; action="accept" mit id übernimmt einen Kandidaten dauerhaft (Tag + TTL entfernt). Ablehnen via brain_delete_node.',
    inputSchema: {
      action: z.enum(['list', 'accept']).optional().describe('list (Default) oder accept'),
      id: z.string().optional().describe('Knoten-ID (nur bei action=accept)'),
    },
    handler: async ({ action = 'list', id }, ctx) => {
      if (action === 'accept') {
        if (!id) return fail('id required for accept');
        const full = db.getNodeFull(id);
        if (!full) return fail('Node not found: ' + id);
        const tags = (full.tags || []).filter(t => t !== 'inbox');
        const r = await operations.updateNode(id, { tags, ttl: null });
        if (r.error === 'not_found') return fail('Node not found: ' + id);
        ctx.onWrite();
        ctx.onLog('updated', [r.node.label]);
        return json({ accepted: true, node: r.node });
      }
      const sub = db.getByTags(['inbox']);
      const items = sub.nodes.map(n => {
        const full = db.getNodeFull(n.id);
        return {
          id: n.id, label: n.label, type: n.type,
          summary: full?.summary || null,
          preview: full ? retrieval.previewText(full) : '',
          source: full?.source || null,
          expires_at: full?.expires_at || null,
        };
      });
      return json({ count: items.length, items });
    },
  },
  {
    name: 'brain_link',
    title: 'Knoten verbinden',
    description: 'Erstellt eine Kante zwischen zwei Knoten (optional typisiert, z.B. supersedes, depends-on).',
    inputSchema: { source: z.string(), target: z.string(), type: z.string().optional(), label: z.string().optional() },
    handler: async ({ source, target, type, label }, ctx) => {
      if (source === target) return fail('Cannot link node to itself');
      const r = db.createLink(source, target, label || '', type || null);
      if (r.error === 'source') return fail('Source node not found');
      if (r.error === 'target') return fail('Target node not found');
      if (r.created) {
        ctx.onWrite();
        ctx.onLog('linked', [source, target].map(id => { try { return db.getNodeFull(id)?.label ?? id; } catch { return id; } }));
      }
      return json({ source, target, type: type || null, created: r.created });
    },
  },
];

function buildServer(ctx = {}) {
  const fullCtx = {
    onWrite: ctx.onWrite || (() => {}),
    onAccess: ctx.onAccess || (() => {}),
    onLog: ctx.onLog || (() => {}),
    onMetaWrite: ctx.onMetaWrite || (() => {}),
  };
  const server = new McpServer({ name: 'brain', version: require('../config').VERSION });
  for (const def of TOOLS) {
    server.registerTool(
      def.name,
      { title: def.title, description: def.description, inputSchema: def.inputSchema },
      (args) => def.handler(args, fullCtx),
    );
  }
  return server;
}

// JSON-Schema einer Tool-Eingabe (zod v4 native, kein Zusatzpaket).
function toolJsonSchema(def) {
  const schema = z.toJSONSchema(z.object(def.inputSchema));
  delete schema.$schema; // generische Clients erwarten ein reines Parameter-Schema
  return schema;
}

/**
 * Exportiert die Tool-Definitionen für /api/tools — dieselbe Quelle wie die
 * MCP-Registrierung oben.
 *   format 'openai' → OpenAI-Function-Calling (chat.completions): {type, function:{name,description,parameters}}
 *   sonst          → {name, title, description, inputSchema(JSON-Schema)}
 */
function listToolSchemas({ format } = {}) {
  return TOOLS.map(def => {
    const parameters = toolJsonSchema(def);
    if (format === 'openai') {
      return { type: 'function', function: { name: def.name, description: def.description, parameters } };
    }
    return { name: def.name, title: def.title, description: def.description, inputSchema: parameters };
  });
}

module.exports = { buildServer, listToolSchemas, TOOLS };

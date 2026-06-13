'use strict';

/**
 * OpenAPI-3.1-Spec als JS-Objekt — die EINE maschinenlesbare Beschreibung der
 * REST-API. Wird live unter /openapi.json und /openapi.yaml ausgeliefert.
 *
 * Bewusst als Code (nicht als statische Datei), damit `version` aus config.VERSION
 * kommt und nicht gegen package.json driften kann. Ein Contract-Test
 * (verify-openapi.js) prüft, dass die hier gelisteten Pfade 1:1 den im Express
 * registrierten Routen entsprechen.
 */

const config = require('./config');

const NODE_TYPES = ['memory', 'note', 'idea', 'project', 'reference'];

const errorResponse = (desc) => ({
  description: desc,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
});

const spec = {
  openapi: '3.1.0',
  info: {
    title: 'Brain API',
    version: config.VERSION,
    description:
      'Persistent-Memory-Wissensgraph für KI-Agenten. REST für direkte Integrationen, ' +
      'MCP (/mcp) für Agenten-Frameworks, /api/tools für Function-Calling-Clients. ' +
      'Antworten sind JSON; usedTokensEst in /api/recall ist eine Schätzung, keine exakte Messung.',
  },
  servers: [{ url: 'http://localhost:' + config.PORT, description: 'lokaler Brain-Server' }],
  tags: [
    { name: 'graph', description: 'Graph lesen, Recall, Briefing' },
    { name: 'nodes', description: 'Knoten-CRUD + Lifecycle' },
    { name: 'links', description: 'Kanten' },
    { name: 'maintenance', description: 'Hygiene, Backups, Import' },
    { name: 'meta', description: 'Health, Tool-Katalog' },
  ],
  paths: {
    '/api/health': {
      get: {
        tags: ['meta'], operationId: 'getHealth', summary: 'Server-Status',
        responses: { 200: { description: 'Status', content: { 'application/json': { schema: { $ref: '#/components/schemas/Health' } } } } },
      },
    },
    '/api/tools': {
      get: {
        tags: ['meta'], operationId: 'listTools',
        summary: 'Tool-Katalog (JSON-Schema oder OpenAI-Function-Calling)',
        parameters: [{ name: 'format', in: 'query', schema: { type: 'string', enum: ['jsonschema', 'openai'] }, description: 'openai = OpenAI-Function-Calling-Format' }],
        responses: { 200: { description: 'Tool-Liste', content: { 'application/json': { schema: { type: 'object' } } } } },
      },
    },
    '/api/brain': {
      get: {
        tags: ['graph'], operationId: 'getBrain',
        summary: 'Graph lesen/filtern (Voll, Tags, Suche, hybrid/semantisch, smart)',
        description: 'Priorität: q (hybrid) > semantic > search > tags > smart > voll. Pagination (limit/offset) greift nur in Listing-Modi; limit=0 hebt das Default-Limit (1000) auf.',
        parameters: [
          { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Hybride Suche (Semantik + Keyword)' },
          { name: 'semantic', in: 'query', schema: { type: 'string' }, description: 'Rein semantische Suche' },
          { name: 'search', in: 'query', schema: { type: 'string' }, description: 'Substring-Suche' },
          { name: 'tags', in: 'query', schema: { type: 'string' }, description: 'Komma-separierte Tags' },
          { name: 'smart', in: 'query', schema: { type: 'string', enum: ['true', '1'] }, description: 'Startknoten + erreichbare Knoten' },
          { name: 'depth', in: 'query', schema: { type: 'integer' }, description: 'BFS-Tiefe für smart' },
          { name: 'fields', in: 'query', schema: { type: 'string' }, description: 'Feld-Projektion, z.B. id,label,type' },
          { name: 'view', in: 'query', schema: { type: 'string', enum: ['index'] }, description: 'Schlankes Inhaltsverzeichnis' },
          { name: 'limit', in: 'query', schema: { type: 'integer' }, description: 'Listing-Modi: max. Knoten (0 = alle); Such-Modi: Treffer' },
          { name: 'offset', in: 'query', schema: { type: 'integer' }, description: 'Listing-Modi: Versatz' },
        ],
        responses: { 200: { description: 'Graph', content: { 'application/json': { schema: { $ref: '#/components/schemas/Graph' } } } }, 500: errorResponse('Fehler') },
      },
    },
    '/api/recall': {
      get: {
        tags: ['graph'], operationId: 'recall',
        summary: 'Token-Budget-Recall: gerankte Kurzfassungen (KI-Einstieg)',
        parameters: [
          { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'budget', in: 'query', schema: { type: 'integer', default: 4000 }, description: 'Token-Budget (Schätzung)' },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 8 } },
          { name: 'rerank', in: 'query', schema: { type: 'boolean' }, description: 'Cross-Encoder Re-Ranking' },
          { name: 'expand', in: 'query', schema: { type: 'boolean' }, description: '1-Hop-Graph-Expansion' },
          { name: 'charsPerToken', in: 'query', schema: { type: 'number' }, description: 'Tokenizer-Kalibrierung (Default 4, geklemmt 1–20)' },
        ],
        responses: { 200: { description: 'Recall', content: { 'application/json': { schema: { $ref: '#/components/schemas/RecallResult' } } } }, 400: errorResponse('q fehlt'), 500: errorResponse('Fehler') },
      },
    },
    '/api/briefing': {
      get: {
        tags: ['graph'], operationId: 'briefing',
        summary: 'Session-Briefing: Startknoten + Kontext (Markdown oder JSON)',
        parameters: [
          { name: 'format', in: 'query', schema: { type: 'string', enum: ['md', 'json'], default: 'md' } },
          { name: 'budget', in: 'query', schema: { type: 'integer', default: 1500 } },
          { name: 'charsPerToken', in: 'query', schema: { type: 'number' } },
        ],
        responses: {
          200: { description: 'Briefing', content: { 'text/markdown': { schema: { type: 'string' } }, 'application/json': { schema: { $ref: '#/components/schemas/Briefing' } } } },
          500: errorResponse('Fehler'),
        },
      },
    },
    '/api/metrics': {
      get: {
        tags: ['meta'], operationId: 'getMetrics',
        summary: 'Laufzeit-Metriken (Latenzen, Durchsatz) + Bestands-/Verhaltensstatistik',
        description: 'Prozesslokale Counter/Latenz-Histogramme (recall/search/create/update/embed) plus DB-Statistik (Top-Knoten, Typverteilung, Wachstum, Aktionsmix). Counter werden bei Neustart zurückgesetzt.',
        responses: { 200: { description: 'Metriken', content: { 'application/json': { schema: { type: 'object' } } } }, 500: errorResponse('Fehler') },
      },
    },
    '/api/brain/suggest-links': {
      get: {
        tags: ['maintenance'], operationId: 'suggestLinks', summary: 'Link-Vorschläge',
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } }],
        responses: { 200: { description: 'Vorschläge', content: { 'application/json': { schema: { type: 'object' } } } }, 500: errorResponse('Fehler') },
      },
    },
    '/api/brain/suggest-links/dismiss': {
      post: {
        tags: ['maintenance'], operationId: 'dismissSuggestion', summary: 'Link-Vorschlag verwerfen',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['source', 'target'], properties: { source: { type: 'string' }, target: { type: 'string' } } } } } },
        responses: { 200: { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/Ok' } } } }, 400: errorResponse('fehlende Felder'), 500: errorResponse('Fehler') },
      },
    },
    '/api/brain/mark-used': {
      post: {
        tags: ['nodes'], operationId: 'markUsed', summary: 'Verwendung melden (Usage-Feedback)',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['ids'], properties: { ids: { type: 'array', items: { type: 'string' } } } } } } },
        responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'object' } } } }, 400: errorResponse('ids fehlen'), 500: errorResponse('Fehler') },
      },
    },
    '/api/brain/health-report': {
      get: {
        tags: ['maintenance'], operationId: 'healthReport', summary: 'Graph-Hygiene-Report',
        responses: { 200: { description: 'Report', content: { 'application/json': { schema: { type: 'object' } } } }, 500: errorResponse('Fehler') },
      },
    },
    '/api/brain/maintenance': {
      post: {
        tags: ['maintenance'], operationId: 'runMaintenance', summary: 'Gärtner-Lauf anstoßen',
        responses: { 200: { description: 'Ergebnis', content: { 'application/json': { schema: { type: 'object' } } } }, 500: errorResponse('Fehler') },
      },
    },
    '/api/inbox': {
      get: {
        tags: ['maintenance'], operationId: 'listInbox',
        summary: 'Auto-Capture-Kandidaten (Inbox) auflisten',
        description: 'Aus Sessions extrahierte Knoten mit Tag `inbox`, die auf Review warten (inkl. Ablaufdatum).',
        responses: { 200: { description: 'Inbox', content: { 'application/json': { schema: { type: 'object' } } } }, 500: errorResponse('Fehler') },
      },
      post: {
        tags: ['maintenance'], operationId: 'inboxIntake',
        summary: 'Kandidaten in die Inbox aufnehmen (Auto-Capture)',
        description: 'Nimmt aus einer Session extrahierte Knoten als Inbox-Kandidaten auf (Tag `inbox`, TTL, Dedup aktiv). Max 10 Knoten pro Aufruf.',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['nodes'], properties: { session_id: { type: 'string' }, nodes: { type: 'array', items: { $ref: '#/components/schemas/NodeCreate' } } } } } } },
        responses: { 200: { description: 'Aufnahme-Ergebnis (Teilerfolge pro Eintrag)', content: { 'application/json': { schema: { type: 'object' } } } }, 400: errorResponse('Validierung') },
      },
    },
    '/api/inbox/{id}/accept': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      post: {
        tags: ['maintenance'], operationId: 'acceptInbox',
        summary: 'Inbox-Kandidat annehmen (Tag + TTL entfernen)',
        responses: { 200: { description: 'Übernommener Knoten', content: { 'application/json': { schema: { $ref: '#/components/schemas/FullNode' } } } }, 400: errorResponse('Validierung'), 404: errorResponse('nicht gefunden') },
      },
    },
    '/api/nodes': {
      post: {
        tags: ['nodes'], operationId: 'createNode', summary: 'Knoten anlegen',
        parameters: [{ name: 'force', in: 'query', schema: { type: 'boolean' }, description: 'Duplikat-Check übergehen' }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/NodeCreate' } } } },
        responses: {
          200: { description: 'Angelegt', content: { 'application/json': { schema: { $ref: '#/components/schemas/FullNode' } } } },
          400: errorResponse('Validierung'), 409: errorResponse('Label/Duplikat existiert'),
        },
      },
    },
    '/api/nodes/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      get: {
        tags: ['nodes'], operationId: 'getNode', summary: 'Knoten lesen (voll)',
        responses: { 200: { description: 'Knoten', content: { 'application/json': { schema: { $ref: '#/components/schemas/FullNode' } } } }, 404: errorResponse('nicht gefunden') },
      },
      put: {
        tags: ['nodes'], operationId: 'updateNode', summary: 'Knoten aktualisieren',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/NodeUpdate' } } } },
        responses: { 200: { description: 'Aktualisiert', content: { 'application/json': { schema: { $ref: '#/components/schemas/FullNode' } } } }, 400: errorResponse('Validierung'), 404: errorResponse('nicht gefunden') },
      },
      delete: {
        tags: ['nodes'], operationId: 'deleteNode', summary: 'Knoten löschen',
        responses: { 200: { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/Ok' } } } }, 404: errorResponse('nicht gefunden') },
      },
    },
    '/api/nodes/{id}/history': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      get: { tags: ['nodes'], operationId: 'getHistory', summary: 'Versionshistorie', responses: { 200: { description: 'History', content: { 'application/json': { schema: { type: 'array', items: { type: 'object' } } } } } } },
    },
    '/api/nodes/{id}/neighbors': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      get: {
        tags: ['nodes'], operationId: 'getNeighbors', summary: 'Nachbar-Subgraph',
        parameters: [
          { name: 'depth', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 3, default: 1 } },
          { name: 'direction', in: 'query', schema: { type: 'string', enum: ['in', 'out', 'both'], default: 'both' } },
        ],
        responses: { 200: { description: 'Subgraph', content: { 'application/json': { schema: { type: 'object' } } } }, 404: errorResponse('nicht gefunden') },
      },
    },
    '/api/nodes/{id}/revert/{version}': {
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'version', in: 'path', required: true, schema: { type: 'integer' } },
      ],
      post: { tags: ['nodes'], operationId: 'revertNode', summary: 'Auf Version zurücksetzen', responses: { 200: { description: 'Zurückgesetzt', content: { 'application/json': { schema: { $ref: '#/components/schemas/FullNode' } } } }, 400: errorResponse('ungültige Version'), 404: errorResponse('nicht gefunden') } },
    },
    '/api/links': {
      post: {
        tags: ['links'], operationId: 'createLink', summary: 'Kante anlegen',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/LinkCreate' } } } },
        responses: { 200: { description: 'Angelegt', content: { 'application/json': { schema: { $ref: '#/components/schemas/Link' } } } }, 400: errorResponse('Validierung'), 404: errorResponse('Knoten fehlt') },
      },
      put: {
        tags: ['links'], operationId: 'updateLink', summary: 'Kante ändern',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/LinkCreate' } } } },
        responses: { 200: { description: 'Aktualisiert', content: { 'application/json': { schema: { $ref: '#/components/schemas/Link' } } } }, 400: errorResponse('keine Änderung'), 404: errorResponse('nicht gefunden') },
      },
      delete: {
        tags: ['links'], operationId: 'deleteLink', summary: 'Kante löschen',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['source', 'target'], properties: { source: { type: 'string' }, target: { type: 'string' } } } } } },
        responses: { 200: { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/Ok' } } } }, 400: errorResponse('fehlende Felder') },
      },
    },
    '/api/backups': {
      get: { tags: ['maintenance'], operationId: 'listBackups', summary: 'Backups auflisten', responses: { 200: { description: 'Liste', content: { 'application/json': { schema: { type: 'array', items: { type: 'object' } } } } } } },
    },
    '/api/restore/{filename}': {
      parameters: [{ name: 'filename', in: 'path', required: true, schema: { type: 'string' } }],
      post: { tags: ['maintenance'], operationId: 'restoreBackup', summary: 'Backup wiederherstellen', responses: { 200: { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/Ok' } } } }, 400: errorResponse('ungültiger Name'), 500: errorResponse('Fehler') } },
    },
    '/api/import': {
      post: {
        tags: ['maintenance'], operationId: 'importMarkdown', summary: 'Markdown-Verzeichnis importieren',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['dirPath'], properties: { dirPath: { type: 'string' } } } } } },
        responses: { 200: { description: 'Ergebnis', content: { 'application/json': { schema: { type: 'object' } } } }, 400: errorResponse('Validierung'), 403: errorResponse('Pfad verboten'), 404: errorResponse('Pfad fehlt') },
      },
    },
    '/mcp': {
      post: {
        tags: ['meta'], operationId: 'mcp',
        summary: 'MCP über Streamable HTTP (JSON-RPC 2.0, stateless)',
        description: 'Model-Context-Protocol-Endpunkt für Agenten-Frameworks. Kein klassisches REST — JSON-RPC-2.0-Body. Tool-Schemata siehe /api/tools.',
        requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { 200: { description: 'JSON-RPC-Antwort', content: { 'application/json': { schema: { type: 'object' } } } }, 401: errorResponse('nicht autorisiert') },
      },
    },
  },
  components: {
    schemas: {
      Error: {
        type: 'object', required: ['error', 'code'],
        properties: {
          error: { type: 'string', description: 'Menschenlesbare Meldung' },
          code: { type: 'string', description: 'Stabiler Fehlercode (z.B. NOT_FOUND, VALIDATION_ERROR, LABEL_EXISTS, SIMILAR_EXISTS)' },
          hint: { type: 'string' },
          existing: { $ref: '#/components/schemas/FullNode' },
          similar: { type: 'object' },
          similarity: { type: 'number' },
        },
      },
      Ok: { type: 'object', properties: { ok: { type: 'boolean' } } },
      Health: {
        type: 'object',
        properties: {
          status: { type: 'string' }, uptime: { type: 'integer' }, lastWrite: { type: ['string', 'null'] },
          lastError: { type: ['string', 'null'] }, writeCount: { type: 'integer' }, errorCount: { type: 'integer' },
          nodeCount: { type: 'integer' }, linkCount: { type: 'integer' }, storage: { type: 'string' },
          vectors: { type: 'boolean' }, version: { type: 'string' },
        },
      },
      Node: {
        type: 'object', description: 'Token-schlanker Knoten (Listen/Graph)',
        required: ['id', 'label', 'type'],
        properties: {
          id: { type: 'string' }, label: { type: 'string' }, type: { type: 'string', enum: NODE_TYPES },
          content: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, created: { type: 'string' },
        },
      },
      FullNode: {
        type: 'object', description: 'Voller Knoten inkl. Lifecycle (null-Felder entfallen)',
        required: ['id', 'label', 'type', 'version'],
        properties: {
          id: { type: 'string' }, label: { type: 'string' }, type: { type: 'string', enum: NODE_TYPES },
          content: { type: 'string' }, summary: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } },
          created: { type: 'string' }, updated_at: { type: 'string' }, accessed_at: { type: 'string' },
          access_count: { type: 'integer' }, source: { type: 'string' }, version: { type: 'integer' },
          ttl: { type: 'integer' }, expires_at: { type: 'string' }, used_count: { type: 'integer' }, used_at: { type: 'string' },
        },
      },
      NodeCreate: {
        type: 'object', required: ['label'],
        properties: {
          label: { type: 'string' }, type: { type: 'string', enum: NODE_TYPES, default: 'note' },
          content: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } },
          summary: { type: 'string' }, source: { type: 'string' },
          ttl: { type: 'integer', description: 'Sekunden bis Ablauf (null = dauerhaft)' },
          force: { type: 'boolean' },
        },
      },
      NodeUpdate: {
        type: 'object', description: 'Partielle Aktualisierung (nur gesetzte Felder)',
        properties: {
          label: { type: 'string' }, type: { type: 'string', enum: NODE_TYPES }, content: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } }, summary: { type: 'string' }, source: { type: 'string' },
          ttl: { type: ['integer', 'null'] },
        },
      },
      Link: {
        type: 'object', required: ['source', 'target'],
        properties: { source: { type: 'string' }, target: { type: 'string' }, label: { type: 'string' }, rel_type: { type: 'string' } },
      },
      LinkCreate: {
        type: 'object', required: ['source', 'target'],
        properties: { source: { type: 'string' }, target: { type: 'string' }, label: { type: 'string' }, type: { type: 'string', description: 'rel_type, z.B. supersedes, depends-on' } },
      },
      Graph: {
        type: 'object',
        properties: {
          nodes: { type: 'array', items: { $ref: '#/components/schemas/Node' } },
          links: { type: 'array', items: { $ref: '#/components/schemas/Link' } },
          startNodeId: { type: ['string', 'null'] },
          pagination: {
            type: 'object',
            properties: { total: { type: 'integer' }, returned: { type: 'integer' }, limit: { type: 'integer' }, offset: { type: 'integer' } },
          },
        },
      },
      RecallResult: {
        type: 'object',
        properties: {
          query: { type: 'string' }, budget: { type: 'integer' }, usedTokensEst: { type: 'integer', description: 'SCHÄTZUNG, keine exakte Messung' },
          count: { type: 'integer' },
          results: {
            type: 'array',
            items: {
              type: 'object',
              properties: { id: { type: 'string' }, label: { type: 'string' }, type: { type: 'string' }, preview: { type: 'string' }, score: { type: 'number' }, via: { type: 'string' } },
            },
          },
        },
      },
      Briefing: {
        type: 'object',
        properties: {
          generatedAt: { type: 'string' },
          stats: { type: 'object', properties: { nodes: { type: 'integer' }, links: { type: 'integer' } } },
          start: { type: ['object', 'null'] },
          neighbors: { type: 'array', items: { type: 'object' } },
        },
      },
    },
  },
};

module.exports = spec;

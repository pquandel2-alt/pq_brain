const config = require('./config'); // zuerst: lädt .env, leitet Pfade/Version ab
const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');
const { createHash } = require('crypto');
const db = require('./db');
const { warmup, embed, MODEL } = require('./embeddings');
const retrieval = require('./retrieval');
const operations = require('./operations');
const gardener = require('./gardener');
const metrics = require('./metrics');

const app = express();
const BACKUP_DIR = config.BACKUP_DIR;   // alle Pfade aus BRAIN_DATA_DIR (eine Quelle)
const LOG_FILE = config.LOG_FILE;
const ALLOWED_TYPES = ['memory', 'note', 'idea', 'project', 'reference', 'session'];
const MAX_BACKUPS = 72;                          // ~3 Tage bei stündlichem Takt
const BACKUP_MIN_INTERVAL_MS = 60 * 60 * 1000;   // max. 1 Backup pro Stunde

// Verzeichnisse legt config.js bereits an (DATA_DIR/backups, /logs, /models).

// ── Einheitliches Fehlerformat ──────────────────────────────────────────
// Rückwärtskompatibel: { error } bleibt; zusätzlich ein stabiles `code` pro
// Fehlerklasse, damit generische Clients zuverlässig darauf verzweigen können.
const ERROR_CODES = { 400: 'BAD_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT', 500: 'INTERNAL_ERROR' };
function sendError(res, status, message, { code, ...extra } = {}) {
  return res.status(status).json({ error: message, code: code || ERROR_CODES[status] || 'ERROR', ...extra });
}

// Logger — persistenter Append-Stream statt synchronem appendFileSync pro Zeile.
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
logStream.on('error', (err) => console.error('Log stream error:', err.message));
const logger = {
  log(level, message, context = {}) {
    const timestamp = new Date().toISOString();
    const entry = { timestamp, level, message, ...context };
    const line = JSON.stringify(entry);

    console.log(`[${level}] ${timestamp} ${message}`);
    logStream.write(line + '\n');
  },
  info(msg, ctx) { this.log('INFO', msg, ctx); },
  warn(msg, ctx) { this.log('WARN', msg, ctx); },
  error(msg, ctx) { this.log('ERROR', msg, ctx); },
  debug(msg, ctx) { this.log('DEBUG', msg, ctx); },
};

// Health tracking
const health = {
  startTime: new Date(),
  lastWrite: null,
  lastError: null,
  writeCount: 0,
  errorCount: 0,
};

// ── Backup management (JSON-Snapshots aus der DB, Throttle + Hash-Skip) ──
function getBackupFilename() {
  const now = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  return `brain.backup.${now}.json`;
}

// In-Memory-Hash des zuletzt geschriebenen Snapshots — erspart das Lesen+Parsen
// der Vorgänger-Datei bei jedem Lauf. Beim Start einmalig aus neuester Datei gefüllt.
let lastBackupHash = null;
let backupDirty = false;

async function initBackupHash() {
  try {
    const files = (await fs.promises.readdir(BACKUP_DIR)).filter(f => f.startsWith('brain.backup.')).sort();
    const newest = files.pop();
    if (!newest) return;
    const prev = await fs.promises.readFile(path.join(BACKUP_DIR, newest), 'utf8');
    // Re-Stringify für stabilen Hash unabhängig von Formatierung der Datei.
    lastBackupHash = createHash('sha1').update(JSON.stringify(JSON.parse(prev))).digest('hex');
  } catch { /* kein/kaputtes Backup → erstes Backup schreibt frisch */ }
}

// Asynchrones Backup: einmal stringifizieren (für Hash + Write), Throttle gegen mtime.
async function createBackup(data, { force = false } = {}) {
  try {
    await fs.promises.mkdir(BACKUP_DIR, { recursive: true });

    const files = (await fs.promises.readdir(BACKUP_DIR)).filter(f => f.startsWith('brain.backup.')).sort();
    const newest = files[files.length - 1];
    if (newest && !force) {
      const ageMs = Date.now() - (await fs.promises.stat(path.join(BACKUP_DIR, newest))).mtimeMs;
      if (ageMs < BACKUP_MIN_INTERVAL_MS) {
        logger.debug('Backup skipped (throttle)', { ageMs });
        return;
      }
    }

    const compact = JSON.stringify(data);
    const newHash = createHash('sha1').update(compact).digest('hex');
    if (newHash === lastBackupHash && !force) {
      logger.debug('Backup skipped (unchanged)');
      backupDirty = false;
      return;
    }

    const backupFile = path.join(BACKUP_DIR, getBackupFilename());
    await fs.promises.writeFile(backupFile, JSON.stringify(data, null, 2), 'utf8');
    lastBackupHash = newHash;
    backupDirty = false;

    // Alte Snapshots über dem Limit entfernen.
    const all = (await fs.promises.readdir(BACKUP_DIR)).filter(f => f.startsWith('brain.backup.')).sort().reverse();
    for (let i = MAX_BACKUPS; i < all.length; i++) {
      await fs.promises.unlink(path.join(BACKUP_DIR, all[i]));
    }

    logger.debug('Backup created', { file: path.basename(backupFile) });
  } catch (err) {
    logger.error('Backup failed', { error: err.message });
  }
}

function listBackups() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return [];
    return fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('brain.backup.'))
      .sort()
      .reverse()
      .map(f => ({
        filename: f,
        timestamp: f.match(/brain\.backup\.(.+)\.json/)?.[1],
        created: fs.statSync(path.join(BACKUP_DIR, f)).mtime.toISOString(),
      }));
  } catch (err) {
    logger.error('List backups failed', { error: err.message });
    return [];
  }
}

function restoreBackup(filename) {
  const backupPath = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(backupPath)) throw new Error('Backup not found');
  const data = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  if (!data.nodes || !Array.isArray(data.nodes)) throw new Error('Invalid backup structure');
  db.replaceAll(data);
  backupDirty = true; // restaurierter Stand soll ins nächste Snapshot
  logger.info('Backup restored', { filename });
  return db.getBrain();
}

// Nach jedem Write: Health zählen, Frontend live updaten, Backup nur als „dirty"
// markieren (das eigentliche Snapshot übernimmt das Backup-Intervall / Shutdown).
function afterWrite() {
  health.lastWrite = new Date();
  health.writeCount++;
  backupDirty = true;
  const graph = db.getBrain();
  broadcast(graph);
}

// Metadaten-Schreiben (z.B. used_count via brain_mark_used): kein Graph-Broadcast,
// nur Backup-Dirty-Flag.
function markBackupDirty() {
  backupDirty = true;
}

function broadcast(data) {
  const msg = JSON.stringify({ type: 'update', data });
  const failed = [];
  for (const client of wss.clients) {
    try {
      if (client.readyState === 1) client.send(msg);
    } catch (err) {
      logger.error('WS send error', { error: err.message });
      failed.push(client);
    }
  }
  failed.forEach(c => c.close());
}

function broadcastAccess(nodeIds) {
  if (!nodeIds || !nodeIds.length) return;
  const msg = JSON.stringify({ type: 'access', nodeIds });
  for (const client of wss.clients) {
    try { if (client.readyState === 1) client.send(msg); } catch { /* ignore */ }
  }
}

function broadcastLog(action, labels = []) {
  // Persistent speichern (7 Tage Aufbewahrung), Zeitstempel aus der DB übernehmen.
  let ts;
  try { ts = db.logAction(action, labels).ts; }
  catch (err) { logger.error('logAction failed', { error: err.message }); ts = new Date().toISOString(); }
  const msg = JSON.stringify({ type: 'log', action, labels, ts });
  for (const client of wss.clients) {
    try { if (client.readyState === 1) client.send(msg); } catch { /* ignore */ }
  }
}

function getNodeLabel(id) {
  try { return db.getNodeFull(id)?.label ?? String(id); } catch { return String(id); }
}

// ── Validation helpers ──────────────────────────────────────────────────
function validateType(type) {
  return ALLOWED_TYPES.includes(type) ? type : 'note';
}
function validateLabel(label) {
  const s = String(label || '').trim();
  if (!s) throw new Error('label cannot be empty');
  return s;
}
function validateContent(content) {
  return String(content || '').trim();
}
function validateTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags.map(t => String(t).trim()).filter(Boolean);
}
function validateSummary(s) {
  if (s === undefined || s === null) return undefined;
  const v = String(s).trim();
  return v || null;
}
function validateSource(s) {
  if (s === undefined || s === null) return undefined;
  const v = String(s).trim();
  return v || null;
}
function validateTtl(v) {
  if (v === undefined || v === null) return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Gerankte Knotenmenge als {nodes(+score), links} (für semantic/hybrid).
function rankedSubgraph(ranked) {
  const ids = ranked.map(([id]) => id);
  const sub = db.buildSubgraph(ids);
  const scoreMap = new Map(ranked);
  const byId = new Map(sub.nodes.map(n => [n.id, n]));
  const nodes = ids.filter(id => byId.has(id)).map(id => ({ ...byId.get(id), score: +scoreMap.get(id).toFixed(4) }));
  return { nodes, links: sub.links };
}

// Feld-Projektion: schlanke Antworten (z.B. nur id+label+type+tags ohne content)
function projectFields(result, fields) {
  const keys = fields.split(',').map(s => s.trim()).filter(Boolean);
  if (keys.length === 0) return result;
  return {
    nodes: result.nodes.map(n => Object.fromEntries(keys.map(k => [k, n[k]]))),
    links: result.links,
  };
}

// ── Health ──────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  const graph = db.getBrain();
  res.json({
    status: 'ok',
    uptime: Math.floor((Date.now() - health.startTime.getTime()) / 1000),
    lastWrite: health.lastWrite?.toISOString() || null,
    lastError: health.lastError || null,
    writeCount: health.writeCount,
    errorCount: health.errorCount,
    nodeCount: graph.nodes.length,
    linkCount: graph.links.length,
    storage: 'sqlite',
    vectors: db.vecEnabled,
    version: config.VERSION,
  });
});

app.get('/api/brain', async (req, res) => {
  try {
    const { tags, smart, search, depth, fields, view, q, semantic, limit, offset } = req.query;

    let result;

    // Priority: q (hybrid) > semantic > search > tags > smart > full
    let trackIds = null; // gezielter Recall → Zugriff zählen
    if (q) {
      result = rankedSubgraph(await retrieval.rankedIds({ q, mode: 'hybrid', limit }));
      trackIds = result.nodes.map(n => n.id);
      logger.debug('Brain hybrid', { q, nodeCount: result.nodes.length });
    } else if (semantic) {
      result = rankedSubgraph(await retrieval.rankedIds({ q: semantic, mode: 'semantic', limit }));
      trackIds = result.nodes.map(n => n.id);
      logger.debug('Brain semantic', { semantic, nodeCount: result.nodes.length });
    } else if (search) {
      result = db.searchNodes(search);
      trackIds = result.nodes.map(n => n.id);
      logger.debug('Brain search', { query: search, nodeCount: result.nodes.length });
    } else if (tags) {
      const tagList = tags.split(',').map(t => t.trim());
      result = db.getByTags(tagList);
      trackIds = result.nodes.map(n => n.id);
      logger.debug('Brain filter by tags', { tags: tagList, nodeCount: result.nodes.length });
    } else if (smart === 'true' || smart === '1') {
      const depthNum = depth !== undefined ? parseInt(depth, 10) : Infinity;
      result = db.getSmart(isNaN(depthNum) ? Infinity : depthNum);
      logger.debug('Brain smart mode', { nodeCount: result.nodes.length, depth: depthNum });
    } else {
      result = db.getBrain();
    }

    // Feld-Projektion (kombinierbar mit allen Modi). view=index = schlankes Inhaltsverzeichnis.
    const projection = view === 'index' ? 'id,label,type,tags' : fields;
    if (projection) {
      result = projectFields(result, projection);
      logger.debug('Brain projection', { fields: projection, nodeCount: result.nodes.length });
    }

    // Pagination — nur in Listing-Modi (q/semantic sind bereits über `limit` gerankt-begrenzt).
    // Default-Limit schützt große Graphen vor versehentlichen Voll-Dumps; `limit=0`
    // hebt es explizit auf ("alles"). Antwort trägt immer ein pagination-Objekt.
    let pagination = null;
    if (!q && !semantic) {
      const DEFAULT_LIST_LIMIT = 1000;
      const total = result.nodes.length;
      const lim = limit !== undefined ? Math.max(0, parseInt(limit, 10) || 0) : DEFAULT_LIST_LIMIT;
      const off = offset !== undefined ? Math.max(0, parseInt(offset, 10) || 0) : 0;
      if (lim > 0 || off > 0) {
        const sliced = lim > 0 ? result.nodes.slice(off, off + lim) : result.nodes.slice(off);
        const hasId = sliced.length === 0 || 'id' in sliced[0];
        const keep = new Set(sliced.map(n => n.id));
        result = {
          nodes: sliced,
          links: hasId ? result.links.filter(l => keep.has(l.source) && keep.has(l.target)) : result.links,
        };
      }
      pagination = { total, returned: result.nodes.length, limit: lim, offset: off };
    }

    // startNodeId (deterministisch via db.getStartNodeId) für GUI-Glow / Agenten-Einstieg.
    res.json({ ...result, startNodeId: db.getStartNodeId(), ...(pagination ? { pagination } : {}) });

    // Zugriffs-Tracking asynchron, blockiert die Antwort nicht.
    if (trackIds && trackIds.length) {
      setImmediate(() => {
        try { db.touchAccess(trackIds); } catch {}
        broadcastAccess(trackIds);
        broadcastLog('read', trackIds.slice(0, 3).map(id => getNodeLabel(id)));
      });
    }
  } catch (err) {
    logger.error('Brain read failed', { error: err.message });
    res.status(500).json({ error: 'Failed to read brain' });
  }
});

// Token-Budget-Recall: gerankte Kurzfassungen bis zum Budget — der KI-Einstieg.
app.get('/api/recall', async (req, res) => {
  try {
    const query = req.query.q;
    if (!query) return sendError(res, 400, 'q required', { code: 'VALIDATION_ERROR' });

    const doRerank = req.query.rerank === 'true'; // Opt-in (Default aus)
    const doExpand = req.query.expand === 'true'; // A4: Graph-Expansion Opt-in
    const doQExpand = req.query.qexpand === 'true'; // Query-Expansion (PRF) Opt-in
    const typeFilter = req.query.type || undefined; // Typ-Filter: nur Knoten dieses Typs
    const out = await retrieval.recall({ q: query, budget: req.query.budget, limit: req.query.limit, rerank: doRerank, expand: doExpand, qexpand: doQExpand, charsPerToken: req.query.charsPerToken, type: typeFilter });
    res.json(out);
    if (out.results.length) {
      const ids = out.results.map(r => r.id);
      setImmediate(() => {
        try { db.touchAccess(ids); } catch {}
        broadcastAccess(ids);
        broadcastLog('read', out.results.slice(0, 3).map(r => r.label || getNodeLabel(r.id)));
      });
    }
  } catch (err) {
    logger.error('Recall failed', { error: err.message });
    res.status(500).json({ error: 'Failed to recall' });
  }
});

// Session-Briefing: generischer Einstiegskontext für JEDE KI (REST-Parität zu
// brain_briefing). format=md (Default) liefert fertiges Markdown, format=json die
// strukturierten Daten. Gleiche Quelle wie das MCP-Tool → identischer Startkontext.
app.get('/api/briefing', (req, res) => {
  try {
    const b = retrieval.buildBriefing({ budget: req.query.budget, charsPerToken: req.query.charsPerToken });
    if (b.start) {
      const sid = b.start.id;
      setImmediate(() => { try { db.touchAccess([sid]); } catch {} broadcastAccess([sid]); });
    }
    if ((req.query.format || 'md') === 'json') return res.json(b);
    res.type('text/markdown').send(retrieval.briefingMarkdown(b));
  } catch (err) {
    logger.error('Briefing failed', { error: err.message });
    sendError(res, 500, 'Failed to build briefing');
  }
});

// Tool-Katalog für generische Agenten — dieselbe Quelle wie die MCP-Registrierung.
// format=openai → OpenAI-Function-Calling; sonst JSON-Schema je Tool.
const { listToolSchemas } = require('./mcp/tools');
app.get('/api/tools', (req, res) => {
  try {
    const format = req.query.format === 'openai' ? 'openai' : undefined;
    const tools = listToolSchemas({ format });
    res.json({ count: tools.length, format: format || 'jsonschema', tools });
  } catch (err) {
    logger.error('Tool list failed', { error: err.message });
    sendError(res, 500, 'Failed to list tools');
  }
});

// OpenAPI-Spec live ausliefern (JSON kanonisch; YAML für ChatGPT-Actions/Menschen).
// Version stammt aus config → kein Drift gegen package.json.
const openapiSpec = require('./openapi');
app.get('/openapi.json', (req, res) => res.json(openapiSpec));
app.get(['/openapi.yaml', '/openapi.yml'], (req, res) => {
  try {
    const yaml = require('js-yaml');
    res.type('text/yaml').send(yaml.dump(openapiSpec));
  } catch {
    // js-yaml optional — JSON ist für Importer ebenso gültig.
    res.type('application/json').send(JSON.stringify(openapiSpec, null, 2));
  }
});

// B2: Link-Vorschläge (semantisch ähnliche, unverlinkte Knotenpaare)
app.get('/api/brain/suggest-links', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 20;
    const suggestions = await retrieval.suggestLinks({ limit });
    res.json({ count: suggestions.length, suggestions });
  } catch (err) {
    res.status(500).json({ error: 'Failed to suggest links' });
  }
});

// B1: Link-Vorschlag verwerfen — Paar wird in suggestLinks/Gärtner künftig übersprungen.
app.post('/api/brain/suggest-links/dismiss', (req, res) => {
  try {
    const { source, target } = req.body;
    if (!source || !target) return res.status(400).json({ error: 'source and target required' });
    db.dismissSuggestion(source, target);
    markBackupDirty();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to dismiss suggestion' });
  }
});

// C3: Usage-Feedback (REST-Parität zu brain_mark_used).
app.post('/api/brain/mark-used', (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    if (!ids.length) return res.status(400).json({ error: 'ids required' });
    const marked = db.markUsed(ids);
    markBackupDirty();
    broadcastAccess(ids);
    res.json({ ok: true, marked });
  } catch (err) {
    res.status(500).json({ error: 'Failed to mark used' });
  }
});

// Metriken: Latenzen/Durchsatz (prozesslokal) + Bestands-/Verhaltensstatistik (DB).
app.get('/api/metrics', (req, res) => {
  try {
    const m = metrics.snapshot();
    const stats = db.getStats({ logDays: config.LOG_RETENTION_DAYS });
    res.json({
      uptime: Math.floor((Date.now() - health.startTime.getTime()) / 1000),
      ...m,
      stats,
    });
  } catch (err) {
    logger.error('Metrics failed', { error: err.message });
    sendError(res, 500, 'Failed to build metrics');
  }
});

// Health-Report (Graph-Hygiene)
app.get('/api/brain/health-report', (req, res) => {
  try {
    res.json(db.getHealthReport());
  } catch (err) {
    res.status(500).json({ error: 'Failed to build health report' });
  }
});

// Gärtner manuell anstoßen (läuft sonst täglich automatisch).
app.post('/api/brain/maintenance', async (req, res) => {
  const result = await gardenerRun('manual');
  if (result.error) return res.status(500).json(result);
  res.json(result);
});

// ── Auto-Capture / Inbox ────────────────────────────────────────────────
// Kandidaten aus Sessions landen als normale Knoten mit Tag `inbox` + TTL +
// source=session:<id> (kein Schema-Zusatz). Dedup via operations.createNode
// verhindert Re-Capture bekannten Wissens; nie reviewte Items laufen via TTL ab.
const INBOX_TAG = 'inbox';
const INBOX_MAX_NODES = 10; // Deckel pro Session gegen Extraktions-Ausreißer
// Auto-Promote: Knoten mit confidence >= Schwelle direkt als reguläre Knoten anlegen.
// 0 = immer manuell; 1 = nie auto. Env-Var BRAIN_AUTO_ACCEPT_THRESHOLD (Default 0.85).
const AUTO_ACCEPT_THRESHOLD = parseFloat(process.env.BRAIN_AUTO_ACCEPT_THRESHOLD || '0.85');

// Inbox-Kandidaten mit Ablaufdatum (für GUI/Agenten-Review).
function listInbox() {
  const sub = db.getByTags([INBOX_TAG]);
  return sub.nodes.map(n => {
    const full = db.getNodeFull(n.id);
    return {
      id: n.id, label: n.label, type: n.type, tags: n.tags,
      summary: full?.summary || null,
      preview: full ? retrieval.previewText(full) : '',
      source: full?.source || null,
      created: full?.created || n.created || null,
      expires_at: full?.expires_at || null,
    };
  });
}

app.get('/api/inbox', (req, res) => {
  try {
    const items = listInbox();
    res.json({ count: items.length, items });
  } catch (err) {
    logger.error('Inbox list failed', { error: err.message });
    sendError(res, 500, 'Failed to list inbox');
  }
});

app.post('/api/inbox', async (req, res) => {
  try {
    const sessionId = String(req.body.session_id || '').trim();
    const raw = Array.isArray(req.body.nodes) ? req.body.nodes : [];
    if (!raw.length) return sendError(res, 400, 'nodes required', { code: 'VALIDATION_ERROR' });

    // Auf INBOX_MAX_NODES kappen und Capture-Metadaten erzwingen.
    const source = sessionId ? `session:${sessionId}` : 'session:unknown';
    const nodes = raw.slice(0, INBOX_MAX_NODES).map(n => {
      const confidence = typeof n.confidence === 'number' ? n.confidence : 0;
      const autoAccept = AUTO_ACCEPT_THRESHOLD > 0 && confidence >= AUTO_ACCEPT_THRESHOLD;
      return {
        label: validateLabel(n.label),
        type: validateType(n.type),
        content: validateContent(n.content),
        summary: validateSummary(n.summary) ?? null,
        // Auto-Promote: bei hohem Confidence direkt als regulärer Knoten, kein Review nötig.
        tags: autoAccept
          ? [...new Set(validateTags(n.tags))]
          : [...new Set([...validateTags(n.tags), INBOX_TAG])],
        source,
        ttl: autoAccept ? null : config.INBOX_TTL,
        force: false, // Dedup aktiv lassen → bekanntes Wissen nicht doppeln
        _autoAccepted: autoAccept, // intern für Logging
      };
    });

    const out = await operations.bulkCreate({ nodes: nodes.map(({ _autoAccepted, ...n }) => n) });
    const autoAccepted = nodes.filter(n => n._autoAccepted).length;
    if (out.created > 0) {
      afterWrite();
      broadcastLog('created', out.results.filter(r => r.ok).slice(0, 3).map(r => r.label));
    }
    logger.info('Inbox intake', { session: sessionId, created: out.created, skipped: out.failed, autoAccepted });
    res.json({ ...out, autoAccepted });
  } catch (err) {
    health.errorCount++;
    health.lastError = err.message;
    sendError(res, 400, err.message, { code: 'VALIDATION_ERROR' });
  }
});

// Kandidat annehmen: inbox-Tag entfernen + TTL löschen → regulärer Daueknoten.
app.post('/api/inbox/:id/accept', async (req, res) => {
  try {
    const full = db.getNodeFull(req.params.id);
    if (!full) return sendError(res, 404, 'Node not found', { code: 'NOT_FOUND' });
    const tags = (full.tags || []).filter(t => t !== INBOX_TAG);
    const r = await operations.updateNode(req.params.id, { tags, ttl: null });
    if (r.error === 'not_found') return sendError(res, 404, 'Node not found', { code: 'NOT_FOUND' });
    afterWrite();
    broadcastLog('updated', [r.node.label]);
    logger.info('Inbox accepted', { id: req.params.id, label: r.node.label });
    res.json(r.node);
  } catch (err) {
    health.errorCount++;
    health.lastError = err.message;
    sendError(res, 400, err.message, { code: 'VALIDATION_ERROR' });
  }
});

// Review-Entscheidungen (accepted/rejected/expired) als Trainingsdaten-Export.
// format=jsonl liefert eine Entscheidung pro Zeile (direkt Fine-Tune-tauglich).
app.get('/api/inbox/decisions', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 500, 5000);
    const items = db.getInboxDecisions({ limit });
    if (req.query.format === 'jsonl') {
      res.type('text/plain');
      return res.send(items.map(i => JSON.stringify(i)).join('\n'));
    }
    res.json({ count: items.length, items });
  } catch (err) {
    logger.error('Inbox decisions list failed', { error: err.message });
    sendError(res, 500, 'Failed to list inbox decisions');
  }
});

app.post('/api/nodes', async (req, res) => {
  try {
    const label = validateLabel(req.body.label);
    const type = validateType(req.body.type);
    const content = validateContent(req.body.content);
    const tags = validateTags(req.body.tags);
    const summary = validateSummary(req.body.summary);
    const source = validateSource(req.body.source);
    const ttl = validateTtl(req.body.ttl);
    const force = req.query.force === 'true' || req.body.force === true;

    const r = await operations.createNode({
      label, type, content, tags, summary: summary ?? null, source: source ?? null, ttl: ttl ?? null, force,
    });
    if (r.error === 'label_exists') {
      return sendError(res, 409, 'Label already exists', { code: 'LABEL_EXISTS', existing: r.existing });
    }
    if (r.error === 'similar_exists') {
      return sendError(res, 409, 'Similar node exists', {
        code: 'SIMILAR_EXISTS', similarity: r.similarity, similar: r.similar,
        hint: 'POST mit ?force=true zum Anlegen trotzdem',
      });
    }
    afterWrite();
    broadcastLog('created', [label]);
    logger.info('Node created', { label, id: r.node.id });
    res.json(r.node);
  } catch (err) {
    health.errorCount++;
    health.lastError = err.message;
    sendError(res, 400, err.message, { code: 'VALIDATION_ERROR' });
  }
});

app.put('/api/nodes/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const updates = {};
    if (req.body.label !== undefined) updates.label = validateLabel(req.body.label);
    if (req.body.type !== undefined) updates.type = validateType(req.body.type);
    if (req.body.content !== undefined) updates.content = validateContent(req.body.content);
    if (req.body.tags !== undefined) updates.tags = validateTags(req.body.tags);
    if (req.body.summary !== undefined) updates.summary = validateSummary(req.body.summary);
    if (req.body.source !== undefined) updates.source = validateSource(req.body.source);
    if ('ttl' in req.body) updates.ttl = req.body.ttl === null ? null : validateTtl(req.body.ttl);

    const r = await operations.updateNode(id, updates);
    if (r.error === 'not_found') return sendError(res, 404, 'Node not found', { code: 'NOT_FOUND' });

    afterWrite();
    broadcastLog('updated', [r.node.label]);
    logger.info('Node updated', { id, fields: Object.keys(updates) });
    res.json(r.node);
  } catch (err) {
    health.errorCount++;
    health.lastError = err.message;
    sendError(res, 400, err.message, { code: 'VALIDATION_ERROR' });
  }
});

app.delete('/api/nodes/:id', (req, res) => {
  try {
    const result = db.deleteNode(req.params.id);
    if (!result) return sendError(res, 404, 'Node not found', { code: 'NOT_FOUND' });

    afterWrite();
    broadcastLog('deleted', [result.label]);
    logger.info('Node deleted', { id: req.params.id, label: result.label });
    res.json({ ok: true });
  } catch (err) {
    health.errorCount++;
    health.lastError = err.message;
    res.status(500).json({ error: 'Failed to delete node' });
  }
});

// Einzelknoten (Drill-down, voll inkl. Lifecycle) + Zugriff zählen
app.get('/api/nodes/:id', (req, res) => {
  try {
    const node = db.getNodeFull(req.params.id);
    if (!node) return sendError(res, 404, 'Node not found', { code: 'NOT_FOUND' });
    const nid = req.params.id;
    setImmediate(() => {
      try { db.touchAccess([nid]); } catch {}
      broadcastAccess([nid]);
      broadcastLog('read', [node.label]);
    });
    res.json(node);
  } catch (err) {
    res.status(500).json({ error: 'Failed to read node' });
  }
});

// Versionshistorie eines Knotens
app.get('/api/nodes/:id/history', (req, res) => {
  try {
    res.json(db.getHistory(req.params.id));
  } catch (err) {
    res.status(500).json({ error: 'Failed to read history' });
  }
});

// C1: Nachbar-Subgraph eines Knotens (fürs GUI-Kontextmenü / Agenten-REST-Parität).
app.get('/api/nodes/:id/neighbors', (req, res) => {
  try {
    const out = retrieval.neighbors({
      id: req.params.id,
      depth: req.query.depth,
      direction: req.query.direction,
    });
    if (!out) return sendError(res, 404, 'Node not found', { code: 'NOT_FOUND' });
    res.json(out);
  } catch (err) {
    sendError(res, 500, 'Failed to read neighbors');
  }
});

// Auf eine frühere Version zurücksetzen (oder gelöschten Knoten wiederherstellen)
// C1: operations.revertNode stellt Vektor korrekt wieder her.
app.post('/api/nodes/:id/revert/:version', async (req, res) => {
  try {
    const version = parseInt(req.params.version, 10);
    if (isNaN(version)) return sendError(res, 400, 'Invalid version', { code: 'VALIDATION_ERROR' });
    const r = await operations.revertNode(req.params.id, version);
    if (r.error === 'not_found') return sendError(res, 404, 'Version not found', { code: 'NOT_FOUND' });
    afterWrite();
    logger.info('Node reverted', { id: req.params.id, toVersion: version });
    res.json(r.node);
  } catch (err) {
    health.errorCount++;
    health.lastError = err.message;
    res.status(500).json({ error: 'Failed to revert node' });
  }
});

app.post('/api/links', (req, res) => {
  try {
    const { source, target, label = '', type = null } = req.body;
    if (!source || !target) return sendError(res, 400, 'source and target required', { code: 'VALIDATION_ERROR' });
    if (source === target) return sendError(res, 400, 'Cannot link node to itself', { code: 'VALIDATION_ERROR' });

    const relType = type ? String(type).trim() || null : null;
    const result = db.createLink(source, target, label, relType);
    if (result.error === 'source') return sendError(res, 404, 'Source node not found', { code: 'NOT_FOUND' });
    if (result.error === 'target') return sendError(res, 404, 'Target node not found', { code: 'NOT_FOUND' });

    if (result.created) {
      afterWrite();
      broadcastLog('linked', [getNodeLabel(source), getNodeLabel(target)]);
      logger.info('Link created', { source, target, type: relType || undefined });
    }
    res.json(relType ? { source, target, label, rel_type: relType } : { source, target, label });
  } catch (err) {
    health.errorCount++;
    health.lastError = err.message;
    res.status(500).json({ error: 'Failed to create link' });
  }
});

// B3: Label/rel_type einer bestehenden Kante ändern (GUI-Link-Editor).
app.put('/api/links', (req, res) => {
  try {
    const { source, target } = req.body;
    if (!source || !target) return res.status(400).json({ error: 'source and target required' });
    const patch = {};
    if (req.body.label !== undefined) patch.label = String(req.body.label);
    if (req.body.type !== undefined) patch.relType = req.body.type ? String(req.body.type).trim() || null : null;
    const result = db.updateLink(source, target, patch);
    if (result.error === 'not_found') return res.status(404).json({ error: 'Link not found' });
    if (result.error === 'no_changes') return res.status(400).json({ error: 'No changes provided' });
    afterWrite();
    broadcastLog('updated', [getNodeLabel(source), getNodeLabel(target)]);
    res.json(result.link);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update link' });
  }
});

app.delete('/api/links', (req, res) => {
  try {
    const { source, target } = req.body;
    if (!source || !target) return res.status(400).json({ error: 'source and target required' });

    const result = db.deleteLink(source, target);
    if (result.deleted) {
      afterWrite();
      broadcastLog('unlinked', [getNodeLabel(source), getNodeLabel(target)]);
      logger.info('Link deleted', { source, target });
    }
    res.json({ ok: true });
  } catch (err) {
    health.errorCount++;
    health.lastError = err.message;
    res.status(500).json({ error: 'Failed to delete link' });
  }
});

// ── Backup endpoints ────────────────────────────────────────────────────
app.get('/api/backups', (req, res) => {
  try {
    res.json(listBackups());
  } catch (err) {
    res.status(500).json({ error: 'Failed to list backups' });
  }
});

app.post('/api/restore/:filename', (req, res) => {
  try {
    const filename = req.params.filename;
    if (!filename.match(/^brain\.backup\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z?\.json$/)) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
    restoreBackup(filename);
    afterWrite();
    res.json({ ok: true, message: 'Restored from ' + filename });
  } catch (err) {
    health.errorCount++;
    health.lastError = err.message;
    res.status(500).json({ error: err.message });
  }
});

// ── Markdown-Import (YAML-Frontmatter + [[wikilinks]]) ──────────────────
function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };
  const meta = {};
  for (const line of match[1].split('\n')) {
    const m = line.match(/^(\w+):\s*(.+)$/);
    if (!m) continue;
    const [, key, val] = m;
    if (val.startsWith('[')) {
      meta[key] = val.slice(1, -1).split(',').map(s => s.trim().replace(/['"]/g, ''));
    } else {
      meta[key] = val.trim().replace(/^['"]|['"]$/g, '');
    }
  }
  return { meta, body: match[2] };
}

app.post('/api/import', (req, res) => {
  try {
    const { dirPath } = req.body;
    if (!dirPath) return res.status(400).json({ error: 'dirPath required' });

    let resolvedPath;
    try {
      const expanded = dirPath.replace(/^~/, process.env.HOME || '/root');
      resolvedPath = path.resolve(expanded);
    } catch {
      return res.status(400).json({ error: 'Invalid path' });
    }

    const homeDir = process.env.HOME || '/root';
    if (!resolvedPath.startsWith(homeDir) && !resolvedPath.startsWith('/tmp')) {
      return res.status(403).json({ error: 'Path outside allowed directories' });
    }
    if (!fs.existsSync(resolvedPath)) {
      return res.status(404).json({ error: 'Path not found' });
    }

    let files;
    try {
      files = fs.readdirSync(resolvedPath).filter(f => f.endsWith('.md'));
    } catch {
      return res.status(403).json({ error: 'No read permission' });
    }
    if (files.length === 0) {
      return res.json({ imported: 0, updated: 0, links: 0, total: 0 });
    }

    let imported = 0;
    let updated = 0;

    for (const file of files) {
      if (file === 'MEMORY.md') continue;
      try {
        const raw = fs.readFileSync(path.join(resolvedPath, file), 'utf8');
        const { meta, body } = parseFrontmatter(raw);

        const label = meta.name || meta.title || file.replace(/\.md$/, '');
        const type = validateType(meta.type);
        const tags = validateTags(meta.tags);

        try { validateLabel(label); }
        catch { logger.warn('Import: skipped file', { file, reason: 'invalid label' }); continue; }

        const existing = db.findByLabel(label);
        if (existing) {
          db.updateNode(existing.id, { content: body.trim(), tags });
          updated++;
        } else {
          db.createNode({ label, type, content: body.trim(), tags });
          imported++;
        }
      } catch (err) {
        logger.error('Import: file read error', { file, error: err.message });
      }
    }

    // B1: Wikilinks → Kanten auflösen (via operations.resolveWikilinks, eine Quelle)
    let newLinks = 0;
    const graph = db.getBrain();
    const linksBefore = graph.links.length;
    for (const node of graph.nodes) {
      operations.resolveWikilinks(node.id, node.content);
    }
    newLinks = db.getBrain().links.length - linksBefore;

    afterWrite();
    logger.info('Import completed', { imported, updated, links: newLinks });
    res.json({ imported, updated, links: newLinks, total: files.length });
  } catch (err) {
    health.errorCount++;
    health.lastError = err.message;
    res.status(400).json({ error: err.message });
  }
});

// ── MCP über Streamable HTTP (stateless) ────────────────────────────────
// Damit jede MCP-fähige KI Brain nativ als Tools nutzt. In-Process →
// onWrite=afterWrite broadcastet Änderungen an die Frontend-WS-Clients.
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { buildServer: buildMcpServer } = require('./mcp/tools');
const MCP_TOKEN = process.env.BRAIN_MCP_TOKEN || '';

function mcpAuth(req, res, next) {
  if (!MCP_TOKEN) return next();
  if ((req.headers['authorization'] || '') === 'Bearer ' + MCP_TOKEN) return next();
  res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
}

app.post('/mcp', mcpAuth, async (req, res) => {
  try {
    const mcp = buildMcpServer({ onWrite: afterWrite, onAccess: broadcastAccess, onLog: broadcastLog, onMetaWrite: markBackupDirty });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); mcp.close(); });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    logger.error('MCP request failed', { error: err.message });
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
  }
});
// Stateless: kein SSE-Stream / keine Sessions
const mcpMethodNotAllowed = (req, res) =>
  res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless mode)' }, id: null });
app.get('/mcp', mcpAuth, mcpMethodNotAllowed);
app.delete('/mcp', mcpAuth, mcpMethodNotAllowed);

const PORT = config.PORT;
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', ws => {
  try {
    const graph = db.getBrain();
    ws.send(JSON.stringify({ type: 'update', data: { ...graph, startNodeId: db.getStartNodeId() } }));
    try {
      const entries = db.getRecentLog(7);
      ws.send(JSON.stringify({ type: 'log-history', entries }));
    } catch (err) {
      logger.error('log-history send failed', { error: err.message });
    }
    logger.debug('Client connected', { clients: wss.clients.size });
  } catch (err) {
    logger.error('WS init error', { error: err.message });
  }
});

// Ephemeral-Cleanup: abgelaufene TTL-Knoten entfernen (alle 60s)
setInterval(() => {
  try {
    const prunedLogs = db.pruneLog(config.LOG_RETENTION_DAYS);
    if (prunedLogs > 0) logger.debug('Action-Log gepruned', { count: prunedLogs });
    const n = db.deleteExpired();
    if (n > 0) {
      logger.info('Ephemeral nodes expired', { count: n });
      backupDirty = true; // gelöschte Knoten sollen ins nächste Snapshot
      const graph = db.getBrain();
      broadcast({ ...graph, startNodeId: db.getStartNodeId() });
    }
  } catch (err) {
    logger.error('Ephemeral cleanup failed', { error: err.message });
  }
}, 60_000);

// Gärtner: tägliche Selbstpflege (Bericht + ggf. Auto-Links) — rein
// deterministisch, 0 Token. Erstlauf verzögert (Embedding-Warmup abwarten).
async function gardenerRun(trigger) {
  try {
    const result = await gardener.runMaintenance();
    if (result.changed) afterWrite();
    logger.info('Gardener run', { trigger, ...result });
    return result;
  } catch (err) {
    logger.error('Gardener run failed', { trigger, error: err.message });
    return { error: err.message };
  }
}
setInterval(() => gardenerRun('hourly'), 60 * 60_000);

// Embedding-Drain: Knoten ohne Vektor nachträglich embedden (z.B. Kaltstart-Skip
// in operations.createNode oder Modellwechsel). Sequentiell, niedrige Priorität.
// Läuft nach dem Warmup einmalig und danach alle 5 Min.
let draining = false;
async function drainEmbeddings(trigger) {
  if (draining || !db.vecEnabled) return;
  draining = true;
  let done = 0;
  try {
    const todo = db.nodesNeedingEmbedding();
    for (const row of todo) {
      const full = db.getNodeFull(row.id);
      if (!full) continue;
      try {
        const vec = await embed(operations.embeddingText(full), 'passage');
        db.upsertEmbedding(row.id, vec, MODEL);
        done++;
      } catch (err) {
        logger.error('Drain embed failed', { id: row.id, error: err.message });
      }
      await new Promise(r => setImmediate(r)); // Event-Loop nicht blockieren
    }
    if (done > 0) logger.info('Embedding drain', { trigger, embedded: done });
  } catch (err) {
    logger.error('Embedding drain failed', { trigger, error: err.message });
  } finally {
    draining = false;
  }
}
const DRAIN_CHECK_MS = 5 * 60 * 1000;
setInterval(() => drainEmbeddings('interval'), DRAIN_CHECK_MS);

// Backup-Intervall: alle 10 Min prüfen, ob seit dem letzten Snapshot geschrieben
// wurde (Throttle/Hash-Skip in createBackup). Entkoppelt I/O vom Request-Pfad.
const BACKUP_CHECK_MS = 10 * 60 * 1000;
setInterval(() => {
  if (backupDirty) createBackup(db.exportGraph());
}, BACKUP_CHECK_MS);

// Graceful Shutdown: letztes Backup erzwingen, damit ein Restart nichts verliert.
let shuttingDown = false;
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Shutdown', { signal });
  const done = () => { try { logStream.end(); } catch {} process.exit(0); };
  const finish = backupDirty
    ? createBackup(db.exportGraph(), { force: true }).catch(() => {})
    : Promise.resolve();
  finish.finally(done);
  setTimeout(done, 5000).unref(); // Notausstieg, falls Backup hängt
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

server.listen(PORT, '0.0.0.0', () => {
  logger.info('Brain server started', { port: PORT, storage: 'sqlite', vectors: db.vecEnabled });
  console.log(`\n✅ Brain läuft auf Port ${PORT} (SQLite${db.vecEnabled ? ' + sqlite-vec' : ''})`);
  console.log(`   Lokal:   http://localhost:${PORT}`);
  console.log(`   Health:  http://localhost:${PORT}/api/health`);
  console.log(`   Recall:  http://localhost:${PORT}/api/recall?q=...\n`);

  initBackupHash(); // Hash des letzten Snapshots in den Speicher laden

  // Embedding-Modell vorwärmen, damit der erste Recall schnell ist.
  // Gärtner-Erstlauf direkt ans Warmup koppeln (statt blindem Timer).
  if (db.vecEnabled) {
    warmup()
      .then(() => logger.info('Embedding model warm', { model: MODEL }))
      .catch(e => logger.error('Embedding warmup failed', { error: e.message }))
      .finally(() => { gardenerRun('startup'); drainEmbeddings('startup'); });
  } else {
    gardenerRun('startup');
  }
});

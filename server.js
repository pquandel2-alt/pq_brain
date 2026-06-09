const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');
const { createHash } = require('crypto');
const db = require('./db');
const { warmup, MODEL } = require('./embeddings');
const retrieval = require('./retrieval');
const operations = require('./operations');

const app = express();
const BACKUP_DIR = path.join(__dirname, 'data', 'backups');
const LOG_FILE = path.join(__dirname, 'logs', 'brain.log');
const ALLOWED_TYPES = ['memory', 'note', 'idea', 'project', 'reference'];
const MAX_BACKUPS = 72;                          // ~3 Tage bei stündlichem Takt
const BACKUP_MIN_INTERVAL_MS = 60 * 60 * 1000;   // max. 1 Backup pro Stunde

// Ensure directories exist
[BACKUP_DIR, path.dirname(LOG_FILE)].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Logger
const logger = {
  log(level, message, context = {}) {
    const timestamp = new Date().toISOString();
    const entry = { timestamp, level, message, ...context };
    const line = JSON.stringify(entry);

    console.log(`[${level}] ${timestamp} ${message}`);
    try {
      fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
    } catch (err) {
      console.error('Failed to write log:', err.message);
    }
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

function createBackup(data) {
  try {
    if (!fs.existsSync(BACKUP_DIR)) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }

    // Frequenz von der Write-Frequenz entkoppeln: gegen das neueste Backup prüfen.
    const newest = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('brain.backup.'))
      .sort()
      .pop();

    if (newest) {
      const newestPath = path.join(BACKUP_DIR, newest);
      const ageMs = Date.now() - fs.statSync(newestPath).mtimeMs;
      if (ageMs < BACKUP_MIN_INTERVAL_MS) {
        logger.debug('Backup skipped (throttle)', { ageMs });
        return;
      }
      const newHash = createHash('sha1').update(JSON.stringify(data)).digest('hex');
      try {
        const prev = JSON.parse(fs.readFileSync(newestPath, 'utf8'));
        const prevHash = createHash('sha1').update(JSON.stringify(prev)).digest('hex');
        if (newHash === prevHash) {
          logger.debug('Backup skipped (unchanged)');
          return;
        }
      } catch { /* fehlerhaftes Backup ignorieren, neues schreiben */ }
    }

    const backupFile = path.join(BACKUP_DIR, getBackupFilename());
    fs.writeFileSync(backupFile, JSON.stringify(data, null, 2), 'utf8');

    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('brain.backup.'))
      .sort()
      .reverse();
    for (let i = MAX_BACKUPS; i < files.length; i++) {
      fs.unlinkSync(path.join(BACKUP_DIR, files[i]));
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
  logger.info('Backup restored', { filename });
  return db.getBrain();
}

// Nach jedem Write: Health zählen, Frontend live updaten, Backup-Snapshot (async).
function afterWrite() {
  health.lastWrite = new Date();
  health.writeCount++;
  const graph = db.getBrain();
  broadcast(graph);
  setImmediate(() => createBackup(db.exportGraph()));
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
    version: '2.0.0',
  });
});

app.get('/api/brain', async (req, res) => {
  try {
    const { tags, smart, search, depth, fields, view, q, semantic, limit } = req.query;

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

    // startNodeId für GUI-Glow (immer mitliefern, token-lean: nur die ID)
    const startNode = result.nodes?.find?.(n => n.label === 'Claude – Startpunkt' || n.label === 'Start');
    res.json({ ...result, startNodeId: startNode?.id ?? null });

    // Zugriffs-Tracking asynchron, blockiert die Antwort nicht.
    if (trackIds && trackIds.length) {
      setImmediate(() => {
        try { db.touchAccess(trackIds); } catch {}
        broadcastAccess(trackIds);
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
    if (!query) return res.status(400).json({ error: 'q required' });

    const doRerank = req.query.rerank === 'true'; // Opt-in (Default aus)
    const out = await retrieval.recall({ q: query, budget: req.query.budget, limit: req.query.limit, rerank: doRerank });
    res.json(out);
    if (out.results.length) {
      const ids = out.results.map(r => r.id);
      setImmediate(() => {
        try { db.touchAccess(ids); } catch {}
        broadcastAccess(ids);
      });
    }
  } catch (err) {
    logger.error('Recall failed', { error: err.message });
    res.status(500).json({ error: 'Failed to recall' });
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
      return res.status(409).json({ error: 'Label already exists', existing: r.existing });
    }
    if (r.error === 'similar_exists') {
      return res.status(409).json({
        error: 'Similar node exists', similarity: r.similarity, similar: r.similar,
        hint: 'POST mit ?force=true zum Anlegen trotzdem',
      });
    }
    afterWrite();
    logger.info('Node created', { label, id: r.node.id });
    res.json(r.node);
  } catch (err) {
    health.errorCount++;
    health.lastError = err.message;
    res.status(400).json({ error: err.message });
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
    if (r.error === 'not_found') return res.status(404).json({ error: 'Node not found' });

    afterWrite();
    logger.info('Node updated', { id, fields: Object.keys(updates) });
    res.json(r.node);
  } catch (err) {
    health.errorCount++;
    health.lastError = err.message;
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/nodes/:id', (req, res) => {
  try {
    const result = db.deleteNode(req.params.id);
    if (!result) return res.status(404).json({ error: 'Node not found' });

    afterWrite();
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
    if (!node) return res.status(404).json({ error: 'Node not found' });
    const nid = req.params.id;
    setImmediate(() => {
      try { db.touchAccess([nid]); } catch {}
      broadcastAccess([nid]);
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

// Auf eine frühere Version zurücksetzen (oder gelöschten Knoten wiederherstellen)
app.post('/api/nodes/:id/revert/:version', (req, res) => {
  try {
    const version = parseInt(req.params.version, 10);
    if (isNaN(version)) return res.status(400).json({ error: 'Invalid version' });
    const node = db.revertNode(req.params.id, version);
    if (!node) return res.status(404).json({ error: 'Version not found' });
    afterWrite();
    logger.info('Node reverted', { id: req.params.id, toVersion: version });
    res.json(node);
  } catch (err) {
    health.errorCount++;
    health.lastError = err.message;
    res.status(500).json({ error: 'Failed to revert node' });
  }
});

app.post('/api/links', (req, res) => {
  try {
    const { source, target, label = '', type = null } = req.body;
    if (!source || !target) return res.status(400).json({ error: 'source and target required' });
    if (source === target) return res.status(400).json({ error: 'Cannot link node to itself' });

    const relType = type ? String(type).trim() || null : null;
    const result = db.createLink(source, target, label, relType);
    if (result.error === 'source') return res.status(404).json({ error: 'Source node not found' });
    if (result.error === 'target') return res.status(404).json({ error: 'Target node not found' });

    if (result.created) {
      afterWrite();
      logger.info('Link created', { source, target, type: relType || undefined });
    }
    res.json(relType ? { source, target, label, rel_type: relType } : { source, target, label });
  } catch (err) {
    health.errorCount++;
    health.lastError = err.message;
    res.status(500).json({ error: 'Failed to create link' });
  }
});

app.delete('/api/links', (req, res) => {
  try {
    const { source, target } = req.body;
    if (!source || !target) return res.status(400).json({ error: 'source and target required' });

    const result = db.deleteLink(source, target);
    if (result.deleted) {
      afterWrite();
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

    // Wikilinks → Kanten auflösen
    let newLinks = 0;
    const graph = db.getBrain();
    const labelMap = new Map(graph.nodes.map(n => [n.label, n]));
    for (const node of graph.nodes) {
      const matches = [...(node.content || '').matchAll(/\[\[([^\]]+)\]\]/g)];
      for (const m of matches) {
        const target = labelMap.get(m[1].trim());
        if (!target || target.id === node.id) continue;
        const r = db.createLink(node.id, target.id, '');
        if (r.created) newLinks++;
      }
    }

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
    const mcp = buildMcpServer({ onWrite: afterWrite });
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

const PORT = process.env.PORT || 3000;
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', ws => {
  try {
    const graph = db.getBrain();
    const startNode = graph.nodes.find(n => n.label === 'Claude – Startpunkt' || n.label === 'Start');
    ws.send(JSON.stringify({ type: 'update', data: { ...graph, startNodeId: startNode?.id ?? null } }));
    logger.debug('Client connected', { clients: wss.clients.size });
  } catch (err) {
    logger.error('WS init error', { error: err.message });
  }
});

// Ephemeral-Cleanup: abgelaufene TTL-Knoten entfernen (alle 60s)
setInterval(() => {
  try {
    const n = db.deleteExpired();
    if (n > 0) {
      logger.info('Ephemeral nodes expired', { count: n });
      const graph = db.getBrain();
      const startNode = graph.nodes.find(nd => nd.label === 'Claude – Startpunkt' || nd.label === 'Start');
      broadcast({ ...graph, startNodeId: startNode?.id ?? null });
    }
  } catch (err) {
    logger.error('Ephemeral cleanup failed', { error: err.message });
  }
}, 60_000);

server.listen(PORT, '0.0.0.0', () => {
  logger.info('Brain server started', { port: PORT, storage: 'sqlite', vectors: db.vecEnabled });
  console.log(`\n✅ Brain läuft auf Port ${PORT} (SQLite${db.vecEnabled ? ' + sqlite-vec' : ''})`);
  console.log(`   Lokal:   http://localhost:${PORT}`);
  console.log(`   Health:  http://localhost:${PORT}/api/health`);
  console.log(`   Recall:  http://localhost:${PORT}/api/recall?q=...\n`);

  // Embedding-Modell vorwärmen, damit der erste Recall schnell ist.
  if (db.vecEnabled) {
    warmup()
      .then(() => logger.info('Embedding model warm', { model: MODEL }))
      .catch(e => logger.error('Embedding warmup failed', { error: e.message }));
  }
});

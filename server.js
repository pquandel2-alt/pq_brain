const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');
const { randomUUID } = require('crypto');

const app = express();
const DATA_FILE = path.join(__dirname, 'data', 'brain.json');
const BACKUP_DIR = path.join(__dirname, 'data', 'backups');
const LOG_FILE = path.join(__dirname, 'logs', 'brain.log');
const ALLOWED_TYPES = ['memory', 'note', 'idea', 'project', 'reference'];
const MAX_BACKUPS = 7;

// Ensure directories exist
[path.dirname(BACKUP_DIR), path.dirname(LOG_FILE)].forEach(dir => {
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

// Backup management
function getBackupFilename() {
  const now = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  return `brain.backup.${now}.json`;
}

function createBackup(data) {
  try {
    if (!fs.existsSync(BACKUP_DIR)) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }

    const backupFile = path.join(BACKUP_DIR, getBackupFilename());
    fs.writeFileSync(backupFile, JSON.stringify(data, null, 2), 'utf8');

    // Cleanup old backups (keep only MAX_BACKUPS)
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('brain.backup.'))
      .sort()
      .reverse();

    for (let i = MAX_BACKUPS; i < files.length; i++) {
      fs.unlinkSync(path.join(BACKUP_DIR, files[i]));
    }

    logger.debug('Backup created', { file: getBackupFilename() });
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
  try {
    const backupPath = path.join(BACKUP_DIR, filename);
    if (!fs.existsSync(backupPath)) {
      throw new Error('Backup not found');
    }
    const data = JSON.parse(fs.readFileSync(backupPath, 'utf8'));

    // Validate structure
    if (!data.nodes || !Array.isArray(data.nodes)) {
      throw new Error('Invalid backup structure');
    }

    // Write restored data
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, DATA_FILE);

    logger.info('Backup restored', { filename });
    return data;
  } catch (err) {
    logger.error('Restore failed', { error: err.message, filename });
    throw err;
  }
}

// Write queue to prevent race conditions
let writeQueue = Promise.resolve();
function enqueueWrite(fn) {
  writeQueue = writeQueue.then(fn).catch(err => {
    health.errorCount++;
    health.lastError = err.message;
    logger.error('Write error', { error: err.message });
    throw err;
  });
  return writeQueue;
}

function readBrain() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (err) {
    logger.warn('Read failed, returning empty', { error: err.message });
    return { nodes: [], links: [] };
  }
}

function writeBrainSync(data) {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE);

  health.lastWrite = new Date();
  health.writeCount++;

  // Create backup on every write (or you could do daily)
  createBackup(data);
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

// Validation helpers
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

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Selective loading helpers
function filterBrainByTags(brain, tags) {
  const tagSet = new Set(tags.map(t => t.toLowerCase()));
  const nodes = brain.nodes.filter(n => {
    const nodeTags = (n.tags || []).map(t => t.toLowerCase());
    return nodeTags.some(t => tagSet.has(t));
  });
  const nodeIds = new Set(nodes.map(n => n.id));
  const links = brain.links.filter(l => nodeIds.has(l.source) && nodeIds.has(l.target));
  return { nodes, links };
}

function getSmartBrain(brain, depth = Infinity) {
  // Smart mode: Start node + reachable nodes up to given depth
  const startNode = brain.nodes.find(n => n.label === 'Claude – Startpunkt' || n.label === 'Start');
  if (!startNode) return brain; // fallback to full

  const visited = new Set();
  const toVisit = [{ id: startNode.id, d: 0 }];
  const nodeIds = new Set();

  while (toVisit.length > 0) {
    const { id, d } = toVisit.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    nodeIds.add(id);

    if (d < depth) {
      for (const link of brain.links) {
        if (link.source === id && !visited.has(link.target)) toVisit.push({ id: link.target, d: d + 1 });
        if (link.target === id && !visited.has(link.source)) toVisit.push({ id: link.source, d: d + 1 });
      }
    }
  }

  const nodes = brain.nodes.filter(n => nodeIds.has(n.id));
  const links = brain.links.filter(l => nodeIds.has(l.source) && nodeIds.has(l.target));
  return { nodes, links };
}

function searchBrainByLabel(brain, query) {
  const q = query.toLowerCase();
  const nodes = brain.nodes.filter(n => n.label.toLowerCase().includes(q) || (n.content || '').toLowerCase().includes(q));
  const nodeIds = new Set(nodes.map(n => n.id));
  const links = brain.links.filter(l => nodeIds.has(l.source) && nodeIds.has(l.target));
  return { nodes, links };
}

// Health check endpoint
app.get('/api/health', (req, res) => {
  const brain = readBrain();
  res.json({
    status: 'ok',
    uptime: Math.floor((Date.now() - health.startTime.getTime()) / 1000),
    lastWrite: health.lastWrite?.toISOString() || null,
    lastError: health.lastError || null,
    writeCount: health.writeCount,
    errorCount: health.errorCount,
    nodeCount: brain.nodes.length,
    linkCount: brain.links.length,
    version: '1.0.0',
  });
});

app.get('/api/brain', (req, res) => {
  try {
    const brain = readBrain();
    const { tags, smart, search, depth } = req.query;

    let result = brain;

    // Priority: search > tags > smart > full
    if (search) {
      result = searchBrainByLabel(brain, search);
      logger.debug('Brain search', { query: search, nodeCount: result.nodes.length });
    } else if (tags) {
      const tagList = tags.split(',').map(t => t.trim());
      result = filterBrainByTags(brain, tagList);
      logger.debug('Brain filter by tags', { tags: tagList, nodeCount: result.nodes.length });
    } else if (smart === 'true' || smart === '1') {
      const depthNum = depth !== undefined ? parseInt(depth, 10) : Infinity;
      result = getSmartBrain(brain, isNaN(depthNum) ? Infinity : depthNum);
      logger.debug('Brain smart mode', { nodeCount: result.nodes.length, depth: depthNum });
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Failed to read brain' });
  }
});

app.post('/api/nodes', (req, res) => {
  try {
    const label = validateLabel(req.body.label);
    const type = validateType(req.body.type);
    const content = validateContent(req.body.content);
    const tags = validateTags(req.body.tags);

    enqueueWrite(() => {
      const brain = readBrain();
      const node = {
        id: randomUUID(),
        label,
        type,
        content,
        tags,
        created: new Date().toISOString(),
      };
      brain.nodes.push(node);
      writeBrainSync(brain);
      broadcast(brain);
      logger.info('Node created', { label, id: node.id });
      res.json(node);
    }).catch(err => {
      res.status(500).json({ error: 'Failed to create node' });
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/nodes/:id', (req, res) => {
  try {
    const id = req.params.id;
    const updates = {};

    if (req.body.label !== undefined) {
      updates.label = validateLabel(req.body.label);
    }
    if (req.body.type !== undefined) {
      updates.type = validateType(req.body.type);
    }
    if (req.body.content !== undefined) {
      updates.content = validateContent(req.body.content);
    }
    if (req.body.tags !== undefined) {
      updates.tags = validateTags(req.body.tags);
    }

    enqueueWrite(() => {
      const brain = readBrain();
      const idx = brain.nodes.findIndex(n => n.id === id);
      if (idx === -1) {
        res.status(404).json({ error: 'Node not found' });
        return;
      }
      brain.nodes[idx] = { ...brain.nodes[idx], ...updates, id };
      writeBrainSync(brain);
      broadcast(brain);
      logger.info('Node updated', { id, fields: Object.keys(updates) });
      res.json(brain.nodes[idx]);
    }).catch(err => {
      res.status(500).json({ error: 'Failed to update node' });
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/nodes/:id', (req, res) => {
  try {
    const id = req.params.id;

    enqueueWrite(() => {
      const brain = readBrain();
      const idx = brain.nodes.findIndex(n => n.id === id);
      if (idx === -1) {
        res.status(404).json({ error: 'Node not found' });
        return;
      }
      const label = brain.nodes[idx].label;
      brain.nodes.splice(idx, 1);
      brain.links = brain.links.filter(
        l => l.source !== id && l.target !== id
      );
      writeBrainSync(brain);
      broadcast(brain);
      logger.info('Node deleted', { id, label });
      res.json({ ok: true });
    }).catch(err => {
      res.status(500).json({ error: 'Failed to delete node' });
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/links', (req, res) => {
  try {
    const { source, target, label = '' } = req.body;

    if (!source || !target) {
      return res.status(400).json({ error: 'source and target required' });
    }
    if (source === target) {
      return res.status(400).json({ error: 'Cannot link node to itself' });
    }

    enqueueWrite(() => {
      const brain = readBrain();

      if (!brain.nodes.some(n => n.id === source)) {
        res.status(404).json({ error: 'Source node not found' });
        return;
      }
      if (!brain.nodes.some(n => n.id === target)) {
        res.status(404).json({ error: 'Target node not found' });
        return;
      }

      const exists = brain.links.some(
        l => (l.source === source && l.target === target) ||
             (l.source === target && l.target === source)
      );

      if (!exists) {
        brain.links.push({ source, target, label });
        writeBrainSync(brain);
        broadcast(brain);
        logger.info('Link created', { source, target });
      }

      res.json({ source, target, label });
    }).catch(err => {
      res.status(500).json({ error: 'Failed to create link' });
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/links', (req, res) => {
  try {
    const { source, target } = req.body;

    if (!source || !target) {
      return res.status(400).json({ error: 'source and target required' });
    }

    enqueueWrite(() => {
      const brain = readBrain();
      const before = brain.links.length;
      brain.links = brain.links.filter(
        l => !(l.source === source && l.target === target)
      );
      if (brain.links.length < before) {
        writeBrainSync(brain);
        broadcast(brain);
        logger.info('Link deleted', { source, target });
      }
      res.json({ ok: true });
    }).catch(err => {
      res.status(500).json({ error: 'Failed to delete link' });
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Backup endpoints
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

    enqueueWrite(() => {
      const data = restoreBackup(filename);
      broadcast(data);
      res.json({ ok: true, message: 'Restored from ' + filename });
    }).catch(err => {
      res.status(500).json({ error: err.message });
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Parse simple YAML frontmatter
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
    if (!dirPath) {
      return res.status(400).json({ error: 'dirPath required' });
    }

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

    enqueueWrite(() => {
      const brain = readBrain();
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

          try {
            validateLabel(label);
          } catch {
            logger.warn('Import: skipped file', { file, reason: 'invalid label' });
            continue;
          }

          const existing = brain.nodes.find(n => n.label === label);
          if (existing) {
            existing.content = body.trim();
            existing.tags = tags;
            updated++;
          } else {
            brain.nodes.push({
              id: randomUUID(),
              label,
              type,
              content: body.trim(),
              tags,
              created: new Date().toISOString(),
            });
            imported++;
          }
        } catch (err) {
          logger.error('Import: file read error', { file, error: err.message });
        }
      }

      let newLinks = 0;
      const labelMap = new Map(brain.nodes.map(n => [n.label, n]));

      for (const node of brain.nodes) {
        const matches = [...(node.content || '').matchAll(/\[\[([^\]]+)\]\]/g)];
        for (const m of matches) {
          const targetLabel = m[1].trim();
          const target = labelMap.get(targetLabel);

          if (!target || target.id === node.id) continue;

          const exists = brain.links.some(
            l => (l.source === node.id && l.target === target.id) ||
                 (l.source === target.id && l.target === node.id)
          );

          if (!exists) {
            brain.links.push({ source: node.id, target: target.id, label: '' });
            newLinks++;
          }
        }
      }

      writeBrainSync(brain);
      broadcast(brain);
      logger.info('Import completed', { imported, updated, links: newLinks });
      res.json({ imported, updated, links: newLinks, total: files.length });
    }).catch(err => {
      res.status(500).json({ error: 'Failed to import files' });
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', ws => {
  try {
    ws.send(JSON.stringify({ type: 'update', data: readBrain() }));
    logger.debug('Client connected', { clients: wss.clients.size });
  } catch (err) {
    logger.error('WS init error', { error: err.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  logger.info('Brain server started', {
    port: PORT,
    dataFile: DATA_FILE,
    backupDir: BACKUP_DIR,
    logFile: LOG_FILE,
  });
  console.log(`\n✅ Brain läuft auf Port ${PORT}`);
  console.log(`   Lokal:   http://localhost:${PORT}`);
  console.log(`   Health:  http://localhost:${PORT}/api/health`);
  console.log(`   Backups: http://localhost:${PORT}/api/backups\n`);
});

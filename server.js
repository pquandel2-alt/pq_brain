const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');
const { randomUUID } = require('crypto');

const app = express();
const DATA_FILE = path.join(__dirname, 'data', 'brain.json');
const ALLOWED_TYPES = ['memory', 'note', 'idea', 'project', 'reference'];

// Write queue to prevent race conditions (read-modify-write atomicity)
let writeQueue = Promise.resolve();
function enqueueWrite(fn) {
  writeQueue = writeQueue.then(fn).catch(err => {
    console.error('[WRITE ERROR]', err.message);
    throw err;
  });
  return writeQueue;
}

function readBrain() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (err) {
    console.warn('[READ WARN]', err.message);
    return { nodes: [], links: [] };
  }
}

function writeBrainSync(data) {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE);
}

function broadcast(data) {
  const msg = JSON.stringify({ type: 'update', data });
  const failed = [];
  for (const client of wss.clients) {
    try {
      if (client.readyState === 1) client.send(msg);
    } catch (err) {
      console.error('[WS SEND ERROR]', err.message);
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

app.get('/api/brain', (req, res) => {
  try {
    res.json(readBrain());
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
      brain.nodes.splice(idx, 1);
      brain.links = brain.links.filter(
        l => l.source !== id && l.target !== id
      );
      writeBrainSync(brain);
      broadcast(brain);
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

      // Check if nodes exist
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
      }
      res.json({ ok: true });
    }).catch(err => {
      res.status(500).json({ error: 'Failed to delete link' });
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

    // Security: check for path traversal (resolved path must be under a reasonable base)
    // Allow imports only from user's home and /tmp to prevent escaping
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
        if (file === 'MEMORY.md') continue; // skip index file
        try {
          const raw = fs.readFileSync(path.join(resolvedPath, file), 'utf8');
          const { meta, body } = parseFrontmatter(raw);

          const label = meta.name || meta.title || file.replace(/\.md$/, '');
          const type = validateType(meta.type);
          const tags = validateTags(meta.tags);

          try {
            validateLabel(label);
          } catch {
            console.warn(`[IMPORT] Skipping ${file}: invalid label`);
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
          console.error(`[IMPORT] Error reading ${file}:`, err.message);
        }
      }

      // Resolve [[wikilinks]] after all nodes exist
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
  } catch (err) {
    console.error('[WS INIT ERROR]', err.message);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ Brain läuft auf Port ${PORT}`);
  console.log(`   Lokal:   http://localhost:${PORT}`);
  console.log(`   Netzwerk: http://<VM-IP>:${PORT}\n`);
});

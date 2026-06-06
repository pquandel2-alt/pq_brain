const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');
const { randomUUID } = require('crypto');

const app = express();
const DATA_FILE = path.join(__dirname, 'data', 'brain.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function readBrain() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { nodes: [], links: [] };
  }
}

function writeBrain(data) {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DATA_FILE);
  broadcast(data);
}

function broadcast(data) {
  const msg = JSON.stringify({ type: 'update', data });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

app.get('/api/brain', (req, res) => {
  res.json(readBrain());
});

app.post('/api/nodes', (req, res) => {
  const brain = readBrain();
  const node = {
    id: randomUUID(),
    label: req.body.label || 'Neuer Knoten',
    type: req.body.type || 'note',
    content: req.body.content || '',
    tags: req.body.tags || [],
    created: new Date().toISOString(),
  };
  brain.nodes.push(node);
  writeBrain(brain);
  res.json(node);
});

app.put('/api/nodes/:id', (req, res) => {
  const brain = readBrain();
  const idx = brain.nodes.findIndex(n => n.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  brain.nodes[idx] = { ...brain.nodes[idx], ...req.body, id: req.params.id };
  writeBrain(brain);
  res.json(brain.nodes[idx]);
});

app.delete('/api/nodes/:id', (req, res) => {
  const brain = readBrain();
  brain.nodes = brain.nodes.filter(n => n.id !== req.params.id);
  brain.links = brain.links.filter(
    l => l.source !== req.params.id && l.target !== req.params.id
  );
  writeBrain(brain);
  res.json({ ok: true });
});

app.post('/api/links', (req, res) => {
  const brain = readBrain();
  const { source, target, label = '' } = req.body;
  if (!source || !target || source === target) return res.status(400).json({ error: 'Invalid link' });
  const exists = brain.links.some(l => l.source === source && l.target === target);
  if (!exists) {
    brain.links.push({ source, target, label });
    writeBrain(brain);
  }
  res.json({ source, target, label });
});

app.delete('/api/links', (req, res) => {
  const brain = readBrain();
  const { source, target } = req.body;
  brain.links = brain.links.filter(l => !(l.source === source && l.target === target));
  writeBrain(brain);
  res.json({ ok: true });
});

// Parse simple YAML frontmatter manually (avoids extra dependencies)
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
  const { dirPath } = req.body;
  if (!dirPath) return res.status(400).json({ error: 'dirPath required' });

  let resolvedPath;
  try {
    resolvedPath = path.resolve(dirPath.replace(/^~/, process.env.HOME || '/root'));
  } catch {
    return res.status(400).json({ error: 'Invalid path' });
  }

  if (!fs.existsSync(resolvedPath)) {
    return res.status(404).json({ error: `Pfad nicht gefunden: ${resolvedPath}` });
  }

  const brain = readBrain();
  let files;
  try {
    files = fs.readdirSync(resolvedPath).filter(f => f.endsWith('.md'));
  } catch {
    return res.status(403).json({ error: 'Kein Lesezugriff' });
  }

  let imported = 0;
  let updated = 0;

  for (const file of files) {
    if (file === 'MEMORY.md') continue; // skip index file
    const raw = fs.readFileSync(path.join(resolvedPath, file), 'utf8');
    const { meta, body } = parseFrontmatter(raw);

    const label = meta.name || meta.title || file.replace(/\.md$/, '');
    const type = ['memory', 'note', 'idea', 'project'].includes(meta.type) ? meta.type : 'memory';
    const tags = Array.isArray(meta.tags) ? meta.tags : [];

    const existing = brain.nodes.find(n => n.label === label);
    if (existing) {
      existing.content = body.trim();
      existing.tags = tags.length ? tags : existing.tags;
      updated++;
    } else {
      brain.nodes.push({ id: randomUUID(), label, type, content: body.trim(), tags, created: new Date().toISOString() });
      imported++;
    }
  }

  // Resolve [[wikilinks]] after all nodes exist
  let newLinks = 0;
  for (const node of brain.nodes) {
    const matches = [...(node.content || '').matchAll(/\[\[([^\]]+)\]\]/g)];
    for (const m of matches) {
      const target = brain.nodes.find(n => n.label === m[1].trim());
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

  writeBrain(brain);
  res.json({ imported, updated, links: newLinks, total: files.length });
});

const PORT = process.env.PORT || 3000;
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', ws => {
  ws.send(JSON.stringify({ type: 'update', data: readBrain() }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\nBrain läuft auf http://0.0.0.0:${PORT}`);
  console.log(`Lokal:   http://localhost:${PORT}`);
  console.log(`Netzwerk: http://<VM-IP>:${PORT}\n`);
});

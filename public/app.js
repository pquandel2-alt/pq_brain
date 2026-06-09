/* ── Constants ───────────────────────────────────────── */
const NODE_COLORS = {
  memory:  '#4a9eff',
  note:    '#4aff9a',
  idea:    '#ffd54a',
  project: '#c54aff',
};
const DIM_COLOR = 'rgba(80,80,100,0.25)';

/* ── State ───────────────────────────────────────────── */
let rawData = { nodes: [], links: [] };
let graph = null;
let selectedNode = null;
let linkSourceNode = null;
let filterType = 'all';
let searchQuery = '';
let semanticMatchIds = null; // Set von Treffer-IDs der semantischen Suche (Enter); null = Substring-Modus
let activeTab = 'edit';
let md = null;
let startNodeId = null;                    // Startknoten: immer hell
const recentlyAccessed = new Map();        // id → expiresAt (ms), 3s nach Zugriff

/* ── Init ────────────────────────────────────────────── */
async function init() {
  md = window.markdownit({ html: false, linkify: true, typographer: true });
  await loadGraph();
  initGraph();
  initUI();
}

/* ── Data ────────────────────────────────────────────── */
async function loadGraph() {
  const res = await fetch('/api/brain');
  const data = await res.json();
  startNodeId = data.startNodeId ?? null;
  rawData = data;
}

function getGraphData() {
  return {
    nodes: rawData.nodes.map(n => ({ ...n })),
    links: rawData.links.map(l => ({ ...l })),
  };
}

/* ── 3D Graph ────────────────────────────────────────── */
function initGraph() {
  const container = document.getElementById('graph-container');

  graph = ForceGraph3D({ controlType: 'orbit' })(container)
    .graphData(getGraphData())
    .nodeId('id')
    .nodeLabel(() => '')          // We use custom hover
    .nodeColor(nodeColor)
    .nodeOpacity(0.92)
    .nodeRelSize(5)
    .linkColor(() => 'rgba(100,150,255,0.35)')
    .linkWidth(1.2)
    .linkDirectionalParticles(1)
    .linkDirectionalParticleWidth(1.5)
    .linkDirectionalParticleColor(() => 'rgba(120,170,255,0.6)')
    .backgroundColor('#0a0a0f')
    .onNodeClick(handleNodeClick)
    .onNodeHover(handleNodeHover)
    .onBackgroundClick(() => {
      if (linkSourceNode) {
        cancelLinkMode();
        return;
      }
      closePanel();
    });

  graph.d3Force('charge').strength(-120);

  handleResize();
  window.addEventListener('resize', handleResize);
}

function handleResize() {
  const container = document.getElementById('graph-container');
  graph.width(container.clientWidth).height(container.clientHeight);
}

function nodeColor(node) {
  // Startknoten leuchtet immer warm-weiß/golden
  if (node.id === startNodeId) return '#fffde7';
  // Kürzlich abgerufene Knoten leuchten hell-blau (3s)
  if (recentlyAccessed.has(node.id)) return '#29b6f6';

  const base = node.color || NODE_COLORS[node.type] || '#888';
  if (semanticMatchIds) {
    if (!semanticMatchIds.has(node.id)) return DIM_COLOR;
  } else if (searchQuery) {
    const match = node.label.toLowerCase().includes(searchQuery.toLowerCase()) ||
                  (node.content || '').toLowerCase().includes(searchQuery.toLowerCase());
    if (!match) return DIM_COLOR;
  }
  if (filterType !== 'all' && node.type !== filterType) return DIM_COLOR;
  if (linkSourceNode && linkSourceNode.id === node.id) return '#ff6b6b';
  return base;
}

function refreshGraph() {
  if (!graph) return;
  graph.nodeColor(nodeColor);
}

// Enter im Suchfeld: hybride semantische Suche (Server) → Treffer hervorheben + zum besten springen.
async function semanticSearch(q) {
  if (!q) { semanticMatchIds = null; refreshGraph(); return; }
  try {
    const res = await fetch('/api/brain?q=' + encodeURIComponent(q) + '&limit=15');
    const data = await res.json();
    semanticMatchIds = new Set((data.nodes || []).map(n => n.id));
    refreshGraph();
    if (data.nodes && data.nodes.length) {
      showToast(`🔎 Semantisch: ${data.nodes.length} Treffer`);
      jumpToNode(data.nodes[0].label);
    } else {
      showToast('Keine semantischen Treffer');
    }
  } catch {
    showToast('Semantische Suche fehlgeschlagen');
  }
}

function reloadGraph() {
  if (!graph) return;
  graph.graphData(getGraphData());
  graph.nodeColor(nodeColor);
}

/* ── Node Click / Hover ──────────────────────────────── */
function handleNodeClick(node, event) {
  if (event && (event.shiftKey || event.ctrlKey)) {
    handleLinkModeClick(node);
    return;
  }
  if (linkSourceNode) {
    handleLinkModeClick(node);
    return;
  }
  selectedNode = rawData.nodes.find(n => n.id === node.id);
  if (selectedNode) showPanel(selectedNode);
}

function handleNodeHover(node) {
  document.body.style.cursor = node ? 'pointer' : 'default';
  if (node) {
    showTooltip(node);
  } else {
    hideTooltip();
  }
}

let tooltipEl = null;
function showTooltip(node) {
  if (!tooltipEl) {
    tooltipEl = document.createElement('div');
    tooltipEl.style.cssText = `
      position:fixed; pointer-events:none; z-index:50;
      background:rgba(14,14,22,0.9); border:1px solid rgba(255,255,255,0.1);
      border-radius:8px; padding:5px 10px; font-size:12px; color:#e8e8f0;
      transition:opacity 0.15s; max-width:160px; word-break:break-word;
    `;
    document.body.appendChild(tooltipEl);
  }
  tooltipEl.textContent = node.label;
  tooltipEl.style.opacity = '1';
  document.addEventListener('mousemove', updateTooltipPos);
}
function hideTooltip() {
  if (tooltipEl) {
    tooltipEl.style.opacity = '0';
    document.removeEventListener('mousemove', updateTooltipPos);
  }
}
function updateTooltipPos(e) {
  if (tooltipEl) {
    tooltipEl.style.left = (e.clientX + 12) + 'px';
    tooltipEl.style.top = (e.clientY - 28) + 'px';
  }
}

/* ── Link Mode ───────────────────────────────────────── */
function handleLinkModeClick(node) {
  if (!linkSourceNode) {
    linkSourceNode = rawData.nodes.find(n => n.id === node.id);
    showLinkBanner(linkSourceNode.label);
    refreshGraph();
    return;
  }
  if (linkSourceNode.id === node.id) {
    cancelLinkMode();
    return;
  }
  const targetId = node.id;
  const sourceId = linkSourceNode.id;
  cancelLinkMode();
  createLink(sourceId, targetId);
}

function cancelLinkMode() {
  linkSourceNode = null;
  hideLinkBanner();
  refreshGraph();
}

function showLinkBanner(label) {
  document.getElementById('link-banner').classList.remove('hidden');
  document.getElementById('link-source-label').textContent = label;
}
function hideLinkBanner() {
  document.getElementById('link-banner').classList.add('hidden');
}

/* ── Panel ───────────────────────────────────────────── */
function showPanel(node) {
  const panel = document.getElementById('panel');
  panel.classList.remove('hidden');

  document.getElementById('panel-label').value = node.label;
  document.getElementById('panel-content').value = node.content || '';

  const badge = document.getElementById('panel-type-badge');
  badge.className = 'type-badge ' + node.type;
  badge.textContent = typeName(node.type);

  const tagsEl = document.getElementById('panel-tags');
  tagsEl.innerHTML = (node.tags || []).map(t =>
    `<span class="tag-chip">#${t}</span>`
  ).join('');

  switchTab(activeTab);
  updateLinksTab(node);
}

function closePanel() {
  document.getElementById('panel').classList.add('hidden');
  selectedNode = null;
}

function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  document.getElementById('panel-content').classList.toggle('hidden', tab !== 'edit');
  document.getElementById('panel-preview').classList.toggle('hidden', tab !== 'preview');
  document.getElementById('panel-links-list').classList.toggle('hidden', tab !== 'links');

  if (tab === 'preview' && selectedNode) {
    const content = document.getElementById('panel-content').value;
    document.getElementById('panel-preview').innerHTML = renderMarkdown(content);
  }
  if (tab === 'links' && selectedNode) {
    updateLinksTab(selectedNode);
  }
}

function renderMarkdown(text) {
  let html = md.render(text);
  // Render [[wikilinks]] as clickable spans
  html = html.replace(/\[\[([^\]]+)\]\]/g, (_, label) => {
    return `<span class="wikilink" onclick="jumpToNode('${label.replace(/'/g,"\\'")}')">[[${label}]]</span>`;
  });
  return html;
}

function jumpToNode(label) {
  const node = rawData.nodes.find(n => n.label === label);
  if (node) {
    selectedNode = node;
    showPanel(node);
    graph.zoomToFit(400, 50, n => n.id === node.id);
  } else {
    showToast(`Knoten "${label}" nicht gefunden`);
  }
}

function updateLinksTab(node) {
  const list = document.getElementById('panel-links-list');
  const connected = rawData.links
    .filter(l => l.source === node.id || l.target === node.id)
    .map(l => {
      const otherId = l.source === node.id ? l.target : l.source;
      return { id: otherId, link: l };
    })
    .map(({ id, link }) => ({
      node: rawData.nodes.find(n => n.id === id),
      link,
    }))
    .filter(x => x.node);

  if (connected.length === 0) {
    list.innerHTML = '<p style="color:var(--text-muted);font-size:12px;padding:4px 0">Keine Verknüpfungen.<br>Shift+Klick zum Verbinden.</p>';
    return;
  }

  list.innerHTML = connected.map(({ node: other, link }) => `
    <div class="link-item" onclick="jumpToNode('${other.label.replace(/'/g,"\\'")}')">
      <div style="display:flex;align-items:center;gap:8px">
        <span class="type-badge ${other.type} link-item-badge">${typeName(other.type)}</span>
        <span class="link-item-label">${escHtml(other.label)}</span>
      </div>
      <button class="link-item-del" onclick="event.stopPropagation(); deleteLink('${link.source}','${link.target}')" title="Verbindung entfernen">&#10005;</button>
    </div>
  `).join('');
}

/* ── CRUD Operations ─────────────────────────────────── */
async function saveNode() {
  if (!selectedNode) return;
  const label = document.getElementById('panel-label').value.trim();
  const content = document.getElementById('panel-content').value;
  if (!label) { showToast('Titel darf nicht leer sein'); return; }

  const updated = await api('PUT', `/api/nodes/${selectedNode.id}`, { label, content });
  const idx = rawData.nodes.findIndex(n => n.id === updated.id);
  if (idx !== -1) rawData.nodes[idx] = updated;
  selectedNode = updated;

  // Process wikilinks
  await processWikilinks(updated, content);

  reloadGraph();
  showPanel(updated);
  showToast('Gespeichert');
}

async function processWikilinks(node, content) {
  const matches = [...content.matchAll(/\[\[([^\]]+)\]\]/g)];
  for (const m of matches) {
    const targetLabel = m[1].trim();
    let target = rawData.nodes.find(n => n.label === targetLabel);
    if (!target) {
      target = await api('POST', '/api/nodes', { label: targetLabel, type: 'note', content: '' });
      rawData.nodes.push(target);
    }
    const exists = rawData.links.some(
      l => (l.source === node.id && l.target === target.id) ||
           (l.source === target.id && l.target === node.id)
    );
    if (!exists) {
      const link = await api('POST', '/api/links', { source: node.id, target: target.id });
      rawData.links.push(link);
    }
  }
}

async function createNode(label, type, content, tags) {
  const node = await api('POST', '/api/nodes', { label, type, content, tags });
  rawData.nodes.push(node);
  await processWikilinks(node, content);
  reloadGraph();
  showToast(`"${label}" erstellt`);
  return node;
}

async function deleteNode(id) {
  await api('DELETE', `/api/nodes/${id}`);
  rawData.nodes = rawData.nodes.filter(n => n.id !== id);
  rawData.links = rawData.links.filter(l => l.source !== id && l.target !== id);
  reloadGraph();
  closePanel();
  showToast('Knoten gelöscht');
}

async function createLink(sourceId, targetId) {
  const exists = rawData.links.some(
    l => (l.source === sourceId && l.target === targetId) ||
         (l.source === targetId && l.target === sourceId)
  );
  if (exists) { showToast('Verbindung existiert bereits'); return; }
  const link = await api('POST', '/api/links', { source: sourceId, target: targetId });
  rawData.links.push(link);
  reloadGraph();
  showToast('Verbunden');
  if (selectedNode) updateLinksTab(selectedNode);
}

async function deleteLink(source, target) {
  await api('DELETE', '/api/links', { source, target });
  rawData.links = rawData.links.filter(l => !(l.source === source && l.target === target));
  reloadGraph();
  if (selectedNode) updateLinksTab(selectedNode);
  showToast('Verbindung entfernt');
}

/* ── UI Bindings ─────────────────────────────────────── */
function initUI() {
  // Search
  const searchEl = document.getElementById('search');
  const clearBtn = document.getElementById('search-clear');
  searchEl.addEventListener('input', () => {
    searchQuery = searchEl.value.trim();
    semanticMatchIds = null; // Tippen → zurück zum Substring-Highlight
    clearBtn.classList.toggle('hidden', !searchQuery);
    refreshGraph();
  });
  searchEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); semanticSearch(searchEl.value.trim()); }
  });
  clearBtn.addEventListener('click', () => {
    searchEl.value = '';
    searchQuery = '';
    semanticMatchIds = null;
    clearBtn.classList.add('hidden');
    refreshGraph();
  });

  // Filter chips
  document.querySelectorAll('#filter-bar .chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('#filter-bar .chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      filterType = chip.dataset.type;
      refreshGraph();
    });
  });

  // Add button
  document.getElementById('btn-add').addEventListener('click', () => {
    document.getElementById('new-label').value = '';
    document.getElementById('new-content').value = '';
    document.getElementById('new-tags').value = '';
    document.getElementById('new-type').value = 'note';
    document.getElementById('modal-create').classList.remove('hidden');
    setTimeout(() => document.getElementById('new-label').focus(), 50);
  });

  document.getElementById('btn-modal-close').addEventListener('click', closeCreateModal);
  document.getElementById('btn-create-cancel').addEventListener('click', closeCreateModal);
  document.getElementById('btn-create-confirm').addEventListener('click', async () => {
    const label = document.getElementById('new-label').value.trim();
    if (!label) { showToast('Titel eingeben'); return; }
    const type = document.getElementById('new-type').value;
    const content = document.getElementById('new-content').value;
    const tags = document.getElementById('new-tags').value
      .split(',').map(t => t.trim()).filter(Boolean);
    closeCreateModal();
    const node = await createNode(label, type, content, tags);
    selectedNode = node;
    showPanel(node);
  });

  // Panel buttons
  document.getElementById('btn-panel-close').addEventListener('click', closePanel);
  document.getElementById('btn-save').addEventListener('click', saveNode);
  document.getElementById('btn-delete').addEventListener('click', () => {
    if (!selectedNode) return;
    document.getElementById('delete-label-text').textContent =
      `"${selectedNode.label}" und alle Verbindungen werden gelöscht.`;
    document.getElementById('modal-delete').classList.remove('hidden');
  });
  document.getElementById('btn-link-mode').addEventListener('click', () => {
    if (!selectedNode) return;
    linkSourceNode = selectedNode;
    showLinkBanner(selectedNode.label);
    refreshGraph();
    closePanel();
    showToast('Shift+Klick auf Zielknoten');
  });

  document.getElementById('link-cancel').addEventListener('click', cancelLinkMode);

  // Panel tabs
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Keyboard save
  document.getElementById('panel-content').addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      saveNode();
    }
  });

  // Delete modal
  document.getElementById('btn-delete-cancel').addEventListener('click', () => {
    document.getElementById('modal-delete').classList.add('hidden');
  });
  document.getElementById('btn-delete-confirm').addEventListener('click', () => {
    document.getElementById('modal-delete').classList.add('hidden');
    if (selectedNode) deleteNode(selectedNode.id);
  });

  // Import modal
  document.getElementById('btn-import').addEventListener('click', () => {
    document.getElementById('import-path').value = '';
    document.getElementById('import-result').classList.add('hidden');
    document.getElementById('modal-import').classList.remove('hidden');
  });
  document.getElementById('btn-import-close').addEventListener('click', closeImportModal);
  document.getElementById('btn-import-cancel').addEventListener('click', closeImportModal);
  document.querySelectorAll('#modal-import .chip[data-path]').forEach(chip => {
    chip.addEventListener('click', () => {
      document.getElementById('import-path').value = chip.dataset.path;
    });
  });
  document.getElementById('btn-import-confirm').addEventListener('click', doImport);

  // Close modals on backdrop click
  document.querySelectorAll('.modal').forEach(modal => {
    modal.addEventListener('click', e => {
      if (e.target === modal) modal.classList.add('hidden');
    });
  });

  // Mobile bottom sheet drag-to-dismiss
  initPanelDrag();
}

function closeCreateModal() {
  document.getElementById('modal-create').classList.add('hidden');
}
function closeImportModal() {
  document.getElementById('modal-import').classList.add('hidden');
}

async function doImport() {
  const dirPath = document.getElementById('import-path').value.trim();
  if (!dirPath) { showToast('Pfad eingeben'); return; }

  const btn = document.getElementById('btn-import-confirm');
  btn.disabled = true;
  btn.textContent = 'Importiere...';

  try {
    const result = await api('POST', '/api/import', { dirPath });
    const resEl = document.getElementById('import-result');
    resEl.classList.remove('hidden', 'error');
    resEl.textContent =
      `${result.imported} neu importiert, ${result.updated} aktualisiert, ${result.links} Verbindungen erstellt.`;
    await loadGraph();
    reloadGraph();
  } catch (err) {
    const resEl = document.getElementById('import-result');
    resEl.classList.remove('hidden');
    resEl.classList.add('error');
    resEl.textContent = err.message;
  }

  btn.disabled = false;
  btn.textContent = 'Importieren';
}

/* ── Mobile Panel Drag ───────────────────────────────── */
function initPanelDrag() {
  const panel = document.getElementById('panel');
  const handle = document.getElementById('panel-handle');
  let startY = 0;
  let isDragging = false;

  handle.addEventListener('touchstart', e => {
    startY = e.touches[0].clientY;
    isDragging = true;
    panel.style.transition = 'none';
  }, { passive: true });

  document.addEventListener('touchmove', e => {
    if (!isDragging) return;
    const dy = e.touches[0].clientY - startY;
    if (dy > 0) panel.style.transform = `translateY(${dy}px)`;
  }, { passive: true });

  document.addEventListener('touchend', e => {
    if (!isDragging) return;
    isDragging = false;
    panel.style.transition = '';
    const dy = e.changedTouches[0].clientY - startY;
    if (dy > 100) {
      closePanel();
    } else {
      panel.style.transform = '';
    }
  });
}

/* ── Helpers ─────────────────────────────────────────── */
async function api(method, url, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function typeName(type) {
  return { memory: 'Memory', note: 'Notiz', idea: 'Idee', project: 'Projekt' }[type] || type;
}

function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

let toastTimer = null;
function showToast(msg, duration = 2200) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

/* ── Live-Sync via WebSocket ─────────────────────────── */
function initLiveSync() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}`);

  ws.addEventListener('message', e => {
    const msg = JSON.parse(e.data);

    // Access-Highlighting: Knoten aufleuchten lassen
    if (msg.type === 'access') {
      const exp = Date.now() + 3000;
      msg.nodeIds.forEach(id => recentlyAccessed.set(id, exp));
      if (graph) graph.nodeColor(nodeColor);
      return;
    }

    if (msg.type !== 'update') return;

    // startNodeId aus Graph-Updates übernehmen
    if (msg.data.startNodeId !== undefined) startNodeId = msg.data.startNodeId;

    const prev = JSON.stringify(rawData);
    const next = JSON.stringify(msg.data);
    if (prev === next) return;

    // Find changed node IDs for the flash animation
    const changedIds = new Set();
    for (const node of msg.data.nodes) {
      const old = rawData.nodes.find(n => n.id === node.id);
      if (!old || JSON.stringify(old) !== JSON.stringify(node)) changedIds.add(node.id);
    }
    const newIds = new Set(msg.data.nodes.map(n => n.id).filter(id => !rawData.nodes.find(n => n.id === id)));

    rawData = msg.data;

    // If open panel's node was updated, refresh it
    if (selectedNode) {
      const fresh = rawData.nodes.find(n => n.id === selectedNode.id);
      if (!fresh) {
        closePanel();
      } else if (changedIds.has(selectedNode.id)) {
        selectedNode = fresh;
        showPanel(fresh);
      }
    }

    reloadGraph();

    // Flash new/changed nodes
    if (changedIds.size > 0 || newIds.size > 0) {
      flashNodes([...changedIds, ...newIds]);
      showLiveIndicator();
    }
  });

  ws.addEventListener('close', () => {
    // Reconnect after 3s
    setTimeout(initLiveSync, 3000);
  });

  // Show connection status
  ws.addEventListener('open', () => updateLiveStatus(true));
  ws.addEventListener('close', () => updateLiveStatus(false));
}

// Decay-Timer: abgelaufene Access-Highlights entfernen (alle 500ms)
setInterval(() => {
  if (!recentlyAccessed.size) return;
  const now = Date.now();
  let changed = false;
  for (const [id, exp] of recentlyAccessed) {
    if (now > exp) { recentlyAccessed.delete(id); changed = true; }
  }
  if (changed && graph) graph.nodeColor(nodeColor);
}, 500);

function flashNodes(ids) {
  if (!graph || ids.length === 0) return;
  const origColor = graph.nodeColor();
  graph.nodeColor(node => ids.includes(node.id) ? '#ffffff' : nodeColor(node));
  setTimeout(() => graph.nodeColor(nodeColor), 600);
}

function updateLiveStatus(connected) {
  let dot = document.getElementById('live-dot');
  if (!dot) {
    dot = document.createElement('span');
    dot.id = 'live-dot';
    dot.title = 'Live-Sync';
    dot.style.cssText = 'display:inline-block;width:7px;height:7px;border-radius:50%;margin-left:6px;vertical-align:middle;transition:background 0.4s';
    document.querySelector('.logo').appendChild(dot);
  }
  dot.style.background = connected ? '#4aff9a' : '#ff4a6b';
}

let liveTimer = null;
function showLiveIndicator() {
  let el = document.getElementById('live-indicator');
  if (!el) {
    el = document.createElement('div');
    el.id = 'live-indicator';
    el.style.cssText = `
      position:fixed; top:calc(var(--header-h) + var(--filter-h) + 10px); right:12px;
      background:rgba(74,255,154,0.15); border:1px solid rgba(74,255,154,0.3);
      color:#4aff9a; font-size:11px; padding:4px 10px; border-radius:20px;
      z-index:200; pointer-events:none; transition:opacity 0.5s;
    `;
    el.textContent = '● Live-Update';
    document.body.appendChild(el);
  }
  el.style.opacity = '1';
  clearTimeout(liveTimer);
  liveTimer = setTimeout(() => { el.style.opacity = '0'; }, 2000);
}

/* ── Start ───────────────────────────────────────────── */
window.addEventListener('DOMContentLoaded', () => { init(); initLiveSync(); });

/* Expose for inline event handlers */
window.jumpToNode = jumpToNode;
window.deleteLink = deleteLink;

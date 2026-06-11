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
const glowOverlays = new Map();            // id → HTMLElement (CSS-Glow-Overlay)

/* ── Init ────────────────────────────────────────────── */
async function init() {
  md = window.markdownit({ html: false, linkify: true, typographer: true });
  await loadGraph();
  initGraph();
  initUI();
  requestAnimationFrame(animateGlow);
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
    .nodeVal(n => n.id === startNodeId ? 6 : 1)
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
  // Kürzlich abgerufene Knoten leuchten weiß (3s)
  if (recentlyAccessed.has(node.id)) return '#ffffff';

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

// Enter im Suchfeld: hybride semantische Suche (Server) → Treffer hervorheben + Ergebnisliste.
let searchResults = [];      // [{id,label,type,score}]
let searchSort = 'score';    // score | name | type
let searchActiveIdx = -1;
async function semanticSearch(q) {
  if (!q) { semanticMatchIds = null; hideSearchResults(); refreshGraph(); return; }
  try {
    const res = await fetch('/api/brain?q=' + encodeURIComponent(q) + '&limit=15');
    const data = await res.json();
    const nodes = data.nodes || [];
    semanticMatchIds = new Set(nodes.map(n => n.id));
    refreshGraph();
    if (nodes.length) {
      searchResults = nodes.map(n => ({ id: n.id, label: n.label, type: n.type, score: n.score ?? 0 }));
      searchActiveIdx = -1;
      renderSearchResults();
      jumpToNode(nodes[0].label);
    } else {
      hideSearchResults();
      showToast('Keine semantischen Treffer');
    }
  } catch {
    showToast('Semantische Suche fehlgeschlagen');
  }
}

function sortedSearchResults() {
  const r = [...searchResults];
  if (searchSort === 'name') r.sort((a, b) => a.label.localeCompare(b.label));
  else if (searchSort === 'type') r.sort((a, b) => (a.type || '').localeCompare(b.type || '') || b.score - a.score);
  else r.sort((a, b) => b.score - a.score);
  return r;
}

function renderSearchResults() {
  const box = document.getElementById('search-results');
  const rows = sortedSearchResults();
  if (!rows.length) { hideSearchResults(); return; }
  const sortBtn = (key, lbl) => `<button class="sr-sort ${searchSort === key ? 'active' : ''}" data-sort="${key}">${lbl}</button>`;
  box.innerHTML = `
    <div class="sr-header">
      <span>${rows.length} Treffer · Sortieren:</span>
      ${sortBtn('score', 'Score')} ${sortBtn('name', 'Name')} ${sortBtn('type', 'Typ')}
    </div>
    ${rows.map((r, i) => `
      <div class="sr-item ${i === searchActiveIdx ? 'active' : ''}" data-jump="${escAttr(r.label)}">
        <span class="type-badge ${r.type} link-item-badge">${typeName(r.type)}</span>
        <span class="sr-label">${escHtml(r.label)}</span>
        <span class="sr-score">${Number(r.score).toFixed(3)}</span>
      </div>`).join('')}`;
  box.classList.remove('hidden');
  box.querySelectorAll('.sr-sort').forEach(b =>
    b.addEventListener('click', () => { searchSort = b.dataset.sort; renderSearchResults(); }));
  box.querySelectorAll('.sr-item').forEach(el =>
    el.addEventListener('click', () => { jumpToNode(el.dataset.jump); hideSearchResults(); }));
}

function hideSearchResults() {
  document.getElementById('search-results').classList.add('hidden');
  searchActiveIdx = -1;
}

function moveSearchActive(delta) {
  const rows = sortedSearchResults();
  if (!rows.length) return;
  searchActiveIdx = (searchActiveIdx + delta + rows.length) % rows.length;
  renderSearchResults();
  document.querySelector('#search-results .sr-item.active')?.scrollIntoView({ block: 'nearest' });
}

function activateSearchSelection() {
  const rows = sortedSearchResults();
  if (searchActiveIdx >= 0 && rows[searchActiveIdx]) {
    jumpToNode(rows[searchActiveIdx].label);
    hideSearchResults();
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
    `<span class="tag-chip">#${escHtml(t)}</span>`
  ).join('');

  // Meta-Felder aus dem (ggf. schlanken) Knoten vorbefüllen…
  fillMetaFields(node);
  // …und vollständigen Stand (summary/ttl) nachladen.
  fetchFullNode(node.id);

  switchTab(activeTab);
  updateLinksTab(node);
}

// Volle Knotendaten (summary/ttl/version) nachladen und ins selectedNode mergen.
async function fetchFullNode(id) {
  try {
    const res = await fetch(`/api/nodes/${id}`);
    if (!res.ok) return;
    const full = await res.json();
    if (selectedNode && selectedNode.id === id) {
      selectedNode = { ...selectedNode, ...full };
      fillMetaFields(selectedNode);
    }
  } catch { /* offline → schlanke Felder bleiben */ }
}

function fillMetaFields(node) {
  document.getElementById('panel-type').value = node.type || 'note';
  document.getElementById('panel-tags-input').value = (node.tags || []).join(', ');
  document.getElementById('panel-summary').value = node.summary || '';
  document.getElementById('panel-ttl').value = node.ttl ? String(node.ttl) : '';
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
  document.getElementById('panel-meta-edit').classList.toggle('hidden', tab !== 'meta');
  document.getElementById('panel-links-list').classList.toggle('hidden', tab !== 'links');
  document.getElementById('panel-history').classList.toggle('hidden', tab !== 'history');

  if (tab === 'preview' && selectedNode) {
    const content = document.getElementById('panel-content').value;
    document.getElementById('panel-preview').innerHTML = renderMarkdown(content);
  }
  if (tab === 'links' && selectedNode) {
    updateLinksTab(selectedNode);
  }
  if (tab === 'history' && selectedNode) {
    loadHistory(selectedNode.id);
  }
}

/* ── History-Tab (B2) ────────────────────────────────── */
async function loadHistory(id) {
  const box = document.getElementById('panel-history');
  box.innerHTML = '<p class="report-empty">Lade Historie…</p>';
  let history;
  try {
    history = await (await fetch(`/api/nodes/${id}/history`)).json();
  } catch {
    box.innerHTML = '<p class="report-empty">Historie nicht ladbar.</p>';
    return;
  }
  if (!Array.isArray(history) || history.length === 0) {
    box.innerHTML = '<p class="report-empty">Noch keine früheren Versionen.</p>';
    return;
  }
  const current = document.getElementById('panel-content').value;
  // Neueste zuerst.
  const items = [...history].sort((a, b) => b.version - a.version);
  box.innerHTML = items.map(h => {
    const d = new Date(h.changed_at);
    const when = d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    return `<div class="hist-item" data-version="${h.version}">
      <div class="hist-head">
        <span><span class="hist-op">v${h.version}</span> <span class="hist-meta">${when} · ${escHtml(h.op || 'update')}</span></span>
        <span class="hist-actions">
          <button data-act="view" data-v="${h.version}">Ansehen</button>
          <button data-act="revert" data-v="${h.version}">Wiederherstellen</button>
        </span>
      </div>
    </div>`;
  }).join('');

  box.querySelectorAll('button[data-act]').forEach(btn => {
    btn.addEventListener('click', () => {
      const v = Number(btn.dataset.v);
      const entry = items.find(h => h.version === v);
      if (btn.dataset.act === 'view') toggleHistDiff(btn, entry, current);
      else revertToVersion(id, v);
    });
  });
}

function toggleHistDiff(btn, entry, currentContent) {
  const item = btn.closest('.hist-item');
  const existing = item.querySelector('.hist-diff');
  if (existing) { existing.remove(); return; }
  const diff = document.createElement('div');
  diff.className = 'hist-diff';
  diff.innerHTML = lineDiff(entry.content || '', currentContent);
  item.appendChild(diff);
}

// Naiver zeilenbasierter Diff (kein Library): nur-in-alt rot, nur-in-neu grün.
function lineDiff(oldText, newText) {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);
  const out = [];
  for (const l of oldLines) {
    if (!newSet.has(l)) out.push(`<span class="diff-del">- ${escHtml(l)}</span>`);
  }
  for (const l of newLines) {
    if (!oldSet.has(l)) out.push(`<span class="diff-add">+ ${escHtml(l)}</span>`);
  }
  if (out.length === 0) return '<span class="diff-ctx">(keine Unterschiede zum aktuellen Inhalt)</span>';
  return out.join('\n');
}

async function revertToVersion(id, version) {
  if (!confirm(`Auf Version v${version} zurücksetzen?`)) return;
  try {
    await api('POST', `/api/nodes/${id}/revert/${version}`);
    showToast(`Auf v${version} zurückgesetzt`);
    // WS-Broadcast aktualisiert das Panel; History neu laden.
    loadHistory(id);
  } catch (err) {
    showToast('Revert fehlgeschlagen: ' + err.message);
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

  list.innerHTML = connected.map(({ node: other, link }) => {
    const rel = link.rel_type
      ? `<span class="rel-badge ${link.rel_type === 'auto' ? 'auto' : ''}">${escHtml(link.rel_type)}</span>`
      : (link.label ? `<span class="rel-badge">${escHtml(link.label)}</span>` : '');
    return `
    <div class="link-item">
      <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0;cursor:pointer" data-jump="${escAttr(other.label)}">
        <span class="type-badge ${other.type} link-item-badge">${typeName(other.type)}</span>
        <span class="link-item-label">${escHtml(other.label)}</span>
        ${rel}
      </div>
      <button class="link-item-edit" data-src="${escAttr(link.source)}" data-tgt="${escAttr(link.target)}" title="Verknüpfung bearbeiten">&#9998;</button>
      <button class="link-item-del" data-src="${escAttr(link.source)}" data-tgt="${escAttr(link.target)}" title="Verbindung entfernen">&#10005;</button>
    </div>`;
  }).join('');

  list.querySelectorAll('[data-jump]').forEach(el =>
    el.addEventListener('click', () => jumpToNode(el.dataset.jump)));
  list.querySelectorAll('.link-item-del').forEach(btn =>
    btn.addEventListener('click', (e) => { e.stopPropagation(); deleteLink(btn.dataset.src, btn.dataset.tgt); }));
  list.querySelectorAll('.link-item-edit').forEach(btn =>
    btn.addEventListener('click', (e) => { e.stopPropagation(); editLink(btn.dataset.src, btn.dataset.tgt); }));
}

async function editLink(source, target) {
  const link = rawData.links.find(l => l.source === source && l.target === target);
  const curLabel = link?.label || '';
  const curType = link?.rel_type || '';
  const label = prompt('Link-Label (leer = keins):', curLabel);
  if (label === null) return;
  const type = prompt('Beziehungstyp (z.B. depends-on, supersedes; leer = keiner):', curType);
  if (type === null) return;
  try {
    await api('PUT', '/api/links', { source, target, label, type: type.trim() || null });
    showToast('Verknüpfung aktualisiert');
    // WS-Update refresht rawData; Tab neu rendern.
    if (selectedNode) updateLinksTab(selectedNode);
  } catch (err) {
    showToast('Update fehlgeschlagen: ' + err.message);
  }
}

/* ── CRUD Operations ─────────────────────────────────── */
async function saveNode() {
  if (!selectedNode) return;
  const label = document.getElementById('panel-label').value.trim();
  const content = document.getElementById('panel-content').value;
  if (!label) { showToast('Titel darf nicht leer sein'); return; }

  const tags = document.getElementById('panel-tags-input').value
    .split(',').map(t => t.trim()).filter(Boolean);
  const summary = document.getElementById('panel-summary').value.trim();
  const ttlVal = document.getElementById('panel-ttl').value;
  const payload = {
    label, content,
    type: document.getElementById('panel-type').value,
    tags,
    summary: summary || null,
    ttl: ttlVal ? Number(ttlVal) : null,
  };

  const updated = await api('PUT', `/api/nodes/${selectedNode.id}`, payload);
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
  // Search (mit Debounce für die Live-Hervorhebung)
  const searchEl = document.getElementById('search');
  const clearBtn = document.getElementById('search-clear');
  let searchDebounce = null;
  searchEl.addEventListener('input', () => {
    searchQuery = searchEl.value.trim();
    semanticMatchIds = null; // Tippen → zurück zum Substring-Highlight
    clearBtn.classList.toggle('hidden', !searchQuery);
    hideSearchResults();
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(refreshGraph, 150);
  });
  searchEl.addEventListener('keydown', (e) => {
    const resultsOpen = !document.getElementById('search-results').classList.contains('hidden');
    if (e.key === 'Enter') {
      e.preventDefault();
      if (resultsOpen && searchActiveIdx >= 0) activateSearchSelection();
      else semanticSearch(searchEl.value.trim());
    } else if (e.key === 'ArrowDown' && resultsOpen) {
      e.preventDefault(); moveSearchActive(1);
    } else if (e.key === 'ArrowUp' && resultsOpen) {
      e.preventDefault(); moveSearchActive(-1);
    } else if (e.key === 'Escape' && resultsOpen) {
      hideSearchResults();
    }
  });
  clearBtn.addEventListener('click', () => {
    searchEl.value = '';
    searchQuery = '';
    semanticMatchIds = null;
    clearBtn.classList.add('hidden');
    hideSearchResults();
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

  // Maintenance dashboard
  document.getElementById('btn-maintenance').addEventListener('click', openMaintenance);
  document.getElementById('btn-maint-close').addEventListener('click', closeMaintenance);
  document.getElementById('btn-maint-done').addEventListener('click', closeMaintenance);
  document.getElementById('btn-gardener-run').addEventListener('click', async () => {
    const btn = document.getElementById('btn-gardener-run');
    btn.disabled = true; btn.textContent = 'Läuft…';
    try {
      const r = await api('POST', '/api/brain/maintenance');
      showToast(r.changed ? 'Gärtner: Bericht aktualisiert' : 'Gärtner: nichts zu tun');
      await renderMaintenance();
    } catch (err) {
      showToast('Gärtner fehlgeschlagen: ' + err.message);
    }
    btn.disabled = false; btn.textContent = 'Gärtner jetzt ausführen';
  });

  // Close modals on backdrop click
  document.querySelectorAll('.modal').forEach(modal => {
    modal.addEventListener('click', e => {
      if (e.target === modal) modal.classList.add('hidden');
    });
  });

  // Mobile bottom sheet drag-to-dismiss
  initPanelDrag();

  // Globale Tastatur-Shortcuts: '/' fokussiert Suche, Escape schließt Overlays.
  document.addEventListener('keydown', (e) => {
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
    if (e.key === '/' && !inField) {
      e.preventDefault();
      document.getElementById('search').focus();
    } else if (e.key === 'Escape') {
      hideContextMenu();
      hideSearchResults();
      const openModal = document.querySelector('.modal:not(.hidden)');
      if (openModal) { openModal.classList.add('hidden'); return; }
      if (linkSourceNode) { cancelLinkMode(); return; }
      if (!document.getElementById('panel').classList.contains('hidden')) closePanel();
    }
  });

  // Kontextmenü (Rechtsklick auf Knoten)
  graph.onNodeRightClick((node, evt) => {
    if (evt) evt.preventDefault();
    showContextMenu(node, evt);
  });
  document.addEventListener('click', hideContextMenu);
  document.getElementById('graph-container').addEventListener('contextmenu', e => e.preventDefault());

  // Such-Dropdown bei Klick außerhalb schließen.
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#search-results') && !e.target.closest('.search-wrap')) hideSearchResults();
  });

  // Action log toggle
  const logHeader = document.getElementById('log-header');
  if (logHeader) {
    logHeader.addEventListener('click', () => {
      const logEl = document.getElementById('action-log');
      const toggleBtn = document.getElementById('log-toggle');
      const collapsed = logEl.classList.toggle('collapsed');
      if (toggleBtn) toggleBtn.textContent = collapsed ? '▲' : '▼';
    });
  }
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

/* ── Context Menu (B4) ───────────────────────────────── */
function showContextMenu(node, evt) {
  const full = rawData.nodes.find(n => n.id === node.id) || node;
  const menu = document.getElementById('ctx-menu');
  const actions = [
    ['Öffnen', () => { selectedNode = full; showPanel(full); }],
    ['Verbinden', () => { linkSourceNode = full; showLinkBanner(full.label); refreshGraph(); showToast('Shift+Klick auf Zielknoten'); }],
    ['Nachbarn zeigen', () => showNeighbors(full.id)],
    ['Historie', () => { selectedNode = full; showPanel(full); switchTab('history'); }],
    ['Löschen', () => { selectedNode = full; deleteNode(full.id); }, 'danger'],
  ];
  menu.innerHTML = '';
  for (const [label, fn, cls] of actions) {
    const b = document.createElement('button');
    b.textContent = label;
    if (cls) b.className = cls;
    b.addEventListener('click', (e) => { e.stopPropagation(); hideContextMenu(); fn(); });
    menu.appendChild(b);
  }
  const x = evt?.clientX ?? window.innerWidth / 2;
  const y = evt?.clientY ?? window.innerHeight / 2;
  menu.style.left = Math.min(x, window.innerWidth - 180) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - 220) + 'px';
  menu.classList.remove('hidden');
}

function hideContextMenu() {
  document.getElementById('ctx-menu').classList.add('hidden');
}

async function showNeighbors(id) {
  try {
    const sub = await (await fetch(`/api/nodes/${id}/neighbors?depth=1`)).json();
    if (!sub || !sub.nodes) { showToast('Keine Nachbarn'); return; }
    semanticMatchIds = new Set(sub.nodes.map(n => n.id));
    refreshGraph();
    showToast(`${sub.count - 1} Nachbar(n) hervorgehoben`);
    jumpToNode(sub.root.label);
  } catch {
    showToast('Nachbarn nicht ladbar');
  }
}

/* ── Maintenance Dashboard (B1) ──────────────────────── */
function openMaintenance() {
  document.getElementById('modal-maintenance').classList.remove('hidden');
  renderMaintenance();
}
function closeMaintenance() {
  document.getElementById('modal-maintenance').classList.add('hidden');
}

async function renderMaintenance() {
  const body = document.getElementById('maint-body');
  body.innerHTML = '<p class="hint">Lade Bericht…</p>';
  let report, suggestions;
  try {
    [report, suggestions] = await Promise.all([
      fetch('/api/brain/health-report').then(r => r.json()),
      fetch('/api/brain/suggest-links').then(r => r.json()),
    ]);
  } catch {
    body.innerHTML = '<p class="report-empty">Bericht nicht ladbar.</p>';
    return;
  }

  const t = report.totals || { nodes: 0, links: 0 };
  const section = (title, items, render) => {
    const list = (items && items.length)
      ? items.map(render).join('')
      : '<span class="report-empty">– keine –</span>';
    return `<details class="report-section"${items && items.length ? ' open' : ''}>
      <summary>${title} (${items ? items.length : 0})</summary>
      <div class="report-list">${list}</div>
    </details>`;
  };
  const li = (txt) => `<span class="item">${escHtml(txt)}</span>`;

  const sugHtml = (suggestions.suggestions || []).map((s, i) => `
    <div class="suggestion-row" data-i="${i}">
      <span class="suggestion-pair">${escHtml(s.source.label)} ↔ ${escHtml(s.target.label)} <span class="sim">${s.similarity}</span></span>
      <span class="suggestion-actions">
        <button class="accept" data-src="${escAttr(s.source.id)}" data-tgt="${escAttr(s.target.id)}">Verbinden</button>
        <button class="reject" data-src="${escAttr(s.source.id)}" data-tgt="${escAttr(s.target.id)}">Verwerfen</button>
      </span>
    </div>`).join('') || '<span class="report-empty">– keine offenen Vorschläge –</span>';

  body.innerHTML = `
    <div class="maint-totals">${t.nodes} Knoten · ${t.links} Kanten</div>
    <details class="report-section" open>
      <summary>Link-Vorschläge (${(suggestions.suggestions || []).length})</summary>
      <div class="report-list" id="maint-suggestions">${sugHtml}</div>
    </details>
    ${section('Waisen (ohne Kanten)', report.orphans, n => li(n.label || n))}
    ${section('Doppelte Labels', report.duplicateLabels, li)}
    ${section('Tote Wikilinks', report.deadWikilinks, li)}
    ${section('Nie zugegriffen', report.neverAccessed, li)}
    ${section('Läuft bald ab (TTL)', report.expiringSoon, n => li(`${n.label} · ${n.expires_at}`))}
  `;

  body.querySelectorAll('.suggestion-actions .accept').forEach(btn =>
    btn.addEventListener('click', () => acceptSuggestion(btn)));
  body.querySelectorAll('.suggestion-actions .reject').forEach(btn =>
    btn.addEventListener('click', () => rejectSuggestion(btn)));
}

async function acceptSuggestion(btn) {
  try {
    // rel_type null → unterscheidbar von Gärtner-'auto'.
    await api('POST', '/api/links', { source: btn.dataset.src, target: btn.dataset.tgt });
    showToast('Verbunden');
    btn.closest('.suggestion-row').remove();
  } catch (err) {
    showToast('Verbinden fehlgeschlagen: ' + err.message);
  }
}

async function rejectSuggestion(btn) {
  try {
    await api('POST', '/api/brain/suggest-links/dismiss', { source: btn.dataset.src, target: btn.dataset.tgt });
    showToast('Vorschlag verworfen');
    btn.closest('.suggestion-row').remove();
  } catch (err) {
    showToast('Verwerfen fehlgeschlagen: ' + err.message);
  }
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
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
// Für Attributwerte (data-*): zusätzlich einfache Anführungszeichen entschärfen.
function escAttr(str) {
  return escHtml(str).replace(/'/g,'&#39;');
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

    if (msg.type === 'log') {
      appendLogEntry(msg);
      return;
    }

    if (msg.type === 'log-history') {
      const logEntries = document.getElementById('log-entries');
      if (logEntries) logEntries.innerHTML = '';
      // Älteste zuerst rendern → neueste landen oben (prepend).
      (msg.entries || []).forEach(appendLogEntry);
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

/* ── Glow Overlays ───────────────────────────────────── */
function animateGlow() {
  if (graph) {
    const container = document.getElementById('graph-container');
    const rect = container.getBoundingClientRect();
    const now = Date.now();
    const glowNodes = rawData.nodes.filter(n =>
      n.id === startNodeId || recentlyAccessed.has(n.id)
    );
    const glowIds = new Set(glowNodes.map(n => n.id));

    for (const [id, el] of glowOverlays) {
      if (!glowIds.has(id)) { el.remove(); glowOverlays.delete(id); }
    }

    for (const node of glowNodes) {
      const simNode = graph.graphData().nodes.find(n => n.id === node.id);
      if (!simNode || simNode.x == null) continue;

      const coords = graph.graph2ScreenCoords(simNode.x, simNode.y, simNode.z ?? 0);
      if (!coords) continue;
      const sx = rect.left + coords.x;
      const sy = rect.top + coords.y;

      let el = glowOverlays.get(node.id);
      if (!el) {
        el = document.createElement('div');
        el.style.position = 'fixed';
        el.style.pointerEvents = 'none';
        el.style.borderRadius = '50%';
        el.style.zIndex = '3';
        document.body.appendChild(el);
        glowOverlays.set(node.id, el);
      }

      const isStart = node.id === startNodeId;
      const size = isStart ? 55 : 45;
      let opacity, color;

      if (isStart) {
        const phase = (Math.sin(now / 900) + 1) / 2;
        opacity = 0.2 + phase * 0.3;
        color = '255, 248, 180';
      } else {
        const remaining = recentlyAccessed.get(node.id) - now;
        opacity = Math.max(0, (remaining / 3000) * 0.65);
        color = '255, 255, 255';
      }

      const outOfBounds = sx < -60 || sx > window.innerWidth + 60 ||
                          sy < -60 || sy > window.innerHeight + 60;
      el.style.opacity = outOfBounds ? '0' : '1';
      el.style.width = `${size}px`;
      el.style.height = `${size}px`;
      el.style.left = `${sx - size / 2}px`;
      el.style.top = `${sy - size / 2}px`;
      el.style.background = `rgba(${color}, ${opacity})`;
      el.style.filter = `blur(${Math.round(size * 0.55)}px)`;
    }
  }
  requestAnimationFrame(animateGlow);
}

/* ── Action Log ──────────────────────────────────────── */
function appendLogEntry({ action, labels, ts }) {
  const logEntries = document.getElementById('log-entries');
  if (!logEntries) return;

  const el = document.createElement('div');
  el.className = 'log-entry';
  const d = new Date(ts);
  el.dataset.ts = d.getTime();
  // Datum nur zeigen, wenn der Eintrag nicht von heute ist (7-Tage-Historie).
  const isToday = d.toDateString() === new Date().toDateString();
  const time = isToday
    ? d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const icons = { read: '👁', created: '✨', updated: '✏️', deleted: '🗑', linked: '🔗', unlinked: '✂️', used: '✅' };
  const icon = icons[action] ?? '·';
  const labelText = labels && labels.length ? labels.join(' → ') : action;
  el.textContent = `${time} ${icon} ${labelText}`;

  logEntries.prepend(el);

  // Pruning nach Alter (7 Tage) statt nach Anzahl; Hard-Cap gegen DOM-Wildwuchs.
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  while (logEntries.lastChild && Number(logEntries.lastChild.dataset.ts) < cutoff) {
    logEntries.lastChild.remove();
  }
  while (logEntries.children.length > 1000) logEntries.lastChild.remove();

  // Auto-expand the log when new entries arrive
  const logEl = document.getElementById('action-log');
  if (logEl && logEl.classList.contains('collapsed')) {
    // Keep collapsed but show a brief flash on the header
    const header = document.getElementById('log-header');
    if (header) {
      header.style.color = 'rgba(255,255,255,0.85)';
      setTimeout(() => { header.style.color = ''; }, 800);
    }
  }
}

/* ── Start ───────────────────────────────────────────── */
window.addEventListener('DOMContentLoaded', () => { init(); initLiveSync(); });

/* Expose for inline event handlers */
window.jumpToNode = jumpToNode;
window.deleteLink = deleteLink;

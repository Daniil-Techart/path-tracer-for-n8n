/* n8n Path Tracer v1.0.0 | MIT | license: see LICENSE */
(() => {
  'use strict';

  const VERSION = '1.4.0';
  if (window.__pathTracer && window.__pathTracer.version === VERSION) return;

  const NS = 'http://www.w3.org/2000/svg';
  const MAX_PATHS = 64;
  const MAX_DEPTH = 256;
  const STYLE_ID = 'n8n-path-tracer-style';

  const q = (sel, root = document) => root.querySelector(sel);
  const qa = (sel, root = document) => Array.from(root.querySelectorAll(sel));


  function looksLikeN8n() {
    if (q('meta[name="n8n:config:rest-endpoint"]')) return true;
    if (q('.vue-flow') && /^\/workflow\//.test(location.pathname)) return true;
    return !!q('#app') && /n8n/i.test(document.title || '');
  }

  if (!looksLikeN8n()) return;

  const state = {
    version: VERSION,
    enabled: true,
    target: null,
    paths: [],
    isolated: null,
    workflowId: null,
    domEdges: [],
    pairPaths: new Map(),
    pathKeySets: [],
    overlay: null,
    overlaySignature: '',
    geometry: new Map(),
    timer: 0,
  };

  let marker = null;
  let markerPanel = null;
  let observer = null;
  let watchedCanvas = null;

  const CSS = `
#pt-marker{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--text-color,#444);cursor:pointer;transition:background .12s,opacity .12s,filter .12s}
#pt-marker:hover{background:var(--background--hover,rgba(0,0,0,.06))}
#pt-marker[data-off]{opacity:.4;filter:grayscale(1)}
#pt-marker svg{width:16px;height:16px;display:block}
.pt-panel{position:absolute;right:15px;bottom:15px;z-index:6;padding:3px;border-radius:8px;border:1px solid var(--color--foreground--shade-1,rgba(0,0,0,.12));background:var(--background--surface,#fff);box-shadow:0 2px 8px rgba(0,0,0,.12)}
body>.pt-panel{position:fixed}
.pt-panel[hidden]{display:none!important}
.pt-toolbar{display:flex;gap:2px;align-items:center}
.pt-overlay-svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none}
.vue-flow__node[data-pt-dim]{opacity:.2!important;filter:saturate(.2)!important;transition:opacity .15s ease}
.vue-flow__edge[data-pt-dim]{opacity:.1!important;transition:opacity .15s ease}
.vue-flow__edge[data-pt-on]{opacity:.2!important;transition:opacity .15s ease}
.pt-spark{stroke-opacity:.85;stroke-width:3;stroke-linecap:round;stroke-dasharray:var(--pt-dash,24px) var(--pt-gap,200px);animation:pt-spark var(--pt-dur,1.2s) linear infinite;pointer-events:none}
@keyframes pt-spark{to{stroke-dashoffset:calc(-1 * (var(--pt-gap,200px) + var(--pt-dash,24px)))}}
`;

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  function onWorkflowPage() {
    return /\/workflow(\/|$|\?)/.test(location.pathname);
  }

  function sparkColorFor(index) {
    const hue = Math.round((index * 137.508) % 360);
    return `hsl(${hue} 95% 80%)`;
  }
  function colorFor(index) {
    const hue = Math.round((index * 137.508) % 360);
    return `hsl(${hue} 85% 62%)`;
  }

  function piniaStores() {
    const app = q('#app');
    const pinia = app && app.__vue_app__ && app.__vue_app__.config
      ? app.__vue_app__.config.globalProperties.$pinia
      : null;
    return pinia && pinia._s ? pinia._s : null;
  }

  function workflowStore() {
    const stores = piniaStores();
    if (!stores) return null;
    const urlId = (location.pathname.match(/\/workflow\/([^/?#]+)/) || [])[1];
    let fallback = null;
    for (const [id, store] of stores) {
      if (!id.startsWith('workflowDocuments/')) continue;
      let workflowId = null;
      let nodes = null;
      try {
        workflowId = store.workflowId;
        nodes = store.allNodes;
      } catch {
        continue;
      }
      if (workflowId && typeof workflowId === 'object' && 'value' in workflowId) workflowId = workflowId.value;
      if (!Array.isArray(nodes)) continue;
      if (urlId && workflowId === urlId) return store;
      if (id === 'workflowDocuments/@latest') fallback = store;
    }
    return fallback;
  }

  function parseEdgeId(id) {
    const match = /^\[([^/]+)\/([^\]]+)\]\[([^/]+)\/([^\]]+)\]$/.exec(id || '');
    if (!match) return null;
    return { source: match[1], sourceHandle: match[2], target: match[3], targetHandle: match[4] };
  }

  function parseHandle(handle) {
    const parts = String(handle || '').split('/');
    if (parts.length < 3) return { type: parts[0] || 'main', index: 0 };
    return { type: parts[1], index: Number(parts[2]) || 0 };
  }

  function domNodeEntries() {
    const entries = [];
    for (const el of qa('.vue-flow__node[data-id]')) {
      const id = el.getAttribute('data-id');
      if (!id) continue;
      const inner = el.querySelector('[data-node-name]');
      const name = el.getAttribute('data-node-name') || (inner ? inner.getAttribute('data-node-name') : null);
      if (!name) continue;
      const type = el.getAttribute('data-node-type')
        || (inner ? inner.getAttribute('data-node-type') : '')
        || '';
      entries.push({ el, id, name, type });
    }
    return entries;
  }

  function domNodeName(element) {
    const wrapper = element instanceof Element ? element.closest('.vue-flow__node') : null;
    if (!wrapper) return null;
    const inner = wrapper.querySelector('[data-node-name]');
    return wrapper.getAttribute('data-node-name') || (inner ? inner.getAttribute('data-node-name') : null);
  }



  function nodeNamesById() {
    const names = new Map();
    for (const entry of domNodeEntries()) names.set(entry.id, entry.name);
    return names;
  }

  function collectDomEdges() {
    const list = [];
    const names = nodeNamesById();
    for (const el of qa('.vue-flow__edge[data-id]')) {
      const id = el.getAttribute('data-id');
      const parsed = parseEdgeId(id);
      if (!parsed) continue;
      const sourceHandle = parseHandle(parsed.sourceHandle);
      const targetHandle = parseHandle(parsed.targetHandle);
      list.push({
        el,
        key: id,
        source: names.get(parsed.source) || parsed.source,
        target: names.get(parsed.target) || parsed.target,
        type: sourceHandle.type,
        outIndex: sourceHandle.index,
        inIndex: targetHandle.index,
      });
    }
    return list;
  }

  function readGraph() {
    const store = workflowStore();
    if (store && Array.isArray(store.allNodes)) {
      const nodes = new Map();
      for (const node of store.allNodes) {
        if (!node || typeof node.name !== 'string') continue;
        if (String(node.type || '').includes('stickyNote')) continue;
        nodes.set(node.name, { name: node.name, type: node.type || '', disabled: !!node.disabled });
      }
      const edges = [];
      const source = store.connectionsBySourceNode || {};
      for (const [from, byType] of Object.entries(source)) {
        if (!nodes.has(from) || !byType || typeof byType !== 'object') continue;
        for (const [type, lists] of Object.entries(byType)) {
          if (!Array.isArray(lists)) continue;
          lists.forEach((list, outIndex) => {
            if (!Array.isArray(list)) return;
            for (const conn of list) {
              if (!conn || typeof conn.node !== 'string' || !nodes.has(conn.node)) continue;
              edges.push({
                source: from,
                target: conn.node,
                type,
                outIndex,
                inIndex: Number.isFinite(conn.index) ? conn.index : 0,
              });
            }
          });
        }
      }
      if (nodes.size) return { nodes, edges, source: 'store' };
    }

    const nodes = new Map();
    for (const entry of domNodeEntries()) {
      if (entry.type.includes('stickyNote')) continue;
      nodes.set(entry.name, { name: entry.name, type: entry.type, disabled: false });
    }
    const edges = [];
    for (const edge of collectDomEdges()) {
      if (!nodes.has(edge.source) || !nodes.has(edge.target)) continue;
      edges.push({
        source: edge.source,
        target: edge.target,
        type: edge.type,
        outIndex: edge.outIndex,
        inIndex: edge.inIndex,
      });
    }
    return { nodes, edges, source: 'dom' };
  }

  function findPaths(graph, target) {
    if (!graph.nodes.has(target)) return { paths: [], truncated: false };
    const incoming = new Map();
    for (const edge of graph.edges) {
      if (edge.type !== 'main') continue;
      if (!incoming.has(edge.target)) incoming.set(edge.target, []);
      incoming.get(edge.target).push(edge);
    }

    const paths = [];
    let truncated = false;

    const walk = (name, trail, visited) => {
      if (paths.length >= MAX_PATHS) {
        truncated = true;
        return;
      }
      if (trail.length > MAX_DEPTH) {
        truncated = true;
        return;
      }
      const preds = (incoming.get(name) || []).filter((edge) => graph.nodes.has(edge.source));
      if (!preds.length) {
        paths.push(trail.slice().reverse());
        return;
      }
      for (const edge of preds) {
        if (visited.has(edge.source)) continue;
        visited.add(edge.source);
        trail.push(edge.source);
        walk(edge.source, trail, visited);
        trail.pop();
        visited.delete(edge.source);
      }
    };

    walk(target, [target], new Set([target]));
    return { paths, truncated };
  }

  function syncGeometry() {
    for (const [geoKey, entry] of state.geometry) {
      const [edgeKey, indexText] = geoKey.split('|');
      const edge = state.domEdges.find((item) => item.key === edgeKey);
      if (!edge) continue;
      const native = edge.el.querySelectorAll('.vue-flow__edge-path')[Number(indexText)];
      if (!native) continue;
      const shape = native.getAttribute('d');
      if (!shape || shape === entry.shape) continue;
      entry.shape = shape;
      for (const node of entry.copies) node.setAttribute('d', shape);
      for (const node of entry.sparks) node.setAttribute('d', shape);
    }
  }

  let geometryFrame = 0;
  function scheduleGeometry() {
    if (geometryFrame) return;
    geometryFrame = requestAnimationFrame(() => {
      geometryFrame = 0;
      syncGeometry();
    });
  }
  function safeLength(pathEl) {
    try {
      const length = pathEl.getTotalLength();
      return Number.isFinite(length) ? length : 0;
    } catch {
      return 0;
    }
  }

  function ensureOverlayGroup() {
    const pane = q('.vue-flow__transformationpane') || q('.vue-flow__viewport');
    if (!pane) return null;

    let svg = Array.from(pane.children).find((child) => child.hasAttribute && child.hasAttribute('data-pt-overlay-svg'));
    if (!svg) {
      svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('data-pt-overlay-svg', '');
      svg.setAttribute('class', 'pt-overlay-svg');
    }

    const nodesLayer = Array.from(pane.children).find((child) => child.classList && child.classList.contains('vue-flow__nodes'));
    if (nodesLayer) {
      if (svg.nextElementSibling !== nodesLayer) pane.insertBefore(svg, nodesLayer);
    } else if (pane.lastElementChild !== svg) {
      pane.appendChild(svg);
    }

    let group = svg.querySelector('g[data-pt-overlay]');
    if (!group) {
      group = document.createElementNS(NS, 'g');
      group.setAttribute('data-pt-overlay', '');
      svg.appendChild(group);
    }
    return group;
  }
  function renderOverlay() {
    const group = ensureOverlayGroup();
    if (!group) {
      state.overlay = null;
      return;
    }
    state.overlay = group;

    state.pairPaths = new Map();
    state.pathKeySets = [];
    if (!state.paths.length) {
      state.overlaySignature = '';
      while (group.firstChild) group.removeChild(group.firstChild);
      return;
    }

    const pairMap = new Map();
    for (const edge of state.domEdges) {
      const key = edge.source + '\u0000' + edge.target;
      if (!pairMap.has(key)) pairMap.set(key, []);
      pairMap.get(key).push(edge);
    }

    state.pathKeySets = state.paths.map((path) => {
      const keys = new Set();
      for (let i = 1; i < path.length; i++) {
        const list = pairMap.get(path[i - 1] + '\u0000' + path[i]) || [];
        for (const edge of list) keys.add(edge.key);
      }
      return keys;
    });

    state.pathKeySets.forEach((keys, index) => {
      for (const key of keys) {
        if (!state.pairPaths.has(key)) state.pairPaths.set(key, new Set());
        state.pairPaths.get(key).add(index);
      }
    });

    const signature = state.paths.map((path) => path.join('\u0001')).join('\u0002')
      + '|' + [...state.pairPaths.keys()].sort().map((key) => {
        const edge = state.domEdges.find((item) => item.key === key);
        if (!edge) return key;
        return key + ':' + edge.el.querySelectorAll('.vue-flow__edge-path').length;
      }).join(';');

    if (signature === state.overlaySignature && group.isConnected && group.childElementCount) return;
    state.overlaySignature = signature;
    state.geometry.clear();
    while (group.firstChild) group.removeChild(group.firstChild);

    const defs = document.createElementNS(NS, 'defs');
    for (let i = 0; i < state.paths.length; i++) {
      const marker = document.createElementNS(NS, 'marker');
      marker.setAttribute('id', 'pt-arrow-' + i);
      marker.setAttribute('viewBox', '0 0 10 10');
      marker.setAttribute('refX', '7.5');
      marker.setAttribute('refY', '5');
      marker.setAttribute('markerWidth', '4');
      marker.setAttribute('markerHeight', '4');
      marker.setAttribute('orient', 'auto-start-reverse');
      const head = document.createElementNS(NS, 'path');
      head.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
      head.setAttribute('fill', colorFor(i));
      marker.appendChild(head);
      defs.appendChild(marker);
    }
    group.appendChild(defs);

    state.edgeColors = new Map();

    for (const key of [...state.pairPaths.keys()].sort()) {
      const edge = state.domEdges.find((item) => item.key === key);
      if (!edge) continue;
      const indexes = [...state.pairPaths.get(key)].sort((a, b) => a - b);
      const colorIndex = indexes[0];
      state.edgeColors.set(key, colorIndex);

      const edgeGroup = document.createElementNS(NS, 'g');
      edgeGroup.setAttribute('data-pt-edge', key);

      const natives = [...edge.el.querySelectorAll('.vue-flow__edge-path')];
      for (let shapeIndex = 0; shapeIndex < natives.length; shapeIndex++) {
        const native = natives[shapeIndex];
        const shape = native.getAttribute('d');
        if (!shape) continue;

        const length = safeLength(native);
        const sparkDash = Math.max(14, Math.min(60, length ? length * 0.16 : 24));
        const sparkGap = length || 200;
        const sparkDuration = Math.max(0.8, (sparkGap + sparkDash) / 170);

        const halo = document.createElementNS(NS, 'path');
        halo.setAttribute('d', shape);
        halo.setAttribute('fill', 'none');
        halo.setAttribute('stroke', 'rgba(0,0,0,.4)');
        halo.setAttribute('stroke-width', '6.5');
        halo.setAttribute('stroke-linecap', 'round');
        halo.setAttribute('pointer-events', 'none');
        edgeGroup.appendChild(halo);

        const line = document.createElementNS(NS, 'path');
        line.setAttribute('d', shape);
        line.setAttribute('fill', 'none');
        line.setAttribute('stroke', colorFor(colorIndex));
        line.setAttribute('stroke-width', '3');
        line.setAttribute('stroke-linecap', 'round');
        line.setAttribute('marker-end', 'url(#pt-arrow-' + colorIndex + ')');
        line.setAttribute('data-pt-line', '');
        line.setAttribute('pointer-events', 'none');
        edgeGroup.appendChild(line);

        const copies = [halo, line];
        const sparks = [];

        for (let copy = 0; copy < 2; copy++) {
          const spark = document.createElementNS(NS, 'path');
          spark.setAttribute('d', shape);
          spark.setAttribute('fill', 'none');
          spark.setAttribute('class', 'pt-spark');
          spark.setAttribute('stroke', sparkColorFor(colorIndex));
          spark.setAttribute('pointer-events', 'none');
          spark.style.setProperty('--pt-dash', sparkDash.toFixed(1) + 'px');
          spark.style.setProperty('--pt-gap', sparkGap.toFixed(1) + 'px');
          spark.style.setProperty('--pt-dur', sparkDuration.toFixed(2) + 's');
          if (copy) spark.style.animationDelay = (-sparkDuration / 2).toFixed(2) + 's';
          edgeGroup.appendChild(spark);
          sparks.push(spark);
        }

        const geoKey = edge.key + '|' + shapeIndex;
        const entry = state.geometry.get(geoKey) || { copies: [], sparks: [], shape };
        entry.copies.push(...copies);
        entry.sparks.push(...sparks);
        state.geometry.set(geoKey, entry);
      }

      group.appendChild(edgeGroup);
    }
  }
  function activePathIndexes() {
    if (state.isolated != null && state.paths[state.isolated]) return [state.isolated];
    return state.paths.map((_, index) => index);
  }

  function applyHighlight() {
    const tracking = state.paths.length > 0;
    const active = tracking ? activePathIndexes() : [];
    const visibleNodes = new Set();
    const visibleEdges = new Set();
    for (const index of active) {
      for (const name of state.paths[index]) visibleNodes.add(name);
      for (const key of state.pathKeySets[index] || []) visibleEdges.add(key);
    }

    for (const entry of domNodeEntries()) {
      const on = tracking && visibleNodes.has(entry.name);
      entry.el.toggleAttribute('data-pt-on', on);
      entry.el.toggleAttribute('data-pt-dim', tracking && !on);
    }

    for (const edge of state.domEdges) {
      const on = tracking && visibleEdges.has(edge.key);
      edge.el.toggleAttribute('data-pt-on', on);
      edge.el.toggleAttribute('data-pt-dim', tracking && !on);
    }

    if (state.overlay) {
      for (const edgeGroup of state.overlay.querySelectorAll('g[data-pt-edge]')) {
        const key = edgeGroup.getAttribute('data-pt-edge');
        const on = tracking && visibleEdges.has(key);
        edgeGroup.style.display = on ? '' : 'none';
        if (!on) continue;
        const colorIndex = state.isolated != null
          ? state.isolated
          : (state.edgeColors.get(key) || 0);
        for (const line of edgeGroup.querySelectorAll('path[data-pt-line]')) {
          line.setAttribute('stroke', colorFor(colorIndex));
          line.setAttribute('marker-end', 'url(#pt-arrow-' + colorIndex + ')');
        }
        for (const spark of edgeGroup.querySelectorAll('.pt-spark')) {
          spark.setAttribute('stroke', sparkColorFor(colorIndex));
        }
      }
    }

  }

  function clearHighlight() {
    for (const el of qa('.vue-flow__node[data-pt-on], .vue-flow__node[data-pt-dim]')) {
      el.removeAttribute('data-pt-on');
      el.removeAttribute('data-pt-dim');
    }
    for (const el of qa('.vue-flow__edge[data-id]')) {
      el.removeAttribute('data-pt-on');
      el.removeAttribute('data-pt-dim');
    }
    if (state.overlay) {
      while (state.overlay.firstChild) state.overlay.removeChild(state.overlay.firstChild);
    }

    state.overlaySignature = '';
    state.geometry.clear();
    state.paths = [];
    state.pathKeySets = [];
    state.pairPaths = new Map();
    state.isolated = null;
  }

  function refresh() {
    if (!state.enabled) return;
    ensureStyle();
    const graph = readGraph();
    state.domEdges = collectDomEdges();

    const workflowId = (location.pathname.match(/\/workflow\/([^/?#]+)/) || [])[1] || null;
    if (workflowId !== state.workflowId) {
      state.workflowId = workflowId;
      state.target = null;
      state.isolated = null;
    }

    if (!state.target || !graph.nodes.has(state.target)) {
      state.target = null;
    }

    if (!state.target) {
      clearHighlight();
      return;
    }

    const result = findPaths(graph, state.target);
    state.paths = result.paths;
    if (state.isolated != null && !state.paths[state.isolated]) state.isolated = null;

    renderOverlay();
    applyHighlight();
  }

  function schedule(delay = 180) {
    clearTimeout(state.timer);
    state.timer = setTimeout(refresh, delay);
  }

  function pickTarget(name) {
    state.target = name;
    state.isolated = null;
    schedule(0);
  }

  function distanceToSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const square = dx * dx + dy * dy;
    let t = square ? ((px - ax) * dx + (py - ay) * dy) / square : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  function pathIndexesAt(clientX, clientY, threshold = 14) {
    if (!state.paths.length || !state.pairPaths.size) return null;
    let best = null;
    for (const [key, indexes] of state.pairPaths) {
      const edge = state.domEdges.find((item) => item.key === key);
      if (!edge) continue;
      for (const native of edge.el.querySelectorAll('.vue-flow__edge-path')) {
        const matrix = native.getScreenCTM();
        if (!matrix) continue;
        let length = 0;
        try {
          length = native.getTotalLength();
        } catch {
          continue;
        }
        if (!length) continue;
        const scale = Math.hypot(matrix.a, matrix.b) || 1;
        const steps = Math.max(8, Math.min(400, Math.ceil((length * scale) / 8)));
        let previous = null;
        for (let i = 0; i <= steps; i++) {
          const point = native.getPointAtLength((length * i) / steps);
          const screen = new DOMPoint(point.x, point.y).matrixTransform(matrix);
          if (previous) {
            const distance = distanceToSegment(clientX, clientY, previous.x, previous.y, screen.x, screen.y);
            if (distance <= threshold && (!best || distance < best.distance)) {
              best = { distance, indexes: [...indexes].sort((a, b) => a - b) };
            }
          }
          previous = { x: screen.x, y: screen.y };
        }
      }
    }
    return best;
  }
  function cycleIsolation(indexes) {
    if (!indexes || !indexes.length) return;
    if (indexes.length === 1) {
      state.isolated = indexes[0];
    } else {
      const position = indexes.indexOf(state.isolated);
      state.isolated = indexes[(position + 1) % indexes.length];
    }
    applyHighlight();
  }
  function ensureUi() {
    if (!document.body) return;
    ensureStyle();

    if (!marker) {
      markerPanel = document.createElement('div');
      markerPanel.className = 'pt-panel';

      const toolbar = document.createElement('div');
      toolbar.className = 'pt-toolbar';
      toolbar.setAttribute('role', 'group');

      marker = document.createElement('button');
      marker.id = 'pt-marker';
      marker.type = 'button';
      marker.className = 'pt-button';
      marker.setAttribute('aria-label', 'Path Tracer');
      marker.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false"><path d="M3 8C6.25 1.25 7.75 1.25 13 8" stroke="#e5484d" stroke-width="1.6" stroke-linecap="round"/><path d="M3 8C6.25 8 7.75 8 13 8" stroke="#30a46c" stroke-width="1.6" stroke-linecap="round"/><path d="M3 8C6.25 14.75 7.75 14.75 13 8" stroke="#8e4ec6" stroke-width="1.6" stroke-linecap="round"/><circle cx="3" cy="8" r="1" fill="currentColor"/><circle cx="13" cy="8" r="1" fill="currentColor"/></svg>';
      marker.addEventListener('pointerdown', (event) => event.stopPropagation());
      marker.addEventListener('mousedown', (event) => event.stopPropagation());
      marker.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        setEnabled(!state.enabled);
      });

      toolbar.appendChild(marker);
      markerPanel.appendChild(toolbar);
    }

    const host = q('.vue-flow') || document.body;
    if (markerPanel.parentElement !== host) host.appendChild(markerPanel);
    markerPanel.hidden = !onWorkflowPage();
    marker.toggleAttribute('data-off', !state.enabled);
    marker.setAttribute('aria-pressed', String(state.enabled));
    marker.title = 'Path Tracer v' + VERSION + ': ' + (state.enabled ? 'active' : 'off') + '. Click to turn ' + (state.enabled ? 'off' : 'on') + '.';
  }
  function stopWatch() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    watchedCanvas = null;
  }

  function startWatch() {
    const canvas = q('.vue-flow');
    if (!canvas) {
      stopWatch();
      return;
    }
    if (canvas === watchedCanvas && observer) return;
    stopWatch();
    watchedCanvas = canvas;
    observer = new MutationObserver((records) => {
      const overlay = canvas.querySelector('svg[data-pt-overlay-svg]');
      for (const record of records) {
        if (overlay && (record.target === overlay || overlay.contains(record.target))) continue;
        if (record.type === 'childList') {
          scheduleGeometry();
          return schedule(200);
        }
        const attr = record.attributeName;
        if (attr === 'd') {
          scheduleGeometry();
          continue;
        }
        if (attr === 'class' || attr === 'data-node-name') return schedule(200);
      }
    });
    observer.observe(canvas, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'd', 'data-node-name'],
    });
  }

  function setEnabled(value) {
    state.enabled = !!value;
    ensureUi();
    if (!state.enabled) {
      clearTimeout(state.timer);
      state.target = null;
      stopWatch();
      clearHighlight();
      return;
    }
    startWatch();
    schedule(0);
  }

  function boot() {
    ensureUi();
    startWatch();
    schedule(0);
  }

  document.addEventListener('click', (event) => {
    if (!state.enabled) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.closest('#pt-marker')) return;
    if (state.paths.length) {
      const hit = pathIndexesAt(event.clientX, event.clientY);
      if (hit) {
        event.preventDefault();
        event.stopPropagation();
        cycleIsolation(hit.indexes);
        return;
      }
    }
    const node = target.closest('.vue-flow__node');
    if (node) {
      const name = domNodeName(node);
      if (name) pickTarget(name);
      return;
    }
    if (target.closest('.vue-flow__edge')) return;
    if (state.isolated != null && target.closest('.vue-flow')) {
      state.isolated = null;
      applyHighlight();
    }
  }, true);

  window.addEventListener('keydown', (event) => {
    if (event.altKey && !event.ctrlKey && !event.metaKey && event.code === 'KeyT') {
      if (!state.enabled && !onWorkflowPage()) return;
      event.preventDefault();
      setEnabled(!state.enabled);
      return;
    }
    if (event.key === 'Escape' && state.enabled) {
      const origin = event.target;
      if (origin instanceof Element && origin.closest('input, textarea, [contenteditable="true"]')) return;
      if (state.isolated != null) {
        state.isolated = null;
        applyHighlight();
      } else if (state.paths.length) {
        state.target = null;
        clearHighlight();
      }
    }
  });

  setInterval(() => {
    ensureUi();
    if (!state.enabled || !onWorkflowPage()) return;
    const before = watchedCanvas;
    startWatch();
    if (!before && watchedCanvas) schedule(0);
  }, 800);

  function dump() {
    const active = new Set();
    for (const keys of state.pathKeySets) for (const key of keys) active.add(key);
    return {
      version: VERSION,
      target: state.target,
      paths: state.paths,
      isolated: state.isolated,
      edges: state.domEdges
        .filter((edge) => active.has(edge.key))
        .map((edge) => ({
          id: edge.key,
          source: edge.source,
          target: edge.target,
          shapes: [...edge.el.querySelectorAll('.vue-flow__edge-path')].map((node) => node.getAttribute('d')),
        })),
    };
  }

  window.__pathTracer = {
    version: VERSION,
    enable: () => setEnabled(true),
    disable: () => setEnabled(false),
    toggle: () => setEnabled(!state.enabled),
    refresh: () => schedule(0),
    sync: syncGeometry,
    getState: () => state,
    dump,
    findPaths,
    readGraph,
  };
  try {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
      boot();
    }
  } catch (error) {
    console.error('[path-tracer] boot failed', error);
  }
})();
































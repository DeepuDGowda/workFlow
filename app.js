/* Read-only viewer with:
   - Desktop: drag-pan + wheel zoom
   - Mobile (≤768px): drag-pan + pinch-to-zoom (hand cursor restored)
   - Backlinks: behind tree (color/style from JSON) + hover tooltip + right-panel info
   - Parent→child lines: neutral base; on hover they glow & show child name tooltip
   - Nodes: shapes/colors preserved from JSON
*/

const state = {
  nodes: {},
  rootId: null,
  hubId: null,
  selectedId: null,
  zoom: { k: 1, tx: 0, ty: 0 },
  backlinks: [], // {id, from, to, style, color, bend, pad, title, note}
};

let viewport = null;
let gBack = null,
  gTree = null,
  gNodes = null;

// ===== DOM =====
const mapWrap = document.getElementById("mapWrap");
const svg = document.getElementById("map");
const zoomInBtn = document.getElementById("zoomInBtn");
const zoomOutBtn = document.getElementById("zoomOutBtn");
const zoomResetBtn = document.getElementById("zoomResetBtn");
const fitBtn = document.getElementById("fitBtn");
const reloadBtn = document.getElementById("reloadBtn");
const globalToggleBtn = document.getElementById("globalToggleBtn");

const editorTitle = document.getElementById("editorTitle");
const nodeNameEl = document.getElementById("nodeName");
const nodeTypeEl = document.getElementById("nodeType");
const nodeChildrenEl = document.getElementById("nodeChildren");
const nodeStateEl = document.getElementById("nodeState");
const nodeContentEl = document.getElementById("nodeContent");

const backNameEl = document.getElementById("backName");
const backContentEl = document.getElementById("backContent");
const tooltipEl = document.getElementById("backlinkTooltip");

// ===== Interaction mode =====
let allowPan = true; // now always true (desktop + responsive)
window.addEventListener("resize", () => adjustSvgCanvasSizeForMobile());

// ===== SVG helpers =====
function s_el(name, attrs = {}) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}
function clearGroup(g) {
  while (g.firstChild) g.removeChild(g.firstChild);
}

// ===== Data helpers =====
function getVisibleChildren(n) {
  return n.collapsed
    ? []
    : n.children.map((id) => state.nodes[id]).filter(Boolean);
}
function getVisibleNodes() {
  const vis = [];
  (function walk(id) {
    const n = state.nodes[id];
    if (!n) return;
    vis.push(n);
    if (!n.collapsed) n.children.forEach(walk);
  })(state.rootId);
  return vis;
}

// ===== Layout =====
function measureVisibleLeaves(nodeId) {
  const n = state.nodes[nodeId];
  if (!n) return 1;
  const kids = getVisibleChildren(n);
  if (kids.length === 0) return 1;
  let sum = 0;
  for (const c of kids) sum += measureVisibleLeaves(c.id);
  return sum;
}
function assignDepths() {
  (function dfs(id, d) {
    const n = state.nodes[id];
    if (!n) return;
    n.depth = d;
    if (!n.collapsed) n.children.forEach((cid) => dfs(cid, d + 1));
  })(state.rootId, 0);
}
function computeLayout() {
  const { height: H } = svg.getBoundingClientRect();
  const DX = 160,
    DY = 70,
    CENTER_Y = H / 2;

  assignDepths();

  const root = state.nodes[state.rootId];
  const MARGIN_LEFT = 60;
  root.x = MARGIN_LEFT;
  root.y = CENTER_Y;

  let hub;
  if (state.hubId) {
    hub = state.nodes[state.hubId];
    hub.x = root.x + DX;
    hub.y = CENTER_Y;
  }

  if (hub) {
    const level2 = getVisibleChildren(hub);
    if (level2.length) {
      const sizes = level2.map((c) => measureVisibleLeaves(c.id));
      const totalLeaves = sizes.reduce((a, b) => a + b, 0);
      const totalHeight = Math.max(0, (totalLeaves - 1) * DY);
      let cursor = hub.y - totalHeight / 2;

      const startX = hub.x + DX;
      for (let i = 0; i < level2.length; i++) {
        const n = level2[i];
        const span = Math.max(0, (sizes[i] - 1) * DY);
        n.x = startX + i * DX;
        n.y = cursor + span / 2;
        cursor += span + DY;
        layoutDescendants(n, DX, DY);
      }
    }
  }
}
function layoutDescendants(parent, DX, DY) {
  const kids = getVisibleChildren(parent);
  if (!kids.length) return;

  const sizes = kids.map((c) => measureVisibleLeaves(c.id));
  const totalLeaves = sizes.reduce((a, b) => a + b, 0);
  const totalHeight = Math.max(0, (totalLeaves - 1) * DY);

  let cursor = parent.y - totalHeight / 2;
  const x = parent.x + DX;

  for (let i = 0; i < kids.length; i++) {
    const c = kids[i];
    const span = Math.max(0, (sizes[i] - 1) * DY);
    c.x = x;
    c.y = cursor + span / 2;
    cursor += span + DY;
    layoutDescendants(c, DX, DY);
  }
}

// ===== Zoom / Pan =====
function applyTransform() {
  const { k, tx, ty } = state.zoom;
  if (viewport)
    viewport.setAttribute("transform", `translate(${tx},${ty}) scale(${k})`);
}
function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}
function zoomAt(screenX, screenY, factor) {
  const rect = svg.getBoundingClientRect();
  const { k, tx, ty } = state.zoom;
  const worldX = (screenX - rect.left - tx) / k;
  const worldY = (screenY - rect.top - ty) / k;
  const newK = clamp(k * factor, 0.4, 3);
  const newTx = screenX - rect.left - worldX * newK;
  const newTy = screenY - rect.top - worldY * newK;
  state.zoom = { k: newK, tx: newTx, ty: newTy };
  applyTransform();
}
function zoomBy(f) {
  const r = svg.getBoundingClientRect();
  zoomAt(r.left + r.width / 2, r.top + r.height / 2, f);
}
function resetZoom() {
  state.zoom = { k: 1, tx: 0, ty: 0 };
  applyTransform();
}

// --- Mouse drag-pan (background only) ---
let isPanning = false,
  panStart = { x: 0, y: 0 },
  panStartTx = 0,
  panStartTy = 0;
svg.addEventListener("mousedown", (e) => {
  if (!allowPan) return;
  if (e.button !== 0) return;
  if (e.target !== svg) return; // only when background is clicked
  isPanning = true;
  panStart.x = e.clientX;
  panStart.y = e.clientY;
  panStartTx = state.zoom.tx;
  panStartTy = state.zoom.ty;
  mapWrap.classList.add("panning");
});
window.addEventListener("mousemove", (e) => {
  if (!isPanning) return;
  const dx = e.clientX - panStart.x,
    dy = e.clientY - panStart.y;
  state.zoom.tx = panStartTx + dx;
  state.zoom.ty = panStartTy + dy;
  applyTransform();
});
window.addEventListener("mouseup", () => {
  if (!isPanning) return;
  isPanning = false;
  mapWrap.classList.remove("panning");
});

// --- Touch/Pointer: pan (1 finger) + pinch (2 fingers) ---
const activePointers = new Map(); // id -> {x,y}
let pinchActive = false;
let lastPinchDist = 0;

svg.addEventListener("pointerdown", (e) => {
  // For touch, allow starting on any SVG child; for mouse we keep background-only rule
  if (e.pointerType === "mouse" && e.target !== svg) return;
  svg.setPointerCapture(e.pointerId);
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (e.pointerType === "touch") {
    if (activePointers.size === 1) {
      // start pan
      const p = activePointers.get(e.pointerId);
      isPanning = true;
      panStart.x = p.x;
      panStart.y = p.y;
      panStartTx = state.zoom.tx;
      panStartTy = state.zoom.ty;
      mapWrap.classList.add("panning");
    } else if (activePointers.size === 2) {
      // start pinch
      const pts = [...activePointers.values()];
      lastPinchDist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) || 1;
      pinchActive = true;
      isPanning = false; // pinch overrides pan
    }
  }
});

svg.addEventListener("pointermove", (e) => {
  if (!activePointers.has(e.pointerId)) return;
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (pinchActive && activePointers.size === 2) {
    const pts = [...activePointers.values()];
    const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) || 1;
    const factor = clamp(dist / lastPinchDist, 0.7, 1.4); // smooth
    lastPinchDist = dist;

    // midpoint as zoom anchor
    const midX = (pts[0].x + pts[1].x) / 2;
    const midY = (pts[0].y + pts[1].y) / 2;
    zoomAt(midX, midY, factor);
    return;
  }

  if (isPanning) {
    const p = activePointers.get(e.pointerId);
    const dx = p.x - panStart.x,
      dy = p.y - panStart.y;
    state.zoom.tx = panStartTx + dx;
    state.zoom.ty = panStartTy + dy;
    applyTransform();
  }
});

function endPointer(e) {
  if (activePointers.has(e.pointerId)) activePointers.delete(e.pointerId);
  if (activePointers.size < 2) pinchActive = false;
  if (activePointers.size === 0) {
    isPanning = false;
    mapWrap.classList.remove("panning");
  }
}
svg.addEventListener("pointerup", endPointer);
svg.addEventListener("pointercancel", endPointer);
svg.addEventListener("pointerleave", (e) => {
  // don't end if pointer still down; pointerup/cancel handles that
});

// wheel zoom
svg.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.15 : 1 / 1.15);
  },
  { passive: false }
);

// ===== Global expand/collapse =====
function expandAll() {
  for (const n of Object.values(state.nodes)) n.collapsed = false;
}
function collapseAll() {
  for (const n of Object.values(state.nodes))
    if (n.children.length) n.collapsed = true;
  const root = state.nodes[state.rootId];
  if (root) root.collapsed = false;
  if (state.hubId && state.nodes[state.hubId])
    state.nodes[state.hubId].collapsed = false;
}
function isAllCollapsed() {
  return Object.values(state.nodes).every((n) => {
    const special =
      n.id === state.rootId || (state.hubId && n.id === state.hubId);
    if (special) return true;
    return n.children.length === 0 || n.collapsed === true;
  });
}
function updateGlobalToggleLabel() {
  globalToggleBtn.textContent = isAllCollapsed()
    ? "Expand All"
    : "Collapse All";
  globalToggleBtn.title = globalToggleBtn.textContent;
}

// ===== Colors for child line hover =====
function colorForNode(n) {
  if (!n) return "var(--lvl2)";
  if (n.fill) return n.fill;
  if (n.type === "root") return "var(--node-root)";
  const d = Math.max(1, Math.min(8, n.depth || 1));
  return `var(--lvl${d})`;
}

// ===== Geometry helper =====
function offsetPoint(x1, y1, x2, y2, dist) {
  const dx = x2 - x1,
    dy = y2 - y1,
    len = Math.hypot(dx, dy) || 1;
  return { x: x1 + (dx / len) * dist, y: y1 + (dy / len) * dist };
}

// ===== Node shape rendering =====
function radiusFor(n) {
  if (n.shape === "circle") {
    if (typeof n.w === "number" && typeof n.h === "number") {
      return Math.max(7.5, Math.min(n.w, n.h) / 2);
    }
  }
  return n.type === "root" ? 10 : n.type === "hub" ? 9 : 7.5;
}
function drawNodeShape(g, n) {
  const fill = n.fill || null;
  const stroke = n.stroke || "#0b122d";
  const sw = 2;

  let el = null;
  if (n.shape === "rect") {
    const w = typeof n.w === "number" ? n.w : 24;
    const h = typeof n.h === "number" ? n.h : 18;
    el = s_el("rect", {
      x: n.x - w / 2,
      y: n.y - h / 2,
      width: w,
      height: h,
      rx: 6,
      ry: 6,
      class: "node-shape",
      fill: fill || "var(--lvl2)",
      stroke,
      "stroke-width": sw,
    });
  } else if (n.shape === "triangle") {
    const w = typeof n.w === "number" ? n.w : 22;
    const h = typeof n.h === "number" ? n.h : 22;
    const points = `${n.x},${n.y - h / 2} ${n.x - w / 2},${n.y + h / 2} ${
      n.x + w / 2
    },${n.y + h / 2}`;
    el = s_el("polygon", {
      points,
      class: "node-shape",
      fill: fill || "var(--lvl3)",
      stroke,
      "stroke-width": sw,
    });
  } else {
    // circle
    el = s_el("circle", {
      cx: n.x,
      cy: n.y,
      r: radiusFor(n),
      class: "node-shape",
      fill: fill || (n.type === "root" ? "var(--node-root)" : "var(--node)"),
      stroke,
      "stroke-width": sw,
    });
  }
  g.appendChild(el);
}

// ===== Render + sizing =====
function ensureLayers() {
  if (!viewport) {
    viewport = s_el("g", { id: "viewport" });
    svg.appendChild(viewport);
  }
  if (!gBack) {
    gBack = s_el("g", { id: "gBacklinks" });
    viewport.appendChild(gBack);
  }
  if (!gTree) {
    gTree = s_el("g", { id: "gTree" });
    viewport.appendChild(gTree);
  }
  if (!gNodes) {
    gNodes = s_el("g", { id: "gNodes" });
    viewport.appendChild(gNodes);
  }
  // arrowhead for backlinks (uses context-stroke to match color)
  if (!svg.querySelector("#arrow-end")) {
    const defs = s_el("defs", {});
    const markerEnd = s_el("marker", {
      id: "arrow-end",
      viewBox: "0 0 10 10",
      refX: "9",
      refY: "5",
      markerWidth: "6",
      markerHeight: "6",
      orient: "auto-start-reverse",
    });
    const arrowPath = s_el("path", { d: "M 0 0 L 10 5 L 0 10 z" });
    arrowPath.setAttribute("fill", "context-stroke");
    markerEnd.appendChild(arrowPath);
    defs.appendChild(markerEnd);
    svg.appendChild(defs);
  }
}
function clearLayers() {
  clearGroup(gBack);
  clearGroup(gTree);
  clearGroup(gNodes);
}

function computeVisibleBounds(pad = 40) {
  const vis = getVisibleNodes();
  if (!vis.length) return { minX: 0, minY: 0, maxX: 600, maxY: 400 };
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const n of vis) {
    minX = Math.min(minX, n.x);
    maxX = Math.max(maxX, n.x);
    minY = Math.min(minY, n.y);
    maxY = Math.max(maxY, n.y);
  }
  return {
    minX: minX - pad,
    minY: minY - pad,
    maxX: maxX + pad,
    maxY: maxY + pad,
  };
}
function adjustSvgCanvasSizeForMobile() {
  const isMobile = window.matchMedia("(max-width: 768px)").matches;
  if (!isMobile) {
    svg.style.width = "100%";
    svg.style.height = "100%";
    return;
  }
  const b = computeVisibleBounds(120);
  const w = Math.max(Math.ceil(b.maxX - b.minX), 600);
  const h = Math.max(Math.ceil(b.maxY - b.minY), 420);
  svg.style.width = `${w}px`;
  svg.style.height = `${h}px`;
}

// Tooltip helpers
function showTooltip(x, y, text) {
  if (!text || !text.trim()) {
    hideTooltip();
    return;
  }
  tooltipEl.textContent = text.trim();
  tooltipEl.style.display = "block";
  tooltipEl.style.left = `${x + 12}px`;
  tooltipEl.style.top = `${y + 12}px`;
  tooltipEl.setAttribute("aria-hidden", "false");
}
function hideTooltip() {
  tooltipEl.style.display = "none";
  tooltipEl.textContent = "";
  tooltipEl.setAttribute("aria-hidden", "true");
}

// ===== Backlinks =====
function renderBacklinks(visibleIds) {
  clearGroup(gBack);
  for (const b of state.backlinks) {
    const src = state.nodes[b.from],
      tgt = state.nodes[b.to];
    if (!src || !tgt) continue;
    if (!visibleIds.has(src.id) || !visibleIds.has(tgt.id)) continue;

    const rS = radiusFor(src);
    const rT = radiusFor(tgt);
    const headLen = 6;

    const pad = typeof b.pad === "number" ? b.pad : 10;
    const start = offsetPoint(src.x, src.y, tgt.x, tgt.y, rS + pad);
    const end = offsetPoint(tgt.x, tgt.y, src.x, src.y, rT + pad + headLen);

    const bend = typeof b.bend === "number" ? b.bend : 40;
    const mx = (start.x + end.x) / 2,
      my = (start.y + end.y) / 2;
    const dx = end.x - start.x,
      dy = end.y - start.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len,
      ny = dx / len;
    const c1x = mx + nx * bend,
      c1y = my + ny * bend;

    // Visible path
    const path = s_el("path", {
      d: `M ${start.x} ${start.y} Q ${c1x} ${c1y} ${end.x} ${end.y}`,
      class: "link--back",
      "marker-end": "url(#arrow-end)",
    });
    const color = b.color || "#7cb8ff";
    path.style.stroke = color;
    if (b.style === "solid") path.style.strokeDasharray = "none";
    else if (b.style === "dotted") path.style.strokeDasharray = "1 6";
    else path.style.strokeDasharray = "6 6"; // dashed
    gBack.appendChild(path);

    // Fat hit path
    const hit = s_el("path", {
      d: `M ${start.x} ${start.y} Q ${c1x} ${c1y} ${end.x} ${end.y}`,
      class: "link--back-hit",
    });
    gBack.appendChild(hit);

    const tipText = [b.title, b.note]
      .filter((s) => s && String(s).trim())
      .join(" — ");

    hit.addEventListener("mouseenter", () => {
      path.classList.add("hovered");
      setBacklinkPanel(b.title || "", b.note || "");
    });
    hit.addEventListener("mousemove", (evt) =>
      showTooltip(evt.pageX, evt.pageY, tipText)
    );
    hit.addEventListener("mouseleave", () => {
      path.classList.remove("hovered");
      hideTooltip();
      setBacklinkPanel("", "");
    });

    // Optional label bubble
    if (b.title && String(b.title).trim()) {
      const labelG = s_el("g", { class: "backlabel" });
      const text = s_el("text", { x: c1x, y: c1y });
      text.setAttribute("text-anchor", "middle");
      text.setAttribute("dominant-baseline", "central");
      text.textContent = String(b.title).trim();
      const w = Math.max(30, 7.5 * text.textContent.length + 12),
        h = 18;
      const rect = s_el("rect", {
        x: c1x - w / 2,
        y: c1y - h / 2,
        width: w,
        height: h,
      });
      labelG.appendChild(rect);
      labelG.appendChild(text);

      labelG.addEventListener("mouseenter", (e) => {
        path.classList.add("hovered");
        setBacklinkPanel(b.title || "", b.note || "");
        showTooltip(e.pageX, e.pageY, tipText);
      });
      labelG.addEventListener("mousemove", (e) =>
        showTooltip(e.pageX, e.pageY, tipText)
      );
      labelG.addEventListener("mouseleave", () => {
        path.classList.remove("hovered");
        hideTooltip();
        setBacklinkPanel("", "");
      });

      gBack.appendChild(labelG);
    }
  }
}

// ===== Render =====
function render() {
  computeLayout();
  ensureLayers();
  clearLayers();

  const visible = getVisibleNodes();
  const visIds = new Set(visible.map((n) => n.id));

  // backlinks (bottom)
  renderBacklinks(visIds);

  // parent→child tree links (middle)
  for (const n of visible) {
    if (!n.parentId) continue;
    if (!visIds.has(n.parentId)) continue;
    const p = state.nodes[n.parentId];

    // visible line
    const line = s_el("line", {
      x1: p.x,
      y1: p.y,
      x2: n.x,
      y2: n.y,
      class: "link-tree",
    });
    gTree.appendChild(line);

    // fat hit-line for hover
    const hit = s_el("line", {
      x1: p.x,
      y1: p.y,
      x2: n.x,
      y2: n.y,
      class: "link-tree-hit",
    });
    gTree.appendChild(hit);

    // Hover → glow + tooltip with child name; color matches child
    hit.addEventListener("mouseenter", (e) => {
      line.classList.add("hovered");
      line.style.stroke = colorForNode(n); // temporarily match child color
      showTooltip(e.pageX, e.pageY, n.label || "");
    });
    hit.addEventListener("mousemove", (e) => {
      showTooltip(e.pageX, e.pageY, n.label || "");
    });
    hit.addEventListener("mouseleave", () => {
      line.classList.remove("hovered");
      line.style.stroke = ""; // revert to CSS var(--line)
      hideTooltip();
    });
  }

  // nodes (top) with preserved shapes
  for (const n of visible) {
    const depthClass = `node--depth-${Math.min(n.depth, 8)}`;
    const g = s_el("g", {
      class: `node ${depthClass} node--${n.type}${
        n.collapsed ? " node--collapsed" : ""
      }`,
    });
    g.dataset.id = n.id;

    drawNodeShape(g, n);

    const hasKids = n.children.length > 0;
    const marker = hasKids ? (n.collapsed ? "▸ " : "▾ ") : "";
    const text = s_el("text", {
      x: n.x + 14,
      y: n.y - 12,
      "text-anchor": "start",
    });
    text.textContent = `${marker}${n.label}`;
    g.appendChild(text);

    g.addEventListener("click", (e) => {
      e.stopPropagation();
      state.selectedId = n.id;
      if (n.children.length) n.collapsed = !n.collapsed;
      render();
      updateDetails();
      updateGlobalToggleLabel();
    });

    gNodes.appendChild(g);
  }

  applyTransform();
  adjustSvgCanvasSizeForMobile();
}

// ===== Details =====
function updateDetails() {
  const n = state.nodes[state.selectedId];
  if (!n) {
    editorTitle.textContent = "Node Details";
    nodeNameEl.textContent =
      nodeTypeEl.textContent =
      nodeChildrenEl.textContent =
      nodeStateEl.textContent =
      nodeContentEl.textContent =
        "–";
    setBacklinkPanel("", "");
    return;
  }
  editorTitle.textContent =
    n.type === "root"
      ? "Structure Details"
      : n.type === "hub"
      ? "Hub Node"
      : "Child Node";

  nodeNameEl.textContent = n.label || "—";
  nodeTypeEl.textContent = `${n.type}${
    typeof n.depth === "number" ? ` (depth ${n.depth})` : ""
  }`;
  nodeChildrenEl.textContent = n.children.length;
  nodeStateEl.textContent = n.children.length
    ? n.collapsed
      ? "collapsed"
      : "expanded"
    : "leaf";
  nodeContentEl.textContent = n.content || "—";
}
function setBacklinkPanel(title, note) {
  backNameEl.textContent = title && title.trim() ? title.trim() : "—";
  backContentEl.textContent = note && note.trim() ? note.trim() : "—";
  backNameEl.classList.toggle("dim", !(title && title.trim()));
  backContentEl.classList.toggle("dim", !(note && note.trim()));
}

// ===== Fit =====
function fitView() {
  render();
}

// ===== JSON loader (nodes + backlinks) =====
async function fetchJsonResolved(pathLike) {
  const url = new URL(pathLike || "data/latest.json", location.href);
  url.searchParams.set("__t", Date.now().toString()); // cache-buster
  const res = await fetch(url.toString(), { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status} at ${res.url}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid JSON at ${url.toString()}: ${e.message}`);
  }
}
function normalizeBacklink(b, nodesMap) {
  if (!b) return null;
  const from = b.from ?? b.source;
  const to = b.to ?? b.target;
  if (!from || !to || from === to) return null;
  if (!nodesMap[from] || !nodesMap[to]) return null;
  return {
    id: b.id || `bl-${Math.random().toString(36).slice(2, 9)}`,
    from,
    to,
    style: b.style || "dashed",
    color: b.color || "#7cb8ff",
    bend: typeof b.bend === "number" ? b.bend : 40,
    pad: typeof b.pad === "number" ? b.pad : 10,
    title: typeof b.title === "string" ? b.title : "",
    note: typeof b.note === "string" ? b.note : "",
  };
}

async function loadData() {
  try {
    const qp = new URLSearchParams(location.search);
    const wanted = qp.get("data") || "data/latest.json";

    const candidates = [wanted];
    if (!/^(?:https?:)?\/\//i.test(wanted) && !wanted.startsWith("./")) {
      candidates.push("./" + wanted);
    }

    let data = null,
      lastErr = null;
    for (const c of candidates) {
      try {
        data = await fetchJsonResolved(c);
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!data) throw lastErr || new Error("Unable to load JSON");

    // nodes: keep shape/size/colors
    const rawMap = Array.isArray(data.nodes)
      ? Object.fromEntries(
          data.nodes.filter((n) => n && n.id).map((n) => [n.id, n])
        )
      : data.nodes || {};

    const clean = {};
    for (const [id, raw] of Object.entries(rawMap)) {
      if (!raw || !raw.id) continue;
      clean[id] = {
        id: raw.id,
        label: raw.label ?? "node",
        content: raw.content ?? "",
        type: raw.type ?? "child",
        parentId: raw.parentId ?? null,
        children: Array.isArray(raw.children) ? raw.children.slice() : [],
        collapsed: !!raw.collapsed,
        depth: 0,
        x: 0,
        y: 0,
        // shape passthroughs
        shape: raw.shape || "circle",
        w: typeof raw.w === "number" ? raw.w : undefined,
        h: typeof raw.h === "number" ? raw.h : undefined,
        fill: raw.fill || undefined,
        stroke: raw.stroke || "#0b122d",
      };
    }

    if (!data.rootId || !clean[data.rootId]) {
      throw new Error("JSON missing a valid rootId present in nodes.");
    }

    // repair parent links
    for (const n of Object.values(clean)) {
      n.children = n.children.filter((cid) => clean[cid]);
      n.children.forEach((cid) => (clean[cid].parentId = n.id));
    }

    // backlinks
    const backCandidates =
      data.backlinks || data.backLinks || data.relations || data.edges || [];
    state.backlinks = Array.isArray(backCandidates)
      ? backCandidates.map((b) => normalizeBacklink(b, clean)).filter(Boolean)
      : [];

    state.nodes = clean;
    state.rootId = data.rootId;
    state.hubId = data.hubId && clean[data.hubId] ? data.hubId : null;
    state.selectedId =
      data.selectedId && clean[data.selectedId]
        ? data.selectedId
        : state.rootId;

    state.zoom = { k: 1, tx: 0, ty: 0 };
    render();
    updateDetails();
    updateGlobalToggleLabel();
  } catch (err) {
    console.error("[viewer] load error:", err);
    alert(
      `Could not load data.\nReason: ${err.message}\n\n` +
        `Checklist:\n• Serve over http(s), not file://\n` +
        `• Folder structure:\n   index.html, app.js, styles.css, data/latest.json\n` +
        `• DevTools → Network: confirm the JSON request succeeds\n` +
        `• JSON must include rootId and matching nodes\n` +
        `• For backlinks, include "backlinks" (or backLinks/relations/edges) with {from,to,color,bend,pad,title,note}`
    );
  }
}

// ===== Wire controls =====
zoomInBtn.addEventListener("click", () => zoomBy(1.2));
zoomOutBtn.addEventListener("click", () => zoomBy(1 / 1.2));
zoomResetBtn.addEventListener("click", resetZoom);
fitBtn.addEventListener("click", fitView);
reloadBtn.addEventListener("click", loadData);
globalToggleBtn.addEventListener("click", () => {
  if (isAllCollapsed()) expandAll();
  else collapseAll();
  render();
  updateDetails();
  updateGlobalToggleLabel();
});

// ===== Init =====
loadData();

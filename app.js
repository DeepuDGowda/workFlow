/* Read-only viewer:
   - Per-node click toggles that node's branch (collapse/expand)
   - Global Expand/Collapse button next to − / +
   - Loads data/latest.json (or ?data=URL)
   - Zoom/pan/fit preserved
*/

// ======= State =======
const state = {
  nodes: {}, // id -> node
  rootId: null,
  hubId: null,
  selectedId: null,
  zoom: { k: 1, tx: 0, ty: 0 },
};

let viewport = null;

// ======= DOM =======
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

// ======= SVG helper =======
function s_el(name, attrs = {}) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

// ======= Data helpers =======
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

// ======= Layout (non-overlapping deep trees) =======
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

// ======= Zoom / Pan =======
function applyTransform() {
  const { k, tx, ty } = state.zoom;
  viewport.setAttribute("transform", `translate(${tx},${ty}) scale(${k})`);
}
function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}
function zoomAt(screenX, screenY, factor) {
  const rect = svg.getBoundingClientRect();
  const { k, tx, ty } = state.zoom;
  const worldX = (screenX - rect.left - tx) / k,
    worldY = (screenY - rect.top - ty) / k;
  const newK = clamp(k * factor, 0.4, 3);
  const newTx = screenX - rect.left - worldX * newK,
    newTy = screenY - rect.top - worldY * newK;
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

// Drag panning (left button on empty background)
let isPanning = false,
  panStart = { x: 0, y: 0 },
  panStartTx = 0,
  panStartTy = 0;
svg.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  if (e.target !== svg) return; // only background
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

// Wheel zoom at cursor
svg.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.15 : 1 / 1.15);
  },
  { passive: false }
);

// ======= Global Expand / Collapse =======
function expandAll() {
  for (const n of Object.values(state.nodes)) n.collapsed = false;
}
function collapseAll() {
  for (const n of Object.values(state.nodes)) {
    if (n.children.length) n.collapsed = true;
  }
  // keep root & hub open for orientation
  const root = state.nodes[state.rootId];
  if (root) root.collapsed = false;
  if (state.hubId && state.nodes[state.hubId])
    state.nodes[state.hubId].collapsed = false;
}
function isAllCollapsed() {
  return Object.values(state.nodes).every((n) => {
    const isSpecial =
      n.id === state.rootId || (state.hubId && n.id === state.hubId);
    if (isSpecial) return true;
    return n.children.length === 0 || n.collapsed === true;
  });
}
function updateGlobalToggleLabel() {
  globalToggleBtn.textContent = isAllCollapsed()
    ? "Expand All"
    : "Collapse All";
  globalToggleBtn.title = globalToggleBtn.textContent;
}

// ======= Render =======
function clearViewport() {
  while (viewport.firstChild) viewport.removeChild(viewport.firstChild);
}
function render() {
  computeLayout();
  clearViewport();

  const visible = getVisibleNodes();
  const visIds = new Set(visible.map((n) => n.id));

  // Links
  for (const n of visible) {
    if (!n.parentId) continue;
    if (!visIds.has(n.parentId)) continue;
    const p = state.nodes[n.parentId];
    viewport.appendChild(
      s_el("line", { x1: p.x, y1: p.y, x2: n.x, y2: n.y, class: "link" })
    );
  }

  // Nodes
  for (const n of visible) {
    const depthClass = `node--depth-${Math.min(n.depth, 8)}`;
    const g = s_el("g", {
      class: `node ${depthClass} node--${n.type}${
        n.collapsed ? " node--collapsed" : ""
      }`,
    });
    g.dataset.id = n.id;

    const r = n.type === "root" ? 10 : n.type === "hub" ? 9 : 7.5;
    g.appendChild(s_el("circle", { cx: n.x, cy: n.y, r }));

    const hasKids = n.children.length > 0;
    const marker = hasKids ? (n.collapsed ? "▸ " : "▾ ") : "";
    const text = s_el("text", {
      x: n.x + 14,
      y: n.y - 12,
      "text-anchor": "start",
    });
    text.textContent = `${marker}${n.label}`;
    g.appendChild(text);

    // Click: select + per-node collapse/expand if it has children
    g.addEventListener("click", (e) => {
      e.stopPropagation();
      state.selectedId = n.id;
      if (n.children.length) {
        n.collapsed = !n.collapsed;
      }
      render();
      updateDetails();
      updateGlobalToggleLabel();
    });

    viewport.appendChild(g);
  }

  applyTransform();
}

// ======= Details panel =======
function updateDetails() {
  const n = state.nodes[state.selectedId];
  if (!n) {
    editorTitle.textContent = "Node Details";
    nodeNameEl.textContent = "–";
    nodeTypeEl.textContent = "–";
    nodeChildrenEl.textContent = "–";
    nodeStateEl.textContent = "–";
    nodeContentEl.textContent = "–";
    return;
  }

  editorTitle.textContent =
    n.type === "root"
      ? "Structure Details"
      : n.type === "hub"
      ? "Hub Node"
      : "Child Node";
  nodeNameEl.textContent = n.label || "—";
  nodeTypeEl.textContent = `${n.type} (depth ${n.depth ?? 0})`;
  nodeChildrenEl.textContent = n.children.length;
  nodeStateEl.textContent = n.children.length
    ? n.collapsed
      ? "collapsed"
      : "expanded"
    : "leaf";
  nodeContentEl.textContent = n.content || "—";
}

// ======= Fit (recompute layout) =======
function fitView() {
  render();
}

// ======= Load data =======
async function loadData() {
  const qp = new URLSearchParams(location.search);
  const url = qp.get("data") || "data/latest.json";
  const bust = `__t=${Date.now()}`;
  const maybeSep = url.includes("?") ? "&" : "?";

  try {
    const res = await fetch(`${url}${maybeSep}${bust}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // normalize nodes map
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
      };
    }

    if (!data.rootId || !clean[data.rootId])
      throw new Error("Invalid or missing rootId");
    state.nodes = clean;
    state.rootId = data.rootId;
    state.hubId = data.hubId && clean[data.hubId] ? data.hubId : null;
    state.selectedId =
      data.selectedId && clean[data.selectedId]
        ? data.selectedId
        : state.rootId;

    // build SVG group if needed
    if (!viewport) {
      viewport = s_el("g", { id: "viewport" });
      svg.appendChild(viewport);
    }

    // reset zoom on load
    state.zoom = { k: 1, tx: 0, ty: 0 };

    render();
    updateDetails();
    updateGlobalToggleLabel();
  } catch (err) {
    console.error("[viewer] load error:", err);
    alert(
      "Could not load data/latest.json. Make sure the file exists and is valid JSON."
    );
  }
}

// ======= Wire controls =======
zoomInBtn.addEventListener("click", () => zoomBy(1.2));
zoomOutBtn.addEventListener("click", () => zoomBy(1 / 1.2));
zoomResetBtn.addEventListener("click", resetZoom);
fitBtn.addEventListener("click", fitView);
reloadBtn.addEventListener("click", loadData);

// Global expand/collapse toggle near − / +
globalToggleBtn.addEventListener("click", () => {
  if (isAllCollapsed()) {
    expandAll();
  } else {
    collapseAll();
  }
  render();
  updateDetails();
  updateGlobalToggleLabel();
});

// Wheel zoom at cursor
svg.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.15 : 1 / 1.15);
  },
  { passive: false }
);

// init
loadData();

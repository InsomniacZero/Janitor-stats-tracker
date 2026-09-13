import {
  TRACKED_SERIES,
  RANGE_CONFIG,
  formatNumber,
  formatCompact,
  escapeHtml,
  formatDuration,
  filterSnapshotsByRange,
  getWindowStats,
  ratio,
  sanitizeTransientZeroes,
  downsample,
  buildHourlyMarkers,
  makeTooltipMarkup,
  bindChartTooltips
} from "./common.js";

import {
  getAllCharacters,
  getSnapshots
} from "./db.js";

let state = { characters: [], activeCharacterId: null, snapshots: [], range: "24h" };

function currentCharacter() {
  return state.characters.find(c => c.characterId === state.activeCharacterId) || state.characters[0] || null;
}

function filterPoints(snapshots, range) {
  return filterSnapshotsByRange(snapshots, range);
}

function makePopupChart(title, color, sourcePoints) {
  const width = 760, height = 210, pad = { left: 52, right: 12, top: 12, bottom: 30 };
  const points = sourcePoints.map((p, index) => ({ ...p, originalIndex: index }));
  const sanitized = sanitizeTransientZeroes(points);
  const sampled = downsample(sanitized, 140);
  const valid = sampled.filter(p => Number.isFinite(p.value));
  if (!valid.length) return `<div class="empty">No usable data in this window.</div>`;

  const min = Math.min(...valid.map(p => p.value));
  const max = Math.max(...valid.map(p => p.value));
  const range = max === min ? Math.max(1, Math.abs(max) * .04) : max - min;
  const yMin = max === min ? Math.max(0, min - range) : min;
  const yMax = max === min ? max + range : max;
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const x = i => sampled.length <= 1 ? pad.left + innerW / 2 : pad.left + i / (sampled.length - 1) * innerW;
  const y = value => pad.top + (1 - (value - yMin) / (yMax - yMin || 1)) * innerH;
  const grid = [0,.25,.5,.75,1].map(t => {
    const yy = pad.top + t * innerH;
    const value = yMax - t * (yMax - yMin);
    return `<line class="gridline" x1="${pad.left}" y1="${yy}" x2="${width-pad.right}" y2="${yy}"/><text class="axis-label" x="${pad.left-8}" y="${yy+3}" text-anchor="end">${escapeHtml(formatCompact(value))}</text>`;
  }).join("");

  let path = "", started = false;
  sampled.forEach((point, index) => {
    if (!Number.isFinite(point.value)) { started = false; return; }
    path += `${started ? "L" : "M"}${x(index).toFixed(2)} ${y(point.value).toFixed(2)} `;
    started = true;
  });

  const pointsData = valid.map(point => {
    const index = sampled.indexOf(point);
    const cx = x(index);
    const cy = y(point.value);
    const tooltipHtml = makeTooltipMarkup({ label: title, point, color });
    return { cx, cy, tooltipHtml };
  });

  const { hourDots, edgeMarks, hourLines } = buildHourlyMarkers({
    sampled,
    valid,
    pad,
    width,
    height,
    x,
    y,
    color
  });

  return `<svg class="chart-svg" viewBox="0 0 ${width} ${height}" data-points="${escapeHtml(JSON.stringify(pointsData))}" role="img" aria-label="${escapeHtml(title)} graph">${grid}${hourLines}<path class="chart-line" d="${path.trim()}" stroke="${color}"/>${hourDots}${edgeMarks}<line class="chart-crosshair" x1="0" y1="${pad.top}" x2="0" y2="${height - pad.bottom}" style="display: none;" /><circle class="chart-active-dot" cx="0" cy="0" r="4" fill="${color}" stroke="#181715" stroke-width="2" style="display: none;" /></svg><div class="chart-tooltip" role="status"></div>`;
}

function makePopupCombined(snapshots) {
  if (!snapshots.length) return `<div class="empty">No data yet.</div>`;
  const width = 760, height = 230, pad = { left: 52, right: 12, top: 12, bottom: 28 };
  const sampled = downsample(snapshots.map((p, index) => ({ ...p, originalIndex: index })), 140);
  const series = TRACKED_SERIES.map(seriesInfo => {
    const values = snapshots.map((p, index) => ({ timestamp: p.timestamp, value: Number.isFinite(p[seriesInfo.key]) ? p[seriesInfo.key] : NaN, originalIndex: index }));
    const sanitized = sanitizeTransientZeroes(values);
    const baseline = sanitized.find(p => Number.isFinite(p.value) && p.value > 0)?.value;
    return { ...seriesInfo, points: sampled.map(p => {
      const actual = sanitized[p.originalIndex]?.value;
      const prev = p.originalIndex > 0 ? sanitized[p.originalIndex - 1]?.value : null;
      const delta = prev == null || !Number.isFinite(actual) ? null : actual - prev;
      const percent = prev == null || prev === 0 || !Number.isFinite(actual) ? null : delta / prev * 100;
      return { timestamp: p.timestamp, actual, value: baseline && Number.isFinite(actual) ? actual / baseline * 100 : NaN, delta, percent, elapsedMs: p.originalIndex > 0 ? new Date(p.timestamp).getTime() - new Date(snapshots[p.originalIndex-1].timestamp).getTime() : null, originalIndex: p.originalIndex };
    }) };
  });
  const all = series.flatMap(s => s.points.map(p => p.value)).filter(Number.isFinite);
  if (!all.length) return `<div class="empty">No data yet.</div>`;
  const min = Math.min(...all), max = Math.max(...all), spread = Math.max(1, max-min);
  const yMin = Math.max(0, min - spread*.12), yMax = max + spread*.12;
  const innerW = width-pad.left-pad.right, innerH = height-pad.top-pad.bottom;
  const x = i => sampled.length <= 1 ? pad.left+innerW/2 : pad.left+i/(sampled.length-1)*innerW;
  const y = v => pad.top+(1-(v-yMin)/(yMax-yMin||1))*innerH;
  let svg=[0,.25,.5,.75,1].map(t=>{const yy=pad.top+t*innerH; const value=yMax-t*(yMax-yMin); return `<line class="gridline" x1="${pad.left}" y1="${yy}" x2="${width-pad.right}" y2="${yy}"/><text class="axis-label" x="${pad.left-8}" y="${yy+3}" text-anchor="end">${Math.round(value)}</text>`;}).join("");
  for(const s of series){
    let path="",started=false;
    s.points.forEach((p,i)=>{ if(!Number.isFinite(p.value)){started=false;return;} path += `${started?'L':'M'}${x(i).toFixed(2)} ${y(p.value).toFixed(2)} `; started=true; });
    svg += `<path class="chart-line" stroke="${s.color}" d="${path.trim()}"/>`;
  }
  const pointsData = sampled.map((sPoint, sIdx) => {
    const cx = x(sIdx);
    const dateStr = new Date(sPoint.timestamp).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const rows = series.map(s => {
      const p = s.points[sIdx];
      if (!p || p.actual == null || !Number.isFinite(p.actual)) return "";
      return `<div class="chart-tt-row"><span style="display:inline-flex;align-items:center;gap:4px;"><span class="chart-tt-indicator" style="background:${s.color};"></span><span>${escapeHtml(s.short)}</span></span><span style="font-weight:700;color:#faf8f5;">${escapeHtml(formatNumber(p.actual))}</span></div>`;
    }).join("");
    const tooltipHtml = `<div class="chart-tt-header"><span class="chart-tt-label">${escapeHtml(dateStr)}</span></div>${rows}`;
    const primary = series[0]?.points[sIdx];
    const cy = primary && Number.isFinite(primary.value) ? y(primary.value) : pad.top + innerH / 2;
    return { cx, cy, tooltipHtml };
  });

  const primaryValid = series[0]?.points.filter(p => Number.isFinite(p.value)) || [];
  const { edgeMarks, hourLines } = buildHourlyMarkers({
    sampled,
    valid: primaryValid.length ? primaryValid : sampled.filter(p => p.timestamp),
    pad,
    width,
    height,
    x,
    y: null,
    color: "#d97757"
  });

  return `<svg class="chart-svg" viewBox="0 0 ${width} ${height}" data-points="${escapeHtml(JSON.stringify(pointsData))}" role="img" aria-label="Combined trend graph">${svg}${hourLines}${edgeMarks}<line class="chart-crosshair" x1="0" y1="${pad.top}" x2="0" y2="${height - pad.bottom}" style="display: none;" /><circle class="chart-active-dot" cx="0" cy="0" r="4" fill="#d97757" stroke="#181715" stroke-width="2" style="display: none;" /></svg><div class="chart-tooltip" role="status"></div><div class="legend">${TRACKED_SERIES.map(s=>`<span class="legend-item"><span class="legend-dot" style="background:${s.color}"></span>${escapeHtml(s.short)}</span>`).join("")}</div>`;
}

function renderRangeControls() {
  const target = document.getElementById("rangeControls");
  target.innerHTML = Object.entries(RANGE_CONFIG).map(([id, config]) => `<button class="range-btn ${state.range === id ? "active" : ""}" data-range="${id}">${config.label}</button>`).join("");
  target.querySelectorAll(".range-btn").forEach(button => button.addEventListener("click", () => { state.range = button.dataset.range; render(); }));
}

function render() {
  renderRangeControls();
  const character = currentCharacter();
  if (!character) {
    document.getElementById("title").textContent = "No character tracked";
    document.getElementById("subtitle").textContent = "Open a JanitorAI character page to begin.";
    document.getElementById("cards").innerHTML = "";
    document.getElementById("insights").innerHTML = "";
    document.getElementById("charts").innerHTML = `<article class="panel full"><div class="empty">No history yet.</div></article>`;
    return;
  }

  const snapshots = filterPoints(state.snapshots, state.range);
  const latest = snapshots.at(-1) || state.snapshots.at(-1);
  document.getElementById("title").textContent = character.characterName || "JanitorAI character";
  document.getElementById("subtitle").textContent = latest ? `Last collected ${new Date(latest.timestamp).toLocaleString()}` : "No samples yet.";
  document.getElementById("meta").innerHTML = [
    character.publishedAt && `Published · ${character.publishedAt}`,
    character.createdAt && `Created · ${character.createdAt}`,
    character.updatedAt && `Updated · ${character.updatedAt}`,
    `${state.snapshots.length.toLocaleString()} samples`
  ].filter(Boolean).map(x=>`<span class="pill">${escapeHtml(x)}</span>`).join("");

  document.getElementById("cards").innerHTML = TRACKED_SERIES.map(s => {
    const stats = getWindowStats(snapshots, s.key);
    const value = latest?.[s.key];
    const delta = stats?.delta;
    const isRatio = s.isRatio || s.key === "chatMsgRatio";
    const valueDisplay = isRatio && Number.isFinite(value)
      ? value.toFixed(2)
      : formatCompact(value);
    const changeText = stats && snapshots.length >= 2
      ? (isRatio
          ? `${delta >= 0 ? "+" : ""}${delta.toFixed(2)} over ${formatDuration(stats.durationMs)}`
          : `${delta >= 0 ? "+" : ""}${formatNumber(delta)} over ${formatDuration(stats.durationMs)}`)
      : "Need another sample";
    const pct = stats?.percent == null ? "" : ` · ${stats.percent >= 0 ? "+" : ""}${stats.percent.toFixed(2)}%`;
    return `<article class="stat-card"><div class="stat-label">${escapeHtml(s.label)}</div><div class="stat-value">${escapeHtml(valueDisplay)}</div><div class="stat-change ${delta == null ? "" : delta >= 0 ? "up" : "down"}">${escapeHtml(changeText + pct)}</div></article>`;
  }).join("");

  const latestMsg = latest?.msgs, latestChats = latest?.chats, latestComments = latest?.comments, latestFavs = latest?.favourites;
  const insights = [
    ["Msgs / chat", ratio(latestMsg, latestChats), "messages per chat"],
    ["Chats / 1k msgs", latestMsg > 0 ? latestChats/latestMsg*1000 : null, "chats per 1,000 messages"],
    ["Favs / 1k chats", latestChats > 0 ? latestFavs/latestChats*1000 : null, "favourites per 1,000 chats"],
    ["Comments / 1k chats", latestChats > 0 ? latestComments/latestChats*1000 : null, "comments per 1,000 chats"]
  ];
  document.getElementById("insights").innerHTML = `<section class="panel insights-panel full"><div class="panel-head"><div><h2>Ratios</h2><div class="panel-sub">Derived from the latest recorded values</div></div></div><div class="insight-grid">${insights.map(([label,value,sub])=>`<div class="insight-mini"><div class="insight-mini-label">${label}</div><div class="insight-mini-value">${value == null ? "—" : formatCompact(value)}</div><div class="insight-mini-sub">${sub}</div></div>`).join("")}</div></section>`;

  document.getElementById("charts").innerHTML = TRACKED_SERIES.map(s => `<article class="panel"><div class="panel-head"><div><h2>${escapeHtml(s.label)}</h2><div class="panel-sub">Actual value · hover for exact delta</div></div></div><div class="chart-wrap">${makePopupChart(s.label, s.color, snapshots.map(p=>({timestamp:p.timestamp,value:p[s.key],msgs:p.msgs,chats:p.chats})))}</div></article>`).join("") + `<article class="panel full"><div class="panel-head"><div><h2>Combined trend</h2><div class="panel-sub">Indexed to 100 at the start of the selected window</div></div></div><div class="chart-wrap">${makePopupCombined(snapshots)}</div></article>`;
  bindChartTooltips(document.getElementById("charts"));
}

async function load() {
  state.characters = (await getAllCharacters()).sort((a,b)=>(b.lastSeen||"").localeCompare(a.lastSeen||""));
  const settings = await chrome.storage.local.get({activeCharacterId:null});
  state.activeCharacterId = state.characters.some(c=>c.characterId===settings.activeCharacterId) ? settings.activeCharacterId : state.characters[0]?.characterId||null;
  const character = currentCharacter();
  state.snapshots = character ? await getSnapshots(character.characterId) : [];
  render();
}

document.getElementById("collectBtn").addEventListener("click", async () => {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id || !/janitorai\.com/i.test(tab.url || "")) {
    document.getElementById("notice").textContent = "Open a JanitorAI character page or Following tab in the active tab.";
    return;
  }
  try {
    const isFollowing = (tab.url || "").includes("following");
    const result = await chrome.tabs.sendMessage(tab.id, { type: "COLLECT_STATS" });
    if (result?.ok) {
      document.getElementById("notice").textContent = isFollowing
        ? "Collected live bot stats from Following feed."
        : "Collected the current page stats.";
    } else {
      document.getElementById("notice").textContent = "Page is still loading; try again in a moment.";
    }
    if (result?.snapshot?.characterId) {
      await chrome.storage.local.set({ activeCharacterId: result.snapshot.characterId });
    }
    await load();
  } catch {
    document.getElementById("notice").textContent = "Could not collect. Reload the JanitorAI tab once.";
  }
});

document.getElementById("dashboardBtn").addEventListener("click",()=>chrome.tabs.create({url:chrome.runtime.getURL("dashboard.html")}));

load().catch(error=>{
  console.error(error);
  document.getElementById("notice").textContent="Could not open local tracker data.";
});

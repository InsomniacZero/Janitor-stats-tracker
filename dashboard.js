import {
  STAT_CONFIG,
  TRACKED_SERIES,
  RANGE_CONFIG,
  formatNumber,
  formatCompact,
  relativeChange,
  escapeHtml,
  formatDuration,
  formatRate,
  filterSnapshotsByRange,
  getWindowStats,
  ratio,
  sanitizeTransientZeroes,
  downsample,
  enrichPoints,
  makeTooltipMarkup,
  bindChartTooltips
} from "./common.js";

import {
  openTrackerDb,
  getAllCharacters,
  getCharacter,
  getSnapshots,
  getLatestSnapshot,
  saveCharacterSnapshot,
  importLegacyCharacters,
  deleteCharacter,
  clearDatabase
} from "./db.js";

import {
  getSupabaseConfig,
  setSupabaseConfig,
  clearSupabaseConfig,
  testSupabaseConnection,
  fetchTrackedJobs,
  saveTrackedJob,
  deleteTrackedJob,
  insertSnapshot,
  fetchCharacterSnapshots,
  subscribeToRealtimeSnapshots,
  SCHEMA_SQL
} from "./supabase.js";

const isExtension = typeof chrome !== "undefined" && Boolean(chrome?.storage?.local);

const storage = {
  async get(defaults) {
    if (isExtension && chrome?.storage?.local) {
      try {
        return await chrome.storage.local.get(defaults);
      } catch (err) {
        console.warn("chrome.storage error, falling back to localStorage", err);
      }
    }
    const result = { ...defaults };
    for (const key of Object.keys(defaults)) {
      const val = localStorage.getItem(`janitorai_${key}`);
      if (val !== null) {
        try {
          result[key] = JSON.parse(val);
        } catch {
          result[key] = val;
        }
      }
    }
    return result;
  },
  async set(items) {
    if (isExtension && chrome?.storage?.local) {
      try {
        return await chrome.storage.local.set(items);
      } catch (err) {
        console.warn("chrome.storage set error, falling back to localStorage", err);
      }
    }
    for (const [key, val] of Object.entries(items)) {
      localStorage.setItem(`janitorai_${key}`, JSON.stringify(val));
    }
  }
};

let state = {
  characters: [],
  activeCharacterId: null,
  snapshots: [],
  range: "24h"
};

let trackedJobs = [];
let realtimeUnsubscribe = null;
let countdownTimer = null;

function getCurrent() {
  return state.characters.find(c => c.characterId === state.activeCharacterId) || state.characters[0] || null;
}

function getWindowSnapshots() {
  return filterSnapshotsByRange(state.snapshots, state.range);
}

function pointTooltip(label, point, unit = "") {
  return makeTooltipMarkup({ label, point, suffix: unit });
}

function chartPath(valid, xFor, yFor) {
  let path = "";
  let started = false;
  valid.forEach((point) => {
    if (!Number.isFinite(point.value)) {
      started = false;
      return;
    }
    const command = started ? "L" : "M";
    path += `${command}${xFor(point.sampleIndex).toFixed(2)} ${yFor(point.value).toFixed(2)} `;
    started = true;
  });
  return path.trim();
}

function makeSvgChart(title, color, sourcePoints, maxPoints = 800) {
  const width = 820;
  const height = 290;
  const pad = { left: 60, right: 18, top: 18, bottom: 40 };
  const points = sourcePoints.map((p, index) => ({ ...p, sampleIndex: index }));
  const sanitized = sanitizeTransientZeroes(points);
  const sampled = downsample(sanitized, maxPoints).map((p, index) => ({ ...p, sampleIndex: p.originalIndex ?? index }));
  const valid = sampled.filter(p => Number.isFinite(p.value));
  if (!valid.length) return `<div class="empty">No usable data in this window.</div>`;

  const min = Math.min(...valid.map(p => p.value));
  const max = Math.max(...valid.map(p => p.value));
  const range = max === min ? Math.max(1, Math.abs(max) * 0.04) : max - min;
  const yMin = max === min ? Math.max(0, min - range) : min;
  const yMax = max === min ? max + range : max;
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const x = i => sampled.length <= 1 ? pad.left + innerW / 2 : pad.left + i / (sampled.length - 1) * innerW;
  const y = value => pad.top + (1 - (value - yMin) / (yMax - yMin || 1)) * innerH;

  const grid = [0, .25, .5, .75, 1].map(t => {
    const yy = pad.top + t * innerH;
    const value = yMax - t * (yMax - yMin);
    return `<line class="gridline" x1="${pad.left}" y1="${yy}" x2="${width - pad.right}" y2="${yy}"/><text class="axis-label" x="${pad.left - 10}" y="${yy + 4}" text-anchor="end">${escapeHtml(formatCompact(value))}</text>`;
  }).join("");

  const linePath = chartPath(sampled, x, y);

  // Area path below the line for subtle aesthetic depth
  let areaPath = "";
  if (valid.length > 1) {
    const firstX = x(sampled.indexOf(valid[0]));
    const lastX = x(sampled.indexOf(valid.at(-1)));
    const baselineY = pad.top + innerH;
    areaPath = `${linePath} L${lastX.toFixed(2)} ${baselineY.toFixed(2)} L${firstX.toFixed(2)} ${baselineY.toFixed(2)} Z`;
  }

  // Points metadata for crosshair hover tracking without dots
  const pointsData = valid.map(point => {
    const sampleIdx = sampled.indexOf(point);
    const cx = x(sampleIdx);
    const cy = y(point.value);
    const tooltipHtml = makeTooltipMarkup({ label: title, point, color });
    return { cx, cy, tooltipHtml };
  });

  const serializedPoints = escapeHtml(JSON.stringify(pointsData));

  const firstLabel = new Date(sampled[0].timestamp).toLocaleString([], { month: "short", day: "numeric" });
  const lastLabel = new Date(sampled.at(-1).timestamp).toLocaleString([], { month: "short", day: "numeric" });

  const gradientId = `grad_${title.toLowerCase().replace(/[^a-z0-9]/g, "_")}`;

  return `
    <svg class="chart-svg" viewBox="0 0 ${width} ${height}" data-points="${serializedPoints}" role="img" aria-label="${escapeHtml(title)} graph">
      <defs>
        <linearGradient id="${gradientId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${color}" stop-opacity="0.28" />
          <stop offset="100%" stop-color="${color}" stop-opacity="0.0" />
        </linearGradient>
      </defs>
      ${grid}
      ${areaPath ? `<path class="chart-area" d="${areaPath}" fill="url(#${gradientId})" />` : ""}
      <path class="chart-line" d="${linePath}" stroke="${color}" />
      <line class="chart-crosshair" x1="0" y1="${pad.top}" x2="0" y2="${height - pad.bottom}" style="display: none;" />
      <circle class="chart-active-dot" cx="0" cy="0" r="4.5" fill="${color}" stroke="#181715" stroke-width="2" style="display: none;" />
      <text class="axis-label" x="${pad.left}" y="${height - 12}">${escapeHtml(firstLabel)}</text>
      <text class="axis-label" x="${width - pad.right}" y="${height - 12}" text-anchor="end">${escapeHtml(lastLabel)}</text>
    </svg>
    <div class="chart-tooltip" role="status"></div>
  `;
}

function makeCombinedChart(snapshots) {
  if (!snapshots.length) return `<div class="empty">No data yet.</div>`;
  const width = 820;
  const height = 320;
  const pad = { left: 58, right: 18, top: 20, bottom: 40 };
  const sampledBase = downsample(snapshots.map((p, index) => ({ ...p, originalIndex: index })), 800);
  const sampled = sampledBase.map(p => ({ ...p, sampleIndex: snapshots.indexOf(p) }));

  const series = TRACKED_SERIES.map(seriesInfo => {
    const raw = snapshots.map((p, index) => ({ timestamp: p.timestamp, actual: p[seriesInfo.key], value: Number.isFinite(p[seriesInfo.key]) ? p[seriesInfo.key] : NaN, originalIndex: index }));
    const sanitized = sanitizeTransientZeroes(raw).map((p, index) => ({ ...p, originalIndex: p.originalIndex ?? index }));
    const baselinePoint = sanitized.find(p => Number.isFinite(p.value) && p.value > 0);
    const baseline = baselinePoint?.value;
    return {
      ...seriesInfo,
      points: sampled.map(p => {
        const rawPoint = sanitized[p.originalIndex] || {};
        const actual = rawPoint.value;
        const previousSnapshot = p.originalIndex > 0 ? sanitized[p.originalIndex - 1] : null;
        const previousValue = previousSnapshot && Number.isFinite(previousSnapshot.value) ? previousSnapshot.value : null;
        const delta = previousValue == null || !Number.isFinite(actual) ? null : actual - previousValue;
        return {
          timestamp: p.timestamp,
          actual,
          value: baseline && Number.isFinite(actual) ? actual / baseline * 100 : NaN,
          delta,
          percent: previousValue == null || previousValue === 0 || !Number.isFinite(actual) ? null : (delta / previousValue) * 100,
          elapsedMs: p.originalIndex > 0 ? new Date(p.timestamp).getTime() - new Date(snapshots[p.originalIndex - 1].timestamp).getTime() : null,
          originalIndex: p.originalIndex
        };
      })
    };
  });

  const all = series.flatMap(s => s.points.map(p => p.value)).filter(Number.isFinite);
  if (!all.length) return `<div class="empty">No data yet.</div>`;
  const min = Math.min(...all), max = Math.max(...all);
  const spread = Math.max(1, max - min);
  const yMin = Math.max(0, min - spread * 0.12);
  const yMax = max + spread * 0.12;
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const x = i => sampled.length <= 1 ? pad.left + innerW / 2 : i / (sampled.length - 1) * innerW + pad.left;
  const y = value => pad.top + (1 - (value - yMin) / (yMax - yMin || 1)) * innerH;

  let grid = [0, .25, .5, .75, 1].map(t => {
    const yy = pad.top + t * innerH;
    const value = yMax - t * (yMax - yMin);
    return `<line class="gridline" x1="${pad.left}" y1="${yy}" x2="${width - pad.right}" y2="${yy}"/><text class="axis-label" x="${pad.left - 10}" y="${yy + 4}" text-anchor="end">${Math.round(value)}</text>`;
  }).join("");

  let linesSvg = "";
  series.forEach(seriesInfo => {
    const valid = seriesInfo.points.filter(p => Number.isFinite(p.value));
    let path = "";
    let started = false;
    valid.forEach(point => {
      const sampleIndex = sampled.findIndex(p => p.originalIndex === point.originalIndex);
      const command = started ? "L" : "M";
      path += `${command}${x(sampleIndex).toFixed(2)} ${y(point.value).toFixed(2)} `;
      started = true;
    });
    linesSvg += `<path class="chart-line" d="${path.trim()}" stroke="${seriesInfo.color}"/>`;
  });

  // Build multi-series snapshot points data for crosshair
  const pointsData = sampled.map((sPoint, sIdx) => {
    const cx = x(sIdx);
    const dateStr = new Date(sPoint.timestamp).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });

    const rows = series.map(s => {
      const p = s.points[sIdx];
      if (!p || p.actual == null || !Number.isFinite(p.actual)) return "";
      const deltaStr = p.delta != null ? ` (${p.delta >= 0 ? "+" : ""}${formatNumber(p.delta)})` : "";
      return `
        <div class="chart-tt-row">
          <span style="display:inline-flex;align-items:center;gap:4px;">
            <span class="chart-tt-indicator" style="background:${s.color};"></span>
            <span>${escapeHtml(s.short)}</span>
          </span>
          <span style="font-weight:700;color:#faf8f5;">${escapeHtml(formatNumber(p.actual))}${deltaStr}</span>
        </div>
      `;
    }).join("");

    const tooltipHtml = `
      <div class="chart-tt-header">
        <span class="chart-tt-label">${escapeHtml(dateStr)}</span>
      </div>
      ${rows}
    `;

    const primarySeries = series[0]?.points[sIdx];
    const cy = primarySeries && Number.isFinite(primarySeries.value) ? y(primarySeries.value) : pad.top + innerH / 2;

    return { cx, cy, tooltipHtml };
  });

  const serializedPoints = escapeHtml(JSON.stringify(pointsData));

  return `
    <svg class="chart-svg" viewBox="0 0 ${width} ${height}" data-points="${serializedPoints}" role="img" aria-label="Combined normalized trend graph">
      ${grid}
      ${linesSvg}
      <line class="chart-crosshair" x1="0" y1="${pad.top}" x2="0" y2="${height - pad.bottom}" style="display: none;" />
      <circle class="chart-active-dot" cx="0" cy="0" r="4.5" fill="#d97757" stroke="#181715" stroke-width="2" style="display: none;" />
    </svg>
    <div class="chart-tooltip" role="status"></div>
  `;
}

function renderRangeControls() {
  const target = document.getElementById("rangeControls");
  if (!target) return;
  target.innerHTML = Object.entries(RANGE_CONFIG).map(([id, config]) => `<button class="range-btn ${state.range === id ? "active" : ""}" data-range="${id}">${config.label}</button>`).join("");
  target.querySelectorAll(".range-btn").forEach(button => {
    button.addEventListener("click", () => {
      state.range = button.dataset.range;
      render();
    });
  });
}

function renderCards() {
  const windowSnapshots = getWindowSnapshots();
  const latest = windowSnapshots.at(-1) || state.snapshots.at(-1);
  const container = document.getElementById("cards");
  if (!container) return;

  container.innerHTML = TRACKED_SERIES.map(seriesInfo => {
    const value = latest?.[seriesInfo.key];
    const stats = getWindowStats(windowSnapshots, seriesInfo.key);
    const delta = stats?.delta;
    const percent = stats?.percent;
    const sign = delta == null ? "" : delta >= 0 ? "+" : "";
    const growth = stats && windowSnapshots.length >= 2
      ? `${sign}${formatNumber(delta)} ${percent == null ? "" : `(${percent >= 0 ? "+" : ""}${percent.toFixed(2)}%)`} over ${formatDuration(stats.durationMs)}`.trim()
      : "Need at least two samples";
    const cls = delta == null ? "" : delta >= 0 ? "up" : "down";
    return `<article class="stat-card"><div class="stat-label">${escapeHtml(seriesInfo.label)}</div><div class="stat-value">${formatNumber(value)}</div><div class="stat-change ${cls}">${escapeHtml(growth)}</div><div class="stat-secondary">Rate: ${escapeHtml(formatRate(stats?.perHour))}</div></article>`;
  }).join("");
}

function renderInsights() {
  const windowSnapshots = getWindowSnapshots();
  const latest = windowSnapshots.at(-1) || state.snapshots.at(-1);
  const container = document.getElementById("insights");
  if (!container) return;

  const chats = latest?.chats;
  const msgs = latest?.msgs;
  const comments = latest?.comments;
  const favs = latest?.favourites;
  const pubChats = latest?.publishedChats;

  const msgsPerChat = Number.isFinite(msgs) && Number.isFinite(chats) && chats > 0
    ? (msgs / chats).toFixed(2)
    : null;

  const favRate = Number.isFinite(favs) && Number.isFinite(chats) && chats > 0
    ? `${((favs / chats) * 100).toFixed(2)}%`
    : null;

  const msgsPerFav = Number.isFinite(favs) && Number.isFinite(msgs) && favs > 0
    ? `1 : ${Math.round(msgs / favs).toLocaleString()}`
    : null;

  const commentsPer1kChats = Number.isFinite(comments) && Number.isFinite(chats) && chats > 0
    ? ((comments / chats) * 1000).toFixed(1)
    : null;

  const chatsPer1kMsgs = Number.isFinite(chats) && Number.isFinite(msgs) && msgs > 0
    ? ((chats / msgs) * 1000).toFixed(1)
    : null;

  const pubShare = Number.isFinite(pubChats) && Number.isFinite(chats) && chats > 0
    ? `${((pubChats / chats) * 100).toFixed(1)}%`
    : null;

  const pairs = [
    ["Messages / Chat", msgsPerChat, "Average conversation depth"],
    ["Fave / Chat Rate", favRate, "Favourites per 100 chats"],
    ["Faves to Messages", msgsPerFav, "Ratio of faves per messages"],
    ["Comments / 1k Chats", commentsPer1kChats, "Comments per 1,000 chats"],
    ["Chats / 1k Messages", chatsPer1kMsgs, "New chats per 1,000 messages"],
    ...(pubShare ? [["Public Chat Share", pubShare, "Public vs total conversations"]] : [["Comments / 1k Msgs", Number.isFinite(comments) && Number.isFinite(msgs) && msgs > 0 ? ((comments / msgs) * 1000).toFixed(1) : null, "Comments per 1,000 messages"]])
  ];

  const duration = getWindowStats(windowSnapshots, "msgs")?.durationMs ?? 0;
  const growthStats = TRACKED_SERIES.slice(0, 5).map(seriesInfo => {
    const stats = getWindowStats(windowSnapshots, seriesInfo.key);
    return `<div class="insight-mini"><div class="insight-mini-label">${escapeHtml(seriesInfo.short)} growth</div><div class="insight-mini-value">${stats ? `${stats.delta >= 0 ? "+" : ""}${formatNumber(stats.delta)}` : "—"}</div><div class="insight-mini-sub">${stats?.percent == null ? "Percent unavailable" : `${stats.percent >= 0 ? "+" : ""}${stats.percent.toFixed(2)}% over ${formatDuration(stats.durationMs)}`}</div></div>`;
  }).join("");

  const ratioHtml = pairs.map(([label, value, sub]) => `<div class="insight-mini"><div class="insight-mini-label">${escapeHtml(label)}</div><div class="insight-mini-value">${value == null ? "—" : escapeHtml(value)}</div><div class="insight-mini-sub">${escapeHtml(sub)}</div></div>`).join("");
  const totalDuration = windowSnapshots.length > 1 ? formatDuration(duration) : "—";

  container.innerHTML = `
    <section class="panel insights-panel full">
      <div class="panel-head"><div><h2>Growth & ratios</h2><div class="panel-sub">Window: ${escapeHtml(RANGE_CONFIG[state.range]?.label || state.range)} · ${windowSnapshots.length.toLocaleString()} usable samples · ${escapeHtml(totalDuration)} covered</div></div></div>
      <div class="insight-grid">${growthStats}${ratioHtml}</div>
    </section>`;
}

function renderMeta(character) {
  const meta = [];
  if (character.publishedAt) meta.push(`Published · ${character.publishedAt}`);
  if (character.createdAt) meta.push(`Created · ${character.createdAt}`);
  if (character.updatedAt) meta.push(`Updated · ${character.updatedAt}`);
  meta.push(`${state.snapshots.length.toLocaleString()} stored samples`);
  if (character.publishedChats != null) meta.push(`${formatNumber(character.publishedChats)} published chats`);
  const metaEl = document.getElementById("meta");
  if (metaEl) {
    metaEl.innerHTML = meta.map(x => `<span class="pill">${escapeHtml(x)}</span>`).join("");
  }
}

function renderCharts() {
  const windowSnapshots = getWindowSnapshots();
  const charts = TRACKED_SERIES.map(seriesInfo => {
    const source = windowSnapshots.map(p => ({ timestamp: p.timestamp, value: p[seriesInfo.key], display: p[`${seriesInfo.key}Display`] }));
    return `<article class="panel"><div class="panel-head"><div><h2>${escapeHtml(seriesInfo.label)}</h2><div class="panel-sub">Actual value over time · hover any point for exact change</div></div></div><div class="chart-wrap">${makeSvgChart(seriesInfo.label, seriesInfo.color, enrichPoints(source, "value"))}</div></article>`;
  }).join("");

  const combined = `<article class="panel full"><div class="panel-head"><div><h2>Combined trend</h2><div class="panel-sub">All tracked metrics indexed to 100 at the start of the selected window</div></div></div><div class="chart-wrap">${makeCombinedChart(windowSnapshots)}</div><div class="legend">${TRACKED_SERIES.map(s => `<span class="legend-item"><span class="legend-dot" style="background:${s.color}"></span>${escapeHtml(s.label)}</span>`).join("")}</div></article>`;
  const chartsEl = document.getElementById("charts");
  if (chartsEl) {
    chartsEl.innerHTML = charts + combined;
    bindChartTooltips(chartsEl);
  }
}

function render() {
  renderRangeControls();
  const character = getCurrent();
  const titleEl = document.getElementById("title");
  const subtitleEl = document.getElementById("subtitle");
  const cardsEl = document.getElementById("cards");
  const insightsEl = document.getElementById("insights");
  const chartsEl = document.getElementById("charts");
  const metaEl = document.getElementById("meta");

  if (!character) {
    if (titleEl) titleEl.textContent = "Welcome to JanitorAI Stats Tracker";
    if (subtitleEl) subtitleEl.textContent = "Track character messages, chats, comments and favourites with real-time charts.";
    if (cardsEl) cardsEl.innerHTML = "";
    if (insightsEl) insightsEl.innerHTML = "";
    if (chartsEl) chartsEl.innerHTML = `
      <article class="panel full empty-panel">
        <div class="empty">
          <h3>No tracked characters yet</h3>
          <p>Explore with a simulated demo dataset or import existing character history.</p>
          <div class="empty-actions">
            <button class="btn btn-primary" id="emptyDemoBtn">
              <svg viewBox="0 0 24 24"><path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z"/></svg>
              Load Demo
            </button>
            <button class="btn btn-secondary" id="emptyAddBtn">
              <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
              Add Entry
            </button>
            <button class="btn btn-secondary" id="emptyImportBtn">
              <svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5-5 5 5M12 5v12"/></svg>
              Import CSV
            </button>
          </div>
        </div>
      </article>`;
    if (metaEl) metaEl.innerHTML = "";

    document.getElementById("emptyDemoBtn")?.addEventListener("click", loadSampleData);
    document.getElementById("emptyAddBtn")?.addEventListener("click", openEntryModal);
    document.getElementById("emptyImportBtn")?.addEventListener("click", () => document.getElementById("csvFileInput")?.click());
    return;
  }

  const lastSeen = character.lastSeen ? new Date(character.lastSeen).toLocaleString() : "never";
  if (titleEl) titleEl.textContent = character.characterName || "JanitorAI character";
  if (subtitleEl) subtitleEl.textContent = `Last collected ${lastSeen}`;
  renderMeta(character);
  renderTrackingCountdown();
  updateScraperStatusUI();
  renderCards();
  renderInsights();
  renderCharts();
}

function populateCharacterSelect() {
  const current = getCurrent();
  const currentLabel = document.getElementById("charSelectCurrent");
  const menu = document.getElementById("charSelectMenu");
  const nativeSelect = document.getElementById("characterSelect");

  if (nativeSelect) {
    if (!state.characters.length) {
      nativeSelect.innerHTML = `<option value="">No characters</option>`;
    } else {
      nativeSelect.innerHTML = state.characters
        .map(c => `<option value="${escapeHtml(c.characterId)}">${escapeHtml(c.characterName || c.characterId)}</option>`)
        .join("");
      if (state.activeCharacterId) nativeSelect.value = state.activeCharacterId;
    }
  }

  if (currentLabel) {
    currentLabel.textContent = current ? (current.characterName || current.characterId) : "Select a character...";
  }

  if (menu) {
    if (!state.characters.length) {
      menu.innerHTML = `<div class="custom-select-item" style="color: var(--color-text-muted); cursor: default;">No characters yet</div>`;
      return;
    }

    menu.innerHTML = state.characters.map(c => {
      const isSelected = c.characterId === state.activeCharacterId;
      const checkSvg = isSelected
        ? `<svg class="custom-select-check" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>`
        : "";
      return `
        <button type="button" class="custom-select-item ${isSelected ? "is-selected" : ""}" data-id="${escapeHtml(c.characterId)}" role="option" aria-selected="${isSelected}">
          <span class="custom-select-item-text">${escapeHtml(c.characterName || c.characterId)}</span>
          ${checkSvg}
        </button>`;
    }).join("");

    menu.querySelectorAll(".custom-select-item[data-id]").forEach(item => {
      item.addEventListener("click", async () => {
        const id = item.dataset.id;
        state.activeCharacterId = id;
        await storage.set({ activeCharacterId: id });
        closeCustomSelect();
        const character = getCurrent();
        state.snapshots = character ? await getSnapshots(character.characterId) : [];
        populateCharacterSelect();
        render();
      });
    });
  }
}

function toggleCustomSelect() {
  const trigger = document.getElementById("charSelectTrigger");
  const menu = document.getElementById("charSelectMenu");
  if (!trigger || !menu) return;
  const isOpen = trigger.classList.contains("is-open");
  if (isOpen) {
    closeCustomSelect();
  } else {
    trigger.classList.add("is-open");
    trigger.setAttribute("aria-expanded", "true");
    menu.style.display = "flex";
  }
}

function closeCustomSelect() {
  const trigger = document.getElementById("charSelectTrigger");
  const menu = document.getElementById("charSelectMenu");
  if (trigger) {
    trigger.classList.remove("is-open");
    trigger.setAttribute("aria-expanded", "false");
  }
  if (menu) {
    menu.style.display = "none";
  }
}

function setupStepperControls() {
  document.querySelectorAll(".stepper-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      const targetId = btn.dataset.target;
      const input = targetId ? document.getElementById(targetId) : btn.closest(".number-input-wrap")?.querySelector('input[type="number"]');
      if (!input) return;

      const isUp = btn.classList.contains("stepper-up");
      const step = e.shiftKey ? 10 : 1;
      let val = Number(input.value) || 0;

      if (isUp) {
        val += step;
      } else {
        val = Math.max(0, val - step);
      }

      input.value = val;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  });
}

function setupRealtimeListener(characterId) {
  if (realtimeUnsubscribe) {
    realtimeUnsubscribe();
    realtimeUnsubscribe = null;
  }
  if (!characterId) return;

  realtimeUnsubscribe = subscribeToRealtimeSnapshots(characterId, (newSnapshot) => {
    if (!newSnapshot || newSnapshot.characterId !== state.activeCharacterId) return;

    // Avoid duplicate insertions
    const exists = state.snapshots.some(s => s.timestamp === newSnapshot.timestamp);
    if (exists) return;

    state.snapshots.push(newSnapshot);
    state.snapshots.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    render();
    showToast(`Received 1m live snapshot for ${getCurrent()?.characterName || 'character'}.`, "info");
  });
}

function renderTrackingCountdown() {
  const pill = document.getElementById("trackingPill");
  if (!pill) return;

  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }

  const char = getCurrent();
  if (!char) {
    pill.style.display = "none";
    return;
  }

  const job = trackedJobs.find(j => (j.character_id || j.characterId) === char.characterId);
  if (!job || !job.expires_at) {
    pill.style.display = "none";
    return;
  }

  const updateCountdown = () => {
    const expiresMs = new Date(job.expires_at).getTime();
    const nowMs = Date.now();
    const diffMs = expiresMs - nowMs;

    if (diffMs > 0 && job.status === "active") {
      const totalHours = Math.floor(diffMs / (1000 * 60 * 60));
      const totalMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
      pill.className = "tracking-pill";
      pill.style.display = "inline-flex";
      pill.innerHTML = `
        <span class="tracking-pulse-dot"></span>
        <span><strong>72h Tracker:</strong> ${totalHours}h ${totalMins}m remaining • 1m interval</span>
      `;
    } else {
      pill.className = "tracking-pill is-completed";
      pill.style.display = "inline-flex";
      pill.innerHTML = `
        <svg viewBox="0 0 24 24" style="width: 14px; height: 14px; stroke: currentColor; fill: none; stroke-width: 2;"><path d="M20 6 9 17l-5-5"/></svg>
        <span>72h Tracking Finished • Data permanently saved in Supabase</span>
      `;
    }
  };

  updateCountdown();
  countdownTimer = setInterval(updateCountdown, 30000);
}

let isExtensionDetected = isExtension;

// Bridge listener for Chrome Extension presence
window.addEventListener("message", (event) => {
  if (event.data?.source === "JSTATS_EXTENSION" && event.data?.active) {
    if (!isExtensionDetected) {
      isExtensionDetected = true;
      updateScraperStatusUI();
    }
  }
});

// Periodically ping extension bridge
setInterval(() => {
  window.postMessage({ source: "JSTATS_DASHBOARD", type: "PING_EXTENSION" }, "*");
}, 4000);
window.postMessage({ source: "JSTATS_DASHBOARD", type: "PING_EXTENSION" }, "*");

function updateScraperStatusUI() {
  const card = document.getElementById("scraperStatusCard");
  if (!card) return;

  const char = getCurrent();
  if (!char) {
    card.style.display = "none";
    return;
  }

  const job = trackedJobs.find(j => (j.character_id || j.characterId) === char.characterId);
  if (!job || job.status !== "active") {
    card.style.display = "none";
    return;
  }

  const snapCount = state.snapshots?.length || 0;

  if (isExtensionDetected) {
    card.style.display = "block";
    card.innerHTML = `
      <div class="scraper-banner is-active">
        <div class="scraper-banner-left">
          <span class="status-indicator-dot is-connected"></span>
          <span><strong>Scraper Active:</strong> Chrome Extension connected • Scraping every 1m & syncing to Supabase</span>
        </div>
        <button type="button" class="btn-micro" id="manualScrapeTriggerBtn" data-tooltip="Trigger immediate scrape right now">
          <svg viewBox="0 0 24 24" style="width:13px;height:13px;stroke:currentColor;fill:none;stroke-width:2;"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 21h5v-5"/></svg>
          <span>Scrape Now</span>
        </button>
      </div>
    `;

    const triggerBtn = document.getElementById("manualScrapeTriggerBtn");
    if (triggerBtn) {
      triggerBtn.onclick = async () => {
        triggerBtn.disabled = true;
        triggerBtn.innerHTML = `<span>Scraping...</span>`;
        if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
          try {
            await chrome.runtime.sendMessage({
              type: "TRIGGER_SCRAPE_NOW",
              payload: { characterId: char.characterId }
            });
          } catch {}
        } else {
          window.postMessage({
            source: "JSTATS_DASHBOARD",
            type: "TRIGGER_SCRAPE_NOW",
            payload: { characterId: char.characterId }
          }, "*");
        }
        setTimeout(async () => {
          await render();
          triggerBtn.disabled = false;
          triggerBtn.innerHTML = `
            <svg viewBox="0 0 24 24" style="width:13px;height:13px;stroke:currentColor;fill:none;stroke-width:2;"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 21h5v-5"/></svg>
            <span>Scrape Now</span>
          `;
        }, 2500);
      };
    }
    return;
  }

  // If extension is waiting / not loaded into Chrome
  card.style.display = "block";
  card.innerHTML = `
    <div class="scraper-banner is-waiting">
      <div class="scraper-banner-header">
        <div class="scraper-banner-title">
          <svg viewBox="0 0 24 24" class="scraper-warn-icon"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          <strong>Scraper Extension Waiting (${snapCount} samples collected)</strong>
        </div>
        <span class="scraper-badge-pill">Free ($0) Background Engine</span>
      </div>
      <p class="scraper-banner-desc">
        Your 72-hour tracking job is saved in Supabase. Because Vercel is a static web app, automated 1-minute scraping requires the JStats Chrome extension to be loaded in your Chrome browser:
      </p>
      <div class="scraper-setup-steps">
        <div class="scraper-step">
          <span class="step-num">1</span>
          <span>Open <code>chrome://extensions</code> in Chrome</span>
        </div>
        <div class="scraper-step">
          <span class="step-num">2</span>
          <span>Turn on <strong>Developer mode</strong> (top-right toggle)</span>
        </div>
        <div class="scraper-step">
          <span class="step-num">3</span>
          <span>Click <strong>Load unpacked</strong> and select folder:</span>
        </div>
      </div>
      <div class="scraper-path-box">
        <code>/home/insomniac/Desktop/UNI/Apps/janitorai-stats-tracker</code>
        <button type="button" class="btn-micro" id="copyExtPathBtn" data-tooltip="Copy path to clipboard">Copy Path</button>
      </div>
    </div>
  `;

  const copyBtn = document.getElementById("copyExtPathBtn");
  if (copyBtn) {
    copyBtn.onclick = () => {
      navigator.clipboard.writeText("/home/insomniac/Desktop/UNI/Apps/janitorai-stats-tracker").then(() => {
        copyBtn.textContent = "Copied!";
        setTimeout(() => { copyBtn.textContent = "Copy Path"; }, 2000);
      });
    };
  }
}

async function updateCloudSyncIndicator() {
  const dot = document.getElementById("syncStatusDot");
  const label = document.getElementById("syncBtnLabel");
  const btn = document.getElementById("cloudSyncBtn");
  if (!dot || !label || !btn) return;

  const config = await getSupabaseConfig();
  if (!config) {
    dot.className = "sync-status-dot";
    label.textContent = "Cloud Sync";
    btn.setAttribute("data-tooltip", "Connect Supabase ($0 Cloud Storage & 3-Day Tracker)");
    return;
  }

  dot.className = "sync-status-dot is-connected";
  label.textContent = "Cloud Sync";
  btn.setAttribute("data-tooltip", "Supabase Connected • 100% Free Cloud Storage Active");
}

async function load() {
  // 1. Fetch local characters
  const localCharacters = await getAllCharacters();
  const charMap = new Map();
  for (const c of localCharacters) {
    charMap.set(c.characterId, c);
  }

  // 2. Fetch Supabase tracked jobs if connected
  try {
    const supabaseJobs = await fetchTrackedJobs();
    if (supabaseJobs && supabaseJobs.length > 0) {
      trackedJobs = supabaseJobs;
      for (const job of supabaseJobs) {
        if (!charMap.has(job.character_id)) {
          charMap.set(job.character_id, {
            characterId: job.character_id,
            characterName: job.character_name,
            url: job.url,
            createdAt: job.created_at,
            lastSeen: job.last_scraped_at
          });
        }
      }
    }
  } catch (err) {
    console.warn("JStats: could not load Supabase tracked jobs", err);
  }

  // 3. Fallback to local tracked jobs
  if (isExtension && chrome?.storage?.local) {
    try {
      const localStore = await chrome.storage.local.get("trackedJobs");
      const localJobs = localStore.trackedJobs || {};
      for (const [id, job] of Object.entries(localJobs)) {
        if (!trackedJobs.some(j => (j.character_id || j.characterId) === id)) {
          trackedJobs.push(job);
        }
        if (!charMap.has(id)) {
          charMap.set(id, {
            characterId: id,
            characterName: job.character_name,
            url: job.url,
            lastSeen: job.last_scraped_at
          });
        }
      }
    } catch {}
  }

  state.characters = Array.from(charMap.values()).sort((a, b) => (b.lastSeen || "").localeCompare(a.lastSeen || ""));
  const settings = await storage.get({ activeCharacterId: null });
  state.activeCharacterId = state.characters.some(c => c.characterId === settings.activeCharacterId)
    ? settings.activeCharacterId
    : state.characters[0]?.characterId || null;

  populateCharacterSelect();
  const character = getCurrent();

  // 4. Fetch snapshots for active character
  if (character) {
    let snaps = [];
    const config = await getSupabaseConfig();
    if (config) {
      snaps = await fetchCharacterSnapshots(character.characterId);
    }
    if (!snaps || snaps.length === 0) {
      snaps = await getSnapshots(character.characterId);
    }
    state.snapshots = snaps || [];
  } else {
    state.snapshots = [];
  }

  // 5. Connect Realtime WebSocket listener
  setupRealtimeListener(state.activeCharacterId);

  // 6. Update tracking countdown indicator
  renderTrackingCountdown();

  // 7. Update cloud sync status
  await updateCloudSyncIndicator();

  render();
}

function setupEventListeners() {
  document.getElementById("charSelectTrigger")?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleCustomSelect();
  });

  document.addEventListener("click", (e) => {
    const wrap = document.getElementById("characterCustomSelect");
    if (wrap && !wrap.contains(e.target)) {
      closeCustomSelect();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeCustomSelect();
      closeEntryModal();
    }
  });

  setupStepperControls();

  document.getElementById("characterSelect")?.addEventListener("change", async e => {
    state.activeCharacterId = e.target.value;
    await storage.set({ activeCharacterId: state.activeCharacterId });
    const character = getCurrent();
    state.snapshots = character ? await getSnapshots(character.characterId) : [];
    populateCharacterSelect();
    render();
  });

  document.getElementById("collectBtn")?.addEventListener("click", async () => {
    if (!isExtension || !chrome?.tabs?.query) {
      openEntryModal();
      return;
    }
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      if (!tab?.id || !/janitorai\.com\/characters\//i.test(tab.url || "")) {
        showNotice("Open the character you want to collect in the active tab.");
        return;
      }
      const result = await chrome.tabs.sendMessage(tab.id, { type: "COLLECT_STATS" });
      showNotice(result?.ok ? "Collected the current page." : "The page is still loading; try again in a moment.");
      if (result?.snapshot?.characterId) {
        await storage.set({ activeCharacterId: result.snapshot.characterId });
      }
      await load();
    } catch {
      showNotice("Could not collect from tab. Reload the JanitorAI character page once or add manually.");
    }
  });

  document.getElementById("demoBtn")?.addEventListener("click", loadSampleData);

  document.getElementById("addBtn")?.addEventListener("click", openEntryModal);

  document.getElementById("clearBtn")?.addEventListener("click", () => {
    const character = getCurrent();
    if (!character) {
      showToast("No active character selected to clear.", "info");
      return;
    }
    openConfirmModal({
      title: "Delete Character History",
      message: `Are you sure you want to permanently delete all snapshot data for <strong>${escapeHtml(character.characterName)}</strong>? This action cannot be undone.`,
      confirmText: "Delete Data",
      onConfirm: async () => {
        await deleteCharacter(character.characterId);
        await deleteTrackedJob(character.characterId);
        const remaining = (await getAllCharacters()).sort((a, b) => (b.lastSeen || "").localeCompare(a.lastSeen || ""));
        await storage.set({ activeCharacterId: remaining[0]?.characterId || null });
        await load();
        showToast(`Deleted history for ${character.characterName}.`, "info");
        showNotice(`Deleted character ${character.characterName}.`);
      }
    });
  });

  document.getElementById("exportBtn")?.addEventListener("click", async () => {
    const character = getCurrent();
    if (!character || !state.snapshots.length) {
      showToast("No snapshot data available to export for this character.", "warning");
      return;
    }
    const rows = [["timestamp", "messages", "chats", "comments", "favourites", "publishedChats", "publishedAt", "createdAt", "updatedAt"]];
    for (const p of state.snapshots) {
      rows.push([
        p.timestamp,
        p.msgs ?? "",
        p.chats ?? "",
        p.comments ?? "",
        p.favourites ?? "",
        p.publishedChats ?? "",
        character.publishedAt ?? "",
        character.createdAt ?? "",
        character.updatedAt ?? ""
      ]);
    }
    const csv = rows.map(row => row.map(v => `"${String(v).replaceAll('"', '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(character.characterName || "janitorai").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "")}-stats.csv`;
    a.click();
    showToast(`Exported ${state.snapshots.length} snapshots to CSV.`, "success");
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  const importBtn = document.getElementById("importBtn");
  const fileInput = document.getElementById("csvFileInput");
  if (importBtn && fileInput) {
    importBtn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", handleCsvUpload);
  }

  // Track Bot URL Modal
  document.getElementById("trackUrlBtn")?.addEventListener("click", openTrackModal);
  document.getElementById("closeTrackModalBtn")?.addEventListener("click", closeTrackModal);
  document.getElementById("cancelTrackModalBtn")?.addEventListener("click", closeTrackModal);
  document.getElementById("trackModalOverlay")?.addEventListener("click", (e) => {
    if (e.target.id === "trackModalOverlay") closeTrackModal();
  });
  document.getElementById("trackUrlInput")?.addEventListener("input", updateTrackUrlHelper);
  document.getElementById("trackUrlInput")?.addEventListener("change", updateTrackUrlHelper);
  document.getElementById("trackUrlForm")?.addEventListener("submit", handleTrackUrlSubmit);

  // Supabase Cloud Sync Modal
  document.getElementById("cloudSyncBtn")?.addEventListener("click", openSupabaseModal);
  document.getElementById("closeSupabaseModalBtn")?.addEventListener("click", closeSupabaseModal);
  document.getElementById("cancelSupabaseModalBtn")?.addEventListener("click", closeSupabaseModal);
  document.getElementById("supabaseModalOverlay")?.addEventListener("click", (e) => {
    if (e.target.id === "supabaseModalOverlay") closeSupabaseModal();
  });
  document.getElementById("supabaseConfigForm")?.addEventListener("submit", handleSupabaseConfigSubmit);
  document.getElementById("disconnectSupabaseBtn")?.addEventListener("click", handleDisconnectSupabase);
  document.getElementById("copySchemaBtn")?.addEventListener("click", handleCopySchemaSql);
  document.getElementById("toggleKeyVisibility")?.addEventListener("click", () => {
    const input = document.getElementById("supabaseAnonKeyInput");
    if (!input) return;
    input.type = input.type === "password" ? "text" : "password";
  });

  // Modal event listeners
  document.getElementById("closeModalBtn")?.addEventListener("click", closeEntryModal);
  document.getElementById("cancelModalBtn")?.addEventListener("click", closeEntryModal);
  document.getElementById("entryModalOverlay")?.addEventListener("click", (e) => {
    if (e.target.id === "entryModalOverlay") closeEntryModal();
  });
  document.getElementById("entryForm")?.addEventListener("submit", handleManualEntrySubmit);

  setupDragAndDrop();
  setupTooltips();

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeEntryModal();
      closeTrackModal();
      closeSupabaseModal();
      const confirmModal = document.getElementById("confirmModalOverlay");
      if (confirmModal) confirmModal.classList.remove("open");
    }
  });
}

function openTrackModal() {
  const modal = document.getElementById("trackModalOverlay");
  if (!modal) return;
  modal.classList.add("open");
  const urlInput = document.getElementById("trackUrlInput");
  if (urlInput) {
    urlInput.value = "";
    urlInput.focus();
  }
  const helper = document.getElementById("parsedUuidDisplay");
  if (helper) {
    helper.textContent = "Paste full character URL or UUID";
    helper.style.color = "var(--color-text-muted)";
  }
}

function closeTrackModal() {
  const modal = document.getElementById("trackModalOverlay");
  if (modal) modal.classList.remove("open");
}

function updateTrackUrlHelper() {
  const urlInput = document.getElementById("trackUrlInput");
  const helper = document.getElementById("parsedUuidDisplay");
  if (!urlInput || !helper) return;

  const val = urlInput.value.trim();
  if (!val) {
    helper.textContent = "Paste full character URL or UUID";
    helper.style.color = "var(--color-text-muted)";
    return;
  }

  const match = val.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (match) {
    helper.textContent = `✓ Detected UUID: ${match[1]}`;
    helper.style.color = "var(--color-info)";
  } else {
    helper.textContent = "Please enter a valid JanitorAI character URL or UUID.";
    helper.style.color = "var(--color-warning)";
  }
}

async function handleTrackUrlSubmit(e) {
  e.preventDefault();
  const urlInput = document.getElementById("trackUrlInput");
  const durationSelect = document.getElementById("trackDurationSelect");
  const customNameInput = document.getElementById("trackCustomName");

  const url = urlInput?.value.trim();
  if (!url) return;

  const match = url.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  const characterId = match ? match[1] : url.replace(/.*\/characters\//i, "").split(/[/?#]/)[0];

  if (!characterId) {
    showToast("Could not find a valid character ID or UUID in this link.", "error");
    return;
  }

  const durationHours = Number(durationSelect?.value) || 72;
  const characterName = customNameInput?.value.trim() || "JanitorAI Character";

  showToast(`Starting ${durationHours}h autonomous tracker for character...`, "info");

  if (isExtension && chrome?.runtime?.sendMessage) {
    try {
      const resp = await chrome.runtime.sendMessage({
        type: "TRACK_NEW_URL",
        payload: { url, durationHours, characterName }
      });
      if (resp?.ok) {
        await storage.set({ activeCharacterId: characterId });
        closeTrackModal();
        await load();
        showToast(`Autonomous ${durationHours}h scraper active! Polling every 1 minute.`, "success");
        return;
      }
    } catch (err) {
      console.warn("Extension message error, registering directly", err);
    }
  }

  // Direct Supabase / Web fallback
  const now = new Date();
  const expiresAt = new Date(now.getTime() + durationHours * 3600 * 1000).toISOString();
  const job = {
    character_id: characterId,
    character_name: characterName,
    url: url.startsWith("http") ? url : `https://janitorai.com/characters/${characterId}`,
    started_at: now.toISOString(),
    expires_at: expiresAt,
    status: "active",
    last_scraped_at: now.toISOString()
  };

  await saveTrackedJob(job);
  await storage.set({ activeCharacterId: characterId });
  closeTrackModal();
  await load();
  showToast(`Registered ${durationHours}h tracking job in Supabase!`, "success");
}

async function openSupabaseModal() {
  const modal = document.getElementById("supabaseModalOverlay");
  if (!modal) return;
  modal.classList.add("open");

  const urlInput = document.getElementById("supabaseUrlInput");
  const keyInput = document.getElementById("supabaseAnonKeyInput");
  const banner = document.getElementById("cloudStatusBanner");
  const text = document.getElementById("modalStatusText");

  const config = await getSupabaseConfig();
  if (config) {
    if (urlInput) urlInput.value = config.url || "";
    if (keyInput) keyInput.value = config.anonKey || "";
    if (text) text.textContent = "Testing connection...";
    const test = await testSupabaseConnection(config.url, config.anonKey);
    if (test.ok) {
      banner.className = "cloud-status-banner is-connected";
      if (text) text.textContent = "Connected to Supabase PostgreSQL (Ready)";
    } else {
      banner.className = "cloud-status-banner is-error";
      if (text) text.textContent = `Connection error: ${test.error || "Check credentials"}`;
    }
  } else {
    if (urlInput) urlInput.value = "";
    if (keyInput) keyInput.value = "";
    banner.className = "cloud-status-banner";
    if (text) text.textContent = "Supabase not configured (Local Mode)";
  }
}

function closeSupabaseModal() {
  const modal = document.getElementById("supabaseModalOverlay");
  if (modal) modal.classList.remove("open");
}

async function handleSupabaseConfigSubmit(e) {
  e.preventDefault();
  const urlInput = document.getElementById("supabaseUrlInput");
  const keyInput = document.getElementById("supabaseAnonKeyInput");
  const banner = document.getElementById("cloudStatusBanner");
  const text = document.getElementById("modalStatusText");

  const url = urlInput?.value.trim();
  const anonKey = keyInput?.value.trim();

  if (!url || !anonKey) {
    showToast("Please enter both Supabase URL and Anon Key.", "warning");
    return;
  }

  if (text) text.textContent = "Testing connection...";
  const test = await testSupabaseConnection(url, anonKey);
  if (!test.ok) {
    banner.className = "cloud-status-banner is-error";
    if (text) text.textContent = `Connection failed: ${test.error}`;
    showToast(`Supabase Error: ${test.error}`, "error");
    return;
  }

  await setSupabaseConfig(url, anonKey);
  banner.className = "cloud-status-banner is-connected";
  if (text) text.textContent = "Successfully connected to Supabase!";
  showToast("Supabase cloud database connected successfully!", "success");
  closeSupabaseModal();
  await load();
}

async function handleDisconnectSupabase() {
  await clearSupabaseConfig();
  const banner = document.getElementById("cloudStatusBanner");
  const text = document.getElementById("modalStatusText");
  const urlInput = document.getElementById("supabaseUrlInput");
  const keyInput = document.getElementById("supabaseAnonKeyInput");

  if (urlInput) urlInput.value = "";
  if (keyInput) keyInput.value = "";
  if (banner) banner.className = "cloud-status-banner";
  if (text) text.textContent = "Disconnected (Local Mode)";

  showToast("Disconnected Supabase. Running in local storage mode.", "info");
  closeSupabaseModal();
  await load();
}

function handleCopySchemaSql() {
  navigator.clipboard.writeText(SCHEMA_SQL).then(() => {
    showToast("schema.sql copied to clipboard! Paste into Supabase SQL Editor.", "success");
  }).catch(() => {
    showToast("Could not access clipboard. schema.sql is available in your project directory.", "warning");
  });
}

function showNotice(text) {
  showToast(text);
}

function openEntryModal() {
  const modal = document.getElementById("entryModalOverlay");
  if (!modal) return;
  modal.classList.add("open");
  const current = getCurrent();
  if (current) {
    const nameInput = document.getElementById("manualName");
    const idInput = document.getElementById("manualId");
    if (nameInput && !nameInput.value) nameInput.value = current.characterName;
    if (idInput && !idInput.value) idInput.value = current.characterId;
  }
}

function closeEntryModal() {
  const modal = document.getElementById("entryModalOverlay");
  if (modal) modal.classList.remove("open");
}

async function handleManualEntrySubmit(e) {
  e.preventDefault();
  const name = document.getElementById("manualName")?.value.trim() || "JanitorAI Character";
  let id = document.getElementById("manualId")?.value.trim();
  if (!id) {
    id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || `char-${Date.now()}`;
  }

  const msgs = Number(document.getElementById("manualMsgs")?.value) || 0;
  const chats = Number(document.getElementById("manualChats")?.value) || 0;
  const comments = Number(document.getElementById("manualComments")?.value) || 0;
  const favourites = Number(document.getElementById("manualFavourites")?.value) || 0;
  const pubVal = document.getElementById("manualPublishedChats")?.value;
  const publishedChats = pubVal ? Number(pubVal) : null;

  const character = {
    characterId: id,
    characterName: name,
    url: `https://janitorai.com/characters/${id}`,
    createdAt: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
    updatedAt: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
    publishedAt: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
    publishedChats
  };

  const snapshot = {
    timestamp: new Date().toISOString(),
    characterId: id,
    msgs,
    msgsDisplay: formatCompact(msgs),
    chats,
    chatsDisplay: formatCompact(chats),
    comments,
    commentsDisplay: formatCompact(comments),
    favourites,
    favouritesDisplay: formatCompact(favourites),
    publishedChats,
    publishedChatsDisplay: publishedChats != null ? formatCompact(publishedChats) : null
  };

  await saveCharacterSnapshot(character, snapshot);
  await storage.set({ activeCharacterId: id });
  closeEntryModal();
  await load();
  showToast(`Successfully recorded snapshot for ${name}!`, "success");
  showNotice(`Successfully recorded snapshot for ${name}!`);
}

async function processCsvFile(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".csv") && file.type && !file.type.includes("csv") && !file.type.includes("text")) {
    showToast("Please select or drop a valid .csv file.", "warning");
    return;
  }

  try {
    const text = await file.text();
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) {
      showToast("CSV file does not contain enough data rows.", "warning");
      return;
    }

    const parseCsvLine = (line) => {
      const regex = /(?:,|\n|^)("(?:(?:"")*[^"]*)*"|[^",\n]*|(?:\n|$))/g;
      const record = [];
      let match;
      while ((match = regex.exec(line)) !== null) {
        let field = match[1];
        if (field.startsWith('"') && field.endsWith('"')) {
          field = field.slice(1, -1).replace(/""/g, '"');
        }
        record.push(field);
        if (regex.lastIndex >= line.length) break;
      }
      return record;
    };

    const header = parseCsvLine(lines[0]).map(h => h.toLowerCase().trim());
    const charName = file.name.replace(/-stats\.csv$/i, "").replace(/[_-]/g, " ") || "Imported Character";
    const charId = "imported-" + charName.toLowerCase().replace(/[^a-z0-9]+/g, "-");

    let importedCount = 0;
    let charMetadata = {
      characterId: charId,
      characterName: charName,
      url: "",
      createdAt: null,
      updatedAt: null,
      publishedAt: null
    };

    for (let i = 1; i < lines.length; i++) {
      const cols = parseCsvLine(lines[i]);
      if (cols.length < 5) continue;
      const row = {};
      header.forEach((h, idx) => { row[h] = cols[idx]; });

      const timestamp = row.timestamp || new Date(Date.now() - (lines.length - i) * 3600000).toISOString();
      const msgs = Number(row.messages || row.msgs);
      const chats = Number(row.chats);
      const comments = Number(row.comments);
      const favourites = Number(row.favourites || row.favorites);
      const publishedChats = row.publishedchats ? Number(row.publishedchats) : null;

      if (row.createdat && !charMetadata.createdAt) charMetadata.createdAt = row.createdat;
      if (row.updatedat) charMetadata.updatedAt = row.updatedat;
      if (row.publishedat && !charMetadata.publishedAt) charMetadata.publishedAt = row.publishedat;

      if (![msgs, chats, comments, favourites].every(Number.isFinite)) continue;

      const snapshot = {
        timestamp,
        characterId: charId,
        msgs,
        msgsDisplay: formatCompact(msgs),
        chats,
        chatsDisplay: formatCompact(chats),
        comments,
        commentsDisplay: formatCompact(comments),
        favourites,
        favouritesDisplay: formatCompact(favourites),
        publishedChats,
        publishedChatsDisplay: publishedChats != null ? formatCompact(publishedChats) : null
      };

      await saveCharacterSnapshot(charMetadata, snapshot);
      importedCount++;
    }

    if (importedCount === 0) {
      showToast("No valid snapshot rows could be parsed from this CSV.", "warning");
      return;
    }

    closeEntryModal();
    await storage.set({ activeCharacterId: charId });
    await load();
    showToast(`Successfully imported ${importedCount} snapshots for "${charName}".`, "success");
    showNotice(`Successfully imported ${importedCount} snapshots for "${charName}".`);
  } catch (err) {
    console.error(err);
    showToast("Failed to parse CSV file: " + err.message, "error");
  }
}

async function handleCsvUpload(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  await processCsvFile(file);
  e.target.value = "";
}

function setupDragAndDrop() {
  const dropzone = document.getElementById("csvDropzone");
  const modal = document.getElementById("entryModalOverlay");
  const fileInput = document.getElementById("csvFileInput");

  if (dropzone && fileInput) {
    dropzone.addEventListener("click", () => fileInput.click());
    dropzone.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        fileInput.click();
      }
    });
  }

  const preventDefaults = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const setDragActive = (active) => {
    if (dropzone) {
      if (active) {
        dropzone.classList.add("drag-active");
      } else {
        dropzone.classList.remove("drag-active");
      }
    }
  };

  [modal, dropzone].forEach(el => {
    if (!el) return;
    ["dragenter", "dragover"].forEach(eventName => {
      el.addEventListener(eventName, (e) => {
        preventDefaults(e);
        setDragActive(true);
      });
    });

    ["dragleave", "dragend"].forEach(eventName => {
      el.addEventListener(eventName, (e) => {
        preventDefaults(e);
        if (!el.contains(e.relatedTarget)) {
          setDragActive(false);
        }
      });
    });

    el.addEventListener("drop", async (e) => {
      preventDefaults(e);
      setDragActive(false);
      const droppedFiles = e.dataTransfer?.files;
      if (droppedFiles && droppedFiles.length > 0) {
        const file = droppedFiles[0];
        await processCsvFile(file);
      }
    });
  });
}

function showToast(message, type = "info") {
  let container = document.getElementById("toastContainer");
  if (!container) {
    container = document.createElement("div");
    container.id = "toastContainer";
    container.className = "toast-container";
    document.body.appendChild(container);
  }

  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;

  const iconMap = {
    info: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>`,
    success: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>`,
    warning: `<svg viewBox="0 0 24 24"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4M12 17h.01"/></svg>`,
    error: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/></svg>`
  };

  toast.innerHTML = `
    <div class="toast-icon">${iconMap[type] || iconMap.info}</div>
    <div class="toast-message">${escapeHtml(message)}</div>
    <button type="button" class="toast-close" aria-label="Close notification">&times;</button>
  `;

  const removeToast = () => {
    toast.classList.add("toast-leaving");
    setTimeout(() => {
      toast.remove();
    }, 220);
  };

  toast.querySelector(".toast-close").addEventListener("click", removeToast);
  container.appendChild(toast);

  requestAnimationFrame(() => {
    toast.classList.add("toast-visible");
  });

  setTimeout(removeToast, 4200);
}

function openConfirmModal({ title, message, confirmText, onConfirm }) {
  const overlay = document.getElementById("confirmModalOverlay");
  const titleEl = document.getElementById("confirmModalTitle");
  const descEl = document.getElementById("confirmModalDesc");
  const proceedBtn = document.getElementById("proceedConfirmBtn");
  const cancelBtn = document.getElementById("cancelConfirmBtn");

  if (!overlay) return;

  if (titleEl && title) titleEl.textContent = title;
  if (descEl && message) descEl.innerHTML = message;
  if (proceedBtn && confirmText) proceedBtn.textContent = confirmText;

  const close = () => {
    overlay.classList.remove("open");
  };

  const newProceedBtn = proceedBtn.cloneNode(true);
  proceedBtn.parentNode.replaceChild(newProceedBtn, proceedBtn);

  newProceedBtn.addEventListener("click", async () => {
    close();
    if (onConfirm) await onConfirm();
  });

  cancelBtn.onclick = close;
  overlay.onclick = (e) => {
    if (e.target === overlay) close();
  };

  overlay.classList.add("open");
}

function setupTooltips() {
  let tooltipEl = document.getElementById("appTooltip");
  if (!tooltipEl) {
    tooltipEl = document.createElement("div");
    tooltipEl.id = "appTooltip";
    tooltipEl.className = "app-tooltip";
    document.body.appendChild(tooltipEl);
  }

  const showTooltip = (el) => {
    const text = el.getAttribute("data-tooltip");
    if (!text) return;

    tooltipEl.textContent = text;
    tooltipEl.classList.add("visible");

    const rect = el.getBoundingClientRect();
    const tooltipRect = tooltipEl.getBoundingClientRect();

    let top = rect.top - tooltipRect.height - 8;
    let left = rect.left + (rect.width / 2) - (tooltipRect.width / 2);

    if (top < 8) {
      top = rect.bottom + 8;
    }

    const pad = 12;
    if (left < pad) left = pad;
    if (left + tooltipRect.width > window.innerWidth - pad) {
      left = window.innerWidth - pad - tooltipRect.width;
    }

    tooltipEl.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
  };

  const hideTooltip = () => {
    tooltipEl.classList.remove("visible");
  };

  document.body.addEventListener("pointerover", (e) => {
    const target = e.target.closest("[data-tooltip]");
    if (target) showTooltip(target);
  });

  document.body.addEventListener("pointerout", (e) => {
    const target = e.target.closest("[data-tooltip]");
    if (target) hideTooltip();
  });

  document.body.addEventListener("focusin", (e) => {
    const target = e.target.closest("[data-tooltip]");
    if (target) showTooltip(target);
  });

  document.body.addEventListener("focusout", (e) => {
    const target = e.target.closest("[data-tooltip]");
    if (target) hideTooltip();
  });

  window.addEventListener("scroll", hideTooltip, { passive: true });
}

async function loadSampleData() {
  const sampleCharacter = {
    characterId: "lyra-archivist-demo",
    characterName: "Lyra // Cyberpunk Archivist",
    url: "https://janitorai.com/characters/lyra-archivist-demo",
    createdAt: "Nov 12, 2023",
    updatedAt: "Jan 18, 2024",
    publishedAt: "Nov 14, 2023",
    publishedChats: 4820
  };

  // Generate 72 data points over the last 3 days
  const now = Date.now();
  const stepMs = 60 * 60 * 1000; // hourly
  let msgs = 84200;
  let chats = 3210;
  let comments = 485;
  let favourites = 1240;
  let pubChats = 3400;

  for (let i = 72; i >= 0; i--) {
    const pointTime = new Date(now - i * stepMs).toISOString();
    msgs += Math.floor(Math.random() * 45) + 15;
    chats += Math.floor(Math.random() * 3) + (Math.random() > 0.4 ? 1 : 0);
    if (Math.random() > 0.6) comments += 1;
    if (Math.random() > 0.3) favourites += Math.floor(Math.random() * 2) + 1;
    if (Math.random() > 0.5) pubChats += Math.floor(Math.random() * 2);

    const snapshot = {
      timestamp: pointTime,
      characterId: sampleCharacter.characterId,
      msgs,
      msgsDisplay: formatCompact(msgs),
      chats,
      chatsDisplay: formatCompact(chats),
      comments,
      commentsDisplay: formatCompact(comments),
      favourites,
      favouritesDisplay: formatCompact(favourites),
      publishedChats: pubChats,
      publishedChatsDisplay: formatCompact(pubChats)
    };

    await saveCharacterSnapshot(sampleCharacter, snapshot);
  }

  await storage.set({ activeCharacterId: sampleCharacter.characterId });
  await load();
  showNotice("Loaded sample character data: Lyra // Cyberpunk Archivist (72 hourly snapshots).");
}

function setupScrollAnimations() {
  const elements = document.querySelectorAll(".reveal-on-scroll");
  if (!elements.length) return;

  if (!("IntersectionObserver" in window)) {
    elements.forEach(el => el.classList.add("is-revealed"));
    return;
  }

  const observer = new IntersectionObserver((entries, obs) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-revealed");
        obs.unobserve(entry.target);
      }
    });
  }, {
    threshold: 0.08,
    rootMargin: "0px 0px -40px 0px"
  });

  elements.forEach(el => observer.observe(el));
}

setupEventListeners();
setupScrollAnimations();

let refreshTimer = null;
async function refreshLoop() {
  await load();
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshLoop, 15000);
}

refreshLoop().catch(error => {
  console.error(error);
  showNotice("Could not open local tracker data.");
});

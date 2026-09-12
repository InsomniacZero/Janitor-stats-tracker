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

  const path = chartPath(sampled, x, y);
  const dots = valid.map(point => {
    const cx = x(sampled.indexOf(point));
    const cy = y(point.value);
    const tooltip = pointTooltip(title, point);
    return `<circle tabindex="0" class="chart-point" cx="${cx}" cy="${cy}" r="3.2" fill="${color}" data-x="${cx}" data-y="${cy}" data-tooltip="${escapeHtml(tooltip)}"></circle>`;
  }).join("");

  const firstLabel = new Date(sampled[0].timestamp).toLocaleString([], { month: "short", day: "numeric" });
  const lastLabel = new Date(sampled.at(-1).timestamp).toLocaleString([], { month: "short", day: "numeric" });

  return `<svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)} graph">${grid}<path class="chart-line" d="${path}" stroke="${color}"/>${dots}<text class="axis-label" x="${pad.left}" y="${height - 12}">${escapeHtml(firstLabel)}</text><text class="axis-label" x="${width - pad.right}" y="${height - 12}" text-anchor="end">${escapeHtml(lastLabel)}</text></svg><div class="chart-tooltip" role="status"></div>`;
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

  let svg = [0, .25, .5, .75, 1].map(t => {
    const yy = pad.top + t * innerH;
    const value = yMax - t * (yMax - yMin);
    return `<line class="gridline" x1="${pad.left}" y1="${yy}" x2="${width - pad.right}" y2="${yy}"/><text class="axis-label" x="${pad.left - 10}" y="${yy + 4}" text-anchor="end">${Math.round(value)}</text>`;
  }).join("");

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
    svg += `<path class="chart-line" d="${path.trim()}" stroke="${seriesInfo.color}"/>`;
    valid.forEach(point => {
      const sampleIndex = sampled.findIndex(p => p.originalIndex === point.originalIndex);
      const cx = x(sampleIndex);
      const cy = y(point.value);
      const tooltip = makeTooltipMarkup({ label: seriesInfo.label, point: { ...point, value: point.actual } });
      svg += `<circle tabindex="0" class="chart-point" cx="${cx}" cy="${cy}" r="3" fill="${seriesInfo.color}" data-x="${cx}" data-y="${cy}" data-tooltip="${escapeHtml(tooltip)}"></circle>`;
    });
  });

  return `<svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Combined trend graph">${svg}</svg><div class="chart-tooltip" role="status"></div>`;
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
    return `<article class="stat-card"><div class="stat-label">${escapeHtml(seriesInfo.label)}</div><div class="stat-value">${formatCompact(value)}</div><div class="stat-change ${cls}">${escapeHtml(growth)}</div><div class="stat-secondary">Rate: ${escapeHtml(formatRate(stats?.perHour))}</div></article>`;
  }).join("");
}

function renderInsights() {
  const windowSnapshots = getWindowSnapshots();
  const latest = windowSnapshots.at(-1) || state.snapshots.at(-1);
  const container = document.getElementById("insights");
  if (!container) return;

  const pairs = [
    ["Messages / chat", ratio(latest?.msgs, latest?.chats), "messages per chat"],
    ["Chats / 1k messages", Number.isFinite(latest?.chats) && Number.isFinite(latest?.msgs) && latest.msgs > 0 ? latest.chats / latest.msgs * 1000 : null, "chats per 1,000 messages"],
    ["Comments / 1k chats", Number.isFinite(latest?.comments) && Number.isFinite(latest?.chats) && latest.chats > 0 ? latest.comments / latest.chats * 1000 : null, "comments per 1,000 chats"],
    ["Favourites / 1k chats", Number.isFinite(latest?.favourites) && Number.isFinite(latest?.chats) && latest.chats > 0 ? latest.favourites / latest.chats * 1000 : null, "favourites per 1,000 chats"],
    ["Favourites / 1k messages", Number.isFinite(latest?.favourites) && Number.isFinite(latest?.msgs) && latest.msgs > 0 ? latest.favourites / latest.msgs * 1000 : null, "favourites per 1,000 messages"],
    ["Comments / 1k messages", Number.isFinite(latest?.comments) && Number.isFinite(latest?.msgs) && latest.msgs > 0 ? latest.comments / latest.msgs * 1000 : null, "comments per 1,000 messages"]
  ];

  const duration = getWindowStats(windowSnapshots, "msgs")?.durationMs ?? 0;
  const growthStats = TRACKED_SERIES.slice(0, 5).map(seriesInfo => {
    const stats = getWindowStats(windowSnapshots, seriesInfo.key);
    return `<div class="insight-mini"><div class="insight-mini-label">${escapeHtml(seriesInfo.short)} growth</div><div class="insight-mini-value">${stats ? `${stats.delta >= 0 ? "+" : ""}${formatNumber(stats.delta)}` : "—"}</div><div class="insight-mini-sub">${stats?.percent == null ? "Percent unavailable" : `${stats.percent >= 0 ? "+" : ""}${stats.percent.toFixed(2)}% over ${formatDuration(stats.durationMs)}`}</div></div>`;
  }).join("");

  const ratioHtml = pairs.map(([label, value, sub]) => `<div class="insight-mini"><div class="insight-mini-label">${escapeHtml(label)}</div><div class="insight-mini-value">${value == null ? "—" : escapeHtml(formatCompact(value))}</div><div class="insight-mini-sub">${escapeHtml(sub)}</div></div>`).join("");
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
  const footerEl = document.getElementById("footer");

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
    if (footerEl) footerEl.textContent = "";

    document.getElementById("emptyDemoBtn")?.addEventListener("click", loadSampleData);
    document.getElementById("emptyAddBtn")?.addEventListener("click", openEntryModal);
    document.getElementById("emptyImportBtn")?.addEventListener("click", () => document.getElementById("csvFileInput")?.click());
    return;
  }

  const lastSeen = character.lastSeen ? new Date(character.lastSeen).toLocaleString() : "never";
  if (titleEl) titleEl.textContent = character.characterName || "JanitorAI character";
  if (subtitleEl) subtitleEl.textContent = `Last collected ${lastSeen}`;
  renderMeta(character);
  renderCards();
  renderInsights();
  renderCharts();
  if (footerEl) {
    footerEl.textContent = `Data is saved securely in your browser's IndexedDB. Graphs automatically filter out transient hydration glitches while preserving all raw samples.`;
  }
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

async function load() {
  state.characters = (await getAllCharacters()).sort((a, b) => (b.lastSeen || "").localeCompare(a.lastSeen || ""));
  const settings = await storage.get({ activeCharacterId: null });
  state.activeCharacterId = state.characters.some(c => c.characterId === settings.activeCharacterId)
    ? settings.activeCharacterId
    : state.characters[0]?.characterId || null;
  populateCharacterSelect();
  const character = getCurrent();
  state.snapshots = character ? await getSnapshots(character.characterId) : [];
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

  document.getElementById("clearBtn")?.addEventListener("click", async () => {
    const character = getCurrent();
    if (!character) return;
    if (!confirm(`Delete all stored history for ${character.characterName}?`)) return;
    await deleteCharacter(character.characterId);
    const remaining = (await getAllCharacters()).sort((a, b) => (b.lastSeen || "").localeCompare(a.lastSeen || ""));
    await storage.set({ activeCharacterId: remaining[0]?.characterId || null });
    await load();
    showNotice(`Deleted character ${character.characterName}.`);
  });

  document.getElementById("exportBtn")?.addEventListener("click", async () => {
    const character = getCurrent();
    if (!character || !state.snapshots.length) {
      alert("No data available to export.");
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
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  const importBtn = document.getElementById("importBtn");
  const fileInput = document.getElementById("csvFileInput");
  if (importBtn && fileInput) {
    importBtn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", handleCsvUpload);
  }

  // Modal event listeners
  document.getElementById("closeModalBtn")?.addEventListener("click", closeEntryModal);
  document.getElementById("cancelModalBtn")?.addEventListener("click", closeEntryModal);
  document.getElementById("entryModalOverlay")?.addEventListener("click", (e) => {
    if (e.target.id === "entryModalOverlay") closeEntryModal();
  });
  document.getElementById("entryForm")?.addEventListener("submit", handleManualEntrySubmit);
}

function showNotice(text) {
  const notice = document.getElementById("notice");
  if (!notice) return;
  notice.textContent = text;
  notice.style.display = "block";
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
  showNotice(`Successfully recorded snapshot for ${name}!`);
}

async function handleCsvUpload(e) {
  const file = e.target.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (event) => {
    try {
      const text = event.target.result;
      const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      if (lines.length < 2) {
        alert("CSV file does not contain enough data.");
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

      await storage.set({ activeCharacterId: charId });
      await load();
      showNotice(`Successfully imported ${importedCount} snapshots for "${charName}".`);
    } catch (err) {
      console.error(err);
      alert("Failed to parse CSV file: " + err.message);
    } finally {
      e.target.value = "";
    }
  };
  reader.readAsText(file);
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

setupEventListeners();

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

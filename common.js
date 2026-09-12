const STAT_CONFIG = {
  msgs: { label: "Messages", short: "Msgs", color: "#d97757" },
  chats: { label: "Chats", short: "Chats", color: "#81B29A" },
  comments: { label: "Comments", short: "Comments", color: "#e0a458" },
  favourites: { label: "Favourites", short: "Faves", color: "#d97373" },
  publishedChats: { label: "Published chats", short: "Pub. chats", color: "#6a9bcc" }
};

const TRACKED_SERIES = Object.entries(STAT_CONFIG).map(([key, value]) => ({ key, ...value }));

const RANGE_CONFIG = {
  "1h": { label: "1h", ms: 60 * 60 * 1000 },
  "6h": { label: "6h", ms: 6 * 60 * 60 * 1000 },
  "24h": { label: "24h", ms: 24 * 60 * 60 * 1000 },
  "7d": { label: "7d", ms: 7 * 24 * 60 * 60 * 1000 },
  "30d": { label: "30d", ms: 30 * 24 * 60 * 60 * 1000 },
  all: { label: "All", ms: null }
};

function formatNumber(value) {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  return Number(value).toLocaleString();
}

function formatCompact(value) {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  const n = Number(value);
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(abs >= 1e10 ? 0 : 1)}b`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}m`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}k`;
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function relativeChange(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;"
  }[c]));
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const minutes = ms / 60000;
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours.toFixed(hours >= 10 ? 0 : 1)}h`;
  const days = hours / 24;
  if (days < 14) return `${days.toFixed(days >= 10 ? 0 : 1)}d`;
  const weeks = days / 7;
  return `${weeks.toFixed(weeks >= 10 ? 0 : 1)}w`;
}

function formatRate(valuePerHour, unit = "") {
  if (!Number.isFinite(valuePerHour)) return "—";
  const suffix = unit ? ` ${unit}` : "";
  return `${formatCompact(valuePerHour)}${suffix}/h`;
}

function filterSnapshotsByRange(snapshots, rangeId) {
  if (!snapshots.length || !RANGE_CONFIG[rangeId]) return [];
  if (rangeId === "all") return snapshots;
  const latestMs = new Date(snapshots.at(-1).timestamp).getTime();
  if (!Number.isFinite(latestMs)) return snapshots;
  const cutoff = latestMs - RANGE_CONFIG[rangeId].ms;
  return snapshots.filter(s => new Date(s.timestamp).getTime() >= cutoff);
}

function getWindowStats(snapshots, key) {
  const valid = snapshots.filter(s => Number.isFinite(s[key]));
  if (!valid.length) return null;
  const first = valid[0];
  const last = valid.at(-1);
  const firstTime = new Date(first.timestamp).getTime();
  const lastTime = new Date(last.timestamp).getTime();
  const durationMs = Math.max(0, lastTime - firstTime);
  const delta = last[key] - first[key];
  const percent = first[key] > 0 ? (delta / first[key]) * 100 : null;
  const perHour = durationMs > 0 ? delta / (durationMs / 3600000) : null;
  return { first, last, durationMs, delta, percent, perHour };
}

function ratio(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return null;
  return a / b;
}

function sanitizeTransientZeroes(points, maxGapMs = 6 * 60 * 1000) {
  return points.map((p, i, arr) => {
    if (p.value !== 0 || i === 0 || i === arr.length - 1) return p;
    const prev = arr[i - 1];
    const next = arr[i + 1];
    if (!Number.isFinite(prev.value) || !Number.isFinite(next.value) || prev.value <= 0 || next.value <= 0) return p;
    const t0 = new Date(prev.timestamp).getTime();
    const t1 = new Date(p.timestamp).getTime();
    const t2 = new Date(next.timestamp).getTime();
    if (![t0, t1, t2].every(Number.isFinite)) return p;
    if ((t2 - t0) <= maxGapMs && (t1 - t0) > 0 && (t2 - t1) > 0) {
      return { ...p, value: NaN, transientZero: true };
    }
    return p;
  });
}

function downsample(points, maxPoints = 800) {
  if (points.length <= maxPoints) return points.map((point, index) => ({ ...point, originalIndex: point.originalIndex ?? index }));
  const result = [];
  const stride = (points.length - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints; i++) {
    const sourceIndex = Math.round(i * stride);
    const point = points[sourceIndex];
    result.push({ ...point, originalIndex: point.originalIndex ?? sourceIndex });
  }
  return result;
}

function enrichPoints(snapshots, key) {
  return snapshots.map((snapshot, index) => {
    const previous = index > 0 ? snapshots[index - 1] : null;
    const value = Number.isFinite(snapshot[key]) ? snapshot[key] : NaN;
    const previousValue = previous && Number.isFinite(previous[key]) ? previous[key] : null;
    const delta = previousValue == null || !Number.isFinite(value) ? null : value - previousValue;
    const percent = previousValue == null || previousValue === 0 || !Number.isFinite(value)
      ? null
      : (delta / previousValue) * 100;
    const time = new Date(snapshot.timestamp).getTime();
    const previousTime = previous ? new Date(previous.timestamp).getTime() : null;
    return {
      timestamp: snapshot.timestamp,
      value,
      delta,
      percent,
      elapsedMs: Number.isFinite(time) && Number.isFinite(previousTime) ? Math.max(0, time - previousTime) : null,
      originalIndex: index
    };
  });
}

function makeTooltipMarkup({ label, point, suffix = "" }) {
  const lines = [
    `<strong>${escapeHtml(label)}</strong>`,
    `${escapeHtml(new Date(point.timestamp).toLocaleString())}`,
    `<b>${escapeHtml(formatNumber(point.value))}${escapeHtml(suffix)}</b>`
  ];
  if (point.delta != null) {
    const sign = point.delta >= 0 ? "+" : "";
    const pct = point.percent == null ? "" : ` (${point.percent >= 0 ? "+" : ""}${point.percent.toFixed(2)}%)`;
    lines.push(`Δ ${sign}${escapeHtml(formatNumber(point.delta))}${pct}`);
  }
  if (point.elapsedMs != null) lines.push(`Since prior sample: ${escapeHtml(formatDuration(point.elapsedMs))}`);
  return lines.join("<br>");
}

function bindChartTooltips(root = document) {
  root.querySelectorAll(".chart-wrap").forEach(wrap => {
    const tooltip = wrap.querySelector(".chart-tooltip");
    const svg = wrap.querySelector(".chart-svg");
    if (!tooltip || !svg) return;

    const hide = () => tooltip.classList.remove("visible");
    wrap.addEventListener("mouseleave", hide);

    svg.querySelectorAll(".chart-point[data-tooltip]").forEach(point => {
      const show = () => {
        const rect = svg.getBoundingClientRect();
        const vb = svg.viewBox.baseVal;
        const px = Number(point.dataset.x) * rect.width / vb.width;
        const py = Number(point.dataset.y) * rect.height / vb.height;
        tooltip.innerHTML = point.dataset.tooltip;
        tooltip.classList.add("visible");
        const tooltipRect = tooltip.getBoundingClientRect();
        let left = px + 12;
        let top = py - tooltipRect.height - 12;
        if (left + tooltipRect.width > wrap.clientWidth - 6) left = px - tooltipRect.width - 12;
        if (top < 6) top = py + 12;
        tooltip.style.left = `${Math.max(6, left)}px`;
        tooltip.style.top = `${Math.max(6, top)}px`;
      };
      point.addEventListener("mouseenter", show);
      point.addEventListener("focus", show);
      point.addEventListener("mouseleave", hide);
      point.addEventListener("blur", hide);
    });
  });
}

export {
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
};

if (typeof globalThis !== "undefined") {
  Object.assign(globalThis, {
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
  });
}


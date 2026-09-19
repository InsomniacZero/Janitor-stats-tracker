const STAT_CONFIG = {
  chats: { label: "Chats", short: "Chats", color: "#81B29A" },
  msgs: { label: "Messages", short: "Msgs", color: "#d97757" },
  chatMsgRatio: { label: "Message / Chat Ratio", short: "Msgs/Chat", color: "#c4a7e7", isRatio: true, unit: "" },
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
  const valid = snapshots.map(s => {
    let val = s[key];
    if ((val == null || !Number.isFinite(val)) && key === "chatMsgRatio") {
      const c = Number(s.chats);
      const m = Number(s.msgs);
      if (Number.isFinite(c) && c > 0 && Number.isFinite(m) && m >= 0) {
        val = Number((m / c).toFixed(3));
      }
    }
    return { ...s, [key]: val };
  }).filter(s => Number.isFinite(s[key]));

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
    let value = Number.isFinite(snapshot[key]) ? snapshot[key] : NaN;
    if (!Number.isFinite(value) && key === "chatMsgRatio") {
      const c = Number(snapshot.chats);
      const m = Number(snapshot.msgs);
      if (Number.isFinite(c) && c > 0 && Number.isFinite(m) && m >= 0) {
        value = Number((m / c).toFixed(3));
      }
    }

    let previousValue = previous && Number.isFinite(previous[key]) ? previous[key] : null;
    if ((previousValue == null || !Number.isFinite(previousValue)) && previous && key === "chatMsgRatio") {
      const pc = Number(previous.chats);
      const pm = Number(previous.msgs);
      if (Number.isFinite(pc) && pc > 0 && Number.isFinite(pm) && pm >= 0) {
        previousValue = Number((pm / pc).toFixed(3));
      }
    }

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

/**
 * Calculates a clean, human-friendly Y axis scale with proper increments.
 * For ratio metrics (or published chats), ensures baseline starts at 0 and goes to ~20.
 * For other metrics, calculates nice rounded steps starting at 0 to avoid misleading baseline truncations.
 */
function getNiceYScale(title, minVal, maxVal) {
  const isRatio = typeof title === "string" && title.toLowerCase().includes("ratio");
  const isPub = typeof title === "string" && title.toLowerCase().includes("published");

  if (isRatio || isPub) {
    const yMin = 0;
    const yMax = maxVal <= 20 ? 20 : Math.ceil(maxVal / 5) * 5;
    const step = (yMax - yMin) / 4; // 5 clean ticks: 0, 5, 10, 15, 20
    const ticks = [];
    for (let v = yMin; v <= yMax + 0.001; v += step) {
      ticks.push(Math.round(v));
    }
    return { yMin, yMax, step, ticks };
  }

  // General nice scale starting at 0 for non-negative cumulative stats
  const yMin = 0;
  let max = Math.max(1, maxVal);
  max = max * 1.06; // 6% headroom
  const targetTicks = 5;
  const rawStep = max / (targetTicks - 1);
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const frac = rawStep / mag;
  let niceFrac;
  if (frac <= 1.2) niceFrac = 1;
  else if (frac <= 2.5) niceFrac = 2;
  else if (frac <= 6) niceFrac = 5;
  else niceFrac = 10;
  const step = niceFrac * mag;
  const yMax = Math.ceil(max / step) * step;

  const ticks = [];
  for (let v = 0; v <= yMax + step * 0.01; v += step) {
    ticks.push(v);
  }
  return { yMin, yMax, step, ticks };
}

/**
 * Builds time-linear SVG paths with tracking gap detection.
 * When tracking was offline (e.g. gap > maxGapMs), breaks the solid line
 * and inserts a subtle dashed bridge, preventing misleading steep cliffs.
 */
function buildTimePaths(validPoints, xForTime, yForValue, pad, innerH, maxGapMs = 35 * 60 * 1000) {
  if (!validPoints || !validPoints.length) {
    return { solidPaths: [], gapLines: [], areaPaths: [] };
  }

  const segments = [];
  const gapLines = [];
  let currentSegment = [validPoints[0]];

  for (let i = 1; i < validPoints.length; i++) {
    const prev = validPoints[i - 1];
    const curr = validPoints[i];
    const tPrev = new Date(prev.timestamp).getTime();
    const tCurr = new Date(curr.timestamp).getTime();
    const diff = tCurr - tPrev;

    if (diff > maxGapMs) {
      segments.push(currentSegment);
      currentSegment = [curr];

      const x1 = xForTime(tPrev);
      const y1 = yForValue(prev.value);
      const x2 = xForTime(tCurr);
      const y2 = yForValue(curr.value);
      gapLines.push({ x1, y1, x2, y2, gapMinutes: Math.round(diff / 60000) });
    } else {
      currentSegment.push(curr);
    }
  }

  if (currentSegment.length) {
    segments.push(currentSegment);
  }

  const baselineY = pad.top + innerH;
  const solidPaths = [];
  const areaPaths = [];

  for (const seg of segments) {
    if (seg.length === 0) continue;
    let pathD = "";
    seg.forEach((p, idx) => {
      const px = xForTime(new Date(p.timestamp).getTime());
      const py = yForValue(p.value);
      pathD += `${idx === 0 ? "M" : "L"}${px.toFixed(2)} ${py.toFixed(2)} `;
    });

    // If single point segment, render tiny tick so it remains visible
    if (seg.length === 1) {
      const px = xForTime(new Date(seg[0].timestamp).getTime());
      const py = yForValue(seg[0].value);
      pathD = `M${(px - 0.5).toFixed(2)} ${py.toFixed(2)} L${(px + 0.5).toFixed(2)} ${py.toFixed(2)}`;
    }

    solidPaths.push(pathD.trim());

    if (seg.length > 1) {
      const firstX = xForTime(new Date(seg[0].timestamp).getTime());
      const lastX = xForTime(new Date(seg.at(-1).timestamp).getTime());
      const areaD = `${pathD.trim()} L${lastX.toFixed(2)} ${baselineY.toFixed(2)} L${firstX.toFixed(2)} ${baselineY.toFixed(2)} Z`;
      areaPaths.push(areaD);
    }
  }

  return { solidPaths, gapLines, areaPaths };
}

/**
 * Builds SVG elements for hourly marks strictly on the time axis:
 * 1. Hourly ticks are mathematically guaranteed to be the exact same length apart in pixels.
 * 2. Vertical guidelines & edge "+" ticks span across the entire window uniformly.
 * 3. Line dots are only placed when real tracking data exists near that hour (omitted during gaps).
 */
function buildHourlyMarkers(options) {
  const {
    tStart: optTStart,
    tEnd: optTEnd,
    sampled,
    valid,
    pad,
    width,
    height,
    xForTime: optXForTime,
    yForValue: optYForValue,
    x: legacyX,
    y: legacyY,
    color,
    validPoints = valid || sampled || [],
    maxGapMs = 35 * 60 * 1000
  } = options;

  const pts = validPoints.filter(p => p && p.timestamp);
  if (!pts.length) return { hourDots: "", edgeMarks: "", hourLines: "" };

  const tStart = optTStart || new Date(pts[0].timestamp).getTime();
  const tEnd = optTEnd || new Date(pts.at(-1).timestamp).getTime();
  const durationMs = tEnd - tStart;
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return { hourDots: "", edgeMarks: "", hourLines: "" };
  }

  const innerW = width - pad.left - pad.right;
  const bottomY = height - pad.bottom;
  const topY = pad.top;

  const xForTime = optXForTime || (t => pad.left + Math.max(0, Math.min(1, (t - tStart) / durationMs)) * innerW);
  const yForValue = optYForValue || legacyY;

  // Determine appropriate hourly step based on window duration
  let stepMs = 3600 * 1000; // 1 hour default
  if (durationMs <= 2.5 * 3600 * 1000) {
    stepMs = 30 * 60 * 1000; // 30 minutes for tight windows (<2.5h)
  } else if (durationMs > 14 * 3600 * 1000 && durationMs <= 36 * 3600 * 1000) {
    stepMs = 2 * 3600 * 1000; // 2 hours for 24h window
  } else if (durationMs > 36 * 3600 * 1000 && durationMs <= 5 * 24 * 3600 * 1000) {
    stepMs = 6 * 3600 * 1000; // 6 hours
  } else if (durationMs > 5 * 24 * 3600 * 1000 && durationMs <= 14 * 24 * 3600 * 1000) {
    stepMs = 12 * 3600 * 1000; // 12 hours for 7d window
  } else if (durationMs > 14 * 24 * 3600 * 1000) {
    stepMs = 24 * 3600 * 1000; // 24 hours for 30d window
  }

  const firstBoundary = Math.ceil(tStart / stepMs) * stepMs;
  let hourDots = "";
  let edgeMarks = "";
  let hourLines = "";

  for (let t = firstBoundary; t <= tEnd; t += stepMs) {
    // Exact same length apart in pixels: strictly proportional to time t
    const cx = xForTime(t);
    if (cx < pad.left - 0.5 || cx > width - pad.right + 0.5) continue;

    // 1. Subtle vertical guideline across the chart at uniform hourly intervals
    hourLines += `<line class="chart-hour-guideline" x1="${cx.toFixed(2)}" y1="${topY}" x2="${cx.toFixed(2)}" y2="${bottomY}" />`;

    // 2. "+" Edge mark on bottom axis
    edgeMarks += `
      <g class="chart-hour-edge-plus" transform="translate(${cx.toFixed(2)}, ${bottomY})">
        <line x1="-3.5" y1="0" x2="3.5" y2="0" class="chart-edge-plus-line" />
        <line x1="0" y1="-3.5" x2="0" y2="3.5" class="chart-edge-plus-line" />
      </g>
    `;

    // 3. "+" Edge mark on top axis
    edgeMarks += `
      <g class="chart-hour-edge-plus" transform="translate(${cx.toFixed(2)}, ${topY})">
        <line x1="-3" y1="0" x2="3" y2="0" class="chart-edge-plus-line" />
        <line x1="0" y1="-3" x2="0" y2="3" class="chart-edge-plus-line" />
      </g>
    `;

    // 4. Hourly label below bottom axis
    if (cx >= pad.left + 24 && cx <= width - pad.right - 24) {
      const d = new Date(t);
      const labelStr = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
      edgeMarks += `<text class="axis-label chart-hour-label" x="${cx.toFixed(2)}" y="${bottomY + 16}" text-anchor="middle">${escapeHtml(labelStr)}</text>`;
    }

    // 5. Hourly dot on the line: only place if data was actively tracked near this hour (omitted during gaps)
    if (yForValue && pts.length > 0) {
      let pBefore = null;
      let pAfter = null;
      for (let i = 0; i < pts.length; i++) {
        const ptTime = new Date(pts[i].timestamp).getTime();
        if (ptTime <= t) pBefore = pts[i];
        if (ptTime >= t && !pAfter) pAfter = pts[i];
      }

      if (pBefore && pAfter) {
        const t1 = new Date(pBefore.timestamp).getTime();
        const t2 = new Date(pAfter.timestamp).getTime();
        const gap = t2 - t1;

        if (gap <= maxGapMs && Math.min(Math.abs(t - t1), Math.abs(t - t2)) <= 25 * 60 * 1000) {
          const valAtT = t2 === t1
            ? pBefore.value
            : pBefore.value + ((t - t1) / (t2 - t1)) * (pAfter.value - pBefore.value);
          if (Number.isFinite(valAtT)) {
            const cy = yForValue(valAtT);
            hourDots += `<circle class="chart-hour-dot" cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="3.5" fill="${color || "#d97757"}" stroke="#181715" stroke-width="2" />`;
          }
        }
      }
    }
  }

  return { hourDots, edgeMarks, hourLines };
}

function makeTooltipMarkup({ label, point, suffix = "", color = "#d97757" }) {
  const dateStr = new Date(point.timestamp).toLocaleString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });

  const isRatio = label.toLowerCase().includes("ratio");
  const valueDisplay = isRatio && Number.isFinite(point.value)
    ? `${point.value.toFixed(2)}${suffix}`
    : `${formatNumber(point.value)}${suffix}`;

  const deltaDisplay = point.delta != null
    ? (isRatio
        ? `${point.delta >= 0 ? "+" : ""}${point.delta.toFixed(2)}${point.percent != null ? ` (${point.percent >= 0 ? "+" : ""}${point.percent.toFixed(2)}%)` : ""}`
        : `${point.delta >= 0 ? "+" : ""}${formatNumber(point.delta)}${point.percent != null ? ` (${point.percent >= 0 ? "+" : ""}${point.percent.toFixed(2)}%)` : ""}`)
    : null;

  const ratioExtra = isRatio && Number.isFinite(point.value) && point.value > 0
    ? `<div class="chart-tt-subratio">1 chat per ${point.value.toFixed(2)} msgs · ${((1 / point.value) * 100).toFixed(2)}% chats/msg</div>`
    : "";

  const deltaHtml = deltaDisplay != null
    ? `<div class="chart-tt-delta ${point.delta >= 0 ? "up" : "down"}">
         <span>${escapeHtml(deltaDisplay)}</span>
         ${point.elapsedMs != null ? `<span class="chart-tt-elapsed">in ${formatDuration(point.elapsedMs)}</span>` : ""}
       </div>`
    : "";

  return `
    <div class="chart-tt-header">
      <span class="chart-tt-indicator" style="background: ${color};"></span>
      <span class="chart-tt-label">${escapeHtml(label)}</span>
    </div>
    <div class="chart-tt-value">${escapeHtml(valueDisplay)}</div>
    ${ratioExtra}
    <div class="chart-tt-time">${escapeHtml(dateStr)}</div>
    ${deltaHtml}
  `;
}

function bindChartTooltips(root = document) {
  root.querySelectorAll(".chart-wrap").forEach(wrap => {
    const tooltip = wrap.querySelector(".chart-tooltip");
    const svg = wrap.querySelector(".chart-svg");
    const crosshair = wrap.querySelector(".chart-crosshair");
    const activeDot = wrap.querySelector(".chart-active-dot");
    if (!tooltip || !svg) return;

    let pointsData = [];
    try {
      if (svg.dataset.points) {
        pointsData = JSON.parse(svg.dataset.points);
      }
    } catch {
      pointsData = [];
    }

    if (!pointsData.length) return;

    const hide = () => {
      if (crosshair) crosshair.style.display = "none";
      if (activeDot) activeDot.style.display = "none";
      tooltip.classList.remove("visible");
    };

    wrap.addEventListener("pointermove", (e) => {
      const svgRect = svg.getBoundingClientRect();
      const wrapRect = wrap.getBoundingClientRect();
      const vb = svg.viewBox.baseVal;

      const mouseSvgX = e.clientX - svgRect.left;
      if (mouseSvgX < 0 || mouseSvgX > svgRect.width) {
        hide();
        return;
      }
      const svgX = (mouseSvgX / svgRect.width) * vb.width;

      // Find nearest point by X coordinate
      let nearest = pointsData[0];
      let minDist = Math.abs(pointsData[0].cx - svgX);
      for (let i = 1; i < pointsData.length; i++) {
        const d = Math.abs(pointsData[i].cx - svgX);
        if (d < minDist) {
          minDist = d;
          nearest = pointsData[i];
        }
      }

      if (!nearest) return;

      if (crosshair) {
        crosshair.setAttribute("x1", nearest.cx.toFixed(2));
        crosshair.setAttribute("x2", nearest.cx.toFixed(2));
        crosshair.style.display = "block";
      }

      if (activeDot) {
        activeDot.setAttribute("cx", nearest.cx.toFixed(2));
        activeDot.setAttribute("cy", nearest.cy.toFixed(2));
        activeDot.style.display = "block";
      }

      // Format custom HTML tooltip
      tooltip.innerHTML = nearest.tooltipHtml;
      tooltip.classList.add("visible");

      // Position tooltip right next to the cursor itself
      const cursorX = e.clientX - wrapRect.left;
      const cursorY = e.clientY - wrapRect.top;

      const tooltipWidth = tooltip.offsetWidth || 180;
      const tooltipHeight = tooltip.offsetHeight || 80;

      let left = cursorX + 16;
      let top = cursorY - tooltipHeight / 2;

      // Flip to left side if cursor is close to right edge of container
      if (left + tooltipWidth > wrap.clientWidth - 10) {
        left = cursorX - tooltipWidth - 16;
      }

      // Keep within bounds of wrap container
      if (left < 8) left = 8;
      if (top < 8) top = 8;
      if (top + tooltipHeight > wrap.clientHeight - 8) {
        top = wrap.clientHeight - tooltipHeight - 8;
      }

      tooltip.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
    });

    wrap.addEventListener("pointerleave", hide);
  });
}

function cleanUuid(val) {
  if (!val) return null;
  const m = String(val).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return m ? m[0].toLowerCase() : null;
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
  getNiceYScale,
  buildTimePaths,
  buildHourlyMarkers,
  makeTooltipMarkup,
  bindChartTooltips,
  cleanUuid
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
    getNiceYScale,
    buildTimePaths,
    buildHourlyMarkers,
    makeTooltipMarkup,
    bindChartTooltips,
    cleanUuid
  });
}


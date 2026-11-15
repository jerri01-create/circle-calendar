/*
 * Calendar circle recognizer.
 * Finds the dates that were circled with a yellow or a blue pen on a month-view
 * calendar screenshot. Everything runs on the pixels in memory: no network, no AI model.
 *
 * Pipeline (all sizes are relative to the detected column pitch, so any screen size works):
 *   1. classify pixels: pen colour (yellow / blue) and dark "ink" (date digits)
 *   2. find digit labels, then the 7-column lattice and the evenly spaced week rows
 *   3. read the month layout from the grid (column of the 1st, number of days shown in full colour)
 *   4. for every pen colour: distance to the nearest stroke, then the widest escape path from the
 *      edge of the calendar to every pixel. A date is circled when most of its digit box sits in a
 *      region that cannot reach the edge unless a gap wider than `gapRatio` (x pitch) is crossed,
 *      and that region is big enough and roughly convex (not the space between neighbouring circles).
 * The month read from the layout is an estimate: months with the same first weekday and length look
 * the same, so the caller must let the user confirm it (`month.candidates`).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CircleRecognizer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULTS = {
    workWidth: 600,       // analysis width in px; the image is scaled to this width first
    maxPixels: 1300000,   // cap on analysed pixels (very tall screenshots are scaled further)
    inkContrast: 100,     // |luma - background| that counts as dark date digits
    tintContrast: 40,     // smaller contrast that still counts for coloured digits (red Sunday, blue Saturday)
    gapRatio: 0.14,       // widest half-gap (x column pitch) still treated as a closed circle
    minStrokeArea: 0.03,  // pen pieces smaller than this (x pitch^2) are ignored: event dots, coloured digits
    thickRatio: 0.1,      // pen parts thicker than this half-width (x pitch) are fills (a today disc), not strokes
    minCoverage: 0.5,     // share of the digit box that must lie inside the enclosed region
    minSolidity: 0.7,     // enclosed region / its convex hull; low values mean "the space between circles"
    minArea: 0.12,        // smallest enclosed region (x pitch^2) that can hold a date number
    maxArea: 9,           // largest enclosed region (x pitch^2); bigger means the frame of the screen, not a circle
    monthSearch: 12,      // months before and after today searched when reading the month from the grid
    penGlyphs: true,      // count glyph-sized pen-coloured pieces as digits (light-blue Saturday digits in dark themes)
  };

  const PEN_NAMES = ['yellow', 'blue'];

  function isYellow(h, s, v) { return h >= 38 && h <= 75 && s >= 0.5 && v >= 0.55; }
  function isBlue(h, s, v) { return h >= 160 && h <= 250 && s >= 0.6 && v >= 0.7; }

  // ---------- 1. pixel classes ----------
  function classify(img, opt) {
    const W = img.width, H = img.height, data = img.data, n = W * H;
    const pen = new Uint8Array(n);      // 0 none, 1 yellow, 2 blue
    const luma = new Uint8Array(n);
    const tint = new Uint8Array(n);     // coloured but not a pen colour (coloured digits, bars)
    const red = new Uint8Array(n);      // reddish (Sunday digits)
    const blueText = new Uint8Array(n); // bluish but not pen-bright (Saturday digits)
    const hist = new Uint32Array(256);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const r = data[p], g = data[p + 1], b = data[p + 2];
      const y = (299 * r + 587 * g + 114 * b) / 1000 | 0;
      luma[i] = y; hist[y]++;
      const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
      const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
      const d = mx - mn;
      if (d < 40) continue;
      const s = d / mx, v = mx / 255;
      let h;
      if (mx === r) h = 60 * (((g - b) / d) % 6);
      else if (mx === g) h = 60 * ((b - r) / d + 2);
      else h = 60 * ((r - g) / d + 4);
      if (h < 0) h += 360;
      if (isYellow(h, s, v)) pen[i] = 1;
      else if (isBlue(h, s, v)) pen[i] = 2;
      else if (s >= 0.3) {
        if (s >= 0.35) tint[i] = 1;
        if ((h <= 20 || h >= 340) && s >= 0.35) red[i] = 1;
        else if (h >= 190 && h <= 250) blueText[i] = 1;
      }
    }
    let acc = 0, bg = 255;
    for (let k = 0; k < 256; k++) { acc += hist[k]; if (acc >= n / 2) { bg = k; break; } }
    // Pale anti-aliased pen edges are far from a dark background, so they would look like digits:
    // keep 2 px around every pen pixel out of the digit mask.
    const near = dilate(pen, W, H, 2);
    const ink = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (near[i]) continue;
      const dl = Math.abs(luma[i] - bg);
      if (dl >= opt.inkContrast || (tint[i] && dl >= opt.tintContrast)) ink[i] = 1;
    }
    return { W, H, pen, ink, red, blueText, bg };
  }

  // square dilation of a non-zero mask by r pixels (separable max filter)
  function dilate(mask, W, H, r) {
    const tmp = new Uint8Array(W * H), out = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      const o = y * W;
      for (let x = 0; x < W; x++) {
        if (!mask[o + x]) continue;
        const a = Math.max(0, x - r), b = Math.min(W - 1, x + r);
        for (let k = a; k <= b; k++) tmp[o + k] = 1;
      }
    }
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) {
        if (!tmp[y * W + x]) continue;
        const a = Math.max(0, y - r), b = Math.min(H - 1, y + r);
        for (let k = a; k <= b; k++) out[k * W + x] = 1;
      }
    }
    return out;
  }

  // ---------- connected components (8-neighbour) ----------
  function components(mask, W, H, value) {
    const n = W * H;
    const lab = new Int32Array(n).fill(-1);
    const stack = new Int32Array(n);
    const comps = [];
    for (let i = 0; i < n; i++) {
      if (mask[i] !== value || lab[i] !== -1) continue;
      const id = comps.length;
      let sp = 0, minX = W, minY = H, maxX = -1, maxY = -1, area = 0, sx = 0, sy = 0;
      stack[sp++] = i; lab[i] = id;
      while (sp) {
        const j = stack[--sp];
        const x = j % W, y = (j - x) / W;
        area++; sx += x; sy += y;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy; if (yy < 0 || yy >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx; if (xx < 0 || xx >= W) continue;
            const k = yy * W + xx;
            if (mask[k] === value && lab[k] === -1) { lab[k] = id; stack[sp++] = k; }
          }
        }
      }
      comps.push({ id, minX, minY, maxX, maxY, area, cx: sx / area, cy: sy / area });
    }
    return { lab, comps };
  }

  function median(arr) {
    if (!arr.length) return NaN;
    const a = arr.slice().sort((x, y) => x - y), m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  // ---------- 2. labels, columns, week rows ----------
  function findLabels(cls, opt) {
    const { W, H } = cls;
    const minH = 0.012 * W, maxH = 0.06 * W, maxW = 0.09 * W;
    // Coloured digits bright enough to pass as a pen colour (e.g. light-blue Saturday digits in a dark
    // theme) are small pen pieces with a glyph's size: count them as digits as well.
    const ink = cls.ink.slice();
    const small = 0.03 * Math.pow(W / 7.3, 2);
    for (const value of opt.penGlyphs ? [1, 2] : []) {
      const pieces = components(cls.pen, W, H, value);
      const glyph = pieces.comps.map((c) => {
        const h = c.maxY - c.minY + 1, w = c.maxX - c.minX + 1;
        return c.area < small && h >= minH && h <= maxH && w <= maxW;
      });
      if (!glyph.some(Boolean)) continue;
      for (let i = 0; i < ink.length; i++) if (pieces.lab[i] >= 0 && glyph[pieces.lab[i]]) ink[i] = 1;
    }
    const { comps } = components(ink, W, H, 1);
    const glyphs = comps.filter((c) => {
      const h = c.maxY - c.minY + 1, w = c.maxX - c.minX + 1;
      return h >= minH && h <= maxH && w <= maxW && c.area >= 6;
    }).sort((a, b) => a.minX - b.minX);
    const labels = [];
    for (const g of glyphs) {
      const gh = g.maxY - g.minY + 1;
      let host = null;
      for (const L of labels) {
        const lh = L.maxY - L.minY + 1;
        const overlap = Math.min(L.maxY, g.maxY) - Math.max(L.minY, g.minY) + 1;
        const gap = g.minX - L.maxX - 1;
        if (overlap >= 0.6 * Math.min(lh, gh) && gap <= 0.5 * Math.max(lh, gh) && gap >= -Math.max(lh, gh)) { host = L; break; }
      }
      if (host) {
        host.minX = Math.min(host.minX, g.minX); host.maxX = Math.max(host.maxX, g.maxX);
        host.minY = Math.min(host.minY, g.minY); host.maxY = Math.max(host.maxY, g.maxY);
        host.area += g.area; host.parts++;
      } else {
        labels.push({ minX: g.minX, maxX: g.maxX, minY: g.minY, maxY: g.maxY, area: g.area, parts: 1 });
      }
    }
    for (const L of labels) {
      L.cx = (L.minX + L.maxX) / 2; L.cy = (L.minY + L.maxY) / 2;
      L.w = L.maxX - L.minX + 1; L.h = L.maxY - L.minY + 1;
    }
    return labels;
  }

  function groupRows(labels) {
    const sorted = labels.slice().sort((a, b) => a.cy - b.cy);
    const rows = [];
    for (const L of sorted) {
      const last = rows[rows.length - 1];
      if (last && Math.abs(L.cy - last.cy) <= 0.5 * Math.max(L.h, last.h)) {
        last.items.push(L);
        last.cy = last.items.reduce((s, it) => s + it.cy, 0) / last.items.length;
        last.h = median(last.items.map((it) => it.h));
      } else rows.push({ cy: L.cy, h: L.h, items: [L] });
    }
    return rows;
  }

  function findColumns(rows, W) {
    const diffs = [];
    const good = rows.filter((r) => r.items.length >= 4);
    for (const r of good) {
      const xs = r.items.map((L) => L.cx).sort((a, b) => a - b);
      for (let i = 1; i < xs.length; i++) diffs.push(xs[i] - xs[i - 1]);
    }
    // the calendar may not fill the screen: accept 7 columns from a sixteenth to a sixth of the width,
    // and take the most common neighbour spacing (date rows outnumber any other text row)
    const cand = diffs.filter((d) => d >= W / 16 && d <= W / 6);
    if (cand.length < 3) return null;
    let mode = null;
    for (const d of cand) {
      const close = cand.filter((e) => Math.abs(e - d) <= 0.06 * d);
      if (!mode || close.length > mode.n) mode = { n: close.length, d: median(close) };
    }
    if (mode.n < 3) return null;
    let pitch = mode.d;
    // circular mean of the phase of every label centre
    let sc = 0, ss = 0;
    const pts = [];
    for (const r of good) for (const L of r.items) pts.push(L.cx);
    for (const x of pts) { const a = 2 * Math.PI * x / pitch; sc += Math.cos(a); ss += Math.sin(a); }
    let phase = (Math.atan2(ss, sc) / (2 * Math.PI)) * pitch; if (phase < 0) phase += pitch;
    // choose the 7 lattice columns that hold the most labels
    let best = null;
    const kmax = Math.ceil(W / pitch) + 1;
    for (let k0 = -1; k0 <= kmax - 7; k0++) {
      const x0 = phase + k0 * pitch;
      if (x0 - pitch / 2 < -0.25 * pitch || x0 + 6.5 * pitch > W + 0.25 * pitch) continue;
      let hit = 0;
      for (const x of pts) { const c = Math.round((x - x0) / pitch); if (c >= 0 && c <= 6 && Math.abs(x - x0 - c * pitch) <= 0.3 * pitch) hit++; }
      if (!best || hit > best.hit) best = { x0, hit };
    }
    if (!best) return null;
    // refine x0 and pitch with least squares over the aligned labels
    let n = 0, sxc = 0, sx = 0, scc = 0, scn = 0;
    for (const x of pts) {
      const c = Math.round((x - best.x0) / pitch);
      if (c < 0 || c > 6 || Math.abs(x - best.x0 - c * pitch) > 0.3 * pitch) continue;
      n++; sx += x; scn += c; sxc += x * c; scc += c * c;
    }
    let x0 = best.x0;
    const den = n * scc - scn * scn;
    if (n >= 4 && den > 0) {
      const p2 = (n * sxc - scn * sx) / den;
      if (Math.abs(p2 - pitch) < 0.1 * pitch) { pitch = p2; x0 = (sx - pitch * scn) / n; }
    }
    return { x0, pitch };
  }

  function colOf(x, cols) {
    const c = Math.round((x - cols.x0) / cols.pitch);
    if (c < 0 || c > 6 || Math.abs(x - cols.x0 - c * cols.pitch) > 0.3 * cols.pitch) return -1;
    return c;
  }

  function findWeekRows(rows, cols) {
    const cand = [];
    for (const r of rows) {
      const cells = new Map();
      for (const L of r.items) {
        if (L.w > 1.6 * L.h + 2) continue;  // wider than two digits: words, not dates
        const c = colOf(L.cx, cols);
        if (c < 0) continue;
        if (!cells.has(c) || cells.get(c).area < L.area) cells.set(c, L);
      }
      if (cells.size) cand.push({ cy: r.cy, h: r.h, cells });
    }
    let best = null;
    for (let i = 0; i < cand.length; i++) {
      for (let j = i + 1; j < cand.length; j++) {
        const S = cand[j].cy - cand[i].cy;
        if (S < 0.6 * cols.pitch || S > 2.2 * cols.pitch) continue;
        const chain = [cand[i], cand[j]];
        let y = cand[j].cy;
        for (let k = j + 1; k < cand.length; k++) {
          const d = cand[k].cy - y;
          if (Math.abs(d - S) <= 0.12 * S) { chain.push(cand[k]); y = cand[k].cy; }
          else if (d > 1.12 * S) break;
        }
        if (chain.length < 4 || chain.length > 6) continue;
        const layout = layoutOf(chain);
        const cells = chain.reduce((s, r) => s + r.cells.size, 0);
        const score = (layout.ok ? 10000 : 0) + chain.length * 100 + cells;
        if (!best || score > best.score) best = { chain, S, score, layout };
      }
    }
    return best;
  }

  // Month layout implied by a chain of week rows, and whether it is a plausible month view.
  function layoutOf(chain) {
    const first = [...chain[0].cells.keys()], last = [...chain[chain.length - 1].cells.keys()];
    const firstCol = Math.min(...first), lastCol = Math.max(...last);
    const days = 7 * (chain.length - 1) + lastCol - firstCol + 1;
    let ok = days >= 28 && days <= 31;
    if (Math.max(...first) < 5) ok = false;   // the first week runs to the end of its row
    if (Math.min(...last) > 1) ok = false;    // the last week starts at the beginning of its row
    for (let i = 1; i < chain.length - 1; i++) if (chain[i].cells.size < 4) ok = false;  // full weeks (pens may hide a few)
    return { firstCol, lastCol, days, ok };
  }

  // ---------- 3. month layout ----------
  function daysInMonth(year, month) { return new Date(Date.UTC(year, month, 0)).getUTCDate(); }
  function weekdayOf(year, month, day) { return new Date(Date.UTC(year, month - 1, day)).getUTCDay(); }
  function firstColumn(year, month, weekStart) { return (weekdayOf(year, month, 1) - weekStart + 7) % 7; }
  function cellDate(r, c, year, month, weekStart) {
    const d = 7 * r + c - firstColumn(year, month, weekStart) + 1;
    return d >= 1 && d <= daysInMonth(year, month) ? d : null;
  }

  function guessMonth(firstCol, days, weekStart, today, span) {
    const y0 = today.getFullYear(), m0 = today.getMonth() + 1;
    const all = [];
    for (let k = -span; k <= span; k++) {
      const t = (y0 * 12 + (m0 - 1)) + k;
      const year = Math.floor(t / 12), month = (t % 12) + 1;
      all.push({ year, month, k });
    }
    const byDist = (a, b) => (Math.abs(a.k) - Math.abs(b.k)) || (b.k - a.k);  // nearest first, future wins ties
    const exact = all.filter((m) => firstColumn(m.year, m.month, weekStart) === firstCol && daysInMonth(m.year, m.month) === days).sort(byDist);
    if (exact.length) return { year: exact[0].year, month: exact[0].month, source: 'grid', candidates: exact.slice(0, 3).map((m) => `${m.year}-${m.month}`) };
    const loose = all.filter((m) => firstColumn(m.year, m.month, weekStart) === firstCol).sort(byDist);
    if (loose.length && firstCol >= 0) return { year: loose[0].year, month: loose[0].month, source: 'first-column', candidates: loose.slice(0, 3).map((m) => `${m.year}-${m.month}`) };
    return { year: y0, month: m0, source: 'today', candidates: [] };
  }

  // ---------- 4. enclosure ----------
  function edt(mask, W, H) {
    const INF = 1e20, n = W * H, m = Math.max(W, H);
    const f = new Float64Array(m), d = new Float64Array(m), v = new Int32Array(m), z = new Float64Array(m + 1);
    const g = new Float64Array(n);
    for (let i = 0; i < n; i++) g[i] = mask[i] ? 0 : INF;
    const pass = (len) => {
      let k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
      for (let q = 1; q < len; q++) {
        let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
        k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
      }
      k = 0;
      for (let q = 0; q < len; q++) { while (z[k + 1] < q) k++; const t = q - v[k]; d[q] = t * t + f[v[k]]; }
    };
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) f[y] = g[y * W + x];
      pass(H);
      for (let y = 0; y < H; y++) g[y * W + x] = d[y];
    }
    for (let y = 0; y < H; y++) {
      const o = y * W;
      for (let x = 0; x < W; x++) f[x] = g[o + x];
      pass(W);
      for (let x = 0; x < W; x++) g[o + x] = d[x];
    }
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = Math.sqrt(g[i]);
    return out;
  }

  const Q = 2;          // keys are half pixels
  const KMAX = 2000;

  // Widest escape path from the edge of the region of interest: key[i] = largest q such that pixel i
  // reaches the edge while staying at least q/Q px away from every stroke.
  function escapeKeys(dist, W, roi) {
    const { x0, y0, x1, y1 } = roi;
    const n = dist.length;
    const key = new Int16Array(n).fill(-1);
    const pend = new Int16Array(n).fill(-1);
    const buckets = new Array(KMAX + 1);
    for (let k = 0; k <= KMAX; k++) buckets[k] = [];
    const quant = (i) => Math.min(KMAX, Math.floor(dist[i] * Q));
    const push = (i, k) => { if (k > pend[i]) { pend[i] = k; buckets[k].push(i); } };
    for (let x = x0; x <= x1; x++) { push(y0 * W + x, quant(y0 * W + x)); push(y1 * W + x, quant(y1 * W + x)); }
    for (let y = y0; y <= y1; y++) { push(y * W + x0, quant(y * W + x0)); push(y * W + x1, quant(y * W + x1)); }
    for (let k = KMAX; k >= 0; k--) {
      const b = buckets[k];
      while (b.length) {
        const i = b.pop();
        if (key[i] !== -1 || pend[i] !== k) continue;
        key[i] = k;
        const x = i % W, y = (i - x) / W;
        if (x > x0) { const j = i - 1; if (key[j] === -1) push(j, Math.min(k, quant(j))); }
        if (x < x1) { const j = i + 1; if (key[j] === -1) push(j, Math.min(k, quant(j))); }
        if (y > y0) { const j = i - W; if (key[j] === -1) push(j, Math.min(k, quant(j))); }
        if (y < y1) { const j = i + W; if (key[j] === -1) push(j, Math.min(k, quant(j))); }
      }
      buckets[k] = null;
    }
    return { key, quant };
  }

  // area and convex-hull solidity of the region {dist > g} that holds the seed
  function regionShape(dist, W, roi, seed, gKey) {
    const { x0, y0, x1, y1 } = roi;
    const seen = new Uint8Array(dist.length);
    const stack = [seed]; seen[seed] = 1;
    const rowMin = new Map(), rowMax = new Map();
    let area = 0, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, touches = false;
    const limit = (x1 - x0 + 1) * (y1 - y0 + 1);
    while (stack.length) {
      const i = stack.pop();
      const x = i % W, y = (i - x) / W;
      area++;
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (!rowMin.has(y) || x < rowMin.get(y)) rowMin.set(y, x);
      if (!rowMax.has(y) || x > rowMax.get(y)) rowMax.set(y, x);
      if (x === x0 || x === x1 || y === y0 || y === y1) touches = true;
      if (area > limit) break;
      const nb = [x > x0 ? i - 1 : -1, x < x1 ? i + 1 : -1, y > y0 ? i - W : -1, y < y1 ? i + W : -1];
      for (const j of nb) {
        if (j < 0 || seen[j]) continue;
        if (Math.floor(dist[j] * Q) > gKey) { seen[j] = 1; stack.push(j); }
      }
    }
    const pts = [];
    for (const [y, xa] of rowMin) { const xb = rowMax.get(y); pts.push([xa - 0.5, y - 0.5], [xa - 0.5, y + 0.5], [xb + 0.5, y - 0.5], [xb + 0.5, y + 0.5]); }
    const hull = convexHull(pts);
    let hullArea = 0;
    for (let i = 0; i < hull.length; i++) { const a = hull[i], b = hull[(i + 1) % hull.length]; hullArea += a[0] * b[1] - b[0] * a[1]; }
    hullArea = Math.abs(hullArea) / 2;
    return { area, solidity: hullArea > 0 ? area / hullArea : 0, bbox: [minX, minY, maxX, maxY], touches };
  }

  function convexHull(points) {
    const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (p.length < 3) return p;
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [], upper = [];
    for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
    for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
    upper.pop(); lower.pop();
    return lower.concat(upper);
  }

  function removeSmallPieces(mask, W, H, value, minArea) {
    const out = new Uint8Array(W * H);
    const { lab, comps } = components(mask, W, H, value);
    const keep = comps.map((c) => c.area >= minArea);
    let kept = 0;
    for (let i = 0; i < out.length; i++) if (lab[i] >= 0 && keep[lab[i]]) { out[i] = 1; kept++; }
    return { mask: out, kept, pieces: comps.length, keptPieces: keep.filter(Boolean).length };
  }

  // Remove filled shapes (e.g. a coloured "today" disc): every pen pixel within r+1.5 px of a pixel that
  // is deeper than r inside the mask. Pen strokes are thin, so they survive.
  function removeThickParts(mask, W, H, r) {
    const n = W * H, inv = new Uint8Array(n);
    for (let i = 0; i < n; i++) inv[i] = mask[i] ? 0 : 1;
    const inner = edt(inv, W, H);
    const core = new Uint8Array(n);
    let any = false;
    for (let i = 0; i < n; i++) if (mask[i] && inner[i] > r) { core[i] = 1; any = true; }
    if (!any) return { mask, removed: 0 };
    const toCore = edt(core, W, H);
    const out = new Uint8Array(n);
    let removed = 0;
    for (let i = 0; i < n; i++) {
      if (!mask[i]) continue;
      if (toCore[i] > r + 1.5) out[i] = 1; else removed++;
    }
    return { mask: out, removed };
  }

  // ---------- main ----------
  function analyze(img, options) {
    const t0 = Date.now();
    const opt = Object.assign({}, DEFAULTS, options || {});
    const today = opt.today instanceof Date ? opt.today : new Date();
    const cls = classify(img, opt);
    const { W, H } = cls;
    const labels = findLabels(cls, opt);
    const rows = groupRows(labels);
    const cols = findColumns(rows, W);
    if (!cols) return { ok: false, reason: 'no-columns', message: '달력 칸(7열)을 찾지 못했습니다.', timingMs: Date.now() - t0 };
    const week = findWeekRows(rows, cols);
    if (!week) return { ok: false, reason: 'no-rows', message: '날짜 줄(주)을 찾지 못했습니다.', timingMs: Date.now() - t0 };
    if (!week.layout.ok) {
      return { ok: false, reason: 'grid-inconsistent', message: '달력 칸 배치를 확실히 읽지 못했습니다.', layout: week.layout, timingMs: Date.now() - t0 };
    }
    const chain = week.chain;
    const pitch = cols.pitch;
    const { firstCol, lastCol, days } = week.layout;

    // week start: Sunday digits are red, Saturday digits are blue (Korean calendar apps)
    const tally = (mask) => {
      const by = new Array(7).fill(0);
      for (const r of chain) for (const [c, L] of r.cells) {
        for (let y = L.minY; y <= L.maxY; y++) for (let x = L.minX; x <= L.maxX; x++) if (mask[y * W + x]) by[c]++;
      }
      const mx = Math.max(...by), col = by.indexOf(mx), rest = (by.reduce((s, v) => s + v, 0) - mx) / 6;
      return mx > 20 && mx > 4 * rest ? col : -1;
    };
    const redCol = tally(cls.red), blueCol = tally(cls.blueText);
    let weekStart = 0, weekStartSource = 'default';
    if (redCol === 0 || (redCol < 0 && blueCol === 6)) { weekStart = 0; weekStartSource = redCol === 0 ? 'red' : 'blue'; }
    else if (redCol === 6 || (redCol < 0 && blueCol === 5)) { weekStart = 1; weekStartSource = redCol === 6 ? 'red' : 'blue'; }

    const month = guessMonth(firstCol, days, weekStart, today, opt.monthSearch);

    const rowY = chain.map((r) => r.cy);
    const S = week.S;
    const roi = {
      x0: 0, x1: W - 1,
      y0: Math.max(0, Math.floor(rowY[0] - 0.9 * S)),
      y1: Math.min(H - 1, Math.ceil(rowY[rowY.length - 1] + 1.6 * S)),
    };

    const cells = [];
    for (let r = 0; r < chain.length; r++) {
      for (let c = 0; c < 7; c++) {
        cells.push({ r, c, x: cols.x0 + c * pitch, y: rowY[r], hasLabel: chain[r].cells.has(c) });
      }
    }

    const marks = {};
    const pens = {};
    const gapKeyMax = opt.gapRatio * pitch * Q;
    PEN_NAMES.forEach((name, idx) => {
      const value = idx + 1;
      const pieces = removeSmallPieces(cls.pen, W, H, value, opt.minStrokeArea * pitch * pitch);
      const thin = pieces.kept ? removeThickParts(pieces.mask, W, H, opt.thickRatio * pitch) : { mask: pieces.mask, removed: 0 };
      pens[name] = { pixels: pieces.kept - thin.removed, pieces: pieces.pieces, keptPieces: pieces.keptPieces, filledRemoved: thin.removed };
      marks[name] = [];
      if (pieces.kept - thin.removed <= 0) { cells.forEach((cell) => { cell[name] = null; }); return; }
      const dist = edt(thin.mask, W, H);
      const { key, quant } = escapeKeys(dist, W, roi);
      for (const cell of cells) {
        // the digit box: the detected label, or a typical two-digit box around the lattice point
        const L = chain[cell.r].cells.get(cell.c);
        const bx0 = Math.max(0, L ? L.minX : Math.round(cell.x - 0.18 * pitch));
        const bx1 = Math.min(W - 1, L ? L.maxX : Math.round(cell.x + 0.18 * pitch));
        const by0 = Math.max(roi.y0, L ? L.minY : Math.round(cell.y - 0.13 * pitch));
        const by1 = Math.min(roi.y1, L ? L.maxY : Math.round(cell.y + 0.13 * pitch));
        let free = 0, inside = 0, seed = -1, seedQ = -1;
        for (let y = by0; y <= by1; y++) {
          for (let x = bx0; x <= bx1; x++) {
            const i = y * W + x, q = quant(i);
            if (q < 2) continue;  // on a stroke
            free++;
            const k = key[i];
            if (k >= 0 && k < q - 1 && k <= gapKeyMax) { inside++; if (q > seedQ) { seedQ = q; seed = i; } }
          }
        }
        const info = { coverage: free ? +(inside / free).toFixed(2) : 0, free };
        info.circled = false;
        if (seed >= 0 && free >= 6 && inside / free >= opt.minCoverage) {
          const gKey = key[seed];
          const shape = regionShape(dist, W, roi, seed, gKey);
          info.gap = gKey / Q;
          info.gapRatio = +(gKey / Q / pitch).toFixed(3);
          info.area = +(shape.area / (pitch * pitch)).toFixed(3);
          info.solidity = +shape.solidity.toFixed(3);
          info.touches = shape.touches;
          info.circled = !shape.touches && info.solidity >= opt.minSolidity && info.area >= opt.minArea && info.area <= opt.maxArea;
        }
        cell[name] = info;
        if (info.circled) marks[name].push({ r: cell.r, c: cell.c });
      }
    });

    const scale = img.sourceWidth ? img.sourceWidth / W : 1;
    return {
      ok: true,
      size: { width: W, height: H, scale },
      grid: { x0: cols.x0, pitch, rowY, rowPitch: S, rows: chain.length, weekStart, weekStartSource, firstCol, lastCol, days },
      month,
      pens,
      marks,
      cells,
      background: cls.bg,
      labels: labels.length,
      timingMs: Date.now() - t0,
    };
  }

  // Browser helper: draw an <img>/<canvas>/ImageBitmap at the work width and analyse it.
  function analyzeSource(source, options) {
    const opt = Object.assign({}, DEFAULTS, options || {});
    const sw = source.naturalWidth || source.videoWidth || source.width;
    const sh = source.naturalHeight || source.videoHeight || source.height;
    let scale = sw > opt.workWidth ? opt.workWidth / sw : 1;
    if (sw * sh * scale * scale > opt.maxPixels) scale = Math.sqrt(opt.maxPixels / (sw * sh));
    const w = Math.round(sw * scale), h = Math.round(sh * scale);
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h);
    const res = analyze({ width: w, height: h, data: data.data, sourceWidth: sw }, opt);
    if (res.ok) res.size.source = { width: sw, height: sh };
    return res;
  }

  return { analyze, analyzeSource, cellDate, firstColumn, daysInMonth, weekdayOf, guessMonth, DEFAULTS };
});

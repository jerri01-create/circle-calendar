/* Geometry in CSS pixels; no DOM, storage or network. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CircleDraw = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function classify(points) {
    const bbox = { x: 0, y: 0, w: 0, h: 0 };
    if (!points.length) return { kind: 'invalid', bbox, area: 0, gap: 0 };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, length = 0, twiceArea = 0;
    for (let i = 0; i < points.length; i++) {
      const p = points[i], q = points[(i + 1) % points.length];
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
      twiceArea += p.x * q.y - q.x * p.y;
      if (i + 1 < points.length) length += Math.hypot(q.x - p.x, q.y - p.y);
    }
    Object.assign(bbox, { x: minX, y: minY, w: maxX - minX, h: maxY - minY });
    const area = Math.abs(twiceArea) / 2, first = points[0], last = points[points.length - 1];
    const gap = Math.hypot(last.x - first.x, last.y - first.y);
    const loop = gap <= Math.max(bbox.w, bbox.h) * .35 && Math.min(bbox.w, bbox.h) >= 12 && area >= bbox.w * bbox.h * .3;
    return { kind: length < 10 ? 'tap' : loop ? 'loop' : 'invalid', bbox, area, gap };
  }
  function daysInside(points, cells) {
    return cells.filter(cell => {
      const x = cell.x + cell.w / 2, y = cell.y + cell.h / 2;
      let inside = false;
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const a = points[i], b = points[j];
        if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
      }
      return inside;
    }).map(cell => cell.day).sort((a, b) => a - b);
  }
  function centerDay(bbox, cells) {
    const x = bbox.x + bbox.w / 2, y = bbox.y + bbox.h / 2;
    return cells.find(c => x >= c.x && x < c.x + c.w && y >= c.y && y < c.y + c.h)?.day ?? null;
  }
  return { classify, daysInside, centerDay };
});

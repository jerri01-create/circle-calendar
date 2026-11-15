/*
 * Selected dates -> Google Calendar all-day event requests.
 * Pure functions: no network, no DOM. Used by app.js and by the tests.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CalendarEvents = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // colorId values follow the Calendar event palette (P-003 confirms the names on a real calendar).
  const COLORS = {
    yellow: { colorId: '5', label: '노랑', googleName: 'Banana' },
    blue: { colorId: '7', label: '파랑', googleName: 'Peacock' },
  };
  const COLOR_ORDER = ['yellow', 'blue'];
  const KEY_PROP = 'circleCalKey';  // private extended property used to find events this app already added
  const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

  const pad = (n) => String(n).padStart(2, '0');
  function isoDate(year, month, day) { return `${year}-${pad(month)}-${pad(day)}`; }
  function shiftDate(year, month, day, delta) {
    const t = new Date(Date.UTC(year, month - 1, day + delta));
    return isoDate(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
  }
  function daysInMonth(year, month) { return new Date(Date.UTC(year, month, 0)).getUTCDate(); }
  function firstColumn(year, month, weekStart) { return (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() - weekStart + 7) % 7; }
  function cellDate(r, c, year, month, weekStart) {
    const d = 7 * r + c - firstColumn(year, month, weekStart) + 1;
    return d >= 1 && d <= daysInMonth(year, month) ? d : null;
  }
  function weekdayName(year, month, day) { return WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]; }

  // FNV-1a 32-bit as 8 hex digits: short, stable key part for the event name.
  function hash(text) {
    let h = 0x811c9dc5;
    for (const ch of String(text)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
  }
  function cleanName(name) { return String(name == null ? '' : name).replace(/\s+/g, ' ').trim(); }
  function eventKey(date, color, summary) { return `cc1-${date}-${color}-${hash(cleanName(summary))}`; }

  function cleanDays(list, year, month) {
    const dim = daysInMonth(year, month);
    return Array.from(new Set(list || [])).filter((d) => Number.isInteger(d) && d >= 1 && d <= dim).sort((a, b) => a - b);
  }

  // Problems that block adding, in the user's words: which field, why, how to fix.
  function validate({ year, month, days, names }) {
    const problems = [];
    let total = 0;
    for (const color of COLOR_ORDER) {
      const list = cleanDays(days && days[color], year, month);
      total += list.length;
      if (list.length && !cleanName(names && names[color])) {
        problems.push({ color, field: 'name', message: `${COLORS[color].label} 일정 이름을 넣어 주세요. ${COLORS[color].label}으로 고른 ${list.length}일에 이 이름이 들어갑니다.` });
      }
    }
    if (!total) problems.unshift({ field: 'days', message: '넣을 날짜가 없습니다. 달력에서 날짜를 눌러 노랑이나 파랑으로 고르세요.' });
    return problems;
  }

  // One request per date. end.date is the next day because the Calendar API end is exclusive.
  function buildEvents({ year, month, days, names }) {
    const out = [];
    for (const color of COLOR_ORDER) {
      const summary = cleanName(names && names[color]);
      for (const day of cleanDays(days && days[color], year, month)) {
        const date = isoDate(year, month, day);
        const key = eventKey(date, color, summary);
        out.push({
          color, day, date, summary, key,
          label: `${month}월 ${day}일 (${weekdayName(year, month, day)})`,
          body: {
            summary,
            start: { date },
            end: { date: shiftDate(year, month, day, 1) },
            colorId: COLORS[color].colorId,
            extendedProperties: { private: { [KEY_PROP]: key } },
          },
        });
      }
    }
    out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : COLOR_ORDER.indexOf(a.color) - COLOR_ORDER.indexOf(b.color)));
    return out;
  }

  // Client-chosen event id (base32hex: 0-9 and a-v, 5-1024 chars). The same date, colour and name always give the
  // same id, so a second insert (retry after a lost response, a second tab) gets 409 instead of a duplicate.
  // attempt > 0 gives a new id for the case where the old id belongs to an event the user deleted.
  // owner (P-009): the person key, only for calendars other than the primary one. Without it the id is the P-002 id,
  // so events already in a primary calendar are still found; with it two people adding the same name on the same
  // date to one shared calendar each get their own event.
  function eventId(evt, attempt, owner) {
    if (owner && !/^[0-9a-f]{8}$/.test(owner)) throw new Error('owner key must be 8 hex digits');
    const base = `cc1${evt.date.replace(/-/g, '')}${COLOR_ORDER.indexOf(evt.color)}${hash(evt.summary)}${owner ? 'o' + owner : ''}`;
    return attempt ? `${base}r${attempt}` : base;
  }

  // Person key: 8 hex digits from the account's primary calendar id (its e-mail address). Only the key goes into
  // event ids and this device's storage, never the address itself.
  function ownerKey(primaryId) { return hash(String(primaryId == null ? '' : primaryId).trim().toLowerCase()); }

  function monthUrl(year, month) { return `https://calendar.google.com/calendar/r/month/${year}/${month}/1`; }

  return { COLORS, COLOR_ORDER, KEY_PROP, buildEvents, validate, eventId, ownerKey, monthUrl, eventKey, isoDate, daysInMonth, firstColumn, cellDate, cleanName };
});

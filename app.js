(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const R = window.CircleRecognizer, E = window.CalendarEvents, D = window.CircleDraw;
  const googleCal = window.GoogleCalendar.create({ clientId: window.APP_CONFIG.googleClientId });
  const colors = E.COLOR_ORDER, weekdays = ['일', '월', '화', '수', '목', '금', '토'];
  const STATE_KEY = 'circle-cal-state-v1', RECENT_KEY = 'circle-cal-recent-names-v1', CALENDAR_KEY = 'circle-cal-calendar-v1';
  const emptyCells = () => ({ yellow: new Set(), blue: new Set() });
  const copyCells = cells => Object.fromEntries(colors.map(c => [c, new Set(cells[c])]));
  function fresh() {
    const today = new Date();
    return { year: today.getFullYear(), month: today.getMonth() + 1, weekStart: 0, cells: emptyCells(), names: { yellow: '', blue: '' }, source: null, active: false, sample: false, image: null, analysis: null, detected: null };
  }
  let state = fresh(), results = [], busy = false, reading = false, accountLabel = '', validationShown = false, photoSequence = 0;
  // P-009 calendar choice: calendars = writable calendars from the list (null = not read), ownerKey = person key
  // ('' = account unknown), batch = the target fixed when a run starts, runError = the reason shown by the button
  let calendars = null, ownerKey = '', chosen = 'primary', calendarNote = '', listGranted = false, batch = null, runError = '', runInfo = false, shownOptions = '';
  // P-011 my calendar: the month shown and its events, the ids the last run added or found, and the primary
  // calendar's real id and colour (kept in memory only; the device stores the person key and the choice as before)
  let view = { year: 0, month: 0, items: [], state: 'signed-out', note: '로그인하면 내 달력이 보입니다.', seq: 0, picked: 0 }, justAdded = { calendarId: '', ids: new Set() };
  let undoOpen = false;  // the '방금 넣은 일정 지우기' confirmation is showing
  let primaryId = '', primaryColor = '', viewDue = false;
  let drawing = false, pen = colors[0], stroke = null, viewDeferred = false, suppressClickUntil = 0;
  const cancelledPointers = new Set();
  let selectionVersion = 0, pendingSelection = null, drawHistory = [];
  let conflictClickUntil = 0, conflictGuardTimer;
  const viewLegend = $('view-legend').textContent;
  // Google Calendar's eleven event colours as the web shows them (colorId -> colour)
  const PALETTE = { 1: '#7986cb', 2: '#33b679', 3: '#8e24aa', 4: '#e67c73', 5: '#f6bf26', 6: '#f4511e', 7: '#039be5', 8: '#616161', 9: '#3f51b5', 10: '#0b8043', 11: '#d50000' };
  // the permission message says which button brings the permission screen back, by the button that was pressed
  const AGAIN = { add: ' 넣기 단추를 다시 누르면 권한 화면이 다시 나오니, 그 항목에 체크해 주세요.',
    login: ' 구글 로그인을 다시 누르면 권한 화면이 다시 나오니, 그 항목에 체크해 주세요.' };
  const explain = (err, where) => err.message + (err.code === 'scope' ? AGAIN[where] : '');
  function readStorage(key) { try { return JSON.parse(localStorage.getItem(key)); } catch (_) { return null; } }
  function writeStorage(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* Storage is optional. */ } }
  function node(tag, text, className) {
    const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (className) n.className = className; return n;
  }
  function save() {
    if (state.sample) return;
    writeStorage(STATE_KEY, { year: state.year, month: state.month, weekStart: state.weekStart, source: state.source,
      cells: Object.fromEntries(colors.map(c => [c, [...state.cells[c]]])), names: state.names, savedAt: Date.now() });
  }
  function days() {
    return Object.fromEntries(colors.map(color => [color, [...state.cells[color]].map(key => {
      const [r, c] = key.split(':').map(Number); return R.cellDate(r, c, state.year, state.month, state.weekStart);
    }).filter(d => d !== null).sort((a, b) => a - b)]));
  }
  function inputData() { return { year: state.year, month: state.month, days: days(), names: state.names }; }
  // ---- P-013: one selection transaction for gestures, keyboard, clear and undo ----
  const selectionCount = () => Object.values(days()).reduce((n, list) => n + list.length, 0);
  const viewWeekStart = () => state.active && !state.sample ? state.weekStart : 0;
  function dayKey(day, year = state.year, month = state.month, weekStart = state.weekStart) {
    const k = R.firstColumn(year, month, weekStart) + day - 1;
    return `${Math.floor(k / 7)}:${k % 7}`;
  }
  function focusDay(day) { $('view-grid').querySelector(`[data-day="${day}"]`)?.focus({ preventScroll: true }); }
  function closeConflict() {
    const old = pendingSelection;
    const hadFocus = $('draw-conflict').contains(document.activeElement);
    pendingSelection = null; $('draw-conflict').hidden = true;
    clearTimeout(conflictGuardTimer); delete $('draw-conflict').dataset.pointerGuard;
    if (hadFocus && old) focusDay(old.days[0]);
  }
  function selectionBoundary(clearHistory = false) {
    cancelStroke(false); closeConflict(); selectionVersion++;
    if (clearHistory) drawHistory = [];
  }
  function selectionSnapshot() {
    return { year: state.year, month: state.month, weekStart: state.weekStart, cells: copyCells(state.cells),
      source: state.source, active: state.active, image: state.image, analysis: state.analysis, detected: state.detected };
  }
  function selectionChange(kind, selectedDays) {
    return { kind, days: selectedDays, color: pen, year: view.year, month: view.month, weekStart: viewWeekStart(), version: selectionVersion };
  }
  function selectionDates(snapshot) {
    const dates = new Map();
    for (const c of colors) for (const key of snapshot.cells[c]) {
      const [r, col] = key.split(':').map(Number);
      const day = R.cellDate(r, col, snapshot.year, snapshot.month, snapshot.weekStart);
      if (day !== null) dates.set(`${snapshot.year}-${snapshot.month}-${day}`, { month: snapshot.month, day, color: c });
    }
    return dates;
  }
  function applySelection(change, replace = false) {
    if (busy || reading || !viewShown() || !googleCal.isSignedIn()) return;
    if (change.version !== undefined && change.version !== selectionVersion) return;
    if (change.kind === 'undo') {
      const previous = drawHistory.pop(); if (!previous) return;
      const before = selectionDates(state), after = selectionDates(previous);
      const changedDates = [...new Set([...before.keys(), ...after.keys()])].filter(key => before.get(key)?.color !== after.get(key)?.color);
      let action = `고른 날짜 ${changedDates.length}개를 되돌렸습니다`;
      if (changedDates.length === 1) {
        const key = changedDates[0], restored = after.get(key), day = restored || before.get(key);
        action = `${day.month}월 ${day.day}일 ${E.COLORS[day.color].label}을 ${restored ? '다시 골랐습니다' : '풀었습니다'}`;
      }
      const moved = view.year !== previous.year || view.month !== previous.month;
      selectionBoundary(); Object.assign(state, previous); setViewMonth(state.year, state.month);
      changed();
      const selected = days();
      $('draw-status').textContent = `${action}. 지금 고른 날짜: ${state.year}년 ${state.month}월 ${colors.map(c => E.COLORS[c].label + ' ' + selected[c].length).join('·')}`;
      if (moved) loadView();
      $('draw-undo').focus({ preventScroll: true }); return;
    }
    const clearing = change.kind === 'clear';
    if (clearing && !selectionCount()) return;
    if (!clearing && !change.days.length) return;
    const sameMonth = state.year === change.year && state.month === change.month;
    if (!clearing && !sameMonth && selectionCount() && !replace) {
      pendingSelection = { ...change, days: [...change.days] };
      const count = selectionCount();
      $('conflict-note').textContent = `지금 고른 ${state.year}년 ${state.month}월 날짜 ${count}개가 있습니다. 이미 넣은 일정은 달력에 그대로 남습니다.`;
      const canUndo = !$('undo-run').hidden;
      $('conflict-undo-note').hidden = !canUndo;
      $('conflict-undo-note').textContent = canUndo ? `방금 넣은 일정을 지우려면 먼저 ${$('undo-run').textContent}를 누르세요.` : '';
      $('conflict-undo').hidden = !canUndo;
      $('conflict-undo').textContent = $('undo-run').textContent;
      $('conflict-replace').textContent = `고른 표시 ${count}개 풀고 ${change.month}월에 고르기`;
      $('conflict-go').textContent = `${state.month}월로 가기`;
      $('draw-conflict').hidden = false;
      conflictClickUntil = performance.now() + 400;
      $('draw-conflict').dataset.pointerGuard = 'true';
      clearTimeout(conflictGuardTimer);
      conflictGuardTimer = setTimeout(() => { delete $('draw-conflict').dataset.pointerGuard; }, 400);
      $('draw-conflict').scrollIntoView({ block: 'nearest' });
      $('conflict-replace').focus({ preventScroll: true }); return;
    }
    drawHistory.push(selectionSnapshot()); if (drawHistory.length > 30) drawHistory.shift();
    closeConflict();
    if (replace) {
      validationShown = false;
      for (const c of colors) { state.names[c] = ''; $('name-' + c).value = ''; }
    }
    let removed = false;
    if (clearing) state.cells = emptyCells();
    else {
      if (!sameMonth || !state.active) {
        state.cells = emptyCells(); state.image = null; state.analysis = null; state.detected = null; state.source = 'drawn';
        state.year = change.year; state.month = change.month; state.weekStart = change.weekStart;
      }
      state.source ||= 'drawn'; state.active = true;
      for (const day of change.days) {
        const key = dayKey(day);
        const toggleOff = change.kind === 'tap' && state.cells[change.color].has(key);
        for (const c of colors) state.cells[c].delete(key);
        if (!toggleOff) state.cells[change.color].add(key); else removed = true;
      }
    }
    changed();
    const label = change.days?.length === 1 ? `${state.month}월 ${change.days[0]}일을`
      : `${state.month}월 ${change.days?.join('·')}일 ${change.days?.length}개를`;
    let existing = '';
    if (!clearing && !removed) {
      if (change.days.length === 1) {
        const items = view.items.filter(it => it.days.includes(change.days[0]));
        if (items.length) existing = `(그날 일정: ${items.slice(0, 2).map(it => E.cleanName(it.ev.summary) || '(제목 없음)').join('·')}${items.length > 2 ? ` 외 ${items.length - 2}개` : ''})`;
      } else {
        const count = change.days.filter(day => view.items.some(it => it.days.includes(day))).length;
        if (count) existing = `, 그중 일정이 있는 날 ${count}일`;
      }
    }
    $('draw-status').textContent = clearing ? '고른 표시를 모두 풀었습니다. 넣을 날짜가 없습니다.'
      : `${label} ${removed ? '풀었습니다' : E.COLORS[change.color].label + '으로 골랐습니다'}${existing}.`;
    if (!clearing) focusDay(change.days[0]);
  }
  function renderDraw() {
    const available = viewShown() && googleCal.isSignedIn() && view.state !== 'signed-out';
    if (!available) { drawing = false; cancelStroke(false); closeConflict(); }
    if (!available) $('draw-status').textContent = '';
    $('draw-toggle').hidden = !available; $('draw-toggle').disabled = busy || reading;
    $('draw-toggle').setAttribute('aria-pressed', String(drawing));
    $('draw-tools').hidden = !drawing; $('view-board').classList.toggle('drawing', drawing);
    $('draw-canvas').hidden = !drawing;
    for (const c of colors) {
      $('pen-' + c).textContent = `${c === pen ? '✓ ' : ''}${E.COLORS[c].label} 펜`;
      $('pen-' + c).setAttribute('aria-pressed', String(c === pen)); $('pen-' + c).disabled = busy || reading;
    }
    for (const id of ['draw-undo', 'draw-clear', 'draw-to-names', 'conflict-replace', 'conflict-go', 'conflict-undo']) $(id).disabled = busy || reading;
    // Keep the undo button focusable after the last undo; its empty action is a no-op.
    $('draw-undo').setAttribute('aria-disabled', String(!drawHistory.length || busy || reading));
    $('draw-clear').setAttribute('aria-disabled', String(!selectionCount() || busy || reading));
    $('draw-to-names').disabled ||= !state.active;
    $('view-grid').setAttribute('aria-label', drawing ? `날짜 고르기, 펜 ${E.COLORS[pen].label}` : '이 달의 날짜와 일정 수');
    $('view-legend').textContent = drawing ? `날짜 고르기: ${E.COLORS[pen].label} 펜으로 둘러 그리거나 날짜를 누르세요. 고른 색과 같으면 풀립니다. 점은 기존 일정입니다.` : viewLegend + ' 노랑·파랑 테두리는 고른 날짜(아직 넣기 전이거나 이번 묶음)입니다.';
  }
  function cancelStroke(repaint = true, completed = false) {
    const old = stroke; stroke = null;
    if (old && !completed) cancelledPointers.add(old.id);
    if (old && $('view-grid').hasPointerCapture(old.id)) $('view-grid').releasePointerCapture(old.id);
    const canvas = $('draw-canvas'); canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    if (repaint && viewDeferred) { viewDeferred = false; renderView(); }
  }
  function drawStroke() {
    if (!stroke) return;
    const ctx = $('draw-canvas').getContext('2d'), p = stroke.points;
    ctx.clearRect(0, 0, stroke.rect.width, stroke.rect.height);
    ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = stroke.change.color === 'yellow' ? '#a07800' : '#2879db';
    ctx.beginPath(); ctx.moveTo(p[0].x, p[0].y);
    for (const point of p.slice(1)) ctx.lineTo(point.x, point.y);
    ctx.stroke();
  }
  for (const c of colors) {
    const b = node('button', `${E.COLORS[c].label} 펜`); b.id = 'pen-' + c; b.type = 'button'; b.dataset.pen = c;
    b.onclick = () => { if (busy || reading) return; cancelStroke(); pen = c; renderView(); };
    $('draw-pens').append(b);
  }
  $('draw-toggle').onclick = () => {
    if (busy || reading || !viewShown() || !googleCal.isSignedIn()) return;
    cancelStroke(false); closeConflict(); drawing = !drawing; view.picked = 0;
    if (!drawing) $('draw-status').textContent = '';
    renderView();
  };
  $('draw-undo').onclick = () => applySelection({ kind: 'undo' });
  $('draw-clear').onclick = () => applySelection({ kind: 'clear' });
  $('draw-to-names').onclick = () => {
    const selected = days(), relevant = colors.filter(c => selected[c].length);
    const c = relevant.find(c => !E.cleanName(state.names[c])) || relevant[0] || colors[0];
    $('name-' + c).focus();
  };
  $('conflict-replace').onclick = () => {
    const change = pendingSelection;
    if (change && change.year === view.year && change.month === view.month && change.weekStart === viewWeekStart()) applySelection(change, true);
  };
  $('conflict-go').onclick = () => {
    if (busy || reading || !pendingSelection) return;
    const first = Math.min(...Object.values(days()).flat());
    setViewMonth(state.year, state.month); loadView(); focusDay(first);
  };
  $('conflict-undo').onclick = () => {
    if (busy || reading || !pendingSelection || $('undo-run').hidden) return;
    closeConflict(); $('undo-run').click();
  };
  // Ignore the next physical tap while the question moves under the pointer.
  // Native keyboard activation has detail 0 and remains available immediately.
  $('draw-conflict').addEventListener('click', event => {
    if (event.detail >= 1 && performance.now() < conflictClickUntil) {
      event.preventDefault(); event.stopImmediatePropagation();
    }
  }, true);
  const grid = $('view-grid');
  // Capture stays on the stable grid, never on a date button replaced by a render.
  document.addEventListener('pointerdown', event => {
    if (!stroke) suppressClickUntil = 0;
    else if (event.pointerId !== stroke.id) { suppressClickUntil = performance.now() + 700; cancelStroke(); }
  }, true);
  // A discarded gesture can end much later (e.g. a second finger held down).
  // Suppress its own eventual pointer click without swallowing keyboard clicks.
  for (const type of ['pointerup', 'pointercancel']) document.addEventListener(type, event => {
    if (cancelledPointers.delete(event.pointerId)) suppressClickUntil = performance.now() + 700;
  }, true);
  grid.addEventListener('pointerdown', event => {
    if (pendingSelection) { event.preventDefault(); return; }
    if (!drawing || busy || reading || !googleCal.isSignedIn() || !event.isPrimary || event.button !== 0) return;
    cancelledPointers.delete(event.pointerId);
    const rect = $('view-board').getBoundingClientRect();
    const cells = [...grid.querySelectorAll('button[data-day]')].map(b => {
      const r = b.getBoundingClientRect(); return { day: Number(b.dataset.day), x: r.x - rect.x, y: r.y - rect.y, w: r.width, h: r.height };
    });
    const canvas = $('draw-canvas'), ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * ratio); canvas.height = Math.round(rect.height * ratio);
    canvas.getContext('2d').setTransform(ratio, 0, 0, ratio, 0, 0);
    stroke = { id: event.pointerId, rect, cells, points: [{ x: event.clientX - rect.x, y: event.clientY - rect.y }], change: selectionChange('loop', []) };
    grid.setPointerCapture(event.pointerId); event.preventDefault();
  });
  grid.addEventListener('pointermove', event => {
    if (!stroke || stroke.id !== event.pointerId) return;
    stroke.points.push({ x: event.clientX - stroke.rect.x, y: event.clientY - stroke.rect.y }); drawStroke();
  });
  grid.addEventListener('pointerup', event => {
    if (!stroke || stroke.id !== event.pointerId) return;
    const s = stroke; s.points.push({ x: event.clientX - s.rect.x, y: event.clientY - s.rect.y });
    const judged = D.classify(s.points);
    suppressClickUntil = performance.now() + 700; cancelStroke(false, true);
    let selected = [];
    if (judged.kind === 'tap') {
      const day = D.centerDay({ ...s.points[0], w: 0, h: 0 }, s.cells); if (day !== null) selected = [day];
    } else if (judged.kind === 'loop') {
      selected = D.daysInside(s.points, s.cells);
      if (!selected.length) { const day = D.centerDay(judged.bbox, s.cells); if (day !== null) selected = [day]; }
    }
    if (selected.length) applySelection({ ...s.change, kind: judged.kind, days: selected });
    else $('draw-status').textContent = '선만 그어서는 고르지 않습니다. 날짜를 동그라미로 둘러 그리거나 날짜를 누르세요.';
    if (viewDeferred) { viewDeferred = false; renderView(); }
  });
  for (const type of ['pointercancel', 'lostpointercapture']) grid.addEventListener(type, event => {
    if (stroke?.id === event.pointerId) { suppressClickUntil = performance.now() + 700; cancelStroke(); }
    if (type === 'pointercancel') cancelledPointers.delete(event.pointerId);
  });
  grid.addEventListener('click', event => {
    if (pendingSelection || (event.detail >= 1 && performance.now() < suppressClickUntil)) {
      suppressClickUntil = 0; event.preventDefault(); event.stopImmediatePropagation();
    }
  }, true);
  window.addEventListener('resize', () => cancelStroke());
  window.addEventListener('orientationchange', () => cancelStroke());
  function testMode() { return !googleCal.configured || state.sample; }
  function connection() {
    const signed = googleCal.isSignedIn();
    $('mode-badge').textContent = !googleCal.configured ? '시험 모드' : signed ? `연결됨: ${accountLabel || '구글 달력'}` : '로그인 필요';
    $('login-button').hidden = !googleCal.configured || signed;
    $('logout-button').hidden = !googleCal.configured || !signed;
    $('test-mode-note').hidden = googleCal.configured;
  }
  function clearResults() {
    results = []; batch = null; runError = ''; runInfo = false; undoOpen = false;
    $('add-results').replaceChildren(); $('add-summary').textContent = ''; $('progress').textContent = '';
    $('retry-failed').hidden = true; $('open-calendar').hidden = true; $('preview-list').hidden = false;
  }
  function showValidation(focus) {
    for (const c of colors) { $('error-' + c).hidden = true; $('name-' + c).removeAttribute('aria-invalid'); }
    // the reason a run stopped stays next to the button until the results are cleared
    $('add-error').textContent = runError; $('add-error').hidden = !runError; $('add-error').classList.toggle('info', runInfo);
    const problems = E.validate(inputData());
    if (!validationShown) return problems;
    for (const p of problems) {
      const target = p.field === 'name' ? $('error-' + p.color) : $('add-error');
      target.textContent = p.message; target.hidden = false;
      if (p.color) $('name-' + p.color).setAttribute('aria-invalid', 'true');
    }
    // a short summary next to the button too, so the press visibly answers
    if (problems.length && problems.every(p => p.field === 'name')) {
      $('add-error').textContent = `일정 이름이 비어 있습니다. 위 ${$('step-check').hidden ? 2 : 3}단계에서 ${problems.map(p => E.COLORS[p.color].label).join('·')} 이름을 넣어 주세요.`;
      $('add-error').hidden = false;
    }
    if (focus && problems.length) (problems[0].color ? $('name-' + problems[0].color) : $('mini-calendar')).focus();
    return problems;
  }
  function yearOptions() {
    const y = new Date().getFullYear(), years = new Set([y - 1, y, y + 1, y + 2, state.year]);
    $('year-select').replaceChildren(...[...years].sort((a, b) => a - b).map(year => { const o = node('option', `${year}년`); o.value = year; return o; }));
    $('year-select').value = state.year; $('month-select').value = state.month; $('week-start-select').value = state.weekStart;
  }
  function drawPhoto() {
    const canvas = $('photo-preview'); canvas.hidden = !state.image;
    $('photo-caption').hidden = !state.image || !state.analysis?.ok;
    if (!state.image) return;
    const a = state.analysis, image = state.image;
    if (!a?.ok) {
      canvas.width = Math.min(600, image.naturalWidth);
      canvas.height = Math.round(image.naturalHeight * canvas.width / image.naturalWidth);
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      return;
    }
    // Show only the calendar part of the screenshot (month title to the last week), not the whole screen.
    const g = a.grid, s = image.naturalWidth / a.size.width;
    const top = Math.max(0, Math.floor(g.rowY[0] - 2.2 * g.rowPitch));
    const bottom = Math.min(a.size.height, Math.ceil(g.rowY[g.rowY.length - 1] + 1.3 * g.rowPitch));
    canvas.width = a.size.width; canvas.height = bottom - top;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, top * s, a.size.width * s, (bottom - top) * s, 0, 0, canvas.width, canvas.height);
    for (const color of colors) for (const key of state.cells[color]) {
      const [r, c] = key.split(':').map(Number), day = R.cellDate(r, c, state.year, state.month, state.weekStart);
      if (day === null || a.grid.rowY[r] === undefined) continue;
      const x = a.grid.x0 + c * a.grid.pitch, y = a.grid.rowY[r] - top, radius = a.grid.pitch * .33;
      const width = Math.max(3, a.grid.pitch * .045);
      // dark under-stroke so the ring stands out from the user's own pen strokes and from white
      ctx.lineWidth = width + 3; ctx.strokeStyle = color === 'yellow' ? '#5a4300' : '#0b2f66';
      ctx.beginPath(); ctx.arc(x, y, radius, 0, 2 * Math.PI); ctx.stroke();
      ctx.lineWidth = width; ctx.strokeStyle = color === 'yellow' ? '#ffdb37' : '#5b95ff';
      ctx.beginPath(); ctx.arc(x, y, radius, 0, 2 * Math.PI); ctx.stroke();
      const label = `${day}${color === 'yellow' ? ' 노' : ' 파'}`;
      ctx.font = `bold ${Math.max(14, a.grid.pitch * .27)}px system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const w = ctx.measureText(label).width + 10, h = Math.max(22, a.grid.pitch * .34), cy = y + radius;
      ctx.fillStyle = color === 'yellow' ? '#ffdf60' : '#185bb0'; ctx.fillRect(x - w / 2, cy - h / 2, w, h);
      ctx.fillStyle = color === 'yellow' ? '#302400' : '#ffffff'; ctx.fillText(label, x, cy);
    }
  }
  function renderCalendar() {
    const cal = $('mini-calendar'); cal.setAttribute('aria-label', `${state.year}년 ${state.month}월 날짜 고르기`); cal.tabIndex = -1;
    const children = [];
    for (let c = 0; c < 7; c++) children.push(node('span', weekdays[(c + state.weekStart) % 7]));
    const first = R.firstColumn(state.year, state.month, state.weekStart);
    for (let c = 0; c < first; c++) { const blank = node('span'); blank.setAttribute('aria-hidden', 'true'); children.push(blank); }
    for (let day = 1; day <= R.daysInMonth(state.year, state.month); day++) {
      const k = first + day - 1, key = `${Math.floor(k / 7)}:${k % 7}`;
      const color = colors.find(c => state.cells[c].has(key)) || 'none';
      const b = node('button'); b.type = 'button'; b.dataset.day = day; b.dataset.state = color;
      const mark = color === 'none' ? '' : E.COLORS[color].label;
      b.append(node('span', day), document.createTextNode(' '), node('small', mark));
      const weekday = weekdays[new Date(Date.UTC(state.year, state.month - 1, day)).getUTCDay()];
      // the accessible name starts with the visible text (WCAG 2.5.3 label in name)
      b.setAttribute('aria-label', `${day}${mark ? ' ' + mark : ''}, ${state.month}월 ${day}일 ${weekday}요일${mark ? '' : ', 고르지 않음'}`);
      b.disabled = busy || reading;
      b.addEventListener('click', () => {
        if (busy || reading) return;
        selectionBoundary(true);
        state.cells.yellow.delete(key); state.cells.blue.delete(key);
        if (color === 'none') state.cells.yellow.add(key); else if (color === 'yellow') state.cells.blue.add(key);
        changed(); $('mini-calendar').querySelector(`[data-day="${day}"]`).focus({ preventScroll: true });
      });
      children.push(b);
    }
    cal.replaceChildren(...children);
  }
  function render() {
    if (busy || reading) { cancelStroke(false); closeConflict(); }
    for (const id of ['step-check', 'step-names', 'step-add']) $(id).hidden = !state.active;
    $('step-check').hidden = !state.active || state.source === 'drawn';
    $('step-names').querySelector('h2').textContent = `${$('step-check').hidden ? 2 : 3}. 일정 이름`;
    $('step-add').querySelector('h2').textContent = `${$('step-check').hidden ? 3 : 4}. 구글 달력에 넣기`;
    connection(); yearOptions();
    const d = days(), events = E.buildEvents(inputData());
    $('result-summary').textContent = `노랑 ${d.yellow.length}일 · 파랑 ${d.blue.length}일을 ${state.analysis ? '찾았습니다' : '골랐습니다'}.`;
    // the example's month is known; a real photo's month is an estimate from the layout (no year in the picture)
    const candidates = state.sample ? [] : (state.analysis?.month?.candidates || []);
    const monthNote = state.sample ? '예시 사진(2027년 1월)입니다. 실제 달력에는 넣지 않고, 저장하지 않아 새로고침하면 처음으로 돌아갑니다.'
      : state.analysis?.month?.source === 'grid' ? '사진에 연도가 없어서 칸 배치(1일의 요일과 그 달 날수)로 달을 추정했습니다. 사진 위 배지 숫자가 사진의 날짜와 같은지 보고, 다르면 바꾸세요.'
        + (candidates.length > 1 ? ' 칸 배치가 같은 달이 더 있어 오늘과 가장 가까운 달로 골랐습니다.' : '')
      : !state.analysis ? '지난번에 고른 달입니다. 다르면 바꾸세요.' : '달을 확실히 읽지 못했습니다. 연·월을 확인해 주세요.';
    $('month-note').textContent = monthNote;
    $('month-candidates').hidden = candidates.length < 2;
    $('month-candidates').replaceChildren(node('span', '칸 배치가 같은 달:'));
    for (const ym of candidates) {  // fixed list and order; the chosen one is pressed
      const [year, month] = ym.split('-').map(Number);
      const b = node('button', `${year}년 ${month}월`); b.type = 'button'; b.dataset.ym = ym; b.disabled = busy || reading;
      b.setAttribute('aria-pressed', String(year === state.year && month === state.month));
      b.onclick = () => { selectionBoundary(true); state.year = year; state.month = month; changed(); }; $('month-candidates').append(b);
    }
    $('week-start-label').hidden = !!state.analysis?.ok && state.analysis.grid.weekStartSource !== 'default';
    $('restore-detected').hidden = !state.image || !state.detected;
    renderCalendar(); drawPhoto();
    for (const c of colors) $('count-' + c).textContent = d[c].length ? `(${d[c].length}일)` : '(0일 · 넣지 않음)';
    $('preview-list').replaceChildren(...events.map(evt => {
      const li = node('li', `${evt.label} · `); li.append(node('span', evt.summary || '(이름을 넣으세요)', evt.summary ? '' : 'muted'), node('span', ` · ${E.COLORS[evt.color].label}`)); return li;
    }));
    // after a run the same button checks again and skips what is in, so it says so (SOP-014 C round 2)
    const again = !testMode() && results.some(r => r.status !== 'pending');
    $('add-button').textContent = `${state.year}년 ${state.month}월 일정 ${events.length}개${testMode() ? ' 넣기 (시험)' : `를 ${targetText(chosen)}에 ${again ? '다시 넣기 (이미 들어간 것은 건너뜀)' : '넣기'}`}`;
    $('add-button').disabled = busy || reading || events.length === 0; $('empty-note').hidden = events.length !== 0;
    $('test-add-note').hidden = !testMode() || events.length === 0;
    $('test-add-note').textContent = state.sample ? '예시라 눌러도 실제 달력에는 넣지 않고 넣을 목록만 보여 줍니다.' : '시험 모드라 눌러도 실제 달력에는 넣지 않고 넣을 목록만 보여 줍니다.';
    for (const id of ['pick-photo', 'try-sample', 'file-input', 'year-select', 'month-select', 'week-start-select', 'name-yellow', 'name-blue', 'restore-detected', 'reset-button', 'login-button', 'logout-button', 'calendar-allow', 'calendar-reload']) $(id).disabled = busy || reading;
    $('target-change').hidden = testMode();
    renderCalendarField(); renderView(); renderInvite(); renderUndo(); showValidation(false);
  }
  // ---- P-009: the calendar to add to ----
  function calendarName(id) { return id === 'primary' ? '내 기본 달력' : (calendars || []).find(c => c.id === id)?.name || '고른 달력'; }
  function targetText(id) { return id === 'primary' ? '내 기본 달력' : `'${calendarName(id)}' 달력`; }
  function renderCalendarField() {
    // the example and test mode never write, so there is nothing to choose
    const show = googleCal.configured && !state.sample;
    $('calendar-pick').hidden = !show;  // its own section before step 2: chosen first, then added (SOP-014 C, D)
    if (!show) return;
    const signed = googleCal.isSignedIn(), options = [{ id: 'primary', name: '내 기본 달력' }, ...(calendars || [])];
    const select = $('calendar-select'), key = JSON.stringify(options);
    if (key !== shownOptions) {
      select.replaceChildren(...options.map(c => { const o = node('option', c.hidden ? `${c.name} (숨긴 달력)` : c.name); o.value = c.id; return o; }));
      shownOptions = key;
    }
    select.value = chosen;
    select.disabled = busy || reading || !signed || !calendars;
    // each person's events go in separately (D-013): say so, so two same-looking events are not taken for a mistake
    const sharedHint = chosen === 'primary' ? '' : ' 같은 날·같은 이름이라도 넣은 사람마다 따로 들어갑니다(서로 덮어쓰지 않음). 누구 일정인지 보이게 이름에 사람을 넣어 주세요(예: 엄마 근무).';
    $('calendar-note').textContent = signed ? calendarNote + sharedHint
      : '로그인하면 넣을 달력을 고를 수 있고, 전에 고른 달력도 다시 나옵니다. 구글 권한 화면이 나오면 캘린더 일정을 보고 수정하는 항목은 꼭, 공유 달력에 넣으려면 캘린더 목록을 보는 항목도 체크해 주세요.';
    $('calendar-allow').hidden = !signed || !!calendars;
    $('calendar-reload').hidden = !signed || !calendars;  // a calendar made in Google Calendar meanwhile (P-012)
  }
  function savedChoices() { const v = readStorage(CALENDAR_KEY); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
  function rememberChoice(id) {
    if (!ownerKey) return;  // without the calendar list the account is unknown: nothing is stored
    const all = savedChoices();
    if (id === 'primary') delete all[ownerKey]; else all[ownerKey] = id;
    writeStorage(CALENDAR_KEY, all);
  }
  // After every sign-in: the calendars this person can write to, their person key and their remembered choice.
  // Without the list (permission left unticked, or reading failed) only the primary calendar and the P-002 ids are used.
  async function loadCalendars() {
    calendars = null; ownerKey = ''; chosen = 'primary'; calendarNote = ''; primaryId = ''; primaryColor = '';
    if (!listGranted) { calendarNote = '내 기본 달력에만 넣습니다. 공유 달력에 넣으려면 아래 단추를 눌러 캘린더 목록을 보는 항목도 허용해 주세요.'; return; }
    try {
      const items = await googleCal.listCalendars(), primary = items.find(c => c.primary);
      if (!primary || !primary.id) throw new Error('no primary calendar in the list');
      const writable = items.filter(c => !c.primary && c.id && ['writer', 'owner'].includes(c.accessRole));
      const list = [...writable.filter(c => !c.hidden), ...writable.filter(c => c.hidden)]
        .map(c => ({ id: c.id, name: E.cleanName(c.summaryOverride || c.summary) || c.id, hidden: !!c.hidden, role: c.accessRole, color: c.backgroundColor || '' }));
      calendars = list; ownerKey = E.ownerKey(primary.id); accountLabel = primary.summaryOverride || primary.summary || primary.id;
      primaryId = primary.id; primaryColor = primary.backgroundColor || '';
      const saved = savedChoices()[ownerKey];
      if (typeof saved === 'string' && saved !== 'primary') {
        if (list.some(c => c.id === saved)) { chosen = saved; calendarNote = `전에 고른 ${targetText(saved)}을 다시 골라 두었습니다. `; }
        else { rememberChoice('primary'); calendarNote = '전에 고른 달력을 목록에서 찾지 못해 내 기본 달력으로 바꿨습니다. '; }
      }
      calendarNote += '공유받은 달력은 초대 메일에서 내 달력 목록에 추가해야 여기에 나옵니다.';
    } catch (_) {
      calendars = null; ownerKey = ''; chosen = 'primary'; primaryId = ''; primaryColor = '';
      calendarNote = '달력 목록을 읽지 못해 내 기본 달력에만 넣습니다. 아래 단추로 다시 읽을 수 있습니다.';
    }
  }
  // ---- P-011: my calendar, one month of the chosen calendar ----
  const pad2 = n => String(n).padStart(2, '0');
  const localDay = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  function shiftDay(iso, delta) {
    const [y, m, d] = iso.split('-').map(Number), t = new Date(Date.UTC(y, m - 1, d + delta));
    return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
  }
  // The days of year-month an event covers. All-day dates stay as they are (end date excluded); timed events use
  // this device's time zone, and one ending at midnight does not reach the next day.
  function coveredDays(ev, year, month) {
    let from, to;
    if (ev.start && ev.start.date) {
      from = ev.start.date; to = shiftDay((ev.end && ev.end.date) || ev.start.date, -1);
      if (to < from) to = from;
    } else if (ev.start && ev.start.dateTime) {
      const s = new Date(ev.start.dateTime), e = new Date((ev.end && ev.end.dateTime) || ev.start.dateTime);
      from = localDay(s); to = localDay(new Date(Math.max(s.getTime(), e.getTime() - 1)));
    } else return [];
    const first = `${year}-${pad2(month)}-01`, last = `${year}-${pad2(month)}-${pad2(E.daysInMonth(year, month))}`;
    const out = [];
    for (let d = from > first ? from : first; d <= (to < last ? to : last); d = shiftDay(d, 1)) out.push(Number(d.slice(8)));
    return out;
  }
  function viewShown() { return googleCal.configured && !state.sample; }
  function setViewMonth(year, month) {
    cancelStroke(false); closeConflict();
    if (view.year !== year || view.month !== month) $('draw-status').textContent = '';
    view.year = year; view.month = month; view.picked = 0;
  }
  // forget what is on screen at once (another calendar, account or the example): a late answer cannot come back
  function dropView(stateName, note) { view.seq++; view.items = []; view.state = stateName; view.note = note || ''; view.picked = 0; }
  function viewFailure(err) {
    if (err.code === 'auth') return '로그인이 끝났습니다. 위의 구글 로그인을 다시 누르면 내 달력이 보입니다.';
    if (['forbidden', 'calendar'].includes(err.code)) return '이 달력을 읽을 수 없습니다(권한이 없거나 목록에서 빠짐). 다른 달력을 고르거나 다시 읽기를 눌러 주세요.';
    if (err.code === 'network') return '인터넷 연결을 확인한 뒤 다시 읽기를 눌러 주세요.';
    return '구글 서버가 잠시 응답하지 않습니다. 잠시 뒤 다시 읽기를 눌러 주세요.';
  }
  async function loadView() {
    if (!viewShown()) return;
    if (!googleCal.isSignedIn()) { dropView('signed-out', '로그인하면 내 달력이 보입니다.'); renderView(); return; }
    dropView('loading', '읽는 중…');
    const key = { seq: view.seq, gen: googleCal.generation(), calendarId: chosen, year: view.year, month: view.month };
    renderView();
    // two days either side, filtered by date below: an all-day event of a calendar in another time zone is not lost
    const timeMin = new Date(key.year, key.month - 1, 1 - 2).toISOString(), timeMax = new Date(key.year, key.month, 1 + 2).toISOString();
    let result, failure;
    try { result = await googleCal.listEvents(key.calendarId, timeMin, timeMax); } catch (err) { failure = err; }
    // an answer for an earlier read, sign-in, calendar or month is dropped (P-011 Codex review 1)
    if (key.seq !== view.seq || key.gen !== googleCal.generation() || key.calendarId !== chosen || !viewShown()) return;
    if (failure) {
      view.state = failure.code === 'auth' ? 'signed-out' : 'error'; view.note = viewFailure(failure);
      renderView(); connection(); return;
    }
    if (!result.complete) {  // never a part shown as the whole month
      view.state = 'partial'; view.note = '일정이 많아 이 달을 다 읽지 못했습니다. 다시 읽기를 누르거나 구글 달력에서 보세요.';
      renderView(); return;
    }
    const startOf = ev => (ev.start && ev.start.dateTime ? new Date(ev.start.dateTime).getTime() : 0);
    view.items = result.items.map(ev => ({ ev, days: coveredDays(ev, key.year, key.month) })).filter(x => x.days.length)
      .sort((a, b) => a.days[0] - b.days[0] || startOf(a.ev) - startOf(b.ev));
    view.state = 'ready'; view.note = view.items.length ? '' : '이 달에는 일정이 없습니다.';
    renderView();
  }
  function colorOf(ev) {
    if (PALETTE[ev.colorId]) return PALETTE[ev.colorId];
    const own = chosen === 'primary' ? primaryColor : ((calendars || []).find(c => c.id === chosen) || {}).color;
    return own || 'var(--accent)';
  }
  function dayText(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return `${m}월 ${d}일 (${weekdays[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]})`;
  }
  function eventText(ev) {
    const isNew = justAdded.calendarId === chosen && justAdded.ids.has(ev.id);
    let when;
    if (ev.start && ev.start.date) {
      const lastDay = shiftDay((ev.end && ev.end.date) || ev.start.date, -1);
      when = lastDay > ev.start.date ? `${dayText(ev.start.date)} ~ ${dayText(lastDay)}` : `${dayText(ev.start.date)} 하루 종일`;
    } else {
      const s = new Date(ev.start.dateTime);
      when = `${dayText(localDay(s))} ${s.toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' })}`;
    }
    return { isNew, text: `${when} · ${E.cleanName(ev.summary) || '(제목 없음)'}${isNew ? ' · 방금 넣음' : ''}` };
  }
  function renderView() {
    if (stroke) { viewDeferred = true; return; }
    viewDeferred = false;
    const focusedDay = drawing && document.activeElement.closest?.('#view-grid') ? Number(document.activeElement.dataset.day) : 0;
    renderDraw();
    const show = viewShown();
    $('my-calendar').hidden = !show;
    if (!show) return;
    if (!view.year) setViewMonth(state.active && !state.sample ? state.year : new Date().getFullYear(), state.active && !state.sample ? state.month : new Date().getMonth() + 1);
    $('my-calendar').dataset.state = view.state;
    $('view-title').textContent = `${view.year}년 ${view.month}월 · ${calendarName(chosen)}`;
    $('view-note').textContent = view.note;
    $('view-retry').hidden = !['error', 'partial'].includes(view.state);
    $('view-open').href = E.monthUrl(view.year, view.month);
    for (const id of ['view-prev', 'view-next', 'view-today']) $(id).disabled = view.state === 'signed-out';
    // before signing in an empty month would read as 'no events': only the guidance shows
    $('view-grid').hidden = $('view-legend').hidden = view.state === 'signed-out';
    $('view-list').hidden = view.state === 'signed-out';
    const counts = {}, byDay = {};
    for (const it of view.items) for (const d of it.days) { counts[d] = (counts[d] || 0) + 1; (byDay[d] = byDay[d] || []).push(it); }
    const weekStart = state.active && !state.sample ? state.weekStart : 0, cells = [];
    for (let c = 0; c < 7; c++) cells.push(node('span', weekdays[(c + weekStart) % 7]));
    for (let c = 0; c < R.firstColumn(view.year, view.month, weekStart); c++) { const blank = node('span'); blank.setAttribute('aria-hidden', 'true'); cells.push(blank); }
    const today = localDay(new Date());
    for (let d = 1; d <= R.daysInMonth(view.year, view.month); d++) {
      const n = counts[d] || 0, b = node('button'); b.type = 'button'; b.dataset.day = d; b.dataset.count = n;
      const weekday = weekdays[new Date(Date.UTC(view.year, view.month - 1, d)).getUTCDay()];
      const pickedColor = state.active && state.year === view.year && state.month === view.month
        ? colors.find(c => state.cells[c].has(dayKey(d))) : null;
      const pickLabel = pickedColor ? E.COLORS[pickedColor].label : '';
      if (pickedColor) b.dataset.pick = pickedColor;
      b.setAttribute('aria-label', `${d}${pickLabel ? ' ' + pickLabel : ''}, ${view.month}월 ${d}일 ${weekday}요일, 일정 ${n}개`);
      if (`${view.year}-${pad2(view.month)}-${pad2(d)}` === today) b.classList.add('today');
      const marks = node('span', undefined, 'marks'); marks.setAttribute('aria-hidden', 'true');
      for (const it of (byDay[d] || []).slice(0, 3)) { const dot = node('span', undefined, 'dot'); dot.style.background = colorOf(it.ev); marks.append(dot); }
      if (n > 3) marks.append(node('span', `+${n - 3}`, 'more'));
      b.append(node('span', d), document.createTextNode(' '), node('small', pickLabel, 'pick-label'), marks);
      b.setAttribute('aria-pressed', String(drawing ? !!pickedColor : view.picked === d)); b.classList.toggle('picked', !drawing && view.picked === d);
      b.onclick = () => {  // a picked day shows its events only; pressing it again shows the whole month
        if (drawing) { applySelection(selectionChange('tap', [d])); return; }
        view.picked = view.picked === d ? 0 : d; renderView();
        const li = $('view-list').querySelector('li[data-id]');
        if (view.picked && li) { li.focus(); li.scrollIntoView({ block: 'nearest' }); }
        else $(view.picked ? 'view-day-title' : 'view-list').scrollIntoView({ block: 'nearest' });
      };
      cells.push(b);
    }
    $('view-grid').replaceChildren(...cells);
    const shown = !drawing && view.picked ? view.items.filter(it => it.days.includes(view.picked)) : view.items;
    $('view-day-title').hidden = $('view-all').hidden = drawing || !view.picked;
    if (view.picked) {
      const iso = `${view.year}-${pad2(view.month)}-${pad2(view.picked)}`;
      $('view-day-title').textContent = shown.length ? `${dayText(iso)} 일정 ${shown.length}개` : `${dayText(iso)}에는 일정이 없습니다.`;
    }
    $('view-list').replaceChildren(...shown.map(it => {
      const { isNew, text } = eventText(it.ev), li = node('li');
      li.dataset.id = it.ev.id; li.dataset.date = `${view.year}-${pad2(view.month)}-${pad2(it.days[0])}`; li.dataset.new = String(isNew); li.tabIndex = -1;
      const swatch = node('span', undefined, 'swatch'); swatch.style.background = colorOf(it.ev); swatch.setAttribute('aria-hidden', 'true');
      li.append(swatch, node('span', text));
      if (/^https:\/\//.test(it.ev.htmlLink || '')) {  // details, editing and deleting stay in Google Calendar
        const a = node('a', '열기', 'open'); a.href = it.ev.htmlLink; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.setAttribute('aria-label', `${E.cleanName(it.ev.summary) || '(제목 없음)'} 구글 달력에서 열기 (새 창)`);
        li.append(a);
      }
      return li;
    }));
    if (focusedDay) focusDay(focusedDay);
  }
  // ---- '방금 넣은 일정 지우기': only what this run added, after one confirmation (SOP-014 evaluators C, D) ----
  function renderUndo() {
    const added = results.filter(r => r.status === 'added' && r.id), can = !testMode() && !!batch && added.length > 0;
    $('undo-run').hidden = !can || undoOpen || busy;  // not a grey button with no reason while adding (SOP-014 C round 2)
    $('undo-run').textContent = `방금 넣은 ${added.length}개 지우기`;
    $('undo-box').hidden = !can || !undoOpen;
    if (can && undoOpen) $('undo-text').textContent = `방금 넣은 ${added.length}개를 ${batch.calendarName}에서 지웁니다. 전에 있던 일정은 그대로 둡니다.`;
    for (const id of ['undo-run', 'undo-confirm', 'undo-cancel']) $(id).disabled = busy || reading;
  }
  // ---- P-012: share the app, invite people to the chosen calendar ----
  const appUrl = () => location.origin + location.pathname;
  const SETTINGS = 'https://calendar.google.com/calendar/r/settings';
  function calendarSettingsUrl(id) {
    const b64 = encodeURIComponent(btoa(unescape(encodeURIComponent(id))).replace(/=+$/, ''));
    return `${SETTINGS}/calendar/${b64}${primaryId ? `?authuser=${encodeURIComponent(primaryId)}` : ''}`;
  }
  function renderInvite() {
    const show = googleCal.configured && !state.sample;
    $('invite').hidden = !show;
    if (!show) return;
    // whose sharing can this person change: the primary calendar and calendars they own; writers ask the owner
    const entry = chosen === 'primary' ? (primaryId ? { id: primaryId, role: 'owner' } : null) : (calendars || []).find(c => c.id === chosen) || null;
    const link = $('invite-settings'), name = targetText(chosen);
    $('invite-owner-note').hidden = true; $('invite-settings-note').hidden = true; link.hidden = false;
    if (entry && entry.role === 'owner') {
      link.href = calendarSettingsUrl(entry.id); link.textContent = `${name} 공유 설정 열기 (새 창)`;
    } else if (entry) {
      link.hidden = true;
      $('invite-owner-note').textContent = `${name}의 공유는 그 달력의 주인만 바꿀 수 있습니다. 같이 쓸 사람을 넣어 달라고 달력 주인에게 부탁하세요. 초대 메시지는 아래 단추로 보낼 수 있습니다.`;
      $('invite-owner-note').hidden = false;
    } else {
      link.href = SETTINGS; link.textContent = '구글 캘린더 설정 열기 (새 창)';
      $('invite-settings-note').textContent = "구글 캘린더 설정 화면 왼쪽 '내 캘린더의 설정'에서 같이 쓸 달력을 고르고, '공유 대상'(특정 사용자와 공유)에 사람을 추가하세요. 내가 주인이 아닌 달력은 주인에게 부탁하세요.";
      $('invite-settings-note').hidden = false;
    }
  }
  function inviteMessage() {
    const name = chosen === 'primary' ? `${accountLabel || '내'} 기본 달력` : calendarName(chosen);
    return `동그라미 일정으로 '${name}' 달력에 같이 일정을 넣어요.\n1. 받은 초대 메일에서 '${name}' 달력을 내 캘린더 목록에 추가하세요.\n`
      // the person invited asks whoever sent this, not an 'operator' they do not know (SOP-014 C round 2)
      + "2. 아래 웹을 열고 구글 로그인을 누르세요. 이 웹은 시험 운영 중이라 쓸 사람을 테스트 사용자로 미리 넣어야 합니다. 구글이 '액세스 차단'이라고 하면 이 메시지를 보낸 나에게 알려 주세요.\n"
      + `3. 로그인할 때 권한 화면에서 캘린더 목록 보기 항목도 허용하고, '내 달력'에서 '${name}'을 고르세요.`;
  }
  // the phone's share sheet, else the clipboard, else the text to copy by hand; closing the sheet is not an error
  async function shareOrCopy(data, copyText, noteId, copiedText) {
    const box = $(noteId);
    // right under the button: what happened, the text in a box when it could not be copied, mail and SMS links
    const show = (message, withText) => {
      const parts = [node('p', message)];
      if (withText) {
        const area = node('textarea'); area.readOnly = true; area.rows = 4; area.textContent = copyText; area.setAttribute('aria-label', '보낼 글');
        parts.push(area);
      }
      const mail = node('a', '메일로 보내기'); mail.href = `mailto:?subject=${encodeURIComponent(data.title)}&body=${encodeURIComponent(copyText)}`;
      const sms = node('a', '문자로 보내기'); sms.href = `sms:?&body=${encodeURIComponent(copyText)}`;
      const links = node('p', undefined, 'send-links'); links.append(mail, sms); parts.push(links);
      box.replaceChildren(...parts); box.hidden = false;
      // as tall as its text, so the whole message is read before sending (SOP-014 C, D round 2)
      const area = box.querySelector('textarea');
      if (area) { area.style.height = 'auto'; area.style.height = `${area.scrollHeight + 2}px`; }
      box.scrollIntoView({ block: 'nearest' });
      if (area) area.select();
    };
    box.replaceChildren(); box.hidden = true;
    if (typeof navigator.share === 'function') {
      try { await navigator.share(data); return; } catch (err) { if (err && err.name === 'AbortError') return; }
    }
    try { await navigator.clipboard.writeText(copyText); show(copiedText, false); }
    catch (_) { show('이 기기에서는 바로 보내거나 복사할 수 없습니다. 아래 글을 골라 복사해 카카오톡 같은 메신저에 붙여 넣거나, 메일·문자로 보내세요.', true); }
  }
  // the target moved away from the one a run (or a press) was made for: another calendar or another account
  function movedFrom(target) { return target.calendarId !== chosen || (!!target.ownerKey && target.ownerKey !== ownerKey); }
  function changed() { selectionVersion++; closeConflict(); clearResults(); save(); render(); }
  function recentNames(add = []) {
    const stored = readStorage(RECENT_KEY), old = Array.isArray(stored) ? stored.filter(v => typeof v === 'string') : [];
    const names = [...new Set([...add, ...old].map(E.cleanName).filter(Boolean))].slice(0, 8);
    if (add.length) writeStorage(RECENT_KEY, names);
    $('recent-names').replaceChildren(...names.map(name => { const o = node('option'); o.value = name; return o; }));
  }
  async function loadPhoto(src, sample, objectURL = false) {
    if (busy || reading) { if (objectURL) URL.revokeObjectURL(src); return; }
    const drawnCount = state.source === 'drawn' ? selectionCount() : 0;
    selectionBoundary(true);
    const sequence = ++photoSequence, start = Date.now(); let showCheck = false; reading = true; $('status').textContent = '사진을 읽는 중…'; render();
    const timer = setInterval(() => { const seconds = Math.floor((Date.now() - start) / 1000); if (seconds >= 10) $('status').textContent = `사진을 읽는 중… ${seconds}초`; }, 1000);
    try {
      const image = new Image();
      await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = src; });
      try { await image.decode(); } catch (_) { /* loaded already; drawImage works without decode() */ }
      await new Promise(resolve => setTimeout(resolve, 0));
      const analysis = R.analyzeSource(image, { today: new Date() });
      if (sequence !== photoSequence) return;
      const next = fresh(); next.names = { ...state.names }; next.source = 'photo'; next.active = true; next.sample = sample; next.image = image; next.analysis = analysis;
      if (analysis.ok) {
        next.year = analysis.month.year; next.month = analysis.month.month; next.weekStart = analysis.grid.weekStart;
        for (const c of colors) next.cells[c] = new Set(analysis.marks[c].map(p => `${p.r}:${p.c}`));
      }
      if (sample) { next.year = 2027; next.month = 1; }
      next.detected = { cells: copyCells(next.cells), weekStart: next.weekStart };
      state = next; validationShown = false; $('restore-note').hidden = true; clearResults(); save();
      // my calendar follows the photo's month; the example steps it aside and drops any read in flight (P-011)
      if (sample) dropView(googleCal.isSignedIn() ? 'loading' : 'signed-out'); else { setViewMonth(state.year, state.month); viewDue = true; }
      $('status').textContent = !analysis.ok ? "달력 칸을 찾지 못했습니다. 달력 앱의 '월' 화면 전체를 캡처한 사진인지 확인해 주세요. 아래 2단계 달력에서 날짜를 직접 골라도 됩니다." :
        !colors.some(c => state.cells[c].size) ? '동그라미를 찾지 못했습니다. 노랑·파랑 펜으로 그렸는지 확인하거나, 아래 2단계 달력에서 날짜를 직접 고르세요.'
          : sample ? '예시 사진을 읽었습니다. 아래 2단계에서 확인해 보세요.' : '사진을 읽었습니다. 아래 2단계에서 달과 날짜를 확인해 주세요.';
      if (drawnCount) $('status').textContent = `그린 날짜 ${drawnCount}개 대신 사진의 날짜로 바꿨습니다. ` + $('status').textContent;
      showCheck = true;
    } catch (_) { $('status').textContent = '사진을 열지 못했습니다. JPG나 PNG 사진을 골라 주세요.'; }
    finally {
      clearInterval(timer); if (objectURL) URL.revokeObjectURL(src); reading = false; render();
      if (viewDue) { viewDue = false; loadView(); }
      // on a phone step 2 starts below the fold: bring it into view so the result is seen
      // instant (not smooth) so it also happens in a background or hidden tab
      if (showCheck) { $('step-check').scrollIntoView({ block: 'start' }); $('check-title').focus({ preventScroll: true }); }
    }
  }
  function resultNode(result) {
    const li = node('li'); li.dataset.date = result.evt.date; li.dataset.color = result.evt.color;
    result.li = li; updateResult(result); return li;
  }
  function updateResult(result) {
    result.li.dataset.status = result.status;
    const label = { test: '시험', added: '넣음', exists: '이미 있어 건너뜀', failed: `실패: ${result.message || ''}`, pending: '대기', deleted: '지움' }[result.status];
    result.li.textContent = `${result.evt.label} · ${result.evt.summary} · ${E.COLORS[result.evt.color].label} — ${label}`;
  }
  async function signIn(consent = false, hint = '') {
    selectionBoundary(true); drawing = false;
    const response = await googleCal.signIn({ consent, hint });
    accountLabel = response.label; listGranted = response.listGranted; $('login-error').hidden = true;
    connection();  // signed in: show it now, the calendar list may take a moment
    dropView('loading', '내 달력을 읽는 중…'); renderView();  // nothing of an earlier account stays on screen
    await loadCalendars(); connection();
    loadView();  // not awaited: adding does not wait for the view
  }
  function summarize(authStopped, where, signInFailed) {
    const count = status => results.filter(r => r.status === status).length;
    $('add-summary').textContent = authStopped ? "로그인이 끝나 멈췄습니다. '실패한 것만 다시'를 누르면 다시 로그인한 뒤 남은 것만 넣습니다." :
      signInFailed ? `${where}: ${results.length}개 모두 넣지 않았습니다.` :
      `${where}: ${results.length}개 중 ` + [[count('added'), '개 넣음'], [count('exists'), '개는 이미 있어 건너뜀'], [count('failed'), '개 실패']].filter(([n]) => n).map(([n, s]) => n + s).join(', ');
    $('retry-failed').hidden = !count('failed'); $('retry-failed').disabled = false;
    $('open-calendar').hidden = !(count('added') || count('exists'));
    $('open-calendar').href = E.monthUrl(state.year, state.month);
    if (count('added') || count('exists')) recentNames(results.filter(r => ['added', 'exists'].includes(r.status)).map(r => r.evt.summary));
  }
  async function add(retry = false) {
    if (busy || reading) return;
    validationShown = true; if (showValidation(true).length) return;
    if (!retry) {
      clearResults(); results = E.buildEvents(inputData()).map(evt => ({ evt, status: 'pending' }));
      $('add-results').replaceChildren(...results.map(resultNode));
      $('preview-list').hidden = true;  // the result rows repeat the same list with their status
    }
    if (testMode()) {
      for (const r of results) {
        r.status = 'test'; updateResult(r);
        const color = E.COLORS[r.evt.color], details = node('details');
        details.append(node('summary', '보낼 내용 보기'),
          node('p', `제목 '${r.evt.summary}', ${r.evt.date} 하루 종일, 색 ${color.label}(구글 색 ${color.googleName})`));
        r.li.append(details);
      }
      $('add-summary').textContent = state.sample ? `예시라 ${results.length}개 모두 실제 달력에는 넣지 않았습니다. 내 달력 사진을 고르면 그 날짜로 넣을 수 있습니다.`
        : `시험 모드라 ${results.length}개 모두 실제 달력에는 넣지 않았습니다. 구글 연결 설정이 끝나면 같은 단추로 이 ${results.length}개가 들어갑니다.`;
      $('add-summary').scrollIntoView({ block: 'nearest' });
      return;
    }
    // the target on screen when pressing; a retry keeps its own run's target (P-009 Codex review 1)
    const pressed = retry && batch ? batch : { calendarId: chosen, ownerKey };
    const couldChoose = !!calendars && calendars.length > 0;
    busy = true; runError = ''; $('add-summary').textContent = ''; $('retry-failed').hidden = true; render();
    let authStopped = false, moved = false, signInFailed = false;
    const queue = results.filter(r => retry ? r.status === 'failed' : true);
    try {
      // signIn is called before the first await, preserving the user's click.
      if (!googleCal.isSignedIn()) {
        await signIn();
        // signing in can bring back a calendar remembered for this account, another account, or calendars to
        // choose from that were not on screen when pressing: nothing goes in before the person has seen them
        moved = movedFrom(pressed) || (!retry && !couldChoose && !!calendars && calendars.length > 0);
        renderCalendarField();
      }
      if (!moved) {
        if (!batch) batch = { calendarId: chosen, calendarName: targetText(chosen), ownerKey };
        for (let i = 0; i < queue.length; i++) {
          const r = queue[i]; $('progress').textContent = `넣는 중 ${i + 1}/${queue.length}`;
          try { const result = await googleCal.insertIfMissing(r.evt, batch); r.status = result.status; r.id = result.id; r.message = ''; updateResult(r); }
          catch (err) {
            r.status = 'failed'; r.message = err.message; updateResult(r);
            if (err.code === 'auth') {
              authStopped = true;
              for (const remaining of queue.slice(i)) { remaining.status = 'failed'; remaining.message = '로그인이 끝나 멈춤'; updateResult(remaining); }
              break;
            }
          }
        }
      }
    } catch (err) {
      // signing in (or its permissions) failed, so nothing was sent: the reason is said once by the button
      for (const r of queue) { r.status = 'failed'; r.message = '넣지 않음'; updateResult(r); }
      authStopped = err.code === 'auth'; signInFailed = !authStopped;
      runError = explain(err, 'add');
    } finally {
      busy = false;
      if (moved) {
        const changed = chosen !== pressed.calendarId;
        clearResults();
        runError = changed ? `넣을 달력이 ${targetText(chosen)}으로 바뀌었습니다. 넣을 달력을 확인한 뒤 다시 눌러 주세요.`
          : '로그인했습니다. 이제 넣을 달력을 고를 수 있습니다. 넣을 달력을 확인한 뒤 다시 눌러 주세요.';
        runInfo = true;  // a notice, not an error: nothing failed
        render();
      } else {
        render(); summarize(authStopped, batch ? batch.calendarName : targetText(pressed.calendarId), signInFailed); $('progress').textContent = '';
        // my calendar shows the month just added, the added and already-there events marked (P-011)
        if (batch) {
          justAdded = { calendarId: batch.calendarId, ids: new Set(results.filter(r => ['added', 'exists'].includes(r.status) && r.id).map(r => r.id)) };
          setViewMonth(state.year, state.month); loadView();
        }
        const added = colors.map(c => `${E.COLORS[c].label} ${queue.filter(r => r.status === 'added' && r.evt.color === c).length}`).join('·');
        const failed = results.filter(r => r.status === 'failed').length;
        $('draw-status').textContent = `넣었습니다: ${added}${failed ? `. 넣지 못한 ${failed}개는 4단계에서 다시` : ''}`;
      }
      $('add-summary').scrollIntoView({ block: 'center' });  // the result is seen without scrolling (SOP-014 D)
    }
  }
  $('pick-photo').onclick = () => $('file-input').click();
  $('file-input').onchange = () => { const file = $('file-input').files[0]; if (file) loadPhoto(URL.createObjectURL(file), false, true); $('file-input').value = ''; };
  $('try-sample').onclick = () => loadPhoto('sample-calendar.png', true);
  for (const [id, field] of [['year-select', 'year'], ['month-select', 'month'], ['week-start-select', 'weekStart']]) $(id).onchange = () => { if (busy || reading) return; selectionBoundary(true); state[field] = Number($(id).value); changed(); };
  for (const c of colors) $('name-' + c).oninput = () => { state.names[c] = $('name-' + c).value; changed(); };
  $('restore-detected').onclick = () => { if (!busy && !reading && state.detected) { selectionBoundary(true); state.cells = copyCells(state.detected.cells); state.weekStart = state.detected.weekStart; changed(); } };
  $('add-button').onclick = () => add(); $('retry-failed').onclick = () => add(true);
  $('reset-button').onclick = () => {
    if (busy || reading) return;
    selectionBoundary(true); drawing = false; $('draw-status').textContent = '';
    try { localStorage.removeItem(STATE_KEY); } catch (_) { /* Optional storage. */ }
    state = fresh(); for (const c of colors) $('name-' + c).value = ''; validationShown = false;
    $('restore-note').hidden = true; $('status').textContent = ''; changed();
  };
  $('login-button').onclick = async () => {
    if (busy || reading) return;
    busy = true; $('login-error').hidden = true; $('account-status').textContent = ''; render();
    try {
      await signIn(); $('account-status').textContent = '구글 달력에 연결했습니다.';
      if (batch && movedFrom(batch)) clearResults();  // another account or calendar: the old run cannot be retried
    } catch (err) { $('login-error').textContent = explain(err, 'login'); $('login-error').hidden = false; }  // next to the button pressed
    finally { busy = false; render(); }
  };
  $('logout-button').onclick = async () => {
    if (busy || reading) return;
    selectionBoundary(true); drawing = false;
    busy = true; render();
    try { await googleCal.signOut(); accountLabel = ''; }
    finally {
      listGranted = false; calendars = null; ownerKey = ''; chosen = 'primary'; calendarNote = ''; clearResults(); $('login-error').hidden = true;
      primaryId = ''; primaryColor = ''; justAdded = { calendarId: '', ids: new Set() };
      dropView('signed-out', '로그인하면 내 달력이 보입니다.');
      $('account-status').textContent = '로그아웃했습니다.';
      busy = false; render();
    }
  };
  $('calendar-select').onchange = () => {
    if (busy || reading) { render(); return; }
    selectionBoundary();
    chosen = $('calendar-select').value; rememberChoice(chosen);
    clearResults(); render();  // a run's results and its retry belong to the calendar it was made for
    loadView();  // my calendar follows the choice; the previous calendar's answer is dropped
  };
  $('calendar-reload').onclick = async () => {
    if (busy || reading) return;
    busy = true; render();
    try { await loadCalendars(); if (batch && movedFrom(batch)) clearResults(); }
    finally { busy = false; render(); loadView(); }
  };
  $('view-prev').onclick = () => { setViewMonth(view.month === 1 ? view.year - 1 : view.year, view.month === 1 ? 12 : view.month - 1); loadView(); };
  $('view-next').onclick = () => { setViewMonth(view.month === 12 ? view.year + 1 : view.year, view.month === 12 ? 1 : view.month + 1); loadView(); };
  $('view-retry').onclick = () => loadView();
  $('view-today').onclick = () => { const t = new Date(); setViewMonth(t.getFullYear(), t.getMonth() + 1); loadView(); };
  $('view-all').onclick = () => { view.picked = 0; renderView(); $('view-list').scrollIntoView({ block: 'nearest' }); };
  $('undo-run').onclick = () => { undoOpen = true; renderUndo(); $('undo-confirm').focus(); };
  $('undo-cancel').onclick = () => { undoOpen = false; renderUndo(); $('undo-run').focus(); };
  $('undo-confirm').onclick = async () => {
    if (busy || reading || !batch) return;
    const targets = results.filter(r => r.status === 'added' && r.id), where = batch.calendarName;
    let removed = 0, failed = 0;
    undoOpen = false; busy = true; runError = ''; render();
    try {
      if (!googleCal.isSignedIn()) {  // signed in again from this click; another account or calendar is not touched
        await signIn();
        if (movedFrom(batch)) { runError = '로그인한 계정이나 달력이 바뀌어 지우지 않았습니다. 확인한 뒤 다시 눌러 주세요.'; failed = targets.length; return; }
      }
      for (const r of targets) {
        try { await googleCal.deleteEvent(batch.calendarId, r.id); r.status = 'deleted'; r.message = ''; removed++; justAdded.ids.delete(r.id); }
        catch (err) { failed++; runError = err.message; if (err.code === 'auth') break; }
        updateResult(r);
      }
    } catch (err) { runError = explain(err, 'add'); failed = targets.length - removed; }
    finally {
      busy = false; render();
      $('add-summary').textContent = `${where}: 방금 넣은 ${removed}개를 지웠습니다.`
        + (failed ? ` ${failed}개는 지우지 못했습니다. 다시 눌러 주세요.` : " 다시 넣으려면 위 '다시 넣기' 단추를 누르세요.");  // SOP-014 C round 2
      renderUndo(); loadView();
    }
  };
  $('share-app').onclick = () => shareOrCopy({ title: '동그라미 일정', text: '달력 사진의 동그라미 날짜를 구글 달력에 넣는 웹입니다.', url: appUrl() },
    appUrl(), 'share-note', '주소를 복사했습니다. 메신저나 문자에 붙여 넣어 보내세요.');
  $('invite-message').onclick = () => {
    const text = inviteMessage();
    shareOrCopy({ title: '동그라미 일정 초대', text, url: appUrl() }, `${text}\n${appUrl()}`, 'invite-note', '초대 메시지를 복사했습니다. 메신저나 문자에 붙여 넣어 보내세요.');
  };
  $('calendar-allow').onclick = async () => {
    if (busy || reading) return;
    busy = true; render();
    try {
      // the list permission was left unticked: ask again from this click; it was given but reading failed: read again
      if (listGranted && googleCal.isSignedIn()) { await loadCalendars(); loadView(); }
      else await signIn(true, /^[^@\s]+@[^@\s]+$/.test(accountLabel) ? accountLabel : '');  // offer the same account
      if (batch && movedFrom(batch)) clearResults();
    } catch (err) { calendarNote = `${err.message} 지금은 내 기본 달력에만 넣습니다.`; }
    finally { busy = false; render(); }
  };
  window.addEventListener('beforeunload', event => { if (busy) { event.preventDefault(); event.returnValue = ''; } });
  const themeKey = 'circle-cal-theme-v1'; let theme = readStorage(themeKey); if (!['auto', 'light', 'dark'].includes(theme)) theme = 'auto';
  function applyTheme() {
    if (theme === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.dataset.theme = theme;
    const now = { auto: '자동', light: '밝게', dark: '어둡게' }[theme];
    $('theme-toggle').textContent = `테마 바꾸기 (지금: ${now})`; $('theme-toggle').setAttribute('aria-label', `테마 바꾸기, 지금 ${now}`);
  }
  $('theme-toggle').onclick = () => { theme = { auto: 'light', light: 'dark', dark: 'auto' }[theme]; writeStorage(themeKey, theme); applyTheme(); }; applyTheme();
  for (let m = 1; m <= 12; m++) { const o = node('option', `${m}월`); o.value = m; $('month-select').append(o); }
  const saved = readStorage(STATE_KEY);
  if (saved && Number.isInteger(saved.year) && saved.year >= 1900 && saved.year <= 9999 && Number.isInteger(saved.month) && saved.month >= 1 && saved.month <= 12 && [0, 1].includes(saved.weekStart)) {
    const cells = emptyCells();
    for (const c of colors) if (Array.isArray(saved.cells?.[c])) cells[c] = new Set(saved.cells[c].filter(k => typeof k === 'string' && /^[0-5]:[0-6]$/.test(k)));
    for (const key of cells.yellow) cells.blue.delete(key);
    if (colors.some(c => cells[c].size)) {
      Object.assign(state, { year: saved.year, month: saved.month, weekStart: saved.weekStart, cells, active: true, source: saved.source === 'drawn' ? 'drawn' : 'photo' });
      for (const c of colors) state.names[c] = typeof saved.names?.[c] === 'string' ? saved.names[c] : '';
      $('restore-note').hidden = false;
    }
  }
  for (const c of colors) $('name-' + c).value = state.names[c];
  recentNames(); render();
  if (googleCal.configured) googleCal.preload().catch(err => { $('status').textContent = err.message; });
})();

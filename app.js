(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const R = window.CircleRecognizer, E = window.CalendarEvents;
  const googleCal = window.GoogleCalendar.create({ clientId: window.APP_CONFIG.googleClientId, calendarId: window.APP_CONFIG.calendarId });
  const colors = E.COLOR_ORDER, weekdays = ['일', '월', '화', '수', '목', '금', '토'];
  const STATE_KEY = 'circle-cal-state-v1', RECENT_KEY = 'circle-cal-recent-names-v1';
  const emptyCells = () => ({ yellow: new Set(), blue: new Set() });
  const copyCells = cells => Object.fromEntries(colors.map(c => [c, new Set(cells[c])]));
  function fresh() {
    const today = new Date();
    return { year: today.getFullYear(), month: today.getMonth() + 1, weekStart: 0, cells: emptyCells(), names: { yellow: '', blue: '' }, active: false, sample: false, image: null, analysis: null, detected: null };
  }
  let state = fresh(), results = [], busy = false, reading = false, accountLabel = '', validationShown = false, photoSequence = 0;
  function readStorage(key) { try { return JSON.parse(localStorage.getItem(key)); } catch (_) { return null; } }
  function writeStorage(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* Storage is optional. */ } }
  function node(tag, text, className) {
    const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (className) n.className = className; return n;
  }
  function save() {
    if (!state.active || state.sample) return;
    writeStorage(STATE_KEY, { year: state.year, month: state.month, weekStart: state.weekStart,
      cells: Object.fromEntries(colors.map(c => [c, [...state.cells[c]]])), names: state.names, savedAt: Date.now() });
  }
  function days() {
    return Object.fromEntries(colors.map(color => [color, [...state.cells[color]].map(key => {
      const [r, c] = key.split(':').map(Number); return R.cellDate(r, c, state.year, state.month, state.weekStart);
    }).filter(d => d !== null).sort((a, b) => a - b)]));
  }
  function inputData() { return { year: state.year, month: state.month, days: days(), names: state.names }; }
  function testMode() { return !googleCal.configured || state.sample; }
  function connection() {
    const signed = googleCal.isSignedIn();
    $('mode-badge').textContent = !googleCal.configured ? '시험 모드' : signed ? `연결됨: ${accountLabel || '구글 달력'}` : '로그인 필요';
    $('login-button').hidden = !googleCal.configured || signed;
    $('logout-button').hidden = !googleCal.configured || !signed;
    $('test-mode-note').hidden = googleCal.configured;
  }
  function clearResults() {
    results = []; $('add-results').replaceChildren(); $('add-summary').textContent = ''; $('progress').textContent = '';
    $('retry-failed').hidden = true; $('open-calendar').hidden = true; $('preview-list').hidden = false;
  }
  function showValidation(focus) {
    for (const c of colors) { $('error-' + c).hidden = true; $('name-' + c).removeAttribute('aria-invalid'); }
    $('add-error').hidden = true;
    const problems = E.validate(inputData());
    if (!validationShown) return problems;
    for (const p of problems) {
      const target = p.field === 'name' ? $('error-' + p.color) : $('add-error');
      target.textContent = p.message; target.hidden = false;
      if (p.color) $('name-' + p.color).setAttribute('aria-invalid', 'true');
    }
    // a short summary next to the button too, so the press visibly answers
    if (problems.length && problems.every(p => p.field === 'name')) {
      $('add-error').textContent = `일정 이름이 비어 있습니다. 위 3단계에서 ${problems.map(p => E.COLORS[p.color].label).join('·')} 이름을 넣어 주세요.`;
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
        state.cells.yellow.delete(key); state.cells.blue.delete(key);
        if (color === 'none') state.cells.yellow.add(key); else if (color === 'yellow') state.cells.blue.add(key);
        changed(); $('mini-calendar').querySelector(`[data-day="${day}"]`).focus({ preventScroll: true });
      });
      children.push(b);
    }
    cal.replaceChildren(...children);
  }
  function render() {
    for (const id of ['step-check', 'step-names', 'step-add']) $(id).hidden = !state.active;
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
      b.onclick = () => { state.year = year; state.month = month; changed(); }; $('month-candidates').append(b);
    }
    $('week-start-label').hidden = !!state.analysis?.ok && state.analysis.grid.weekStartSource !== 'default';
    $('restore-detected').hidden = !state.image || !state.detected;
    renderCalendar(); drawPhoto();
    for (const c of colors) $('count-' + c).textContent = d[c].length ? `(${d[c].length}일)` : '(0일 · 넣지 않음)';
    $('preview-list').replaceChildren(...events.map(evt => {
      const li = node('li', `${evt.label} · `); li.append(node('span', evt.summary || '(이름을 넣으세요)', evt.summary ? '' : 'muted'), node('span', ` · ${E.COLORS[evt.color].label}`)); return li;
    }));
    $('add-button').textContent = `${state.year}년 ${state.month}월 일정 ${events.length}개${testMode() ? ' 넣기 (시험)' : '를 구글 달력에 넣기'}`;
    $('add-button').disabled = busy || reading || events.length === 0; $('empty-note').hidden = events.length !== 0;
    $('test-add-note').hidden = !testMode() || events.length === 0;
    $('test-add-note').textContent = state.sample ? '예시라 눌러도 실제 달력에는 넣지 않고 넣을 목록만 보여 줍니다.' : '시험 모드라 눌러도 실제 달력에는 넣지 않고 넣을 목록만 보여 줍니다.';
    for (const id of ['pick-photo', 'try-sample', 'file-input', 'year-select', 'month-select', 'week-start-select', 'name-yellow', 'name-blue', 'restore-detected', 'reset-button', 'login-button', 'logout-button']) $(id).disabled = busy || reading;
    showValidation(false);
  }
  function changed() { clearResults(); save(); render(); }
  function recentNames(add = []) {
    const stored = readStorage(RECENT_KEY), old = Array.isArray(stored) ? stored.filter(v => typeof v === 'string') : [];
    const names = [...new Set([...add, ...old].map(E.cleanName).filter(Boolean))].slice(0, 8);
    if (add.length) writeStorage(RECENT_KEY, names);
    $('recent-names').replaceChildren(...names.map(name => { const o = node('option'); o.value = name; return o; }));
  }
  async function loadPhoto(src, sample, objectURL = false) {
    if (busy || reading) { if (objectURL) URL.revokeObjectURL(src); return; }
    const sequence = ++photoSequence, start = Date.now(); let showCheck = false; reading = true; $('status').textContent = '사진을 읽는 중…'; render();
    const timer = setInterval(() => { const seconds = Math.floor((Date.now() - start) / 1000); if (seconds >= 10) $('status').textContent = `사진을 읽는 중… ${seconds}초`; }, 1000);
    try {
      const image = new Image();
      await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = src; });
      try { await image.decode(); } catch (_) { /* loaded already; drawImage works without decode() */ }
      await new Promise(resolve => setTimeout(resolve, 0));
      const analysis = R.analyzeSource(image, { today: new Date() });
      if (sequence !== photoSequence) return;
      const next = fresh(); next.names = { ...state.names }; next.active = true; next.sample = sample; next.image = image; next.analysis = analysis;
      if (analysis.ok) {
        next.year = analysis.month.year; next.month = analysis.month.month; next.weekStart = analysis.grid.weekStart;
        for (const c of colors) next.cells[c] = new Set(analysis.marks[c].map(p => `${p.r}:${p.c}`));
      }
      if (sample) { next.year = 2027; next.month = 1; }
      next.detected = { cells: copyCells(next.cells), weekStart: next.weekStart };
      state = next; validationShown = false; $('restore-note').hidden = true; clearResults(); save();
      $('status').textContent = !analysis.ok ? "달력 칸을 찾지 못했습니다. 달력 앱의 '월' 화면 전체를 캡처한 사진인지 확인해 주세요. 아래 2단계 달력에서 날짜를 직접 골라도 됩니다." :
        !colors.some(c => state.cells[c].size) ? '동그라미를 찾지 못했습니다. 노랑·파랑 펜으로 그렸는지 확인하거나, 아래 2단계 달력에서 날짜를 직접 고르세요.'
          : sample ? '예시 사진을 읽었습니다. 아래 2단계에서 확인해 보세요.' : '사진을 읽었습니다. 아래 2단계에서 달과 날짜를 확인해 주세요.';
      showCheck = true;
    } catch (_) { $('status').textContent = '사진을 열지 못했습니다. JPG나 PNG 사진을 골라 주세요.'; }
    finally {
      clearInterval(timer); if (objectURL) URL.revokeObjectURL(src); reading = false; render();
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
    const label = { test: '시험', added: '넣음', exists: '이미 있어 건너뜀', failed: `실패: ${result.message || ''}`, pending: '대기' }[result.status];
    result.li.textContent = `${result.evt.label} · ${result.evt.summary} · ${E.COLORS[result.evt.color].label} — ${label}`;
  }
  async function signIn() { const response = await googleCal.signIn(); accountLabel = response.label; connection(); }
  function summarize(authStopped) {
    const count = status => results.filter(r => r.status === status).length;
    $('add-summary').textContent = authStopped ? "로그인이 끝나 멈췄습니다. '실패한 것만 다시'를 누르면 다시 로그인한 뒤 남은 것만 넣습니다." :
      `${results.length}개 중 ` + [[count('added'), '개 넣음'], [count('exists'), '개는 이미 있어 건너뜀'], [count('failed'), '개 실패']].filter(([n]) => n).map(([n, s]) => n + s).join(', ');
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
    busy = true; $('add-summary').textContent = ''; $('retry-failed').hidden = true; render();
    let authStopped = false;
    const queue = results.filter(r => retry ? r.status === 'failed' : true);
    try {
      // signIn is called before the first await, preserving the user's click.
      if (!googleCal.isSignedIn()) await signIn();
      for (let i = 0; i < queue.length; i++) {
        const r = queue[i]; $('progress').textContent = `넣는 중 ${i + 1}/${queue.length}`;
        try { const result = await googleCal.insertIfMissing(r.evt); r.status = result.status; r.message = ''; updateResult(r); }
        catch (err) {
          r.status = 'failed'; r.message = err.message; updateResult(r);
          if (err.code === 'auth') {
            authStopped = true;
            for (const remaining of queue.slice(i)) { remaining.status = 'failed'; remaining.message = '로그인이 끝나 멈춤'; updateResult(remaining); }
            break;
          }
        }
      }
    } catch (err) {
      for (const r of queue) { r.status = 'failed'; r.message = err.message; updateResult(r); }
      authStopped = err.code === 'auth';
      $('add-error').textContent = err.message; $('add-error').hidden = false;
    } finally {
      busy = false; render(); summarize(authStopped); $('progress').textContent = '';
      $('add-summary').scrollIntoView({ block: 'nearest' });
    }
  }
  $('pick-photo').onclick = () => $('file-input').click();
  $('file-input').onchange = () => { const file = $('file-input').files[0]; if (file) loadPhoto(URL.createObjectURL(file), false, true); $('file-input').value = ''; };
  $('try-sample').onclick = () => loadPhoto('sample-calendar.png', true);
  for (const [id, field] of [['year-select', 'year'], ['month-select', 'month'], ['week-start-select', 'weekStart']]) $(id).onchange = () => { state[field] = Number($(id).value); changed(); };
  for (const c of colors) $('name-' + c).oninput = () => { state.names[c] = $('name-' + c).value; changed(); };
  $('restore-detected').onclick = () => { if (state.detected) { state.cells = copyCells(state.detected.cells); state.weekStart = state.detected.weekStart; changed(); } };
  $('add-button').onclick = () => add(); $('retry-failed').onclick = () => add(true);
  $('reset-button').onclick = () => {
    try { localStorage.removeItem(STATE_KEY); } catch (_) { /* Optional storage. */ }
    state = fresh(); for (const c of colors) $('name-' + c).value = ''; validationShown = false;
    $('restore-note').hidden = true; $('status').textContent = ''; changed();
  };
  $('login-button').onclick = async () => {
    if (busy || reading) return;
    busy = true; render();
    try { await signIn(); $('status').textContent = '구글 달력에 연결했습니다.'; }
    catch (err) { $('status').textContent = err.message; }
    finally { busy = false; render(); }
  };
  $('logout-button').onclick = async () => {
    if (busy || reading) return;
    busy = true; render();
    try { await googleCal.signOut(); accountLabel = ''; }
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
      Object.assign(state, { year: saved.year, month: saved.month, weekStart: saved.weekStart, cells, active: true });
      for (const c of colors) state.names[c] = typeof saved.names?.[c] === 'string' ? saved.names[c] : '';
      $('restore-note').hidden = false;
    }
  }
  for (const c of colors) $('name-' + c).value = state.names[c];
  recentNames(); render();
  if (googleCal.configured) googleCal.preload().catch(err => { $('status').textContent = err.message; });
})();

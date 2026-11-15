(function () {
  'use strict';
  const SCOPE_EVENTS = 'https://www.googleapis.com/auth/calendar.events';
  // P-009: the list of calendars this person can use. Optional: without it only the primary calendar is used.
  const SCOPE_LIST = 'https://www.googleapis.com/auth/calendar.calendarlist.readonly';
  const API = 'https://www.googleapis.com/calendar/v3';
  const messages = {
    auth: '로그인이 끝나 멈춤',
    // whom to ask: the person who told you about this web, not an 'operator' you do not know (SOP-014 C round 2)
    popup_closed: "구글 로그인 창이 닫혔습니다. 다시 눌러 주세요. 구글이 '액세스 차단'이라고 했다면 이 웹을 알려 준 사람에게 내 구글 이메일을 알려 테스트 사용자로 넣어 달라고 하세요.",
    denied: '구글 로그인이 허락되지 않았습니다. 권한 화면에서 허용하지 않았거나, 이 웹을 쓸 수 있는 사람(테스트 사용자)으로 아직 넣지 않은 계정입니다. 이 웹을 알려 준 사람에게 내 구글 이메일을 알려 테스트 사용자로 넣어 달라고 하세요.',
    popup_failed: '팝업이 막혔습니다. 이 사이트의 팝업을 허용한 뒤 다시 눌러 주세요.',
    scope: '구글 권한 화면에서 캘린더 일정을 보고 수정하는 항목을 허용하지 않아 넣을 수 없습니다.',
    forbidden: '구글이 거절했습니다(권한 없음). 이 달력에 일정을 넣을 수 있는 권한인지 확인하고, 로그아웃한 뒤 다시 로그인해 주세요.',
    calendar: '이 달력을 찾지 못했거나 넣을 권한이 없습니다. 넣을 달력을 다시 고른 뒤 눌러 주세요.',
    target: '넣을 달력을 확인하지 못했습니다. 넣을 달력을 다시 고른 뒤 눌러 주세요.',
    network: "인터넷 연결을 확인한 뒤 '실패한 것만 다시'를 눌러 주세요.",
    server: "구글 서버가 잠시 응답하지 않습니다. 잠시 뒤 '실패한 것만 다시'를 눌러 주세요.",
    conflict: '지워진 일정의 새 자리를 만들지 못했습니다. 구글 달력을 확인한 뒤 다시 눌러 주세요.',
  };
  const error = (code, message) => Object.assign(new Error(message || messages[code]), { code });
  window.GoogleCalendar = { create({ clientId, fetchImpl = window.fetch.bind(window) }) {
    const configured = !!clientId;
    // generation goes up with every token, so callers can drop answers that belong to an earlier sign-in (P-011)
    let token = '', expires = 0, listGranted = false, generation = 0, loading, client, pending;
    function clear() { token = ''; expires = 0; listGranted = false; }
    function isSignedIn() { if (Date.now() >= expires) clear(); return !!token; }
    function init() {
      client = window.google.accounts.oauth2.initTokenClient({
        client_id: clientId, scope: `${SCOPE_EVENTS} ${SCOPE_LIST}`,
        callback(resp) {
          if (!pending) return;
          const p = pending; pending = null;
          const oauth = window.google.accounts.oauth2;
          // access_denied: the user refused, or (Testing status) the account is not a test user (D-012).
          // A second ask for the list permission (p.keep) leaves the token already held when it fails.
          if (resp.error) { if (!p.keep) clear(); p.reject(error(resp.error === 'access_denied' ? 'denied' : 'scope')); return; }
          // the events permission is required; the list permission may be left unticked (checked one by one)
          if (!oauth.hasGrantedAllScopes(resp, SCOPE_EVENTS)) { if (!p.keep) clear(); p.reject(error('scope')); return; }
          token = resp.access_token; expires = Date.now() + Math.max(0, Number(resp.expires_in) - 60) * 1000;
          listGranted = oauth.hasGrantedAllScopes(resp, SCOPE_LIST); generation++;
          p.resolve();
        },
        error_callback(resp) {
          if (!pending) return;
          const p = pending; pending = null;
          p.reject(error(resp.type === 'popup_closed' ? 'popup_closed' : 'popup_failed'));
        },
      });
    }
    function preload() {
      if (!configured) return Promise.resolve();
      if (client) return Promise.resolve();
      if (loading) return loading;
      loading = new Promise((resolve, reject) => {
        if (window.google?.accounts?.oauth2) { init(); resolve(); return; }
        const script = document.createElement('script'); script.src = 'https://accounts.google.com/gsi/client'; script.async = true;
        script.onload = () => { try { init(); resolve(); } catch (_) { reject(error('network')); } };
        script.onerror = () => { script.remove(); loading = null; reject(error('network')); };
        document.head.append(script);
      });
      return loading;
    }
    async function request(url, options = {}) {
      if (!isSignedIn()) throw error('auth');
      const used = token;
      let res, body;
      try {
        res = await fetchImpl(url, { ...options, headers: { ...options.headers, Authorization: `Bearer ${used}` } });
      } catch (_) {
        throw error('network', options.method === 'POST' ? "응답을 받지 못했습니다(들어갔는지 확인 못 함). '실패한 것만 다시'를 누르면 이미 들어간 것은 건너뜁니다." : undefined);
      }
      // a 401 for an older token must not sign out a newer one (P-011 Codex review 1)
      if (res.status === 401) { if (token === used) clear(); throw error('auth'); }
      try { body = await res.json(); } catch (_) { body = {}; }
      if (res.status === 403) {
        const reasons = body?.error?.errors || [];
        throw error(reasons.some(e => ['rateLimitExceeded', 'userRateLimitExceeded'].includes(e.reason)) ? 'server' : 'forbidden');
      }
      if (res.status === 429 || res.status >= 500) throw error('server');
      return { status: res.status, body };
    }
    // consent: show the permission screen again, to get the list permission the person left unticked (P-009);
    // hint: the signed-in account's address, so Google offers that account rather than another one on the device
    function signIn({ consent = false, hint = '' } = {}) {
      if (!configured) return Promise.reject(error('scope'));
      const keep = consent && isSignedIn();
      const start = () => new Promise((resolve, reject) => {
        if (pending) { reject(error('popup_failed')); return; }
        pending = { resolve, reject, keep };
        try { client.requestAccessToken(Object.assign({ prompt: consent ? 'consent' : '' }, hint ? { login_hint: hint } : {})); }
        catch (_) { pending = null; reject(error('popup_failed')); }
      });
      // With preloading finished, requestAccessToken runs synchronously in the click.
      const access = client ? start() : preload().then(start);
      return access.then(async () => {
        if (listGranted) return { listGranted: true, label: '' };  // the account name comes with the calendar list
        const r = await request(`${API}/calendars/primary/events?maxResults=1`);
        if (r.status !== 200) throw error('server');
        return { listGranted: false, label: r.body.summary || '구글 달력' };
      });
    }
    // calendarList.list: calendars this person can add events to (writer or owner), hidden ones included, every page
    async function listCalendars() {
      if (!listGranted) throw error('scope');
      const items = [];
      let pageToken = '';
      for (let page = 0; page < 20; page++) {
        const query = new URLSearchParams({ minAccessRole: 'writer', showHidden: 'true', maxResults: '250' });
        if (pageToken) query.set('pageToken', pageToken);
        const r = await request(`${API}/users/me/calendarList?${query}`);
        if (r.status !== 200) throw error('server');
        if (Array.isArray(r.body.items)) items.push(...r.body.items);
        pageToken = r.body.nextPageToken || '';
        if (!pageToken) return items;
      }
      throw error('server');  // more pages than any real list: show none rather than part of it
    }
    // events.list of one calendar between two instants, every page (P-011). calendar.events is enough to read.
    // complete: false when more pages remain than the app reads, so a part is never shown as the whole month.
    async function listEvents(calendarId, timeMin, timeMax) {
      const base = `${API}/calendars/${encodeURIComponent(calendarId || 'primary')}/events`;
      const items = [];
      let pageToken = '';
      for (let page = 0; page < 20; page++) {
        const query = new URLSearchParams({ timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: '250' });
        if (pageToken) query.set('pageToken', pageToken);
        const r = await request(`${base}?${query}`);
        if (r.status === 404) throw error('calendar');
        if (r.status !== 200) throw error('server');
        if (Array.isArray(r.body.items)) items.push(...r.body.items);
        pageToken = r.body.nextPageToken || '';
        if (!pageToken) return { items, complete: true };
      }
      return { items, complete: false };
    }
    // events.delete of one event this app added in the current run ('방금 넣은 일정 지우기', SOP-014 evaluators).
    // Already gone (404, 410) counts as gone.
    async function deleteEvent(calendarId, eventId) {
      const r = await request(`${API}/calendars/${encodeURIComponent(calendarId || 'primary')}/events/${encodeURIComponent(eventId)}`, { method: 'DELETE' });
      if ([200, 204, 404, 410].includes(r.status)) return;
      throw error('server');
    }
    // target: { calendarId, ownerKey }, fixed for the whole run. The primary calendar keeps the P-002 ids (D-007).
    async function insertIfMissing(evt, target = {}) {
      const calendarId = target.calendarId || 'primary', owner = calendarId === 'primary' ? '' : target.ownerKey;
      if (calendarId !== 'primary' && !owner) throw error('target');
      const base = `${API}/calendars/${encodeURIComponent(calendarId)}/events`;
      for (let attempt = 0; attempt <= 3; attempt++) {
        const id = window.CalendarEvents.eventId(evt, attempt, owner), url = `${base}/${id}`;
        let r = await request(url);
        if (r.status === 200) { if (r.body.status !== 'cancelled') return { status: 'exists', id }; continue; }
        if (![404, 410].includes(r.status)) throw error('server');
        r = await request(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({}, evt.body, { id })) });
        if ([200, 201].includes(r.status)) return { status: 'added', id, htmlLink: r.body.htmlLink };
        if (r.status === 404) throw error('calendar');
        if (r.status === 409) {
          r = await request(url);
          if (r.status === 200 && r.body.status !== 'cancelled') return { status: 'exists', id };
          if (r.status === 200 || [404, 410].includes(r.status)) continue;
        }
        throw error('server');
      }
      throw error('conflict');
    }
    function signOut() {
      const old = token;
      return new Promise(resolve => {
        if (!old || !window.google?.accounts?.oauth2) { clear(); resolve(); return; }
        try { window.google.accounts.oauth2.revoke(old, () => { clear(); resolve(); }); }
        catch (_) { clear(); resolve(); }
      });
    }
    return { configured, preload, signIn, isSignedIn, signOut, listCalendars, listEvents, insertIfMissing, deleteEvent, generation: () => generation };
  } };
})();

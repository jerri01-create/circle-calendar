(function () {
  'use strict';
  const SCOPE = 'https://www.googleapis.com/auth/calendar.events';
  const messages = {
    auth: '로그인이 끝나 멈춤',
    popup_closed: "구글 로그인 창이 닫혔습니다. 다시 눌러 주세요. 구글이 '액세스 차단'이라고 했다면 운영자에게 내 구글 이메일을 테스트 사용자로 넣어 달라고 하세요.",
    denied: '구글 로그인이 허락되지 않았습니다. 권한 화면에서 허용하지 않았거나, 이 웹을 쓸 수 있는 사람(테스트 사용자)으로 아직 넣지 않은 계정입니다. 운영자에게 내 구글 이메일을 테스트 사용자로 넣어 달라고 하세요.',
    popup_failed: '팝업이 막혔습니다. 이 사이트의 팝업을 허용한 뒤 다시 눌러 주세요.',
    scope: '달력 권한을 허용해야 넣을 수 있습니다. 다시 눌러 권한 화면에서 달력 항목을 허용해 주세요.',
    forbidden: '구글이 거절했습니다(권한 없음). 로그아웃한 뒤 다시 로그인해 주세요.',
    network: "인터넷 연결을 확인한 뒤 '실패한 것만 다시'를 눌러 주세요.",
    server: "구글 서버가 잠시 응답하지 않습니다. 잠시 뒤 '실패한 것만 다시'를 눌러 주세요.",
    conflict: '지워진 일정의 새 자리를 만들지 못했습니다. 구글 달력을 확인한 뒤 다시 눌러 주세요.',
  };
  const error = (code, message) => Object.assign(new Error(message || messages[code]), { code });
  window.GoogleCalendar = { create({ clientId, calendarId = 'primary', fetchImpl = window.fetch.bind(window) }) {
    const configured = !!clientId;
    const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
    let token = '', expires = 0, loading, client, pending;
    function clear() { token = ''; expires = 0; }
    function isSignedIn() { if (Date.now() >= expires) clear(); return !!token; }
    function init() {
      client = window.google.accounts.oauth2.initTokenClient({
        client_id: clientId, scope: SCOPE,
        callback(resp) {
          if (!pending) return;
          const p = pending; pending = null;
          // access_denied: the user refused, or (Testing status) the account is not a test user (D-012)
          if (resp.error) { clear(); p.reject(error(resp.error === 'access_denied' ? 'denied' : 'scope')); return; }
          if (!window.google.accounts.oauth2.hasGrantedAllScopes(resp, SCOPE)) { clear(); p.reject(error('scope')); return; }
          token = resp.access_token; expires = Date.now() + Math.max(0, Number(resp.expires_in) - 60) * 1000;
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
      let res, body;
      try {
        res = await fetchImpl(url, { ...options, headers: { ...options.headers, Authorization: `Bearer ${token}` } });
      } catch (_) {
        throw error('network', options.method === 'POST' ? "응답을 받지 못했습니다(들어갔는지 확인 못 함). '실패한 것만 다시'를 누르면 이미 들어간 것은 건너뜁니다." : undefined);
      }
      if (res.status === 401) { clear(); throw error('auth'); }
      try { body = await res.json(); } catch (_) { body = {}; }
      if (res.status === 403) {
        const reasons = body?.error?.errors || [];
        throw error(reasons.some(e => ['rateLimitExceeded', 'userRateLimitExceeded'].includes(e.reason)) ? 'server' : 'forbidden');
      }
      if (res.status === 429 || res.status >= 500) throw error('server');
      return { status: res.status, body };
    }
    function signIn() {
      if (!configured) return Promise.reject(error('scope'));
      const start = () => new Promise((resolve, reject) => {
        if (pending) { reject(error('popup_failed')); return; }
        pending = { resolve, reject };
        try { client.requestAccessToken({ prompt: '' }); } catch (_) { pending = null; reject(error('popup_failed')); }
      });
      // With preloading finished, requestAccessToken runs synchronously in the click.
      const access = client ? start() : preload().then(start);
      return access.then(async () => {
        const r = await request(`${base}?maxResults=1`);
        if (r.status !== 200) throw error('server');
        return { label: r.body.summary || '구글 달력' };
      });
    }
    async function insertIfMissing(evt) {
      for (let attempt = 0; attempt <= 3; attempt++) {
        const id = window.CalendarEvents.eventId(evt, attempt), url = `${base}/${id}`;
        let r = await request(url);
        if (r.status === 200) { if (r.body.status !== 'cancelled') return { status: 'exists', id }; continue; }
        if (![404, 410].includes(r.status)) throw error('server');
        r = await request(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({}, evt.body, { id })) });
        if ([200, 201].includes(r.status)) return { status: 'added', id, htmlLink: r.body.htmlLink };
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
    return { configured, preload, signIn, isSignedIn, signOut, insertIfMissing };
  } };
})();

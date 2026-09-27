/* NORDIC NEXUS · standalone edition — Supabase adapter + sign-in.
   Gives the app the same db / user / assets / sample / downloads interfaces it used inside Claude,
   so the main app code stays almost unchanged. */
(function () {
  'use strict';
  const CFG = window.NEXUS_CONFIG || {};
  const sb = window.supabase.createClient(CFG.url, CFG.key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'nexus-auth' }
  });
  window.NX_SB = sb;
  let profile = null, session = null;

  /* ---------------- small helpers ---------------- */
  const h = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const clean = o => JSON.parse(JSON.stringify(o ?? {}));
  function mapErr(e) {
    const msg = e?.message || String(e || 'error');
    const err = new Error(msg);
    if (e?.code === '42501' || e?.code === 'P0002' || /row-level security|not allowed|permission/i.test(msg)) err.code = 'invalid_argument';
    else if (/quota|exceed|too large|payload/i.test(msg)) err.code = 'quota_exceeded';
    else if (/fetch|network|Failed to fetch/i.test(msg)) err.message = 'No connection to the NEXUS server. Check the internet and try again.';
    return err;
  }
  function splitPath(p) {
    const m = /^data\/users\/([^/]+)\/notif$/.exec(p);
    if (m) return ['notif', m[1]];
    const i = p.lastIndexOf('/');
    return [p.slice(0, i), p.slice(i + 1)];
  }

  /* ---------------- database: collections + documents with live updates ---------------- */
  const colSubs = new Map();   // col -> Set<{cb, cache:Map, limit}>
  const docSubs = new Map();   // "col/id" -> Set<cb>
  let channel = null, wasDown = false;

  const colSnap = cache => ({ docs: [...cache.values()].map(r => ({ id: r.id, data: () => r.data })) });
  const docSnap = (id, r) => ({ id, exists: !!r, data: () => (r ? r.data : undefined) });

  function applyRow(col, id, data /* null = deleted */) {
    const subs = colSubs.get(col);
    if (subs) for (const s of subs) {
      if (data === null) s.cache.delete(id); else s.cache.set(id, { id, data });
      try { s.cb(colSnap(s.cache)); } catch (e) { console.warn(e); }
    }
    const ds = docSubs.get(col + '/' + id);
    if (ds) for (const cb of ds) { try { cb(docSnap(id, data === null ? null : { data })); } catch (e) { console.warn(e); } }
  }
  function ensureChannel() {
    if (channel) return;
    channel = sb.channel('nexus-docs')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'docs' }, p => {
        if (p.eventType === 'DELETE') { const o = p.old || {}; if (o.col) applyRow(o.col, o.id, null); }
        else { const n = p.new || {}; if (n.col) applyRow(n.col, n.id, n.data); }
      })
      .subscribe(status => {
        if (status === 'SUBSCRIBED') { if (wasDown) { wasDown = false; resyncAll(); } setLive(true); }
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') { wasDown = true; setLive(false); }
      });
  }
  function setLive(ok) { const el = document.getElementById('syncState'); if (el) el.textContent = ok ? 'Live · synced' : 'Reconnecting…'; }

  async function fetchCol(col, limit) {
    const { data, error } = await sb.from('docs').select('id,data').eq('col', col).order('updated_at', { ascending: false }).limit(limit || 1000);
    if (error) throw mapErr(error);
    return data;
  }
  async function fetchDoc(col, id) {
    const { data, error } = await sb.from('docs').select('data').eq('col', col).eq('id', id).maybeSingle();
    if (error) throw mapErr(error);
    return data;
  }
  async function resyncAll() {
    for (const [col, subs] of colSubs) for (const s of subs) {
      try { const rows = await fetchCol(col, s.limit); s.cache = new Map(rows.map(r => [r.id, r])); s.cb(colSnap(s.cache)); } catch (e) { console.warn(e); }
    }
    for (const [key, cbs] of docSubs) {
      const [col, id] = splitPath(key);
      try { const r = await fetchDoc(col, id); for (const cb of cbs) cb(docSnap(id, r)); } catch (e) { console.warn(e); }
    }
  }
  window.addEventListener('online', () => resyncAll());
  document.addEventListener('visibilitychange', () => { if (!document.hidden && wasDown) resyncAll(); });

  const db = {
    collection(col) {
      const q = { _limit: 1000 };
      q.limit = n => { q._limit = n; return q; };
      q.get = async () => colSnap(new Map((await fetchCol(col, q._limit)).map(r => [r.id, r])));
      q.onSnapshot = (cb, onErr) => {
        const s = { cb, cache: new Map(), limit: q._limit };
        if (!colSubs.has(col)) colSubs.set(col, new Set());
        colSubs.get(col).add(s);
        ensureChannel();
        fetchCol(col, q._limit).then(rows => { s.cache = new Map(rows.map(r => [r.id, r])); cb(colSnap(s.cache)); })
          .catch(e => onErr && onErr(e));
        return () => colSubs.get(col)?.delete(s);
      };
      return q;
    },
    doc(path) {
      const [col, id] = splitPath(path);
      return {
        id,
        async get() { return docSnap(id, await fetchDoc(col, id)); },
        async set(obj) {
          const data = clean(obj);
          const { error } = await sb.from('docs').upsert({ col, id, data });
          if (error) throw mapErr(error);
          applyRow(col, id, data);
        },
        async update(obj) {
          const patch = clean(obj);
          const { error } = await sb.rpc('doc_merge', { c: col, i: id, patch });
          if (error) throw mapErr(error);
          const r = await fetchDoc(col, id).catch(() => null);
          if (r) applyRow(col, id, r.data);
        },
        async delete() {
          const { error } = await sb.from('docs').delete().eq('col', col).eq('id', id);
          if (error) throw mapErr(error);
          applyRow(col, id, null);
        },
        onSnapshot(cb, onErr) {
          const key = col + '/' + id;
          if (!docSubs.has(key)) docSubs.set(key, new Set());
          docSubs.get(key).add(cb);
          ensureChannel();
          fetchDoc(col, id).then(r => cb(docSnap(id, r))).catch(e => onErr && onErr(e));
          return () => docSubs.get(key)?.delete(cb);
        }
      };
    }
  };

  /* ---------------- user ---------------- */
  const user = {
    async me() { return { id: session.user.id, name: profile?.name || session.user.email, email: session.user.email, avatarUrl: '', role: profile?.role }; },
    async canEdit() { return profile?.role === 'admin'; },
    async can(what) { if (what === 'data.write') return profile?.role !== 'viewer'; return true; },
    async isFinance() { return profile?.role === 'finance'; }
  };

  /* ---------------- files (site photos, tender documents) ---------------- */
  const TEN_YEARS = 60 * 60 * 24 * 365 * 10;
  const assets = {
    async upload(blob, opts = {}) {
      const type = opts.type || blob.type || 'application/octet-stream';
      const name = (blob.name || '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80);
      const ext = name.includes('.') ? '' : ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'application/pdf': '.pdf' }[type] || '');
      const d = new Date();
      const path = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${uid()}-${name || 'file'}${ext}`;
      const up = await sb.storage.from('files').upload(path, blob, { contentType: type, upsert: false });
      if (up.error) throw mapErr(up.error);
      const s = await sb.storage.from('files').createSignedUrl(path, TEN_YEARS);
      if (s.error) throw mapErr(s.error);
      return { url: s.data.signedUrl, path };
    }
  };

  /* ---------------- AI (Gemini through the "ai" server function) ---------------- */
  async function callAI(payload) {
    const { data, error } = await sb.functions.invoke('ai', { body: { ...payload, kind: window.NX_AI_KIND || '' } });
    if (error) {
      let body = null; try { body = await error.context?.json(); } catch (_) {}
      const e = new Error(body?.message || body?.error || error.message);
      if (body?.error === 'rate_limited') e.code = 'rate_limited';
      throw e;
    }
    return data;
  }
  const toPayload = x => Array.isArray(x) ? { turns: x } : { prompt: String(x) };
  // AI answers are shown as plain text: remove markdown marks (**bold**, # headings, * bullets)
  const plain = t => String(t || '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1')
    .replace(/^#{1,6}\s*/gm, '').replace(/^\s*[*•]\s+/gm, '- ').replace(/`([^`]+)`/g, '$1').replace(/\n{3,}/g, '\n\n').trim();
  const sample = async (x, o = {}) => {
    const d = await callAI({ ...toPayload(x), ...(o && o.web ? { web: true } : {}) });
    return { text: plain(d.text), sources: Array.isArray(d.sources) ? d.sources : [], web: !!d.web };
  };
  sample.json = async (x) => {
    const d = await callAI({ ...toPayload(x), json: true });
    const t = String(d.text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    try { return JSON.parse(t); } catch (_) { const e = new Error('invalid json'); e.code = 'invalid_json'; throw e; }
  };

  /* ---------------- downloads ---------------- */
  const downloads = {
    async save({ filename, data, type }) {
      const blob = data instanceof Blob ? data : new Blob([data], { type: type || (typeof data === 'string' ? 'text/plain;charset=utf-8' : 'application/octet-stream') });
      if (window.NX_NATIVE_SAVE) return window.NX_NATIVE_SAVE(filename, blob);   // set by the Android app wrapper
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename || 'download';
      document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
    }
  };

  window.claude = { use: async n => ({ db, user, sample, assets, downloads })[n] || null };

  /* ================= sign-in screens ================= */
  const css = `
  .nxa{position:fixed;inset:0;z-index:200;background:#182340;display:grid;place-items:center;padding:16px;font:14px/1.5 "IBM Plex Sans",system-ui,sans-serif;color:#182340}
  .nxa .box{background:#FAFBFC;border-radius:10px;width:min(400px,100%);padding:26px 24px;display:flex;flex-direction:column;gap:12px;box-shadow:0 10px 40px rgba(0,0,0,.35)}
  .nxa .hz{height:8px;margin:-26px -24px 8px;border-radius:10px 10px 0 0;background:repeating-linear-gradient(-45deg,#F2A900 0 12px,#182340 12px 24px)}
  .nxa h1{font:700 30px/1 "Barlow Condensed",Arial,sans-serif;letter-spacing:.04em;margin:0;text-transform:uppercase}
  .nxa h1 span{color:#539FDC}.nxa p{margin:0;color:#5A6580;font-size:13px}
  .nxa label{font-size:12px;font-weight:600;color:#5A6580;display:flex;flex-direction:column;gap:4px}
  .nxa input,.nxa select{font:inherit;border:1px solid #D4DAE3;border-radius:6px;padding:9px 11px;background:#fff;color:#182340}
  .nxa button{font:inherit;cursor:pointer;border-radius:6px;padding:10px 14px;border:1px solid #D4DAE3;background:#fff;color:#182340}
  .nxa button.pri{background:#539FDC;border-color:#539FDC;color:#0E1830;font-weight:600}
  .nxa .err{color:#B8402A;font-size:13px;min-height:1em}
  .nxa .lnk{background:none;border:0;padding:0;color:#2F6DB5;text-align:left;font-size:13px}
  .nxa .logo{display:flex;align-items:center;gap:10px}.nxa .logo img{height:36px}
  .nxm{position:fixed;inset:0;z-index:150;background:rgba(12,17,21,.5);display:grid;place-items:center;padding:16px}
  .nxm .box{background:var(--panel,#fff);color:var(--ink,#182340);border-radius:8px;width:min(760px,100%);max-height:90vh;overflow:auto;padding:18px;display:flex;flex-direction:column;gap:12px}
  .nxm table{width:100%;border-collapse:collapse;font-size:13px}.nxm td,.nxm th{padding:7px 6px;border-bottom:1px solid var(--line,#D4DAE3);text-align:left;vertical-align:middle}
  .nxm input,.nxm select{font:inherit;border:1px solid var(--line,#D4DAE3);border-radius:5px;padding:6px 8px;background:var(--panel,#fff);color:inherit;min-width:0}
  .nxm .row{display:flex;gap:8px;flex-wrap:wrap;align-items:end}.nxm .row label{display:flex;flex-direction:column;font-size:12px;gap:3px;flex:1;min-width:140px}
  .nxw{position:fixed;z-index:120;background:var(--panel,#fff);color:var(--ink,#182340);border:1px solid var(--line,#D4DAE3);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.18);padding:8px;display:flex;flex-direction:column;min-width:220px}
  .nxw button{all:unset;cursor:pointer;padding:8px 10px;border-radius:5px;font-size:13px}.nxw button:hover{background:var(--panel2,#F0F3F7)}
  .nxw .who2{padding:6px 10px 10px;border-bottom:1px solid var(--line,#D4DAE3);margin-bottom:4px;font-size:12.5px}`;
  const st = document.createElement('style'); st.textContent = css; document.head.append(st);

  const logoSrc = () => document.querySelector('#brandMark img')?.src || '';
  function screen(inner) {
    let w = document.getElementById('nxAuth');
    if (!w) { w = document.createElement('div'); w.id = 'nxAuth'; w.className = 'nxa'; document.body.append(w); }
    w.innerHTML = `<form class="box" autocomplete="on" novalidate><div class="hz"></div><div class="logo"><img alt="" src="${logoSrc()}"><h1>Nordic <span>Nexus</span></h1></div>${inner}</form>`;
    return w.querySelector('form');
  }
  const closeScreen = () => document.getElementById('nxAuth')?.remove();

  function loginScreen(msg) {
    return new Promise(res => {
      const f = screen(`<p>Sign in with your NEXUS email and password.</p>
        <label>Email<input name="email" type="email" autocomplete="username" required></label>
        <label>Password<input name="pw" type="password" autocomplete="current-password" required></label>
        <div class="err" role="alert">${h(msg || '')}</div>
        <button class="pri" type="submit">Sign in</button>
        <button class="lnk" type="button" data-forgot>Forgot password?</button>
        <p style="border-top:1px solid #D4DAE3;padding-top:10px;margin-top:4px">New to NEXUS? <button class="lnk" type="button" data-register>Sign up</button></p>
        ${/NordicNexusAndroid/.test(navigator.userAgent) ? '' : '<p class="small" style="margin:0;color:#5A6580">Get the app: <a href="downloads/NORDIC-NEXUS.apk" download>Android</a> · <a href="downloads/NORDIC-NEXUS-Setup.exe" download>Windows</a></p>'}`);
      f.email.focus();
      f.querySelector('[data-register]').onclick = () => registerScreen().then(res);
      f.querySelector('[data-forgot]').onclick = () => { f.querySelector('.err').textContent = 'Ask a NEXUS administrator to set a new temporary password for you.'; };
      f.onsubmit = async e => {
        e.preventDefault();
        const b = f.querySelector('button.pri'); b.disabled = true; b.textContent = 'Signing in…';
        const { data, error } = await sb.auth.signInWithPassword({ email: f.email.value.trim(), password: f.pw.value });
        b.disabled = false; b.textContent = 'Sign in';
        if (error) { f.querySelector('.err').textContent = /invalid/i.test(error.message) ? 'Wrong email or password.' : /banned/i.test(error.message) ? 'This login has been switched off. Contact an administrator.' : error.message; return; }
        res(data.session);
      };
    });
  }
  function registerScreen() {
    return new Promise(res => {
      const f = screen(`<p><b>Sign up.</b> Fill in your details and choose a password. An administrator approves your sign-up before you can open NEXUS.</p>
        <label>Full name<input name="name" required autocomplete="name"></label>
        <label>Work email<input name="email" type="email" required autocomplete="email"></label>
        <label>Position<input name="position" placeholder="e.g. Site Engineer, QS, Storekeeper"></label>
        <label>Mobile<input name="phone" type="tel" placeholder="+255…" autocomplete="tel"></label>
        <label>Choose a password (10+)<input name="p1" type="password" autocomplete="new-password" required minlength="10"></label>
        <label>Repeat password<input name="p2" type="password" autocomplete="new-password" required></label>
        <div class="err" role="alert"></div>
        <button class="pri" type="submit">Sign up</button>
        <button class="lnk" type="button" data-back>Back to sign in</button>`);
      f.elements.namedItem('name').focus();
      f.querySelector('[data-back]').onclick = () => loginScreen().then(res);
      f.onsubmit = async e => {
        e.preventDefault();
        const v = k => f.elements.namedItem(k).value.trim(), er = f.querySelector('.err');
        if (v('name').length < 3) { er.textContent = 'Enter your full name.'; return; }
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v('email'))) { er.textContent = 'Enter a valid email.'; return; }
        if (f.p1.value.length < 10) { er.textContent = 'Use at least 10 characters for the password.'; return; }
        if (f.p1.value !== f.p2.value) { er.textContent = 'The two passwords are different.'; return; }
        const b = f.querySelector('button.pri'); b.disabled = true; b.textContent = 'Sending…';
        const { data, error } = await sb.auth.signUp({ email: v('email').toLowerCase(), password: f.p1.value,
          options: { data: { name: v('name'), position: v('position'), phone: v('phone') } } });
        b.disabled = false; b.textContent = 'Sign up';
        if (error) { er.textContent = /registered|exists/i.test(error.message) ? 'This email is already signed up. Sign in, or ask an administrator.' : /signups? not allowed|disabled/i.test(error.message) ? 'Self-registration is switched off. Ask an administrator.' : error.message; return; }
        if (data.session) await sb.auth.signOut({ scope: 'local' });
        waitingScreen(v('name'));
      };
    });
  }
  function waitingScreen(name) {
    const f = screen(`<p><b>${name ? 'Thank you, ' + h(name.split(' ')[0]) + '.' : 'Sign-up received.'}</b></p>
      <p>Your sign-up has been sent to the administrators. You will be able to sign in with your email and password as soon as it is approved.</p>
      <button class="pri" type="button">Back to sign in</button>`);
    f.querySelector('button').onclick = async () => { await sb.auth.signOut({ scope: 'local' }); location.reload(); };
  }
  function newPasswordScreen(first) {
    return new Promise(res => {
      const f = screen(`<p>${first ? 'Welcome! Choose your own password before you continue.' : 'Choose a new password.'} Use at least 10 characters.</p>
        <label>New password<input name="p1" type="password" autocomplete="new-password" required minlength="10"></label>
        <label>Repeat new password<input name="p2" type="password" autocomplete="new-password" required></label>
        <div class="err" role="alert"></div>
        <button class="pri" type="submit">Save password</button>
        ${first ? '' : '<button class="lnk" type="button" data-cancel>Cancel</button>'}`);
      f.p1.focus();
      f.querySelector('[data-cancel]')?.addEventListener('click', () => { closeScreen(); res(false); });
      f.onsubmit = async e => {
        e.preventDefault();
        const er = f.querySelector('.err');
        if (f.p1.value.length < 10) { er.textContent = 'Use at least 10 characters.'; return; }
        if (f.p1.value !== f.p2.value) { er.textContent = 'The two passwords are different.'; return; }
        const { error } = await sb.auth.updateUser({ password: f.p1.value, data: { must_change_password: false } });
        if (error) { er.textContent = error.message; return; }
        closeScreen(); res(true);
      };
    });
  }
  function blockedScreen(text) {
    const f = screen(`<p>${h(text)}</p><button class="pri" type="button">Sign out</button>`);
    f.querySelector('button').onclick = async () => { await sb.auth.signOut({ scope: 'local' }); location.reload(); };
  }

  async function loadProfile() {
    const { data, error } = await sb.rpc('whoami');
    if (error) throw error;
    profile = data;
  }

  window.NX_READY = (async () => {
    if (document.readyState === 'loading') await new Promise(r => document.addEventListener('DOMContentLoaded', r, { once: true }));
    // hide the app until signed in
    screen('<p>Connecting…</p>');
    let { data: { session: s } } = await sb.auth.getSession();
    if (s) { // a login ended elsewhere (signed out, switched off) must not leave a half-working page
      try { const { error: ge } = await sb.auth.getUser(); if (ge && [401, 403].includes(ge.status)) { await sb.auth.signOut({ scope: 'local' }); s = null; } } catch (_) {}
    }
    if (!s) s = await loginScreen();
    session = s;
    try { await loadProfile(); } catch (e) { blockedScreen('Could not reach the NEXUS server. Check the internet connection and reload.'); throw e; }
    if (profile && profile.pending) { waitingScreen(profile.name); throw new Error('pending'); }
    if (!profile || !profile.active) { blockedScreen('Your login is not active in NEXUS. Contact an administrator.'); throw new Error('inactive'); }
    if (session.user.user_metadata?.must_change_password) await newPasswordScreen(true);
    closeScreen();
    sb.auth.onAuthStateChange((ev, s2) => { if (ev === 'SIGNED_OUT') location.reload(); if (s2) session = s2; });
    setTimeout(attachMenu, 300);
    if (profile.role === 'admin') {
      const count = async () => { try { const { count: n } = await sb.from('profiles').select('user_id', { count: 'exact', head: true }).eq('pending', true); if (window.NX_PENDING !== (n || 0)) { window.NX_PENDING = n || 0; window.renderAll?.(); } } catch (_) {} };
      count(); setInterval(count, 5 * 60e3);
      loadFilesBk();
    }
  })();
  window.NX_OPEN_USERS = () => openUsers();
  // tell people when a newer NEXUS has been published (browsers keep the old page for a while)
  (() => {
    const mine = ((document.querySelector('script[src*="nexus-sb.js"]') || {}).src || '').match(/[?&]v=(\d+)/)?.[1];
    if (!mine) return;
    let shown = false;
    const check = async () => {
      if (shown || document.hidden) return;
      try {
        const html = await fetch('index.html?check=' + Date.now(), { cache: 'no-store' }).then(r => r.ok ? r.text() : '');
        const live = html.match(/nexus-sb\.js\?v=(\d+)/)?.[1];
        if (live && +live > +mine) {
          shown = true;
          const bar = document.createElement('div');
          bar.setAttribute('role', 'status');
          bar.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:calc(76px + env(safe-area-inset-bottom,0px));z-index:120;background:#182340;color:#fff;padding:10px 14px;border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.3);display:flex;gap:12px;align-items:center;font:14px Arial,sans-serif;max-width:calc(100vw - 32px)';
          bar.innerHTML = '<span>A new version of NEXUS is ready.</span><button type="button" style="background:#539FDC;color:#0E1830;border:0;border-radius:6px;padding:7px 12px;font-weight:700;cursor:pointer">Reload</button>';
          bar.querySelector('button').onclick = async () => { try { await fetch('index.html', { cache: 'reload' }); await fetch('./', { cache: 'reload' }); } catch (_) {} location.reload(); };
          document.body.append(bar);
        }
      } catch (_) {}
    };
    setTimeout(check, 20e3); setInterval(check, 5 * 60e3);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  })();
  // run the cloud tender sync straight away (used after a manual pipeline import)
  window.NX_SYNC_NOW = async () => {
    const r = await fetch(CFG.url + '/functions/v1/tender-sync?force=1', { method: 'POST', headers: { apikey: CFG.key, 'Content-Type': 'application/json' }, body: '{}' });
    return r.ok ? r.json() : null;
  };
  // email the approvers straight away when a purchase request is sent
  window.NX_NOTIFY_PR = async () => {
    try { const r = await fetch(CFG.url + '/functions/v1/tender-sync?pr=1', { method: 'POST', headers: { apikey: CFG.key, 'Content-Type': 'application/json' }, body: '{}' }); return r.ok ? r.json() : null; } catch (_) { return null; }
  };

  /* ---------------- backups (administrators) ---------------- */
  const BK_URL = CFG.url + '/functions/v1/nexus-backup';
  const bkEsc = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const bkWhen = v => { const t = Date.parse(v || ''); return t ? new Date(t).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never'; };
  const bkSay = m => (window.toast ? window.toast(m) : alert(m));
  let bkBusy = '', bkProg = '';
  const bkSize = n => { n = +n || 0; return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; };
  window.NX_FILES_BK = undefined;   // status of the last photo/document download (system/files_backup)
  async function loadFilesBk() {
    try { const { data } = await sb.from('docs').select('data').eq('col', 'system').eq('id', 'files_backup').maybeSingle(); window.NX_FILES_BK = data ? data.data : null; window.renderAll?.(); } catch (_) {}
  }
  window.NX_BACKUP_CARD = bk => {
    const fb = window.NX_FILES_BK;
    const age = bk && bk.last_ok ? (Date.now() - Date.parse(bk.last_ok)) / 36e5 : 1e9;
    const chip = !bk ? '<span class="chip amb">No backup yet</span>' : bk.error ? '<span class="chip bad">Last backup failed</span>'
      : age > 48 ? '<span class="chip bad">Late</span>' : '<span class="chip good">Protected</span>';
    const b = (k, t, pri) => `<button class="btn sm ${pri ? 'pri' : ''}" data-nxbk="${k}" ${bkBusy ? 'disabled' : ''}>${bkBusy === k ? '<span class="spin"></span> ' : ''}${t}</button>`;
    return `<div class="card"><div class="hd"><h2>Backups</h2>${chip}</div><div class="bd small">
      <p>Every night at 02:15 NEXUS saves a full copy of all records and logins, keeps it for 35 days (plus the 1st of every month for good), and emails the file to the administrators.</p>
      <p>Last backup: <b>${bkWhen(bk && bk.last_ok)}</b>${bk && bk.records ? ` · ${bk.records} records · ${Math.max(1, Math.round((bk.size || 0) / 1024))} KB · ${bk.stored || 0} copies kept · ${bk.emailed ? 'emailed' : '<b>not emailed</b>'}` : ''}${bk && bk.error ? `<br><span style="color:var(--bad)">${bkEsc(bk.error)}</span>` : ''}</p>
      <p>Photos &amp; documents: <b>${bk && bk.files != null ? bk.files + ' file' + (bk.files === 1 ? '' : 's') : '—'}</b> in NEXUS storage · last downloaded <b>${bkWhen(fb && fb.last_at)}</b>${fb && fb.files ? ` (${fb.files} files, ${bkSize(fb.bytes)})` : ''}. They are not inside the nightly file – download them once a week and save the zip in the Google Drive folder.</p>
      ${bkProg ? `<p><span class="spin"></span> ${bkEsc(bkProg)}</p>` : ''}
      <div class="toolbar">${b('download', 'Download backup now', true)}${b('run', 'Back up + email now')}${b('files', 'Download photos & documents (.zip)')}${b('restore', 'Restore from file…')}</div></div></div>`;
  };
  async function bkCall(q, body) {
    const { data: { session: s } } = await sb.auth.getSession();
    const r = await fetch(BK_URL + '?' + q, { method: 'POST', headers: { Authorization: 'Bearer ' + (s && s.access_token), apikey: CFG.key }, body: body || '{}' });
    if (!r.ok) { let m = ''; try { m = (await r.json()).message; } catch (_) {} throw new Error(m || 'Backup service error ' + r.status); }
    return r;
  }
  // minimal ZIP writer (stored, no compression – photos and PDFs are already compressed)
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = u8 => { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  function makeZip(entries) { // [{name, data: Uint8Array}]
    const enc = new TextEncoder(), parts = [], central = []; let off = 0;
    const now = new Date(), dt = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF,
      dd = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;
    for (const e of entries) {
      const nm = enc.encode(e.name), c = crc32(e.data), sz = e.data.length;
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
      h.setUint16(10, dt, true); h.setUint16(12, dd, true); h.setUint32(14, c, true); h.setUint32(18, sz, true); h.setUint32(22, sz, true);
      h.setUint16(26, nm.length, true); h.setUint16(28, 0, true);
      parts.push(new Uint8Array(h.buffer), nm, e.data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
      ch.setUint16(12, dt, true); ch.setUint16(14, dd, true); ch.setUint32(16, c, true); ch.setUint32(20, sz, true); ch.setUint32(24, sz, true);
      ch.setUint16(28, nm.length, true); ch.setUint32(42, off, true);
      central.push(new Uint8Array(ch.buffer), nm);
      off += 30 + nm.length + sz;
    }
    const cdSize = central.reduce((a, x) => a + x.length, 0), end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, off, true);
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
  }
  async function listAllFiles(prefix = '') {
    const out = [];
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await sb.storage.from('files').list(prefix, { limit: 1000, offset });
      if (error) throw new Error(error.message);
      for (const f of data || []) { const p = prefix ? prefix + '/' + f.name : f.name; if (f.id === null) out.push(...await listAllFiles(p)); else out.push({ path: p, size: f.metadata?.size || 0 }); }
      if (!data || data.length < 1000) break;
    }
    return out;
  }
  async function downloadFilesZip() {
    bkProg = 'Listing files…'; window.renderAll?.();
    const list = await listAllFiles();
    const total = list.reduce((a, f) => a + f.size, 0);
    if (total > 1.5 * 1073741824) throw new Error('More than 1.5 GB of files – ask the developer to split the download by year.');
    const entries = [], failed = []; let bytes = 0;
    for (const [i, f] of list.entries()) {
      bkProg = `Downloading ${i + 1} of ${list.length} (${bkSize(bytes)})…`; if (i % 5 === 0) window.renderAll?.();
      const { data, error } = await sb.storage.from('files').download(f.path);
      if (error || !data) { failed.push(f.path); continue; }
      const u8 = new Uint8Array(await data.arrayBuffer()); bytes += u8.length; entries.push({ name: f.path, data: u8 });
    }
    const manifest = ['path,size_bytes', ...list.map(f => `"${f.path}",${f.size}`)].join('\r\n') + (failed.length ? '\r\n\r\nNOT DOWNLOADED:\r\n' + failed.join('\r\n') : '');
    entries.push({ name: 'NEXUS-files-list.csv', data: new TextEncoder().encode(manifest) });
    bkProg = 'Saving zip…'; window.renderAll?.();
    const day = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
    await downloads.save({ filename: `nexus-photos-documents-${day}.zip`, data: makeZip(entries) });
    const status = { last_at: new Date().toISOString(), files: list.length - failed.length, failed: failed.length, bytes, by: profile?.email || '' };
    await sb.from('docs').upsert({ col: 'system', id: 'files_backup', data: status }, { onConflict: 'col,id' });
    window.NX_FILES_BK = status;
    return status;
  }
  async function bkDo(k) {
    if (bkBusy) return;
    if (k === 'files') {
      bkBusy = 'files'; window.renderAll?.();
      try { const st = await downloadFilesZip(); bkSay(st.files ? `Saved ${st.files} photos/documents (${bkSize(st.bytes)})${st.failed ? ` – ${st.failed} could not be read` : ''}. Put the zip in the Google Drive folder.` : 'No photos or documents are stored yet – nothing to download.'); }
      catch (e) { bkSay('Photo backup failed: ' + e.message); } finally { bkBusy = ''; bkProg = ''; window.renderAll?.(); }
      return;
    }
    if (k === 'restore') {
      const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.gz,.json,application/gzip,application/json';
      inp.onchange = async () => {
        const f = inp.files && inp.files[0]; if (!f) return;
        const ok = window.confirmBox ? await window.confirmBox(`Restore NEXUS from "${f.name}"? Every record in the file is put back as it was in the backup. Records created after the backup are kept. A safety copy of today's data is saved first.`, 'Restore', true) : confirm('Restore NEXUS from ' + f.name + '?');
        if (!ok) return;
        bkBusy = 'restore'; window.renderAll?.();
        try { const r = await bkCall('restore=1', await f.arrayBuffer()); const j = await r.json(); bkSay(`Restored ${j.restored} records from the backup of ${bkWhen(j.from)}.`); }
        catch (e) { bkSay(e.message); } finally { bkBusy = ''; window.renderAll?.(); }
      };
      inp.click(); return;
    }
    bkBusy = k; window.renderAll?.();
    try {
      if (k === 'download') {
        const r = await bkCall('download=1'); const blob = await r.blob();
        const name = (r.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'nexus-backup.json.gz';
        await downloads.save({ filename: name, data: blob });
        bkSay('Backup downloaded: ' + name);
      } else {
        const j = await (await bkCall('run=1')).json();
        bkSay(j.ok ? `Backup saved (${j.records} records)${j.emailed ? ' and emailed' : ''}.` : 'Backup failed: ' + j.error);
      }
    } catch (e) { bkSay(e.message); } finally { bkBusy = ''; window.renderAll?.(); }
  }
  document.addEventListener('click', e => { const b = e.target.closest && e.target.closest('[data-nxbk]'); if (b) { e.preventDefault(); bkDo(b.dataset.nxbk); } });

  /* ================= account menu + login management ================= */
  const ROLE_TXT = { admin: 'Administrator', finance: 'Finance', staff: 'Staff', viewer: 'Viewer (read only)' };
  window.NX_ROLE = () => ROLE_TXT[profile?.role] || '';
  function attachMenu() {
    const who = document.querySelector('.who'); if (!who) return;
    who.style.cursor = 'pointer'; who.title = 'Account';
    who.onclick = e => {
      e.stopPropagation();
      document.querySelector('.nxw')?.remove();
      const r = who.getBoundingClientRect();
      const m = document.createElement('div'); m.className = 'nxw';
      m.style.top = (r.bottom + 6) + 'px'; m.style.right = Math.max(8, innerWidth - r.right) + 'px';
      m.innerHTML = `<div class="who2"><b>${h(profile?.name || '')}</b><br><span style="opacity:.7">${h(session.user.email)} · ${h(ROLE_TXT[profile?.role] || '')}</span></div>
        ${profile?.role === 'admin' ? '<button data-m="users">Manage logins</button>' : ''}
        <button data-m="pw">Change my password</button><button data-m="out">Sign out</button>`;
      m.onclick = async ev => {
        const k = ev.target.closest('[data-m]')?.dataset.m; if (!k) return; m.remove();
        if (k === 'out') { await sb.auth.signOut({ scope: 'local' }); location.reload(); }
        if (k === 'pw') { if (await newPasswordScreen(false)) window.toast?.('Password changed.'); }
        if (k === 'users') openUsers();
      };
      document.body.append(m);
      setTimeout(() => document.addEventListener('click', function off(ev) { if (!m.contains(ev.target)) { m.remove(); document.removeEventListener('click', off); } }), 0);
    };
  }

  async function adminCall(body) {
    const { data, error } = await sb.functions.invoke('admin-users', { body });
    if (error) { let b = null; try { b = await error.context?.json(); } catch (_) {} throw new Error(b?.message || b?.error || error.message); }
    return data;
  }
  async function openUsers() {
    const w = document.createElement('div'); w.className = 'nxm';
    w.innerHTML = '<div class="box"><p>Loading logins…</p></div>';
    w.onclick = e => { if (e.target === w) w.remove(); };
    document.body.append(w);
    const box = w.querySelector('.box');
    const say = t => { const el = box.querySelector('[data-msg]'); if (el) el.textContent = t; };
    async function render() {
      let users = [];
      try { users = (await adminCall({ action: 'list' })).users; } catch (e) { box.innerHTML = `<p>${h(e.message)}</p>`; return; }
      const roleSel = (id, r) => `<select data-role="${h(id)}" aria-label="Role">${Object.keys(ROLE_TXT).map(k => `<option value="${k}"${k === r ? ' selected' : ''}>${ROLE_TXT[k]}</option>`).join('')}</select>`;
      box.innerHTML = `<div style="display:flex;align-items:center;gap:8px"><h2 style="margin:0;font:700 21px var(--f-display,Arial);text-transform:uppercase">Manage logins</h2><div style="flex:1"></div><button class="btn sm" data-close>Close</button></div>
        ${(() => { const P = users.filter(u => u.pending); return P.length ? `<div style="border:2px solid #F2A900;border-radius:6px;padding:10px 12px"><h3 style="margin:0 0 6px">Waiting for approval (${P.length})</h3>
          <p class="small muted" style="margin:0 0 6px">Only approve people you know. Choose the role, then Approve.</p><div class="tbl-wrap"><table><tbody>
          ${P.map(u => `<tr><td><b>${h(u.name || '')}</b><div class="small muted">${h(u.email || '')}</div></td><td class="small">${h(u.position || '')}<div class="muted">${h(u.phone || '')}</div></td>
            <td class="small">${u.requested_at ? new Date(u.requested_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}</td>
            <td><select data-aprole="${h(u.user_id)}" aria-label="Role">${Object.keys(ROLE_TXT).map(k => `<option value="${k}"${k === 'staff' ? ' selected' : ''}>${ROLE_TXT[k]}</option>`).join('')}</select></td>
            <td style="white-space:nowrap"><button class="btn sm pri" data-approve="${h(u.user_id)}">Approve</button> <button class="btn sm danger" data-reject="${h(u.user_id)}">Reject</button></td></tr>`).join('')}
          </tbody></table></div></div>` : ''; })()}
        <p class="small muted">Only administrators see this. Staff can sign up themselves from the sign-in page (Sign up); you approve them above. You can also add a login directly below with a temporary password – give it in person or by phone, not by email.</p>
        <div class="tbl-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Last sign-in</th><th></th></tr></thead><tbody>
        ${users.filter(u => !u.pending).map(u => `<tr style="${u.active ? '' : 'opacity:.55'}"><td>${h(u.name || '')}</td><td>${h(u.email || '')}</td><td>${roleSel(u.user_id, u.role)}</td>
          <td class="small">${u.last_sign_in_at ? new Date(u.last_sign_in_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never'}</td>
          <td style="white-space:nowrap"><button class="btn sm" data-reset="${h(u.user_id)}">New password</button> <button class="btn sm ${u.active ? 'danger' : ''}" data-act2="${h(u.user_id)}" data-on="${u.active ? 0 : 1}">${u.active ? 'Switch off' : 'Switch on'}</button></td></tr>`).join('')}
        </tbody></table></div>
        <h3 style="margin:6px 0 0">Add a login</h3>
        <form class="row" data-new autocomplete="off">
          <label>Full name<input name="name" required></label>
          <label>Email<input name="email" type="email" required></label>
          <label>Role${roleSel('', 'staff').replace('data-role=""', 'name="role"')}</label>
          <label>Temporary password (8+)<input name="pw" type="text" minlength="8" required autocomplete="new-password"></label>
          <button class="btn pri" type="submit">Create login</button>
        </form>
        <div class="small" data-msg role="status"></div>`;
      box.querySelector('[data-close]').onclick = () => w.remove();
      box.querySelectorAll('[data-approve]').forEach(b => b.onclick = async () => {
        const id = b.dataset.approve, role = box.querySelector(`[data-aprole="${id}"]`).value;
        try { await adminCall({ action: 'approve', id, role }); await render(); say(`Approved as ${ROLE_TXT[role]}. They can sign in now.`); window.NX_PENDING = Math.max(0, (window.NX_PENDING || 1) - 1); window.renderAll?.(); } catch (e) { say(e.message); }
      });
      box.querySelectorAll('[data-reject]').forEach(b => b.onclick = async () => {
        if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Click again to reject'; return; }
        try { await adminCall({ action: 'reject', id: b.dataset.reject }); await render(); say('Sign-up rejected and removed.'); window.NX_PENDING = Math.max(0, (window.NX_PENDING || 1) - 1); window.renderAll?.(); } catch (e) { say(e.message); }
      });
      box.querySelectorAll('[data-role]').forEach(s => s.onchange = async () => {
        try { await adminCall({ action: 'set_role', id: s.dataset.role, role: s.value }); say('Role updated.'); } catch (e) { say(e.message); render(); }
      });
      box.querySelectorAll('[data-reset]').forEach(b => b.onclick = () => {
        const td = b.parentElement, id = b.dataset.reset;
        td.innerHTML = '<input type="text" placeholder="Temporary password (8+)" autocomplete="new-password" style="width:170px"> <button class="btn sm pri">Set</button> <button class="btn sm">Cancel</button>';
        const [inp, ok, no] = [td.querySelector('input'), ...td.querySelectorAll('button')];
        inp.focus(); no.onclick = () => render();
        ok.onclick = async () => {
          try { await adminCall({ action: 'set_password', id, password: inp.value }); say('Temporary password set. The person must change it at next sign-in.'); render(); } catch (e) { say(e.message); }
        };
      });
      box.querySelectorAll('[data-act2]').forEach(b => b.onclick = async () => {
        try { await adminCall({ action: 'set_active', id: b.dataset.act2, active: b.dataset.on === '1' }); render(); } catch (e) { say(e.message); }
      });
      box.querySelector('[data-new]').onsubmit = async e => {
        e.preventDefault(); const f = e.target;
        try {
          const v = k => f.elements.namedItem(k).value.trim();
          const em = v('email');
          await adminCall({ action: 'create', name: v('name'), email: em, role: v('role'), password: f.elements.namedItem('pw').value });
          await render(); say(`Login created for ${em}.`);
        } catch (er) { say(er.message); }
      };
    }
    render();
  }
})();

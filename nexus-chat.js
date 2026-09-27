/* NORDIC NEXUS · private staff chat (1-to-1). Text, photos, documents, voice notes, video.
   Only the two people in a conversation can read it (database rules in 11_chat.sql). */
(function () {
  'use strict';
  const sb = window.NX_SB; if (!sb) return;
  const MAX = 25 * 1024 * 1024, PAGE = 100;
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const say = m => (window.toast ? window.toast(m) : alert(m));
  const st = { me: null, people: new Map(), threads: [], unread: {}, cur: null, msgs: {}, more: {}, urls: {}, root: null, q: '', rec: null, ready: false, err: '' };
  window.NX_CHAT_UNREAD = 0; window.NX_CHAT_ALERTS = [];

  /* ---------- helpers ---------- */
  const other = t => (t.a === st.me ? t.b : t.a);
  const pName = id => st.people.get(id)?.name || 'Former user';
  const initials = n => String(n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
  const hhmm = iso => new Date(iso).toTimeString().slice(0, 5);
  const dayLabel = iso => { const d = new Date(iso), t = new Date(); const y = new Date(Date.now() - 864e5);
    return d.toDateString() === t.toDateString() ? 'Today' : d.toDateString() === y.toDateString() ? 'Yesterday' : d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }); };
  const listTime = iso => { if (!iso) return ''; const d = new Date(iso); return d.toDateString() === new Date().toDateString() ? hhmm(iso) : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }); };
  const size = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
  const linkify = s => esc(s).replace(/(https:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>').replace(/\n/g, '<br>');
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'x' + Date.now() + Math.random().toString(36).slice(2));
  const visible = () => document.visibilityState === 'visible' && (window.NX_ROUTE && window.NX_ROUTE()) === 'chat';
  function beep() { try { const A = window.AudioContext || window.webkitAudioContext; if (!A) return; const c = beep.c || (beep.c = new A()); const o = c.createOscillator(), g = c.createGain();
    o.frequency.value = 880; g.gain.setValueAtTime(0.0001, c.currentTime); g.gain.exponentialRampToValueAtTime(0.18, c.currentTime + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.25);
    o.connect(g); g.connect(c.destination); o.start(); o.stop(c.currentTime + 0.26); } catch (_) {} }

  /* ---------- data ---------- */
  async function loadPeople() { const { data, error } = await sb.rpc('chat_people'); if (error) throw error; st.people = new Map((data || []).map(p => [p.user_id, p])); }
  async function loadThreads() { const { data, error } = await sb.from('chat_threads').select('*').order('last_at', { ascending: false }); if (error) throw error; st.threads = data || []; }
  async function loadUnread() {
    const { data } = await sb.from('chat_messages').select('thread_id').is('read_at', null).neq('sender', st.me).eq('deleted', false).limit(2000);
    st.unread = {}; (data || []).forEach(r => { st.unread[r.thread_id] = (st.unread[r.thread_id] || 0) + 1; }); badge();
  }
  async function loadMsgs(tid, older) {
    let q = sb.from('chat_messages').select('*').eq('thread_id', tid).order('created_at', { ascending: false }).limit(PAGE);
    const have = st.msgs[tid] || [];
    if (older && have.length) q = q.lt('created_at', have[0].created_at);
    const { data, error } = await q; if (error) throw error;
    const rows = (data || []).reverse();
    st.msgs[tid] = older ? [...rows, ...have] : rows; st.more[tid] = (data || []).length === PAGE;
  }
  async function markRead(tid) {
    if (!st.unread[tid]) return;
    st.unread[tid] = 0; badge();
    await sb.from('chat_messages').update({ read_at: new Date().toISOString() }).eq('thread_id', tid).neq('sender', st.me).is('read_at', null);
  }
  function badge() {
    const n = Object.values(st.unread).reduce((a, b) => a + b, 0);
    window.NX_CHAT_UNREAD = n;
    window.NX_CHAT_ALERTS = st.threads.filter(t => st.unread[t.id]).map(t => ({ id: t.id, from: pName(other(t)), n: st.unread[t.id], text: t.last_text || '', at: t.last_at }));
    try { window.renderNav && window.renderNav(); } catch (_) {}
    if (st.root) renderList();
  }

  function subscribe() {
    sb.channel('nx-chat')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages' }, p => onNew(p.new))
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'chat_messages' }, p => onUpd(p.new))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_threads' }, async () => { await loadThreads().catch(() => {}); badge(); })
      .subscribe();
    document.addEventListener('visibilitychange', () => { if (visible() && st.cur) markRead(st.cur).catch(() => {}); });
  }
  async function onNew(m) {
    let t = st.threads.find(x => x.id === m.thread_id);
    if (!t) { await loadThreads().catch(() => {}); await loadPeople().catch(() => {}); t = st.threads.find(x => x.id === m.thread_id); }
    const list = st.msgs[m.thread_id];
    if (list && !list.some(x => x.id === m.id)) { const tmp = list.findIndex(x => x.tmp && x.sender === m.sender && x.body === m.body && x.kind === m.kind); if (tmp >= 0) list.splice(tmp, 1); list.push(m); }
    if (t) { t.last_at = m.created_at; t.last_from = m.sender; t.last_text = preview(m); st.threads.sort((a, b) => b.last_at.localeCompare(a.last_at)); }
    if (m.sender !== st.me) {
      if (st.cur === m.thread_id && visible()) markRead(m.thread_id).catch(() => {});
      else { st.unread[m.thread_id] = (st.unread[m.thread_id] || 0) + 1; beep(); if ((window.NX_ROUTE && window.NX_ROUTE()) !== 'chat' || st.cur !== m.thread_id) say(`💬 ${pName(m.sender)}: ${preview(m)}`); }
    }
    badge(); if (st.cur === m.thread_id) renderMsgs(true);
  }
  function onUpd(m) { const list = st.msgs[m.thread_id]; if (!list) return; const i = list.findIndex(x => x.id === m.id); if (i >= 0) { list[i] = m; if (st.cur === m.thread_id) renderMsgs(false); } }
  const preview = m => m.deleted ? 'Message deleted' : m.kind === 'text' ? String(m.body || '').slice(0, 120) : { image: '📷 Photo', video: '🎬 Video', audio: '🎤 Voice note' }[m.kind] || '📄 ' + (m.file_name || 'Document');

  /* ---------- sending ---------- */
  async function sendText(txt) {
    const tid = st.cur; if (!tid || !txt.trim()) return;
    const tmp = { id: 'tmp' + uuid(), tmp: true, thread_id: tid, sender: st.me, kind: 'text', body: txt.trim(), created_at: new Date().toISOString() };
    (st.msgs[tid] = st.msgs[tid] || []).push(tmp); renderMsgs(true);
    const { data, error } = await sb.from('chat_messages').insert({ thread_id: tid, kind: 'text', body: txt.trim() }).select().single();
    const list = st.msgs[tid]; const i = list.findIndex(x => x.id === tmp.id);
    if (error) { if (i >= 0) list[i] = { ...tmp, failed: true }; say('Message not sent – check your connection.'); }
    else if (i >= 0) { if (list.some(x => x.id === data.id)) list.splice(i, 1); else list[i] = data; }
    renderMsgs(true);
  }
  async function shrink(file) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 450 * 1024) return file;
    try {
      const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = URL.createObjectURL(file); });
      const k = Math.min(1, 1600 / Math.max(img.width, img.height)), c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const b = await new Promise(ok => c.toBlob(ok, 'image/jpeg', 0.82)); URL.revokeObjectURL(img.src);
      return b && b.size < file.size ? new File([b], (file.name || 'photo').replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file;
    } catch (_) { return file; }
  }
  async function sendFile(file, forceKind) {
    const tid = st.cur; if (!tid || !file) return;
    const kind = forceKind || (/^image\//.test(file.type) ? 'image' : /^video\//.test(file.type) ? 'video' : /^audio\//.test(file.type) ? 'audio' : 'file');
    if (kind === 'image') file = await shrink(file);
    if (file.size > MAX) { say(`"${file.name}" is ${size(file.size)} – the limit is 25 MB.`); return; }
    const safe = String(file.name || kind).replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80) || kind;
    const path = `${tid}/${uuid()}-${safe}`;
    const tmp = { id: 'tmp' + uuid(), tmp: true, uploading: true, thread_id: tid, sender: st.me, kind, file_name: file.name || safe, file_size: file.size, created_at: new Date().toISOString() };
    (st.msgs[tid] = st.msgs[tid] || []).push(tmp); renderMsgs(true);
    const up = await sb.storage.from('chat').upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });
    const list = st.msgs[tid], drop = () => { const i = list.findIndex(x => x.id === tmp.id); if (i >= 0) list.splice(i, 1); };
    if (up.error) { drop(); renderMsgs(true); say('Upload failed: ' + up.error.message); return; }
    const { data, error } = await sb.from('chat_messages').insert({ thread_id: tid, kind, file_path: path, file_name: file.name || safe, file_size: file.size, mime: file.type || '' }).select().single();
    drop(); if (error) say('Not sent: ' + error.message); else if (!list.some(x => x.id === data.id)) list.push(data);
    renderMsgs(true);
  }
  async function delMsg(id) {
    const m = (st.msgs[st.cur] || []).find(x => x.id === id); if (!m || m.sender !== st.me) return;
    const ok = window.confirmBox ? await window.confirmBox('Delete this message for everyone?', 'Delete', true) : confirm('Delete this message for everyone?');
    if (!ok) return;
    const { error } = await sb.from('chat_messages').update({ deleted: true }).eq('id', id);
    if (error) say('Could not delete: ' + error.message);
  }

  /* ---------- voice notes ---------- */
  async function recStart() {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { say('Voice notes are not supported on this device/browser.'); return; }
    let stream; try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (_) { say('Microphone blocked – allow microphone access for NEXUS and try again.'); return; }
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find(t => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || '';
    const r = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined), chunks = [];
    r.ondataavailable = e => e.data.size && chunks.push(e.data);
    st.rec = { r, stream, chunks, t0: Date.now(), send: false, timer: setInterval(recTick, 500) };
    r.onstop = () => { const rec = st.rec; st.rec = null; clearInterval(rec.timer); stream.getTracks().forEach(t => t.stop()); renderComposer();
      if (!rec.send) return; const type = r.mimeType || mime || 'audio/webm'; const ext = /mp4/.test(type) ? 'm4a' : /ogg/.test(type) ? 'ogg' : 'webm';
      const secs = Math.round((Date.now() - rec.t0) / 1000); if (secs < 1) return;
      sendFile(new File([new Blob(chunks, { type })], `voice-note-${secs}s.${ext}`, { type }), 'audio'); };
    r.start(); renderComposer();
  }
  function recTick() { if (!st.rec) return; const s = Math.floor((Date.now() - st.rec.t0) / 1000); const el = st.root?.querySelector('.nxc-rt'); if (el) el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; if (s >= 300) recStop(true); }
  function recStop(send) { if (!st.rec) return; st.rec.send = send; try { st.rec.r.stop(); } catch (_) {} }

  /* ---------- signed links for attachments ---------- */
  async function fillMedia() {
    const els = [...st.root.querySelectorAll('[data-sp]:not([data-ok])')]; if (!els.length) return;
    const need = [...new Set(els.map(e => e.dataset.sp).filter(p => !(st.urls[p] && st.urls[p].exp > Date.now())))];
    if (need.length) { const { data } = await sb.storage.from('chat').createSignedUrls(need, 3600); (data || []).forEach(d => { if (d.signedUrl) st.urls[d.path] = { u: d.signedUrl, exp: Date.now() + 3500e3 }; }); }
    els.forEach(e => { const u = st.urls[e.dataset.sp]?.u; if (u) { e.src = u; e.dataset.ok = '1'; } });
  }
  async function openFile(path, name) {
    const { data, error } = await sb.storage.from('chat').createSignedUrl(path, 600, { download: name || true });
    if (error) { say('Could not open the file.'); return; }
    const a = document.createElement('a'); a.href = data.signedUrl; a.target = '_blank'; a.rel = 'noopener'; document.body.append(a); a.click(); a.remove();
  }

  /* ---------- UI ---------- */
  const CSS = `
  .nxchat{display:grid;grid-template-columns:300px 1fr;height:calc(100vh - 150px);min-height:420px;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--panel)}
  .nxc-l{border-right:1px solid var(--line);display:flex;flex-direction:column;min-height:0}
  .nxc-l .hd{padding:10px;border-bottom:1px solid var(--line)} .nxc-l input{width:100%;box-sizing:border-box}
  .nxc-items{overflow:auto;flex:1}
  .nxc-it{display:flex;gap:10px;align-items:center;padding:9px 12px;cursor:pointer;border-bottom:1px solid var(--line)} .nxc-it:hover,.nxc-it.on{background:var(--panel2)}
  .nxc-av{width:38px;height:38px;border-radius:50%;background:var(--accent);color:var(--accent-ink);display:flex;align-items:center;justify-content:center;font-weight:700;flex:none;font-size:14px}
  .nxc-it .g{flex:1;min-width:0} .nxc-it .n{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis} .nxc-it .p{font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .nxc-it .t{font-size:11px;color:var(--muted);text-align:right} .nxc-u{background:var(--good);color:#fff;border-radius:10px;padding:1px 7px;font-size:11px;font-weight:700;display:inline-block;margin-top:3px}
  .nxc-sec{padding:8px 12px 4px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
  .nxc-c{display:flex;flex-direction:column;min-height:0;min-width:0}
  .nxc-ch{display:flex;gap:10px;align-items:center;padding:9px 12px;border-bottom:1px solid var(--line);background:var(--panel2)}
  .nxc-back{display:none}
  .nxc-m{flex:1;overflow:auto;padding:12px 14px;display:flex;flex-direction:column;gap:4px;background:var(--bg)}
  .nxc-day{align-self:center;font-size:11px;color:var(--muted);background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:2px 10px;margin:8px 0}
  .nxc-b{max-width:min(72%,520px);padding:7px 10px 5px;border-radius:10px;background:var(--panel);border:1px solid var(--line);align-self:flex-start;word-wrap:break-word;position:relative}
  .nxc-b.me{align-self:flex-end;background:var(--good-soft);border-color:transparent}
  .nxc-b .meta{font-size:10.5px;color:var(--muted);text-align:right;margin-top:2px;white-space:nowrap}
  .nxc-b .rd{color:var(--blue);font-weight:700} .nxc-b .del{font-style:italic;color:var(--muted)}
  .nxc-b img,.nxc-b video{max-width:100%;max-height:320px;border-radius:6px;display:block;background:var(--panel2);min-width:120px;min-height:80px;cursor:pointer}
  .nxc-b audio{width:240px;max-width:100%} .nxc-f{display:flex;gap:8px;align-items:center;cursor:pointer;text-decoration:underline}
  .nxc-x{position:absolute;top:2px;right:4px;border:0;background:transparent;color:var(--muted);cursor:pointer;font-size:14px;display:none} .nxc-b.me:hover .nxc-x{display:block}
  .nxc-k{display:flex;gap:6px;align-items:flex-end;padding:8px;border-top:1px solid var(--line);background:var(--panel2)}
  .nxc-k textarea{flex:1;resize:none;max-height:120px;min-height:38px;box-sizing:border-box}
  .nxc-k .btn{min-width:38px;height:38px} .nxc-rec{flex:1;display:flex;align-items:center;gap:8px;color:var(--bad);font-weight:600}
  .nxc-dot{width:10px;height:10px;border-radius:50%;background:var(--bad);animation:nxcp 1s infinite} @keyframes nxcp{50%{opacity:.25}}
  .nxc-empty{margin:auto;text-align:center;color:var(--muted);padding:20px;max-width:360px}
  @media (max-width:760px){.nxchat{grid-template-columns:1fr;height:calc(100vh - 215px);height:calc(100dvh - 215px)} .nxchat.conv .nxc-l{display:none} .nxchat:not(.conv) .nxc-c{display:none} .nxc-back{display:inline-flex} .nxc-b{max-width:85%}}`;

  function build() {
    if (st.root) return;
    const s = document.createElement('style'); s.textContent = CSS; document.head.append(s);
    st.root = document.createElement('div'); st.root.className = 'nxchat';
    st.root.innerHTML = `<div class="nxc-l"><div class="hd"><input class="inp" id="nxcSearch" placeholder="Search people…" autocomplete="off"></div><div class="nxc-items"></div></div>
      <div class="nxc-c"><div class="nxc-ch"></div><div class="nxc-m"></div><div class="nxc-k"></div></div>
      <input type="file" id="nxcFile" hidden multiple accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip,.dwg,.dxf">`;
    st.root.querySelector('#nxcSearch').addEventListener('input', e => { st.q = e.target.value.toLowerCase(); renderList(); });
    st.root.querySelector('#nxcFile').addEventListener('change', async e => { const fs = [...e.target.files]; e.target.value = ''; for (const f of fs) await sendFile(f); });
    st.root.addEventListener('click', onClick);
    st.root.addEventListener('keydown', e => { if (e.target.id === 'nxcText' && e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) { e.preventDefault(); doSend(); } });
    st.root.addEventListener('input', e => { if (e.target.id === 'nxcText') { e.target.style.height = 'auto'; e.target.style.height = Math.min(120, e.target.scrollHeight) + 'px'; } });
    st.root.querySelector('.nxc-m').addEventListener('scroll', e => { const m = e.target; st.stick = m.scrollHeight - m.scrollTop - m.clientHeight < 60; });
  }
  function doSend() { const t = st.root.querySelector('#nxcText'); if (!t || !t.value.trim()) return; const v = t.value; t.value = ''; t.style.height = 'auto'; sendText(v); t.focus(); }
  async function onClick(e) {
    const b = e.target.closest('[data-c]'); if (!b) { const im = e.target.closest('img[data-sp]'); if (im && im.src && window.lightbox) window.lightbox(im.src); return; }
    const [a, v] = [b.dataset.c, b.dataset.v];
    if (a === 'open') openThread(v);
    else if (a === 'person') { try { const { data, error } = await sb.rpc('chat_open', { other: v }); if (error) throw error; await loadThreads(); openThread(data); } catch (er) { say('Could not start the chat: ' + (er.message || er)); } }
    else if (a === 'back') { st.cur = null; st.root.classList.remove('conv'); renderList(); renderConv(); }
    else if (a === 'send') doSend();
    else if (a === 'attach') st.root.querySelector('#nxcFile').click();
    else if (a === 'mic') recStart();
    else if (a === 'recsend') recStop(true);
    else if (a === 'reccancel') recStop(false);
    else if (a === 'older') { await loadMsgs(st.cur, true).catch(() => {}); renderMsgs(false); }
    else if (a === 'file') openFile(v, b.dataset.n);
    else if (a === 'del') delMsg(v);
  }
  async function openThread(tid) {
    st.cur = tid; st.root.classList.add('conv'); st.stick = true;
    renderList(); renderConv();
    if (!st.msgs[tid]) { await loadMsgs(tid).catch(er => say('Could not load messages: ' + er.message)); }
    renderMsgs(true); if (visible()) markRead(tid).catch(() => {});
    const t = st.root.querySelector('#nxcText'); if (t && !('ontouchstart' in window)) t.focus();
  }
  function renderList() {
    if (!st.root) return; const box = st.root.querySelector('.nxc-items'), q = st.q;
    const withThread = new Set(st.threads.map(other));
    const th = st.threads.filter(t => !q || pName(other(t)).toLowerCase().includes(q));
    const ppl = [...st.people.values()].filter(p => !withThread.has(p.user_id) && (!q || (p.name || '').toLowerCase().includes(q) || (p.job || '').toLowerCase().includes(q)));
    box.innerHTML = (th.length ? `<div class="nxc-sec">Chats</div>` : '') + th.map(t => { const o = other(t), u = st.unread[t.id] || 0;
      return `<div class="nxc-it ${st.cur === t.id ? 'on' : ''}" data-c="open" data-v="${t.id}"><div class="nxc-av">${esc(initials(pName(o)))}</div><div class="g"><div class="n">${esc(pName(o))}</div><div class="p">${t.last_from === st.me ? 'You: ' : ''}${esc(t.last_text || 'No messages yet')}</div></div><div class="t">${listTime(t.last_text ? t.last_at : '')}${u ? `<br><span class="nxc-u">${u}</span>` : ''}</div></div>`; }).join('')
      + (ppl.length ? `<div class="nxc-sec">Start a chat</div>` + ppl.map(p => `<div class="nxc-it" data-c="person" data-v="${p.user_id}"><div class="nxc-av" style="background:var(--panel2);color:var(--ink)">${esc(initials(p.name))}</div><div class="g"><div class="n">${esc(p.name)}</div><div class="p">${esc(p.job || (p.role === 'admin' ? 'Administrator' : 'Staff'))}</div></div></div>`).join('') : '')
      || `<div class="nxc-empty">${q ? 'Nobody matches your search.' : 'No other NEXUS users yet. Colleagues appear here once they sign up and an administrator approves them.'}</div>`;
  }
  function renderConv() {
    if (!st.root) return; const h = st.root.querySelector('.nxc-ch');
    const t = st.threads.find(x => x.id === st.cur);
    if (!t) { h.innerHTML = '<span class="sub">Private chat</span>'; st.root.querySelector('.nxc-m').innerHTML = `<div class="nxc-empty">💬<br><b>Private staff chat</b><br>Choose a colleague on the left. Only the two of you can read your messages – not even administrators. Send text, photos, documents, voice notes and videos (up to 25 MB).</div>`; st.root.querySelector('.nxc-k').innerHTML = ''; return; }
    const p = st.people.get(other(t)) || {};
    h.innerHTML = `<button class="btn sm nxc-back" data-c="back" aria-label="Back to chats">←</button><div class="nxc-av">${esc(initials(pName(other(t))))}</div><div><div style="font-weight:600">${esc(pName(other(t)))}</div><div class="sub">${esc(p.job || '')} · 🔒 private</div></div>`;
    renderComposer();
  }
  function renderComposer() {
    const k = st.root?.querySelector('.nxc-k'); if (!k || !st.cur) return;
    if (st.rec) { k.innerHTML = `<button class="btn" data-c="reccancel" title="Cancel">✕</button><div class="nxc-rec"><span class="nxc-dot"></span> Recording <span class="nxc-rt">0:00</span></div><button class="btn pri" data-c="recsend" title="Send voice note">➤</button>`; return; }
    const keep = k.querySelector('#nxcText')?.value || '';
    k.innerHTML = `<button class="btn" data-c="attach" title="Photo, video or document">📎</button><textarea class="inp" id="nxcText" rows="1" placeholder="Type a message"></textarea><button class="btn" data-c="mic" title="Record a voice note">🎤</button><button class="btn pri" data-c="send" title="Send">➤</button>`;
    k.querySelector('#nxcText').value = keep;
  }
  function body(m) {
    if (m.deleted) return '<span class="del">🚫 This message was deleted</span>';
    if (m.uploading) return `<span class="sub">⏳ Sending ${esc(m.file_name || '')} (${size(m.file_size || 0)})…</span>`;
    const sp = esc(m.file_path || '');
    switch (m.kind) {
      case 'image': return `<img data-sp="${sp}" alt="Photo" loading="lazy">`;
      case 'video': return `<video data-sp="${sp}" controls preload="metadata" playsinline></video><div class="sub">${esc(m.file_name || '')} · ${size(m.file_size || 0)}</div>`;
      case 'audio': return `<div class="sub">🎤 Voice note</div><audio data-sp="${sp}" controls preload="metadata"></audio>`;
      case 'file': return `<div class="nxc-f" data-c="file" data-v="${sp}" data-n="${esc(m.file_name || 'document')}">📄 <span>${esc(m.file_name || 'Document')}</span><span class="sub">${size(m.file_size || 0)}</span></div>`;
      default: return linkify(m.body || '');
    }
  }
  function renderMsgs(toBottom) {
    if (!st.root || !st.cur) return; const box = st.root.querySelector('.nxc-m'), list = st.msgs[st.cur];
    if (!list) { box.innerHTML = '<div class="nxc-empty">Loading…</div>'; return; }
    const prevH = box.scrollHeight, prevT = box.scrollTop; let day = '', html = st.more[st.cur] ? `<button class="btn sm" data-c="older" style="align-self:center">Load earlier messages</button>` : '';
    for (const m of list) { const d = dayLabel(m.created_at); if (d !== day) { day = d; html += `<div class="nxc-day">${d}</div>`; }
      const mine = m.sender === st.me;
      html += `<div class="nxc-b ${mine ? 'me' : ''}">${mine && !m.deleted && !m.tmp ? `<button class="nxc-x" data-c="del" data-v="${m.id}" title="Delete for everyone">✕</button>` : ''}${body(m)}<div class="meta">${hhmm(m.created_at)}${mine ? (m.failed ? ' <span style="color:var(--bad)">not sent</span>' : m.tmp ? ' 🕓' : m.read_at ? ' <span class="rd" title="Read">✓✓</span>' : ' <span title="Delivered">✓</span>') : ''}</div></div>`; }
    box.innerHTML = html || '<div class="nxc-empty">No messages yet – say hello 👋</div>';
    if (toBottom || st.stick !== false) box.scrollTop = box.scrollHeight; else box.scrollTop = prevT + (box.scrollHeight - prevH);
    fillMedia().catch(() => {});
  }

  /* ---------- page hooks (called by the NEXUS app) ---------- */
  window.NX_CHAT_MOUNT = host => {
    if (!host) return; build();
    if (!st.ready) { host.innerHTML = `<div class="card empty">${st.err ? 'Chat could not start: ' + esc(st.err) : '<span class="spin"></span> Loading chat…'}</div>`; return; }
    if (st.root.parentNode !== host) host.append(st.root);
    if (!st.rendered) { st.rendered = true; renderList(); renderConv(); if (st.cur) renderMsgs(true); }
    if (st.cur && visible()) markRead(st.cur).catch(() => {});
  };
  window.NX_CHAT_OPEN = async tid => { if (st.ready) openThread(tid); };

  async function init(tries = 0) {
    try {
      const { data } = await sb.auth.getSession(); const s = data && data.session;
      if (!s) { setTimeout(() => init(tries), 4000); return; }
      st.me = s.user.id; await loadPeople(); await loadThreads(); await loadUnread(); subscribe();
      st.ready = true; st.err = ''; build(); renderList(); renderConv(); st.rendered = true;
      if ((window.NX_ROUTE && window.NX_ROUTE()) === 'chat') { const h = document.getElementById('chatHost'); if (h) window.NX_CHAT_MOUNT(h); }
    } catch (e) { st.err = e.message || String(e); if (tries < 20) setTimeout(() => init(tries + 1), 6000); }
  }
  setTimeout(init, 1500);
})();

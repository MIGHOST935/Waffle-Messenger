'use strict';
/* ── helpers ── */
const $ = id => document.getElementById(id);
function fmt(ts) {
  const d = new Date(ts);
  return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
}
function fmtDate(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString('ru-RU', { day:'numeric', month:'short' });
}
const AVATARS = {
  a1:'linear-gradient(135deg,#7c3aed,#22c55e)',
  a2:'linear-gradient(135deg,#3b82f6,#7c3aed)',
  a3:'linear-gradient(135deg,#22c55e,#06b6d4)',
  a4:'linear-gradient(135deg,#f97316,#ef4444)',
  a5:'linear-gradient(135deg,#eab308,#22c55e)',
  a6:'linear-gradient(135deg,#06b6d4,#3b82f6)',
};
function applyAvatar(el, avatar) {
  if (!el) return;
  el.style.backgroundImage = '';
  el.style.background = '';
  el.innerHTML = '';
  if (!avatar) { el.style.background = AVATARS.a1; return; }
  if (AVATARS[avatar]) { el.style.background = AVATARS[avatar]; return; }
  el.style.backgroundImage = `url(${JSON.stringify(avatar)})`;
  el.style.backgroundSize = 'cover';
  el.style.backgroundPosition = 'center';
  el.style.backgroundColor = '#c8b89a';
}
function escHtml(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function linkify(text) {
  return escHtml(text).replace(/(https?:\/\/[^\s<>"]+)/g, (m,url) =>
    `<a href="${escHtml(url)}" target="_blank" rel="noopener noreferrer">${escHtml(url)}</a>`
  );
}
function displayName(u) {
  if (!u) return '?';
  const parts = [u.name, u.lastName || u.last_name].filter(Boolean);
  return parts.join(' ') || u.username || u.phone || '?';
}
function vh() {
  document.documentElement.style.setProperty('--vh', window.innerHeight * .01 + 'px');
}
window.addEventListener('resize', vh); vh();

/* System message text parser (__LINK__username|name__ format) */
function renderSystemText(rawText) {
  const parts = [];
  let lastIdx = 0;
  const re = /__LINK__([^|]*)\|([^_]*)__/g;
  let match;
  while ((match = re.exec(rawText)) !== null) {
    if (match.index > lastIdx) parts.push({ type:'text', val: rawText.slice(lastIdx, match.index) });
    parts.push({ type:'link', username: match[1], name: match[2] });
    lastIdx = re.lastIndex;
  }
  if (lastIdx < rawText.length) parts.push({ type:'text', val: rawText.slice(lastIdx) });
  return parts.map(p => {
    if (p.type === 'text') return escHtml(p.val);
    return `<a class="sysLink" href="#" data-username="${escHtml(p.username)}">${escHtml(p.name)}</a>`;
  }).join('');
}

/* ── confirm dialog ── */
const confirmModal      = $('confirmModal');
const confirmTitleEl    = $('confirmTitle');
const confirmTextEl     = $('confirmText');
const confirmOkEl       = $('confirmOk');
const confirmCancelEl   = $('confirmCancel');
const confirmBackdropEl = $('confirmBackdrop');
let confirmResolve = null;
function confirm(title, body, okText, cancelText) {
  return new Promise(resolve => {
    confirmTitleEl.textContent = title || '';
    confirmTextEl.textContent  = body  || '';
    confirmOkEl.textContent    = okText || 'Подтвердить';
    confirmCancelEl.textContent = cancelText || 'Отмена';
    confirmModal.classList.remove('hidden');
    confirmResolve = resolve;
  });
}
function closeConfirm(ok) {
  confirmModal.classList.add('hidden');
  if (confirmResolve) { confirmResolve(ok); confirmResolve = null; }
}
confirmOkEl.addEventListener('click',      () => closeConfirm(true));
confirmCancelEl.addEventListener('click',  () => closeConfirm(false));
confirmBackdropEl.addEventListener('click',() => closeConfirm(false));

/* ── api helpers ── */
async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  const r = await fetch(path, opts);
  return r.json();
}
const apiGet  = (path)       => api('GET',  path);
const apiPost = (path, body) => api('POST', path, body);
async function uploadFile(file, preauth) {
  const fd = new FormData(); fd.append('file', file);
  const r = await fetch(preauth ? '/api/upload/preauth' : '/api/upload', { method:'POST', body: fd });
  return r.json();
}

/* ── state ── */
const state = {
  me: null, token: null,
  contacts: [],
  chats: [],
  groups: [],
  messages: [],
  active: null,
  activeGroup: null,
  activeType: null,
  activeGroupRole: null,
  blockedByMe: false,
  currentTab: 'chats',
  pendingFiles: [],
  pendingRegAvatar: null,
  pendingRegPhone: null,
  pendingIsReg: false,
  peerPanelData: null,
  peerPanelTab: 'media',
  groupPanelData: null,
  groupPanelTab: 'members',
};

/* ── socket ── */
let socket = null;
function connectSocket(token) {
  socket = io({ auth: { token } });
  socket.on('dm:new', onDmNew);
  socket.on('group:new', onGroupNew);
  socket.on('group:joined', ({ group }) => {
    if (!state.groups.find(g => g.id === group.id)) {
      state.groups.push({ ...group, chatType:'group' });
      renderContacts();
    }
  });
  socket.on('group:removed', ({ groupId }) => {
    state.groups = state.groups.filter(g => g.id !== groupId);
    if (state.activeGroup?.id === groupId) {
      state.active = null; state.activeGroup = null; state.activeType = null; state.activeGroupRole = null;
      chatEl.classList.remove('showDialog');
      closeGroupPanel();
    }
    if (state.groupPanelData?.group?.id === groupId) closeGroupPanel();
    renderContacts();
  });
  socket.on('group:left', ({ groupId }) => {
    state.groups = state.groups.filter(g => g.id !== groupId);
    if (state.activeGroup?.id === groupId) {
      state.active = null; state.activeGroup = null; state.activeType = null; state.activeGroupRole = null;
      chatEl.classList.remove('showDialog');
      closeGroupPanel();
    }
    renderContacts();
  });
  socket.on('group:cleared', ({ groupId }) => {
    if (state.activeGroup?.id === groupId) {
      state.messages = [];
      renderMessages();
    }
  });
  socket.on('group:updated', ({ groupId, group }) => {
    const g = state.groups.find(x => x.id === groupId);
    if (g) { Object.assign(g, group); renderContacts(); }
    if (state.activeGroup?.id === groupId) {
      Object.assign(state.activeGroup, group);
      peerNameEl.textContent = group.name;
      peerUsernameEl.textContent = group.description || '';
      applyAvatar(peerAvatarEl, group.avatar);
    }
    if (state.groupPanelData?.group?.id === groupId) {
      Object.assign(state.groupPanelData.group, group);
      applyAvatar($('gpAvatar'), group.avatar);
      $('gpName').textContent = group.name;
      $('gpDesc').textContent = group.description || '';
    }
  });
  socket.on('group:role_changed', ({ groupId, userId, role }) => {
    if (state.groupPanelData?.group?.id === groupId) {
      const m = state.groupPanelData.members?.find(x => x.id === userId);
      if (m) {
        m.role = role;
        renderGroupTab(state.groupPanelTab);
      }
    }
    if (userId === state.me?.id && state.activeGroup?.id === groupId) {
      state.activeGroupRole = role;
    }
  });
  socket.on('msg:deleted', ({ id, scope, groupId }) => {
    if (groupId) {
      if (state.activeGroup && state.activeGroup.id === groupId) {
        state.messages = state.messages.filter(m => m.id !== id);
        renderMessages();
      }
    } else {
      state.messages = state.messages.filter(m => m.id !== id);
      if (state.active || state.activeGroup) renderMessages();
    }
  });
  socket.on('chat:cleared', ({ username }) => {
    if (state.active && state.active.username === username) {
      state.messages = []; renderMessages();
    }
  });
  socket.on('reaction:update', ({ messageId, userId, emoji, active }) => {
    const msg = state.messages.find(m => m.id === messageId);
    if (!msg) return;
    if (!msg.reactions) msg.reactions = [];
    const existing = msg.reactions.find(r => r.emoji === emoji);
    if (active) {
      if (existing) {
        if (!existing.userIds.includes(userId)) { existing.userIds.push(userId); existing.cnt++; }
      } else {
        msg.reactions.push({ emoji, cnt: 1, userIds: [userId] });
      }
    } else {
      if (existing) {
        existing.userIds = existing.userIds.filter(u => u !== userId);
        existing.cnt--;
        if (existing.cnt <= 0) msg.reactions = msg.reactions.filter(r => r.emoji !== emoji);
      }
    }
    renderMessages();
  });
}

/* ── DOM refs ── */
const authEl       = $('auth');
const chatEl       = $('chat');
const stepPhone    = $('stepPhone');
const stepProfile  = $('stepProfile');
const stepCode     = $('stepCode');
const authTitleEl  = $('authTitle');
const phoneEl      = $('phone');
const nameEl       = $('name');
const lastNameEl   = $('lastName');
const regUsernameEl= $('regUsername');
const codeEl       = $('code');
const authErrorEl      = $('authError');
const phoneErrorEl     = $('phoneError');
const profileStepError = $('profileStepError');
const contactsUl   = $('contacts');
const messagesUl   = $('messages');
const inputEl      = $('input');
const formEl       = $('form');
const peerNameEl       = $('peerName');
const peerUsernameEl   = $('peerUsername');
const peerAvatarEl     = $('peerAvatar');
const peerInfoBtn      = $('peerInfoBtn');
const meAvatarEl   = $('meAvatar');
const meNameEl     = $('meName');
const whoEl        = $('who');
const addPeerBtn   = $('addPeerToContacts');
const searchEl     = $('userSearch');
const searchResults= $('searchResults');
const attachPreview= $('attachPreview');
const fileInput    = $('fileInput');
const msgMenuEl    = $('msgMenu');
const peerPanelEl  = $('peerPanel');
const ppAvatarEl   = $('ppAvatar');
const ppNameEl     = $('ppName');
const ppInfoEl     = $('ppInfo');
const ppContentEl  = $('ppContent');
const groupPanelEl = $('groupPanel');

/* ── Auth flow ── */
let isRegister = false;
function showStep(step) {
  [stepPhone, stepProfile, stepCode].forEach(s => s.classList.add('hidden'));
  step.classList.remove('hidden');
}

$('switchMode').addEventListener('click', () => {
  isRegister = !isRegister;
  phoneErrorEl.textContent = '';
  authTitleEl.textContent = isRegister ? 'Регистрация' : 'Вход';
  $('switchMode').textContent = isRegister ? 'Уже есть аккаунт? Войти' : 'Нету аккаунта? Зарегистрироваться';
  showStep(stepPhone);
});
$('backToPhone').addEventListener('click', () => { profileStepError.textContent=''; showStep(stepPhone); });
$('backFromCode').addEventListener('click', () => { authErrorEl.textContent=''; showStep(isRegister ? stepProfile : stepPhone); });

$('nextPhone').addEventListener('click', async () => {
  phoneErrorEl.textContent = '';
  const phone = phoneEl.value.trim();
  if (!phone) { phoneErrorEl.textContent = 'Введите номер телефона.'; return; }
  $('nextPhone').disabled = true;
  if (isRegister) {
    const r = await apiPost('/api/auth/request-code', { phone, purpose:'register' });
    $('nextPhone').disabled = false;
    if (!r.ok) {
      phoneErrorEl.textContent = r.error === 'user_exists' ? 'Номер уже зарегистрирован.' : ('Ошибка: '+r.error);
      return;
    }
    state.pendingRegPhone = phone;
    state.pendingIsReg = true;
    showStep(stepProfile);
  } else {
    const r = await apiPost('/api/auth/request-code', { phone, purpose:'login' });
    $('nextPhone').disabled = false;
    if (!r.ok) {
      phoneErrorEl.textContent = r.error === 'user_not_found' ? 'Пользователь не найден.' : ('Ошибка: '+r.error);
      return;
    }
    state.pendingRegPhone = phone;
    state.pendingIsReg = false;
    codeHintSet(r.devCode);
    showStep(stepCode);
  }
});

document.querySelectorAll('.regAvBtn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.regAvBtn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    state.pendingRegAvatar = btn.dataset.avatar;
    applyAvatar($('regAvatarPreview'), btn.dataset.avatar);
  });
});

$('regPhotoInput').addEventListener('change', async e => {
  const file = e.target.files[0]; if (!file) return;
  const r = await uploadFile(file, true);
  if (r.ok) {
    state.pendingRegAvatar = r.url;
    applyAvatar($('regAvatarPreview'), r.url);
    document.querySelectorAll('.regAvBtn').forEach(b => b.classList.remove('selected'));
  } else {
    profileStepError.textContent = 'Ошибка загрузки фото.';
  }
});

$('nextProfile').addEventListener('click', async () => {
  profileStepError.textContent = '';
  const name     = nameEl.value.trim();
  const username = regUsernameEl.value.trim();
  if (!name) { profileStepError.textContent = 'Введите имя.'; return; }
  if (!username) { profileStepError.textContent = 'Введите юзернейм.'; return; }
  if (!/^[a-zA-Z0-9_]{4,24}$/.test(username)) {
    profileStepError.textContent = 'Юзернейм: латиница, цифры, _ (4–24 символа).'; return;
  }
  if (!state.pendingRegAvatar) { profileStepError.textContent = 'Выберите фото профиля.'; return; }
  $('nextProfile').disabled = true;
  const cr = await apiGet(`/api/users/check-username?username=${encodeURIComponent(username)}`);
  $('nextProfile').disabled = false;
  if (!cr.ok || !cr.available) {
    profileStepError.textContent = cr.reason === 'invalid_format'
      ? 'Юзернейм: латиница, цифры, _ (4–24 символа).'
      : 'Юзернейм уже занят. Попробуйте другой.';
    return;
  }
  codeHintSet('935935');
  showStep(stepCode);
});

function codeHintSet(code) { $('codeHint').textContent = code ? `Код: ${code}` : ''; }
$('requestCode').addEventListener('click', async () => {
  const phone   = state.pendingRegPhone;
  const purpose = state.pendingIsReg ? 'register' : 'login';
  if (!phone) return;
  const r = await apiPost('/api/auth/request-code', { phone, purpose });
  if (r.ok) codeHintSet(r.devCode);
});

$('authForm').addEventListener('submit', async e => {
  e.preventDefault();
  authErrorEl.textContent = '';
  const phone = state.pendingRegPhone;
  const code  = codeEl.value.trim();
  if (!code) { authErrorEl.textContent = 'Введите код.'; return; }
  const body = { phone, code, purpose: isRegister ? 'register' : 'login' };
  if (isRegister) {
    body.name     = nameEl.value.trim();
    body.lastName = lastNameEl.value.trim();
    body.username = regUsernameEl.value.trim();
    body.avatar   = state.pendingRegAvatar || '';
  }
  $('verify').disabled = true;
  const r = await apiPost('/api/auth/verify', body);
  $('verify').disabled = false;
  if (!r.ok) {
    const MAP = { invalid_code:'Неверный код.', code_expired:'Код истёк. Запросите новый.', user_exists:'Номер уже зарегистрирован.', name_required:'Введите имя.', username_invalid:'Юзернейм некорректен.', username_taken:'Юзернейм занят.' };
    authErrorEl.textContent = MAP[r.error] || ('Ошибка: '+r.error);
    return;
  }
  state.token = r.token;
  onLogin(r.user);
});

/* ── Login / init ── */
async function onLogin(user) {
  state.me = user;
  authEl.classList.add('hidden');
  chatEl.classList.remove('hidden');
  applyAvatar(meAvatarEl, user.avatar);
  meNameEl.textContent = displayName(user);
  whoEl.textContent = user.username ? '@'+user.username : '';
  connectSocket(state.token || '');
  await refreshAll();
}

async function refreshAll() {
  const [cr, chr, gr] = await Promise.all([
    apiGet('/api/contacts'),
    apiGet('/api/chats'),
    apiGet('/api/groups'),
  ]);
  if (cr.ok)  state.contacts = cr.contacts;
  if (chr.ok) state.chats    = chr.chats;
  if (gr.ok)  state.groups   = gr.groups;
  renderContacts();
}

(async () => {
  const r = await apiGet('/api/me');
  if (r.ok && r.user) { state.me = r.user; await onLogin(r.user); }
})();

/* ── Contact list / Chats ── */
function renderContacts() {
  const tab = state.currentTab;
  contactsUl.innerHTML = '';

  if (tab === 'contacts') {
    const sorted = [...state.contacts].sort((a,b) => {
      const na = a.nickname||a.name||a.username||'';
      const nb = b.nickname||b.name||b.username||'';
      return na.localeCompare(nb);
    });
    for (const c of sorted) {
      contactsUl.appendChild(mkContactItem({
        avatarKey: c.avatar,
        title: c.nickname || displayName({ name:c.name, lastName:c.last_name }),
        sub: c.username ? '@'+c.username : c.phone,
        active: state.active?.id === c.userId,
        onClick: () => openDialogForUser(c.userId),
      }));
    }
    return;
  }

  const all = [
    ...state.chats.map(c => ({ ...c, _ts: c.lastTs||0 })),
    ...state.groups.map(g => ({ ...g, _ts: g.lastTs||g.created_at||0 })),
  ].sort((a,b) => b._ts - a._ts);

  for (const item of all) {
    if (item.chatType === 'group') {
      contactsUl.appendChild(mkGroupItem(item));
    } else {
      const name = item.nickname || displayName({ name:item.name, lastName:item.last_name });
      contactsUl.appendChild(mkContactItem({
        avatarKey: item.avatar,
        title: name,
        sub: item.lastText || (item.username ? '@'+item.username : ''),
        badge: item.unreadCount||0,
        active: state.active?.id === item.peerUserId,
        onClick: () => openDialogForUser(item.peerUserId),
      }));
    }
  }
}

function mkContactItem({ avatarKey, title, sub, badge, active, onClick }) {
  const li = document.createElement('li'); li.className = 'contact'+(active?' active':'');
  const av = document.createElement('div'); av.className = 'miniAvatar'; applyAvatar(av, avatarKey);
  const txt = document.createElement('div'); txt.className = 'contactTxt';
  txt.innerHTML = `<div class="contactTitle">${escHtml(title)}</div>`+(sub?`<div class="contactSub">${escHtml(String(sub))}</div>`:'');
  li.appendChild(av); li.appendChild(txt);
  if (badge) { const b=document.createElement('span'); b.className='badge'; b.textContent=badge; li.appendChild(b); }
  li.addEventListener('click', onClick);
  return li;
}

function mkGroupItem(g) {
  const li = document.createElement('li'); li.className = 'contact'+(state.activeGroup?.id===g.id?' active':'');
  const av = document.createElement('div');
  if (g.avatar) { av.className='miniAvatar'; applyAvatar(av,g.avatar); }
  else { av.className='groupIcon'; av.textContent='👥'; }
  const txt = document.createElement('div'); txt.className='contactTxt';
  txt.innerHTML = `<div class="contactTitle">${escHtml(g.name)}</div>`+(g.lastText?`<div class="contactSub">${escHtml(g.lastText)}</div>`:'');
  li.appendChild(av); li.appendChild(txt);
  if (g.unreadCount) { const b=document.createElement('span'); b.className='badge'; b.textContent=g.unreadCount; li.appendChild(b); }
  li.addEventListener('click', () => openGroup(g));
  return li;
}

/* ── Open DM ── */
async function openDialogForUser(userId) {
  if (!userId) return;
  const contact = state.contacts.find(c => c.userId===userId);
  const chat    = state.chats.find(c => c.peerUserId===userId);
  const username = contact?.username || chat?.username;
  if (!username) return;
  await openDialogByUsername(username);
}

async function openDialogByUsername(username) {
  const mr = await apiGet('/api/messages/with/'+username);
  if (!mr.ok) return;
  state.active      = mr.with;
  state.activeGroup = null;
  state.activeType  = 'dm';
  state.activeGroupRole = null;
  state.messages    = mr.messages;
  state.blockedByMe = mr.blockedByMe;
  closePeerPanel();
  closeGroupPanel();
  updateDialogHeader();
  // DM: show ⋯ button
  $('chatMenuBtn').classList.remove('hidden');
  renderMessages();
  scrollToBottom();
  markRead();
  renderContacts();
  chatEl.classList.add('showDialog');
  addPeerBtn.classList.toggle('hidden', state.contacts.some(c=>c.userId===mr.with.id));
}

/* ── Open Group ── */
async function openGroup(g) {
  const r = await apiGet(`/api/groups/${g.id}/messages`);
  if (!r.ok) return;
  state.active      = null;
  state.activeGroup = { ...g };
  state.activeType  = 'group';
  state.activeGroupRole = r.myRole || 'member';
  state.messages    = r.messages;
  state.blockedByMe = false;
  closePeerPanel();
  closeGroupPanel();
  peerNameEl.textContent = g.name;
  peerUsernameEl.textContent = g.description||'';
  applyAvatar(peerAvatarEl, g.avatar);
  addPeerBtn.classList.add('hidden');
  // Group: hide ⋯ button (options are in group panel)
  $('chatMenuBtn').classList.add('hidden');
  renderMessages();
  scrollToBottom();
  renderContacts();
  chatEl.classList.add('showDialog');
  apiPost(`/api/groups/${g.id}/read`, {});
  const gi = state.groups.find(x=>x.id===g.id);
  if (gi) { gi.unreadCount=0; renderContacts(); }
}

function updateDialogHeader() {
  if (!state.active) return;
  const contact = state.contacts.find(c=>c.userId===state.active.id);
  peerNameEl.textContent = contact?.nickname || displayName(state.active);
  peerUsernameEl.textContent = state.active.username ? '@'+state.active.username : '';
  applyAvatar(peerAvatarEl, state.active.avatar);
}

function markRead() {
  if (!state.active?.username) return;
  apiPost('/api/chats/read', { username: state.active.username });
  const ch = state.chats.find(c=>c.peerUserId===state.active.id);
  if (ch) { ch.unreadCount=0; renderContacts(); }
}

function scrollToBottom() { requestAnimationFrame(()=>{ messagesUl.scrollTop=messagesUl.scrollHeight; }); }

/* ── Render messages ── */
function renderMessages() {
  messagesUl.innerHTML = '';
  const meId = state.me?.id;
  const isGroup = state.activeType==='group';
  const myRole = state.activeGroupRole;

  for (const msg of state.messages) {
    // System message
    if (msg.isSystem) {
      const sysmsg = document.createElement('li');
      sysmsg.className = 'systemMsg';
      sysmsg.innerHTML = renderSystemText(msg.text || '');
      sysmsg.querySelectorAll('.sysLink').forEach(link => {
        link.addEventListener('click', e => {
          e.preventDefault();
          const un = link.dataset.username;
          if (un) openPeerPanel(un);
        });
      });
      messagesUl.appendChild(sysmsg);
      continue;
    }

    const fromId = msg.senderUserId ?? msg.from?.id;
    const isMe = fromId===meId;

    const row = document.createElement('li');
    row.className = 'row '+(isMe?'me':'other');
    row.dataset.id = msg.id;

    let senderDisplay = '';
    if (isGroup && !isMe) {
      senderDisplay = [msg.senderName||msg.from?.name, msg.senderLastName||msg.from?.lastName].filter(Boolean).join(' ') || '?';
    } else if (!isGroup && !isMe && state.active) {
      const c = state.contacts.find(c=>c.userId===fromId);
      senderDisplay = c?.nickname || displayName(state.active);
    }

    const bubble = document.createElement('div'); bubble.className='bubble';

    const top = document.createElement('div'); top.className='top';
    if (senderDisplay) {
      const un=document.createElement('span'); un.className='uname'; un.textContent=senderDisplay; top.appendChild(un);
    }
    const ts=document.createElement('span'); ts.className='time'; ts.textContent=fmt(msg.ts); top.appendChild(ts);
    const mb=document.createElement('button'); mb.className='msgMenuBtn'; mb.textContent='⋯'; mb.type='button';
    // In group: admin/owner can delete anyone's message for all
    const canDeleteAll = isMe || (isGroup && (myRole==='admin'||myRole==='owner'));
    mb.addEventListener('click',e=>{ e.stopPropagation(); openMsgMenu(e,msg,isMe,canDeleteAll); });
    top.appendChild(mb);
    bubble.appendChild(top);

    if (msg.text) {
      const p=document.createElement('div'); p.className='msgText'; p.innerHTML=linkify(msg.text); bubble.appendChild(p);
    }

    const atts = Array.isArray(msg.attachments)?msg.attachments:[];
    if (atts.length) {
      const wrap=document.createElement('div'); wrap.className='attWrap';
      for (const a of atts) {
        if (a.mime?.startsWith('image/')) {
          const img=document.createElement('img'); img.className='attImg'; img.src=a.url;
          img.addEventListener('click',()=>window.open(a.url,'_blank')); wrap.appendChild(img);
        } else if (a.mime?.startsWith('video/')) {
          const vid=document.createElement('video'); vid.className='attVideo'; vid.src=a.url; vid.controls=true; wrap.appendChild(vid);
        } else if (a.mime?.startsWith('audio/')) {
          const aud=document.createElement('audio'); aud.className='attAudio'; aud.src=a.url; aud.controls=true; wrap.appendChild(aud);
        } else {
          const link=document.createElement('a'); link.className='attFile'; link.href=a.url; link.target='_blank'; link.textContent='📎 '+(a.name||'файл'); wrap.appendChild(link);
        }
      }
      bubble.appendChild(wrap);
    }

    row.appendChild(bubble);

    const reactions = msg.reactions||[];
    if (reactions.length) {
      const rrow=document.createElement('div'); rrow.className='reactionRow';
      for (const r of reactions) {
        const chip=document.createElement('button'); chip.className='reactionChip';
        if (r.userIds?.includes(meId)) chip.classList.add('mine');
        chip.innerHTML=`${escHtml(r.emoji)} <span>${r.cnt}</span>`;
        chip.addEventListener('click',()=>doReaction(msg.id,r.emoji));
        rrow.appendChild(chip);
      }
      row.appendChild(rrow);
    }

    messagesUl.appendChild(row);
  }
}

/* ── Reactions ── */
async function doReaction(messageId, emoji) {
  const body = { messageId, emoji };
  if (state.activeType==='group'&&state.activeGroup) body.groupId=state.activeGroup.id;
  await apiPost('/api/message/react', body);
}

/* ── Socket handlers ── */
function onDmNew(msg) {
  const me=state.me; const fromId=msg.from?.id; const toId=msg.to?.id;
  const peerId=fromId===me.id?toId:fromId;
  const peer=fromId===me.id?msg.to:msg.from;

  const ch=state.chats.find(c=>c.peerUserId===peerId);
  if (ch) {
    ch.lastTs=msg.ts; ch.lastText=msg.text;
    if (fromId!==me.id&&state.active?.id!==peerId) ch.unreadCount=(ch.unreadCount||0)+1;
  } else {
    state.chats.unshift({ chatType:'dm', peerUserId:peerId, lastTs:msg.ts, lastText:msg.text,
      username:peer.username, name:peer.name, last_name:peer.lastName, avatar:peer.avatar,
      unreadCount:fromId===me.id?0:1 });
  }
  if (state.active&&(state.active.id===fromId||state.active.id===toId)) {
    state.messages.push(msg); renderMessages(); scrollToBottom(); markRead();
  }
  renderContacts();
}

function onGroupNew(msg) {
  const g=state.groups.find(x=>x.id===msg.groupId);
  if (g && !msg.isSystem) {
    g.lastTs=msg.ts; g.lastText=msg.text;
    if (state.activeGroup?.id!==msg.groupId) g.unreadCount=(g.unreadCount||0)+1;
  }
  if (state.activeGroup&&state.activeGroup.id===msg.groupId) {
    state.messages.push(msg); renderMessages(); scrollToBottom();
    apiPost(`/api/groups/${msg.groupId}/read`,{});
    if (g) g.unreadCount=0;
  }
  renderContacts();
}

/* ── Send message ── */
formEl.addEventListener('submit', async e => {
  e.preventDefault();
  const text=inputEl.value.trim();
  if (!text&&!state.pendingFiles.length) return;
  const atts=await uploadPending();
  if (state.activeType==='group'&&state.activeGroup) {
    socket.emit('group:send',{ groupId:state.activeGroup.id, text, attachments:atts });
  } else if (state.active) {
    socket.emit('dm:send',{ toUsername:state.active.username, text, attachments:atts });
  }
  inputEl.value='';
  clearAttachPreview();
});

/* ── File attach ── */
fileInput.addEventListener('change', e => {
  for (const f of e.target.files) state.pendingFiles.push(f);
  renderAttachPreview(); fileInput.value='';
});
function renderAttachPreview() {
  attachPreview.innerHTML='';
  if (!state.pendingFiles.length) { attachPreview.classList.add('hidden'); return; }
  attachPreview.classList.remove('hidden');
  state.pendingFiles.forEach((f,i)=>{
    const chip=document.createElement('div'); chip.className='attChip';
    chip.innerHTML=`<span>${escHtml(f.name)}</span>`;
    const rm=document.createElement('button'); rm.textContent='✕'; rm.type='button';
    rm.addEventListener('click',()=>{ state.pendingFiles.splice(i,1); renderAttachPreview(); });
    chip.appendChild(rm); attachPreview.appendChild(chip);
  });
}
function clearAttachPreview() { state.pendingFiles=[]; attachPreview.innerHTML=''; attachPreview.classList.add('hidden'); }
async function uploadPending() {
  const atts=[];
  for (const f of state.pendingFiles) { const r=await uploadFile(f,false); if(r.ok) atts.push(r.file); }
  return atts;
}

/* ── Tabs ── */
$('tabChats').addEventListener('click',()=>{
  state.currentTab='chats';
  $('tabChats').classList.add('active'); $('tabContacts').classList.remove('active');
  renderContacts();
});
$('tabContacts').addEventListener('click',()=>{
  state.currentTab='contacts';
  $('tabContacts').classList.add('active'); $('tabChats').classList.remove('active');
  renderContacts();
});

/* ── Back (mobile) ── */
$('back').addEventListener('click',()=>{
  chatEl.classList.remove('showDialog');
  state.active=null; state.activeGroup=null; state.activeType=null; state.activeGroupRole=null;
  closePeerPanel(); closeGroupPanel();
});

/* ── Add contact from header ── */
addPeerBtn.addEventListener('click',()=>{ if(state.active) openContactModal(state.active,false); });

/* ── Chat header menu (DM only) ── */
const chatMenuEl=$('chatMenu');
$('chatMenuBtn').addEventListener('click',e=>{ e.stopPropagation(); chatMenuEl.classList.toggle('hidden'); });
document.addEventListener('click',()=>{ chatMenuEl.classList.add('hidden'); msgMenuEl.classList.add('hidden'); });
$('deleteForMeBtn').addEventListener('click', async()=>{
  chatMenuEl.classList.add('hidden');
  if (!state.active) return;
  const ok=await confirm('Удалить переписку?','Переписка будет удалена только у вас.');
  if (!ok) return;
  await apiPost('/api/messages/delete',{ username:state.active.username, scope:'me' });
});
$('deleteForAllBtn').addEventListener('click', async()=>{
  chatMenuEl.classList.add('hidden');
  if (!state.active) return;
  const ok=await confirm('Вы уверены?','Данное действие удалит сообщения у всех участников без возможности возврата.');
  if (!ok) return;
  await apiPost('/api/messages/delete',{ username:state.active.username, scope:'all' });
});

/* ── Msg context menu ── */
let msgMenuTarget=null;
function openMsgMenu(e, msg, isMe, canDeleteAll) {
  e.stopPropagation();
  msgMenuTarget={ msg, isMe };
  $('msgDeleteAll').classList.toggle('hidden', !canDeleteAll);
  const meId=state.me?.id;
  document.querySelectorAll('.reactionBtn').forEach(btn=>{
    const r=msg.reactions?.find(x=>x.emoji===btn.dataset.emoji);
    btn.classList.toggle('active',!!(r?.userIds?.includes(meId)));
  });
  const rect=e.target.getBoundingClientRect();
  msgMenuEl.style.left=Math.min(rect.left, window.innerWidth-250)+'px';
  msgMenuEl.style.top=(rect.bottom+4)+'px';
  msgMenuEl.classList.remove('hidden');
}

document.querySelectorAll('.reactionBtn').forEach(btn=>{
  btn.addEventListener('click',e=>{ e.stopPropagation(); if(!msgMenuTarget) return; doReaction(msgMenuTarget.msg.id,btn.dataset.emoji); msgMenuEl.classList.add('hidden'); });
});

$('msgDeleteMe').addEventListener('click', async()=>{
  msgMenuEl.classList.add('hidden');
  if (!msgMenuTarget) return;
  const { msg }=msgMenuTarget;
  if (state.activeType==='group') await apiPost('/api/message/delete-group',{ id:msg.id, scope:'me' });
  else await apiPost('/api/message/delete',{ id:msg.id, scope:'me' });
});
$('msgDeleteAll').addEventListener('click', async()=>{
  msgMenuEl.classList.add('hidden');
  if (!msgMenuTarget) return;
  const { msg }=msgMenuTarget;
  const ok=await confirm('Вы уверены?','Данное действие удалит сообщение у всех участников без возможности возврата.');
  if (!ok) return;
  if (state.activeType==='group') await apiPost('/api/message/delete-group',{ id:msg.id, scope:'all' });
  else await apiPost('/api/message/delete',{ id:msg.id, scope:'all' });
});

/* ── Search ── */
let searchTimer=null;
searchEl.addEventListener('input',()=>{
  clearTimeout(searchTimer);
  const q=searchEl.value.trim();
  if (!q) { searchResults.classList.add('hidden'); return; }
  searchTimer=setTimeout(async()=>{
    const r=await apiGet('/api/users/search?q='+encodeURIComponent(q));
    if (!r.ok) return;
    searchResults.innerHTML='';
    if (!r.users.length) {
      searchResults.innerHTML='<div class="searchItem" style="color:var(--muted)">Не найдено</div>';
    } else {
      for (const u of r.users) {
        const item=document.createElement('div'); item.className='searchItem';
        const av=document.createElement('div'); av.className='miniAvatar'; applyAvatar(av,u.avatar);
        const info=document.createElement('div'); info.className='searchInfo';
        info.innerHTML=`<div class="contactTitle">${escHtml(displayName(u))}</div><div class="contactSub">${u.username?'@'+escHtml(u.username):''}</div>`;
        item.appendChild(av); item.appendChild(info);
        item.addEventListener('click',()=>{ searchEl.value=''; searchResults.classList.add('hidden'); openDialogByUsername(u.username); });
        searchResults.appendChild(item);
      }
    }
    searchResults.classList.remove('hidden');
  },300);
});
searchEl.addEventListener('focus',()=>{ if(searchEl.value.trim()) searchResults.classList.remove('hidden'); });
document.addEventListener('click',e=>{ if(!e.target.closest('.searchWrap')) searchResults.classList.add('hidden'); });

/* ── Unified "+" button ── */
const addDrop = $('addDrop');
$('addBtn').addEventListener('click', e => {
  e.stopPropagation();
  addDrop.classList.toggle('hidden');
});
document.addEventListener('click', e => {
  if (!e.target.closest('.addBtnWrap')) addDrop.classList.add('hidden');
});
$('addContactBtn').addEventListener('click', () => {
  addDrop.classList.add('hidden');
  openContactModal(null, false);
});
$('addGroupBtn').addEventListener('click', () => {
  addDrop.classList.add('hidden');
  openGroupCreationModal();
});

/* ── Peer profile panel (DM) ── */
function closePeerPanel() { peerPanelEl.classList.remove('open'); state.peerPanelData=null; }

async function openPeerPanel(username) {
  if (!username) return;
  // Close group panel if open
  closeGroupPanel();
  peerPanelEl.classList.add('open');
  const r=await apiGet('/api/profile/'+username);
  if (!r.ok) return;
  state.peerPanelData=r;
  state.peerPanelTab='media';
  applyAvatar(ppAvatarEl, r.user.avatar);
  const contact=state.contacts.find(c=>c.userId===r.user.id);
  ppNameEl.textContent=contact?.nickname||displayName(r.user);
  const lines=[];
  if (r.user.phone) lines.push(r.user.phone);
  if (r.user.username) lines.push('@'+r.user.username);
  ppInfoEl.innerHTML=lines.map(escHtml).join('<br>');
  $('ppBlock').textContent=r.blockedByMe?'Разблокировать':'Заблокировать';
  document.querySelectorAll('.ppTab').forEach(t=>t.classList.toggle('active',t.dataset.tab==='media'));
  renderPeerTab('media');
}

function renderPeerTab(tab) {
  state.peerPanelTab=tab;
  const d=state.peerPanelData;
  document.querySelectorAll('.ppTab').forEach(t=>t.classList.toggle('active',t.dataset.tab===tab));
  ppContentEl.innerHTML='';
  if (tab==='media') {
    const media=d?.media||[];
    if (!media.length) { ppContentEl.innerHTML='<div class="ppEmpty">Нет медиафайлов</div>'; return; }
    const grid=document.createElement('div'); grid.className='ppMediaGrid';
    for (const a of media) {
      const img=document.createElement('img'); img.className='ppMediaThumb'; img.src=a.url;
      img.addEventListener('click',()=>window.open(a.url,'_blank')); grid.appendChild(img);
    }
    ppContentEl.appendChild(grid);
  } else if (tab==='links') {
    const links=d?.links||[];
    if (!links.length) { ppContentEl.innerHTML='<div class="ppEmpty">Нет ссылок</div>'; return; }
    for (const l of links) {
      const item=document.createElement('div'); item.className='ppLinkItem';
      item.innerHTML=`<a href="${escHtml(l.url)}" target="_blank" rel="noopener noreferrer">${escHtml(l.url)}</a><div class="ppLinkTime">${fmtDate(l.ts)}</div>`;
      ppContentEl.appendChild(item);
    }
  } else if (tab==='groups') {
    const groups=d?.sharedGroups||[];
    if (!groups.length) { ppContentEl.innerHTML='<div class="ppEmpty">Нет общих групп</div>'; return; }
    for (const g of groups) {
      const item=document.createElement('div'); item.className='ppGroupItem';
      const av=document.createElement('div'); av.className='ppGroupAvatar';
      if (g.avatar) applyAvatar(av,g.avatar); else av.textContent='👥';
      const nm=document.createElement('div'); nm.textContent=g.name;
      item.appendChild(av); item.appendChild(nm); ppContentEl.appendChild(item);
    }
  }
}

document.querySelectorAll('.ppTab').forEach(btn=>btn.addEventListener('click',()=>renderPeerTab(btn.dataset.tab)));
$('peerPanelBack').addEventListener('click', closePeerPanel);

// Click on peer header
peerInfoBtn.addEventListener('click',()=>{
  if (state.activeType==='dm'&&state.active?.username) {
    if (peerPanelEl.classList.contains('open')) { closePeerPanel(); return; }
    openPeerPanel(state.active.username);
  } else if (state.activeType==='group'&&state.activeGroup) {
    if (groupPanelEl.classList.contains('open')) { closeGroupPanel(); return; }
    openGroupPanel(state.activeGroup.id);
  }
});

// Panel action buttons (DM)
$('ppEditContact').addEventListener('click',()=>{
  if (!state.peerPanelData) return;
  const u = state.peerPanelData.user; // Save before closing
  closePeerPanel();
  openContactModal(u, true);
});
$('ppDeleteContact').addEventListener('click', async()=>{
  if (!state.peerPanelData) return;
  const ok=await confirm('Удалить контакт?','Пользователь будет удалён из ваших контактов.');
  if (!ok) return;
  const r=await apiPost('/api/contacts/delete',{ username:state.peerPanelData.user.username });
  if (r.ok) { state.contacts=r.contacts; renderContacts(); closePeerPanel(); }
});
$('ppBlock').addEventListener('click', async()=>{
  if (!state.peerPanelData) return;
  const u=state.peerPanelData.user;
  if (state.peerPanelData.blockedByMe) {
    await apiPost('/api/blocks/remove',{ username:u.username });
    state.peerPanelData.blockedByMe=false; $('ppBlock').textContent='Заблокировать';
  } else {
    const ok=await confirm('Заблокировать?','Пользователь не сможет отправлять вам сообщения.');
    if (!ok) return;
    await apiPost('/api/blocks/add',{ username:u.username });
    state.peerPanelData.blockedByMe=true; $('ppBlock').textContent='Разблокировать';
  }
});

/* ── Group profile panel ── */
function closeGroupPanel() { groupPanelEl.classList.remove('open'); state.groupPanelData=null; }

async function openGroupPanel(groupId) {
  closePeerPanel();
  groupPanelEl.classList.add('open');
  const r = await apiGet(`/api/groups/${groupId}`);
  if (!r.ok) return;
  state.groupPanelData = { group: r.group, members: r.members, myRole: r.myRole };
  state.groupPanelTab = 'members';

  applyAvatar($('gpAvatar'), r.group.avatar);
  $('gpName').textContent = r.group.name;
  $('gpDesc').textContent = r.group.description || '';

  const canManage = r.myRole === 'owner' || r.myRole === 'admin';
  $('groupSettingsBtn').classList.toggle('hidden', !canManage);
  $('gpClearAll').classList.toggle('hidden', !canManage);
  // Owner cannot leave
  $('gpLeave').classList.toggle('hidden', r.myRole === 'owner');

  document.querySelectorAll('.gpTab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'members'));
  renderGroupTab('members');
}

function renderGroupTab(tab) {
  state.groupPanelTab = tab;
  const d = state.groupPanelData;
  if (!d) return;
  document.querySelectorAll('.gpTab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  const content = $('gpContent');
  content.innerHTML = '';

  if (tab === 'members') {
    // "Add members" button for owner/admin
    if (d.myRole === 'owner' || d.myRole === 'admin') {
      const addBtn = document.createElement('button');
      addBtn.className = 'addMembersBtn';
      addBtn.textContent = '+ Добавление участников';
      addBtn.addEventListener('click', openAddMembersModal);
      content.appendChild(addBtn);
    }
    const members = d.members || [];
    for (const m of members) {
      const item = document.createElement('div'); item.className = 'gpMemberItem';
      const av = document.createElement('div'); av.className = 'miniAvatar'; applyAvatar(av, m.avatar);
      const info = document.createElement('div'); info.className = 'contactTxt';
      const roleLabel = m.role === 'owner' ? '<span class="roleLabel owner">Владелец</span>'
                      : m.role === 'admin'  ? '<span class="roleLabel admin">Администратор</span>' : '';
      info.innerHTML = `<div class="contactTitle">${escHtml(displayName(m))}</div>${roleLabel}`;
      const dots = document.createElement('button'); dots.className = 'gpDotsBtn'; dots.type = 'button'; dots.textContent = '⋯';
      dots.addEventListener('click', e => { e.stopPropagation(); openMemberMenu(e, m); });
      item.appendChild(av); item.appendChild(info); item.appendChild(dots);
      content.appendChild(item);
    }
    if (!members.length) content.innerHTML = '<div class="ppEmpty">Нет участников</div>';
  } else if (tab === 'media') {
    // Fetch group media
    apiGet(`/api/groups/${d.group.id}/media`).then(r => {
      content.innerHTML = '';
      if (!r.ok || !r.media.length) { content.innerHTML = '<div class="ppEmpty">Нет медиафайлов</div>'; return; }
      const grid = document.createElement('div'); grid.className = 'ppMediaGrid';
      for (const a of r.media) {
        const img = document.createElement('img'); img.className = 'ppMediaThumb'; img.src = a.url;
        img.addEventListener('click', () => window.open(a.url, '_blank')); grid.appendChild(img);
      }
      content.appendChild(grid);
    });
    content.innerHTML = '<div class="ppEmpty">Загрузка...</div>';
  } else if (tab === 'links') {
    apiGet(`/api/groups/${d.group.id}/links`).then(r => {
      content.innerHTML = '';
      if (!r.ok || !r.links.length) { content.innerHTML = '<div class="ppEmpty">Нет ссылок</div>'; return; }
      for (const l of r.links) {
        const item = document.createElement('div'); item.className = 'ppLinkItem';
        item.innerHTML = `<a href="${escHtml(l.url)}" target="_blank" rel="noopener noreferrer">${escHtml(l.url)}</a><div class="ppLinkTime">${fmtDate(l.ts)}</div>`;
        content.appendChild(item);
      }
    });
    content.innerHTML = '<div class="ppEmpty">Загрузка...</div>';
  }
}

document.querySelectorAll('.gpTab').forEach(btn => btn.addEventListener('click', () => renderGroupTab(btn.dataset.tab)));
$('groupPanelBack').addEventListener('click', closeGroupPanel);

// Member "..." menu
function openMemberMenu(e, member) {
  document.querySelectorAll('.memberMenuFloat').forEach(m => m.remove());
  const d = state.groupPanelData;
  if (!d) return;
  const myRole = d.myRole;

  const menu = document.createElement('div');
  menu.className = 'memberMenuFloat';

  const openBtn = document.createElement('button');
  openBtn.className = 'menuItem'; openBtn.textContent = 'Открыть профиль';
  openBtn.addEventListener('click', () => {
    menu.remove();
    if (member.username) openPeerPanel(member.username);
  });
  menu.appendChild(openBtn);

  const canManage = (myRole === 'owner' || myRole === 'admin') && member.role !== 'owner';
  const itsMe = member.id === state.me?.id;
  if (canManage && !itsMe) {
    const removeBtn = document.createElement('button');
    removeBtn.className = 'menuItem danger'; removeBtn.textContent = 'Удалить из группы';
    removeBtn.addEventListener('click', async () => {
      menu.remove();
      const ok = await confirm('Удалить участника?', `Удалить ${displayName(member)} из группы?`);
      if (!ok) return;
      const r = await apiPost(`/api/groups/${d.group.id}/members/remove`, { userId: member.id });
      if (r.ok) {
        state.groupPanelData.members = state.groupPanelData.members.filter(mm => mm.id !== member.id);
        renderGroupTab(state.groupPanelTab);
      }
    });
    menu.appendChild(removeBtn);
  }

  document.body.appendChild(menu);
  const rect = e.target.getBoundingClientRect();
  const menuW = 220;
  menu.style.left = Math.min(rect.left, window.innerWidth - menuW - 8) + 'px';
  menu.style.top = (rect.bottom + 4) + 'px';
  setTimeout(() => { document.addEventListener('click', () => menu.remove(), { once: true }); }, 0);
}

// Group panel action buttons
$('gpLeave').addEventListener('click', async () => {
  if (!state.groupPanelData) return;
  const ok = await confirm('Покинуть группу?', 'Вы уверены в том, что хотите покинуть данную группу?', 'Да, уверен', 'Отменить');
  if (!ok) return;
  const r = await apiPost(`/api/groups/${state.groupPanelData.group.id}/leave`, {});
  if (!r.ok) {
    if (r.error === 'owner_cannot_leave') alert('Владелец не может покинуть группу.');
  }
  // group:left socket event will handle UI update
});

$('gpClearMe').addEventListener('click', async () => {
  if (!state.groupPanelData) return;
  const ok = await confirm('Очистить сообщения?', 'Все сообщения группы будут удалены только для вас.');
  if (!ok) return;
  await apiPost(`/api/groups/${state.groupPanelData.group.id}/clear-me`, {});
  closeGroupPanel();
});

$('gpClearAll').addEventListener('click', async () => {
  if (!state.groupPanelData) return;
  const ok = await confirm('Очистить для всех?', 'Все сообщения группы будут удалены для всех участников без возможности восстановления.');
  if (!ok) return;
  await apiPost(`/api/groups/${state.groupPanelData.group.id}/clear-all`, {});
  closeGroupPanel();
});

// Group settings button
$('groupSettingsBtn').addEventListener('click', () => {
  if (!state.groupPanelData) return;
  const d = state.groupPanelData;
  $('gsName').value = d.group.name || '';
  $('gsDesc').value = d.group.description || '';
  $('gsError').textContent = '';
  gsAvatarFile = null;
  applyAvatar($('gsAvatarPreview'), d.group.avatar);
  // Show admin button only for owner
  $('gsAdminBtn').classList.toggle('hidden', d.myRole !== 'owner');
  $('groupSettingsModal').classList.remove('hidden');
});

let gsAvatarFile = null;
$('gsPhotoInput').addEventListener('change', e => {
  const f = e.target.files[0]; if (!f) return;
  gsAvatarFile = f; applyAvatar($('gsAvatarPreview'), URL.createObjectURL(f));
});
$('gsCancel').addEventListener('click', () => $('groupSettingsModal').classList.add('hidden'));
$('gsBackdrop').addEventListener('click', () => $('groupSettingsModal').classList.add('hidden'));
$('gsForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (!state.groupPanelData) return;
  $('gsError').textContent = '';
  const gid = state.groupPanelData.group.id;
  const fd = new FormData();
  const name = $('gsName').value.trim();
  if (!name) { $('gsError').textContent = 'Введите название.'; return; }
  fd.append('name', name);
  fd.append('description', $('gsDesc').value.trim());
  if (gsAvatarFile) fd.append('avatar', gsAvatarFile);
  const r = await fetch(`/api/groups/${gid}`, { method: 'PUT', body: fd });
  const data = await r.json();
  if (data.ok) {
    $('groupSettingsModal').classList.add('hidden');
    gsAvatarFile = null;
    if (state.groupPanelData) {
      Object.assign(state.groupPanelData.group, data.group);
      applyAvatar($('gpAvatar'), data.group.avatar);
      $('gpName').textContent = data.group.name;
      $('gpDesc').textContent = data.group.description || '';
    }
  } else {
    $('gsError').textContent = data.error || 'Ошибка';
  }
});

// Admin assignment button
$('gsAdminBtn').addEventListener('click', () => {
  if (!state.groupPanelData) return;
  openAdminModal();
});

function openAdminModal() {
  const d = state.groupPanelData;
  const list = $('adminMembersList');
  list.innerHTML = '';
  // Show all members except owner
  const members = (d.members || []).filter(m => m.role !== 'owner');
  if (!members.length) {
    list.innerHTML = '<div style="padding:8px;color:var(--muted);font-size:13px">Нет участников</div>';
  } else {
    for (const m of members) {
      const item = document.createElement('label'); item.className = 'groupMemberItem';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = m.id;
      cb.checked = m.role === 'admin';
      const av = document.createElement('div'); av.className = 'miniAvatar'; av.style.cssText = 'width:32px;height:32px;flex-shrink:0'; applyAvatar(av, m.avatar);
      const nm = document.createElement('span'); nm.textContent = displayName(m);
      item.appendChild(cb); item.appendChild(av); item.appendChild(nm);
      list.appendChild(item);
    }
  }
  $('adminModal').classList.remove('hidden');
}

$('adminCancel').addEventListener('click', () => $('adminModal').classList.add('hidden'));
$('adminBackdrop').addEventListener('click', () => $('adminModal').classList.add('hidden'));
$('adminApply').addEventListener('click', async () => {
  if (!state.groupPanelData) return;
  const d = state.groupPanelData;
  const gid = d.group.id;
  const checks = [...$('adminMembersList').querySelectorAll('input[type=checkbox]')];
  const members = (d.members || []).filter(m => m.role !== 'owner');
  for (let i = 0; i < checks.length; i++) {
    const m = members[i]; if (!m) continue;
    const shouldBeAdmin = checks[i].checked;
    const isAdmin = m.role === 'admin';
    if (shouldBeAdmin !== isAdmin) {
      await apiPost(`/api/groups/${gid}/set-role`, { userId: m.id, role: shouldBeAdmin ? 'admin' : 'member' });
    }
  }
  $('adminModal').classList.add('hidden');
  // Refresh panel data
  const r = await apiGet(`/api/groups/${gid}`);
  if (r.ok) {
    state.groupPanelData.members = r.members;
    renderGroupTab(state.groupPanelTab);
  }
});

/* ── Add Members Modal ── */
function openAddMembersModal() {
  if (!state.groupPanelData) return;
  const d = state.groupPanelData;
  const currentIds = new Set((d.members || []).map(m => m.id));
  const list = $('addMembersList');
  list.innerHTML = '';
  if (!state.contacts.length) {
    list.innerHTML = '<div style="padding:8px;color:var(--muted);font-size:13px">Нет контактов</div>';
  } else {
    for (const c of state.contacts) {
      const alreadyIn = currentIds.has(c.userId);
      const item = document.createElement('label'); item.className = 'groupMemberItem' + (alreadyIn ? ' already-in' : '');
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = c.userId;
      cb.checked = alreadyIn;
      if (alreadyIn) cb.disabled = true;
      const av = document.createElement('div'); av.className = 'miniAvatar'; av.style.cssText = 'width:32px;height:32px;flex-shrink:0'; applyAvatar(av, c.avatar);
      const nm = document.createElement('span'); nm.textContent = c.nickname || displayName({ name:c.name, lastName:c.last_name }) || c.phone;
      item.appendChild(cb); item.appendChild(av); item.appendChild(nm);
      list.appendChild(item);
    }
  }
  $('addMembersModal').classList.remove('hidden');
}

$('addMembersCancel').addEventListener('click', () => $('addMembersModal').classList.add('hidden'));
$('addMembersBackdrop').addEventListener('click', () => $('addMembersModal').classList.add('hidden'));
$('addMembersApply').addEventListener('click', async () => {
  if (!state.groupPanelData) return;
  const gid = state.groupPanelData.group.id;
  const currentIds = new Set((state.groupPanelData.members || []).map(m => m.id));
  const newIds = [...$('addMembersList').querySelectorAll('input[type=checkbox]:checked:not(:disabled)')]
    .map(cb => Number(cb.value))
    .filter(id => !currentIds.has(id));
  if (!newIds.length) { $('addMembersModal').classList.add('hidden'); return; }
  $('addMembersApply').disabled = true;
  const r = await apiPost(`/api/groups/${gid}/members/add`, { userIds: newIds });
  $('addMembersApply').disabled = false;
  if (r.ok) {
    state.groupPanelData.members = r.members;
    renderGroupTab(state.groupPanelTab);
  }
  $('addMembersModal').classList.add('hidden');
});

/* ── Profile modal ── */
const profileModal=$('profileModal');
let selectedProfileAvatar=null;
$('meLineBtn').addEventListener('click',()=>{
  const u=state.me;
  $('profileName').value     = u.name||'';
  $('profileLastName').value = u.lastName||u.last_name||'';
  $('profileUsername').value = u.username||'';
  $('profilePhone').value    = u.phone||'';
  $('profileError').textContent='';
  selectedProfileAvatar=u.avatar;
  applyAvatar($('profileAvatarPreview'), u.avatar);
  document.querySelectorAll('.profAv').forEach(btn=>{
    btn.classList.toggle('selected', btn.dataset.avatar===u.avatar);
    btn.onclick=()=>{
      document.querySelectorAll('.profAv').forEach(b=>b.classList.remove('selected'));
      btn.classList.add('selected');
      selectedProfileAvatar=btn.dataset.avatar;
      applyAvatar($('profileAvatarPreview'),selectedProfileAvatar);
    };
  });
  $('profilePhotoInput').onchange=async ev=>{
    const f=ev.target.files[0]; if(!f) return;
    const r=await uploadFile(f,false);
    if (r.ok) { selectedProfileAvatar=r.file.url; applyAvatar($('profileAvatarPreview'),selectedProfileAvatar); }
  };
  profileModal.classList.remove('hidden');
});
$('profileForm').addEventListener('submit', async e=>{
  e.preventDefault(); $('profileError').textContent='';
  const r=await apiPost('/api/me/update',{
    name:$('profileName').value.trim(), lastName:$('profileLastName').value.trim(),
    username:$('profileUsername').value.trim(), phone:$('profilePhone').value.trim(),
    avatar:selectedProfileAvatar,
  });
  if (r.ok) {
    state.me=r.user;
    applyAvatar(meAvatarEl,r.user.avatar);
    meNameEl.textContent=displayName(r.user);
    whoEl.textContent=r.user.username?'@'+r.user.username:'';
    profileModal.classList.add('hidden');
  } else {
    const MAP={username_taken:'Юзернейм занят.',username_invalid:'Юзернейм некорректен.',name_required:'Введите имя.',phone_taken:'Номер уже используется.'};
    $('profileError').textContent=MAP[r.error]||r.error;
  }
});
$('profileCancel').addEventListener('click',()=>profileModal.classList.add('hidden'));
$('profileBackdrop').addEventListener('click',()=>profileModal.classList.add('hidden'));

/* ── Contact modal ── */
const contactModal=$('contactModal');
function openContactModal(user, isEdit) {
  $('contactModalTitle').textContent=isEdit?'Изменить контакт':'Добавить контакт';
  $('contactModalDesc').textContent=isEdit?'Измените имя контакта.':'Контакт добавится, если номер зарегистрирован.';
  $('contactFirst').value = user?.name||'';
  $('contactLast').value  = user?.lastName||user?.last_name||'';
  $('contactPhone').value = user?.phone||'';
  $('contactPhone').disabled=!!isEdit;
  $('contactError').textContent='';
  $('contactSubmit').textContent=isEdit?'Сохранить':'Добавить';
  contactModal.classList.remove('hidden');
  $('contactForm').onsubmit=async e=>{
    e.preventDefault(); $('contactError').textContent='';
    if (isEdit) {
      const nickname=[$('contactFirst').value.trim(),$('contactLast').value.trim()].filter(Boolean).join(' ');
      const r=await apiPost('/api/contacts/update',{ username:user.username, nickname });
      if (r.ok) { state.contacts=r.contacts; renderContacts(); contactModal.classList.add('hidden'); updateDialogHeader(); }
      else $('contactError').textContent=r.error;
    } else {
      const phone=$('contactPhone').value.trim();
      const nickname=[$('contactFirst').value.trim(),$('contactLast').value.trim()].filter(Boolean).join(' ');
      const r=await apiPost('/api/contacts/add',{ phone, nickname });
      if (r.ok) {
        state.contacts=r.contacts; renderContacts(); contactModal.classList.add('hidden');
        if (state.active) { addPeerBtn.classList.toggle('hidden', r.contacts.some(c=>c.userId===state.active.id)); updateDialogHeader(); }
      } else {
        const MAP={user_not_found:'Пользователь с таким номером не найден.',invalid_phone:'Некорректный номер.',cannot_add_self:'Нельзя добавить себя.'};
        $('contactError').textContent=MAP[r.error]||r.error;
      }
    }
  };
}
$('contactCancel').addEventListener('click',()=>contactModal.classList.add('hidden'));
$('contactBackdrop').addEventListener('click',()=>contactModal.classList.add('hidden'));

/* ── Group creation modal ── */
const groupModal=$('groupModal');
let groupAvatarFile=null;
function openGroupCreationModal() {
  $('groupName').value=''; $('groupDesc').value=''; $('groupError').textContent='';
  groupAvatarFile=null; applyAvatar($('groupAvatarPreview'),null);
  const list=$('groupMembersList'); list.innerHTML='';
  if (!state.contacts.length) {
    list.innerHTML='<div class="ppEmpty" style="padding:8px">Нет контактов</div>';
  } else {
    for (const c of state.contacts) {
      const item=document.createElement('label'); item.className='groupMemberItem';
      const cb=document.createElement('input'); cb.type='checkbox'; cb.value=c.userId;
      const av=document.createElement('div'); av.className='miniAvatar'; av.style.cssText='width:32px;height:32px;flex-shrink:0'; applyAvatar(av,c.avatar);
      const nm=document.createElement('span'); nm.textContent=c.nickname||displayName({name:c.name,lastName:c.last_name})||c.phone;
      item.appendChild(cb); item.appendChild(av); item.appendChild(nm); list.appendChild(item);
    }
  }
  groupModal.classList.remove('hidden');
}
$('groupPhotoInput').addEventListener('change',e=>{
  const f=e.target.files[0]; if(!f) return;
  groupAvatarFile=f; applyAvatar($('groupAvatarPreview'),URL.createObjectURL(f));
});
$('groupCancel').addEventListener('click',()=>groupModal.classList.add('hidden'));
$('groupBackdrop').addEventListener('click',()=>groupModal.classList.add('hidden'));
$('groupForm').addEventListener('submit', async e=>{
  e.preventDefault(); $('groupError').textContent='';
  const name=$('groupName').value.trim();
  if (!name) { $('groupError').textContent='Введите название группы.'; return; }
  const desc=$('groupDesc').value.trim();
  const memberIds=[...$('groupMembersList').querySelectorAll('input[type=checkbox]:checked')].map(cb=>Number(cb.value));
  const fd=new FormData();
  fd.append('name',name); fd.append('description',desc); fd.append('memberIds',JSON.stringify(memberIds));
  if (groupAvatarFile) fd.append('avatar',groupAvatarFile);
  const submitBtn=$('groupForm').querySelector('.btn.primary'); submitBtn.disabled=true;
  const r=await fetch('/api/groups/create',{ method:'POST', body:fd });
  const data=await r.json(); submitBtn.disabled=false;
  if (data.ok) {
    groupModal.classList.add('hidden');
    const newGroup={ ...data.group, chatType:'group', role:'owner' };
    if (!state.groups.find(g=>g.id===newGroup.id)) state.groups.unshift(newGroup);
    renderContacts();
    openGroup(data.group);
  } else {
    $('groupError').textContent='Ошибка: '+data.error;
  }
});

/* ── Logout ── */
$('logout').addEventListener('click', async()=>{
  const ok=await confirm('Выйти из аккаунта?','Вы будете разлогинены на этом устройстве.');
  if (!ok) return;
  document.cookie='session=;Max-Age=0;Path=/';
  location.reload();
});

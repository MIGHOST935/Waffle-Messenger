const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { Server } = require('socket.io');
const {
  db, getUserByPhone, getUserById, getUserByUsername, isUsernameAvailable, searchUsersByUsername,
  createUser, listContacts, addContact,
  insertMessage, getMessageById, listMessagesBetween,
  listChats, markChatRead,
  hideChatForUser, deleteConversationForAll,
  hideMessageForUser, deleteMessageForAll,
  updateContactNickname, deleteContact,
  blockUser, unblockUser, isBlocked,
  updateProfile,
  toggleReaction,
  createGroup, getGroupById, updateGroup,
  addGroupMember, removeGroupMember, setGroupMemberRole, getGroupMember,
  listGroupMembers, listUserGroups,
  sendGroupMessage, sendGroupSystemMessage, listGroupMessages,
  getGroupMessageById, deleteGroupMessageForAll, hideGroupMessageForUser,
  clearGroupMessagesForUser, clearGroupMessagesForAll,
  markGroupChatRead, getSharedGroups, getMediaBetween, getLinksBetween,
  getGroupMedia, getGroupLinks,
} = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 2e6 });

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const BG_DIR = path.join(__dirname, 'bg');
if (!fs.existsSync(BG_DIR)) fs.mkdirSync(BG_DIR, { recursive: true });
// Инициализация Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const uploadMw = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || '').slice(0, 16).replace(/[^a-zA-Z0-9.]/g, '');
      cb(null, crypto.randomBytes(12).toString('hex') + ext);
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
});

app.use(express.json({ limit: '2mb' }));
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d', immutable: true }));
app.use('/bg', express.static(BG_DIR, { maxAge: '1d' }));

const STATIC = new Set(['index.html', 'client.js', 'styles.css']);
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/:file', (req, res, next) => {
  if (!STATIC.has(req.params.file)) return next();
  res.sendFile(path.join(__dirname, req.params.file));
});

const pendingCodes = new Map();
const sessions = new Map();
const DEFAULT_REGISTER_CODE = '935935';

function normalizePhone(raw) {
  const d = String(raw ?? '').replace(/[^\d]/g, '');
  if (d.length === 11 && d.startsWith('8')) return `7${d.slice(1)}`;
  return d;
}
function parseCookies(h) {
  const out = {};
  for (const p of String(h||'').split(';')) {
    const i = p.indexOf('='); if (i === -1) continue;
    const k = p.slice(0,i).trim(); if (!k) continue;
    out[k] = decodeURIComponent(p.slice(i+1).trim());
  }
  return out;
}
function getToken(req) {
  const a = req.headers.authorization;
  if (a && a.toLowerCase().startsWith('bearer ')) return a.slice(7).trim();
  return parseCookies(req.headers.cookie).session || '';
}
function getSocketToken(socket) {
  const t = socket.handshake?.auth?.token;
  if (t) return String(t);
  return parseCookies(socket.handshake?.headers?.cookie).session || '';
}
function pub(u) {
  if (!u) return null;
  return { id:u.id, phone:u.phone, username:u.username, name:u.name, lastName:u.last_name||u.lastName||null, avatar:u.avatar };
}
function pubMember(m) {
  return { id:m.id, phone:m.phone, username:m.username, name:m.name, lastName:m.last_name||m.lastName||null, avatar:m.avatar, role:m.role };
}
// Format system message text with clickable user link
function sysMsgText(user, action) {
  const name = (user.name || user.username || 'Участник').slice(0, 32);
  const username = user.username || '';
  return `__LINK__${username}|${name}__ ${action}`;
}
async function uploadToCloudinary(filePath, folderName = 'messenger') {
  try {
    const result = await cloudinary.uploader.upload(filePath, {
      folder: folderName,
      resource_type: 'auto',
    });
    // Удаляем временный файл с диска после загрузки в облако
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    return result.secure_url;
  } catch (err) {
    console.error('Ошибка загрузки в Cloudinary:', err);
    throw err;
  }
}
function requireAuth(req, res, next) {
  const session = sessions.get(getToken(req));
  if (!session) return res.status(401).json({ ok:false, error:'unauthorized' });
  const user = getUserByPhone(session.phone);
  if (!user) return res.status(401).json({ ok:false, error:'unauthorized' });
  req.user = user; req.session = session;
  return next();
}

// ── Auth ──────────────────────────────────────────────────────────────────────
app.post('/api/auth/request-code', (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const purpose = String(req.body?.purpose ?? 'login');
  if (!phone || phone.length < 10 || phone.length > 15)
    return res.status(400).json({ ok:false, error:'invalid_phone' });
  if (purpose !== 'login' && purpose !== 'register')
    return res.status(400).json({ ok:false, error:'invalid_purpose' });
  const user = getUserByPhone(phone);
  if (purpose === 'login' && !user) return res.status(404).json({ ok:false, error:'user_not_found' });
  if (purpose === 'register' && user) return res.status(409).json({ ok:false, error:'user_exists' });
  const code = purpose === 'register' ? DEFAULT_REGISTER_CODE : String(Math.floor(100000 + Math.random()*900000));
  pendingCodes.set(phone, { code, expiresAt: Date.now() + 3*60*1000, purpose });
  return res.json({ ok:true, devCode: code, expiresInSec: 180 });
});

app.post('/api/auth/verify', (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const code = String(req.body?.code ?? '').trim();
  const purpose = String(req.body?.purpose ?? 'login');
  const name = String(req.body?.name ?? '').trim().slice(0, 32);
  const lastName = String(req.body?.lastName ?? '').trim().slice(0, 32);
  const username = String(req.body?.username ?? '').trim().slice(0, 24);
  const avatar = String(req.body?.avatar ?? '').trim().slice(0, 512);
  const pending = pendingCodes.get(phone);
  const isMasterCode = purpose === 'register' && code === DEFAULT_REGISTER_CODE;
  if (!isMasterCode) {
    if (!pending || pending.expiresAt < Date.now()) { pendingCodes.delete(phone); return res.status(400).json({ ok:false, error:'code_expired' }); }
    if (pending.purpose !== purpose) return res.status(400).json({ ok:false, error:'invalid_purpose' });
    if (pending.code !== code) return res.status(400).json({ ok:false, error:'invalid_code' });
    pendingCodes.delete(phone);
  }
  let user = getUserByPhone(phone);
  if (purpose === 'register') {
    if (user) return res.status(409).json({ ok:false, error:'user_exists' });
    if (!name) return res.status(400).json({ ok:false, error:'name_required' });
    if (!username || !/^[a-zA-Z0-9_]{4,24}$/.test(username)) return res.status(400).json({ ok:false, error:'username_invalid' });
    if (!isUsernameAvailable(username)) return res.status(409).json({ ok:false, error:'username_taken' });
    if (!avatar) return res.status(400).json({ ok:false, error:'avatar_required' });
    user = createUser({ phone, username, name, lastName, avatar });
  } else {
    if (!user) return res.status(404).json({ ok:false, error:'user_not_found' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { phone, createdAt: Date.now() });
  res.setHeader('Set-Cookie', `session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`);
  return res.json({ ok:true, token, phone, user: pub(user) });
});

app.get('/api/users/check-username', (req, res) => {
  const username = String(req.query.username || '').trim();
  if (!username || !/^[a-zA-Z0-9_]{4,24}$/.test(username))
    return res.json({ ok:true, available: false, reason: 'invalid_format' });
  const available = isUsernameAvailable(username);
  return res.json({ ok:true, available });
});

app.get('/api/me', (req, res) => {
  const session = sessions.get(getToken(req));
  if (!session) return res.status(401).json({ ok:false, error:'unauthorized' });
  const user = getUserByPhone(session.phone);
  return res.json({ ok:true, phone:session.phone, user: pub(user) });
});

app.post('/api/me/update', requireAuth, (req, res) => {
  const me = req.user;
  const patch = {};
  if ('name' in req.body) {
    const v = String(req.body.name||'').trim().slice(0,32);
    if (!v) return res.status(400).json({ ok:false, error:'name_required' });
    patch.name = v;
  }
  if ('lastName' in req.body) patch.lastName = String(req.body.lastName||'').trim().slice(0,32);
  if ('username' in req.body) {
    const v = String(req.body.username||'').trim();
    if (!v || !/^[a-zA-Z0-9_]{4,24}$/.test(v)) return res.status(400).json({ ok:false, error:'username_invalid' });
    if (v.toLowerCase() !== String(me.username||'').toLowerCase()) {
      if (!isUsernameAvailable(v)) return res.status(409).json({ ok:false, error:'username_taken' });
    }
    patch.username = v;
  }
  if ('phone' in req.body) {
    const np = normalizePhone(req.body.phone);
    if (!np || np.length < 10 || np.length > 15) return res.status(400).json({ ok:false, error:'invalid_phone' });
    if (np !== me.phone) {
      if (getUserByPhone(np)) return res.status(409).json({ ok:false, error:'phone_taken' });
      patch.phone = np;
    }
  }
  if ('avatar' in req.body) patch.avatar = String(req.body.avatar||'').trim().slice(0,512);
  const updated = updateProfile({ id: me.id, ...patch });
  if (patch.phone) {
    for (const s of sessions.values()) { if (s.phone === me.phone) s.phone = patch.phone; }
  }
  return res.json({ ok:true, user: pub(updated) });
});

// ── Upload ────────────────────────────────────────────────────────────────────
app.post('/api/upload', requireAuth, uploadMw.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok:false, error:'no_file' });
  try {
    const url = await uploadToCloudinary(req.file.path);
    return res.json({ ok:true, file: {
      url: url,
      name: req.file.originalname,
      size: req.file.size,
      mime: req.file.mimetype || 'application/octet-stream',
    }});
  } catch (e) {
    return res.status(500).json({ ok:false, error:'upload_failed' });
  }
});

app.post('/api/upload/preauth', uploadMw.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok:false, error:'no_file' });
  const mime = req.file.mimetype || '';
  if (!mime.startsWith('image/')) return res.status(400).json({ ok:false, error:'images_only' });
  try {
    const url = await uploadToCloudinary(req.file.path);
    return res.json({ ok:true, url });
  } catch (e) {
    return res.status(500).json({ ok:false, error:'upload_failed' });
  }
});

// ── Contacts ──────────────────────────────────────────────────────────────────
app.get('/api/contacts', requireAuth, (req, res) => {
  return res.json({ ok:true, contacts: listContacts(req.user.id) });
});
app.post('/api/contacts/add', requireAuth, (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const nickname = String(req.body?.nickname||'').trim().slice(0,32);
  if (!phone) return res.status(400).json({ ok:false, error:'invalid_phone' });
  const contact = getUserByPhone(phone);
  if (!contact) return res.status(404).json({ ok:false, error:'user_not_found' });
  if (contact.id === req.user.id) return res.status(400).json({ ok:false, error:'cannot_add_self' });
  try { addContact({ ownerUserId: req.user.id, contactUserId: contact.id, nickname }); } catch {}
  return res.json({ ok:true, contacts: listContacts(req.user.id) });
});
app.post('/api/contacts/update', requireAuth, (req, res) => {
  const contact = getUserByUsername(String(req.body?.username||'').trim());
  if (!contact) return res.status(404).json({ ok:false, error:'user_not_found' });
  const nickname = String(req.body?.nickname||'').trim().slice(0,32);
  updateContactNickname({ ownerUserId: req.user.id, contactUserId: contact.id, nickname });
  return res.json({ ok:true, contacts: listContacts(req.user.id) });
});
app.post('/api/contacts/delete', requireAuth, (req, res) => {
  const contact = getUserByUsername(String(req.body?.username||'').trim());
  if (!contact) return res.status(404).json({ ok:false, error:'user_not_found' });
  deleteContact({ ownerUserId: req.user.id, contactUserId: contact.id });
  return res.json({ ok:true, contacts: listContacts(req.user.id) });
});

// ── Blocks ────────────────────────────────────────────────────────────────────
app.post('/api/blocks/add', requireAuth, (req, res) => {
  const target = getUserByUsername(String(req.body?.username||'').trim());
  if (!target) return res.status(404).json({ ok:false, error:'user_not_found' });
  if (target.id === req.user.id) return res.status(400).json({ ok:false, error:'cannot_block_self' });
  blockUser({ ownerUserId: req.user.id, blockedUserId: target.id });
  return res.json({ ok:true });
});
app.post('/api/blocks/remove', requireAuth, (req, res) => {
  const target = getUserByUsername(String(req.body?.username||'').trim());
  if (!target) return res.status(404).json({ ok:false, error:'user_not_found' });
  unblockUser({ ownerUserId: req.user.id, blockedUserId: target.id });
  return res.json({ ok:true });
});

// ── Search / Chats ────────────────────────────────────────────────────────────
app.get('/api/users/search', requireAuth, (req, res) => {
  return res.json({ ok:true, users: searchUsersByUsername(String(req.query.q||'')) });
});
app.get('/api/chats', requireAuth, (req, res) => {
  return res.json({ ok:true, chats: listChats(req.user.id) });
});
app.post('/api/chats/read', requireAuth, (req, res) => {
  const peer = getUserByUsername(String(req.body?.username||'').trim());
  if (!peer) return res.status(404).json({ ok:false, error:'user_not_found' });
  markChatRead({ ownerUserId: req.user.id, peerUserId: peer.id, ts: Date.now() });
  return res.json({ ok:true });
});

// ── Messages ──────────────────────────────────────────────────────────────────
app.get('/api/messages/with/:username', requireAuth, (req, res) => {
  const other = getUserByUsername(String(req.params.username||'').trim());
  if (!other) return res.status(404).json({ ok:false, error:'user_not_found' });
  const msgs = listMessagesBetween(req.user.id, req.user.id, other.id);
  const blockedByMe = isBlocked({ ownerUserId: req.user.id, blockedUserId: other.id });
  return res.json({ ok:true, with: pub(other), messages: msgs, blockedByMe });
});
app.post('/api/messages/delete', requireAuth, (req, res) => {
  const other = getUserByUsername(String(req.body?.username||'').trim());
  if (!other) return res.status(404).json({ ok:false, error:'user_not_found' });
  const scope = String(req.body?.scope||'me');
  if (scope === 'all') {
    deleteConversationForAll({ aUserId: req.user.id, bUserId: other.id });
    io.to(`user:${req.user.id}`).emit('chat:cleared', { username: other.username });
    io.to(`user:${other.id}`).emit('chat:cleared', { username: req.user.username });
  } else {
    hideChatForUser({ ownerUserId: req.user.id, peerUserId: other.id });
    io.to(`user:${req.user.id}`).emit('chat:cleared', { username: other.username });
  }
  return res.json({ ok:true });
});
app.post('/api/message/delete', requireAuth, (req, res) => {
  const msgId = Number(req.body?.id);
  const scope = String(req.body?.scope||'me');
  if (!msgId) return res.status(400).json({ ok:false, error:'missing_id' });
  const msg = getMessageById(msgId);
  if (!msg) return res.status(404).json({ ok:false, error:'not_found' });
  const me = req.user;
  if (msg.sender_user_id !== me.id && msg.recipient_user_id !== me.id)
    return res.status(403).json({ ok:false, error:'forbidden' });
  if (scope === 'all') {
    if (msg.sender_user_id !== me.id) return res.status(403).json({ ok:false, error:'not_your_message' });
    deleteMessageForAll(msgId);
    io.to(`user:${me.id}`).emit('msg:deleted', { id: msgId, scope:'all' });
    io.to(`user:${msg.recipient_user_id}`).emit('msg:deleted', { id: msgId, scope:'all' });
  } else {
    hideMessageForUser({ messageId: msgId, userId: me.id });
    io.to(`user:${me.id}`).emit('msg:deleted', { id: msgId, scope:'me' });
  }
  return res.json({ ok:true });
});

// ── Reactions ─────────────────────────────────────────────────────────────────
app.post('/api/message/react', requireAuth, (req, res) => {
  const msgId = Number(req.body?.messageId);
  const emoji = String(req.body?.emoji || '').trim();
  const groupId = req.body?.groupId ? Number(req.body.groupId) : null;
  if (!msgId || !emoji) return res.status(400).json({ ok:false, error:'missing_params' });
  const result = toggleReaction(msgId, req.user.id, emoji);
  if (groupId) {
    const members = listGroupMembers(groupId);
    for (const m of members) io.to(`user:${m.id}`).emit('reaction:update', { messageId: msgId, groupId, userId: req.user.id, emoji, active: result !== null });
  } else {
    const msg = getMessageById(msgId);
    if (msg) {
      const otherUserId = msg.sender_user_id === req.user.id ? msg.recipient_user_id : msg.sender_user_id;
      io.to(`user:${req.user.id}`).emit('reaction:update', { messageId: msgId, userId: req.user.id, emoji, active: result !== null });
      io.to(`user:${otherUserId}`).emit('reaction:update', { messageId: msgId, userId: req.user.id, emoji, active: result !== null });
    }
  }
  return res.json({ ok:true, active: result !== null });
});

// ── Peer profile data ─────────────────────────────────────────────────────────
app.get('/api/profile/:username', requireAuth, (req, res) => {
  const other = getUserByUsername(String(req.params.username||'').trim());
  if (!other) return res.status(404).json({ ok:false, error:'user_not_found' });
  const media = getMediaBetween(req.user.id, other.id);
  const links = getLinksBetween(req.user.id, other.id);
  const sharedGroups = getSharedGroups(req.user.id, other.id);
  const blockedByMe = isBlocked({ ownerUserId: req.user.id, blockedUserId: other.id });
  return res.json({ ok:true, user: pub(other), media, links, sharedGroups, blockedByMe });
});

// ── Groups ────────────────────────────────────────────────────────────────────
app.get('/api/groups', requireAuth, (req, res) => {
  const groups = listUserGroups(req.user.id);
  return res.json({ ok:true, groups: groups.map(g => ({ ...g, chatType:'group' })) });
});

  app.post('/api/groups/create', requireAuth, uploadMw.single('avatar'), async (req, res) => {
    const name = String(req.body?.name||'').trim().slice(0,64);
    const description = String(req.body?.description||'').trim().slice(0,256);
    if (!name) return res.status(400).json({ ok:false, error:'name_required' });
    let avatar = null;
    if (req.file) {
      try {
        avatar = await uploadToCloudinary(req.file.path);
      } catch (e) {
        return res.status(500).json({ ok:false, error:'upload_failed' });
      }
    }
  const group = createGroup({ name, description, avatar, creatorId: req.user.id });
  const memberIds = JSON.parse(req.body?.memberIds || '[]');
  for (const uid of memberIds) {
    if (typeof uid === 'number' && uid !== req.user.id) {
      try { addGroupMember({ groupId: group.id, userId: uid, role: 'member' }); } catch {}
    }
  }
  const members = listGroupMembers(group.id);
  for (const m of members) {
    io.to(`user:${m.id}`).emit('group:joined', { group: { ...group, chatType:'group' } });
  }
  return res.json({ ok:true, group });
});

app.get('/api/groups/:id', requireAuth, (req, res) => {
  const groupId = Number(req.params.id);
  const group = getGroupById(groupId);
  if (!group) return res.status(404).json({ ok:false, error:'not_found' });
  const member = getGroupMember(groupId, req.user.id);
  if (!member) return res.status(403).json({ ok:false, error:'not_member' });
  const members = listGroupMembers(groupId);
  return res.json({ ok:true, group, members: members.map(pubMember), myRole: member.role });
});

app.put('/api/groups/:id', requireAuth, uploadMw.single('avatar'), async (req, res) => {
  const groupId = Number(req.params.id);
  const member = getGroupMember(groupId, req.user.id);
  if (!member) return res.status(403).json({ ok:false, error:'not_member' });
  if (member.role !== 'owner' && member.role !== 'admin')
    return res.status(403).json({ ok:false, error:'forbidden' });

  const patch = {};
  if (req.body?.name) patch.name = String(req.body.name).trim().slice(0,64);
  if ('description' in (req.body||{})) patch.description = String(req.body.description||'').trim().slice(0,256);

  if (req.file) {
    try {
      patch.avatar = await uploadToCloudinary(req.file.path);
    } catch (e) {
      return res.status(500).json({ ok:false, error:'upload_failed' });
    }
  }

  if (!Object.keys(patch).length) return res.json({ ok:true, group: getGroupById(groupId) });

  const group = updateGroup({ id: groupId, ...patch });
  const members = listGroupMembers(groupId);
  for (const m of members) io.to(`user:${m.id}`).emit('group:updated', { groupId, group });
  return res.json({ ok:true, group });
});

app.get('/api/groups/:id/messages', requireAuth, (req, res) => {
  const groupId = Number(req.params.id);
  const member = getGroupMember(groupId, req.user.id);
  if (!member) return res.status(403).json({ ok:false, error:'not_member' });
  markGroupChatRead({ groupId, userId: req.user.id });
  const msgs = listGroupMessages(groupId, req.user.id);
  return res.json({ ok:true, messages: msgs, myRole: member.role });
});

app.post('/api/groups/:id/read', requireAuth, (req, res) => {
  const groupId = Number(req.params.id);
  markGroupChatRead({ groupId, userId: req.user.id });
  return res.json({ ok:true });
});

app.get('/api/groups/:id/media', requireAuth, (req, res) => {
  const groupId = Number(req.params.id);
  const member = getGroupMember(groupId, req.user.id);
  if (!member) return res.status(403).json({ ok:false, error:'not_member' });
  return res.json({ ok:true, media: getGroupMedia(groupId) });
});

app.get('/api/groups/:id/links', requireAuth, (req, res) => {
  const groupId = Number(req.params.id);
  const member = getGroupMember(groupId, req.user.id);
  if (!member) return res.status(403).json({ ok:false, error:'not_member' });
  return res.json({ ok:true, links: getGroupLinks(groupId) });
});

app.post('/api/groups/:id/members/add', requireAuth, (req, res) => {
  const groupId = Number(req.params.id);
  const myMember = getGroupMember(groupId, req.user.id);
  if (!myMember) return res.status(403).json({ ok:false, error:'not_member' });
  if (myMember.role !== 'owner' && myMember.role !== 'admin')
    return res.status(403).json({ ok:false, error:'forbidden' });
  const userIds = Array.isArray(req.body?.userIds) ? req.body.userIds : [];
  const group = getGroupById(groupId);
  const currentMembers = listGroupMembers(groupId);
  const currentIds = new Set(currentMembers.map(m => m.id));
  for (const uid of userIds) {
    if (typeof uid === 'number' && !currentIds.has(uid)) {
      try { addGroupMember({ groupId, userId: uid, role: 'member' }); } catch {}
      io.to(`user:${uid}`).emit('group:joined', { group: { ...group, chatType:'group' } });
      const addedUser = getUserById(uid);
      if (addedUser) {
        const sysmsg = sendGroupSystemMessage(groupId, sysMsgText(addedUser, 'добавлен(а) в группу'));
        const allMembers = listGroupMembers(groupId);
        for (const m of allMembers) io.to(`user:${m.id}`).emit('group:new', { ...sysmsg, groupId });
      }
    }
  }
  return res.json({ ok:true, members: listGroupMembers(groupId).map(pubMember) });
});

app.post('/api/groups/:id/members/remove', requireAuth, (req, res) => {
  const groupId = Number(req.params.id);
  const myMember = getGroupMember(groupId, req.user.id);
  if (!myMember) return res.status(403).json({ ok:false, error:'not_member' });
  if (myMember.role !== 'owner' && myMember.role !== 'admin')
    return res.status(403).json({ ok:false, error:'forbidden' });
  const targetId = Number(req.body?.userId);
  if (!targetId) return res.status(400).json({ ok:false, error:'missing_userId' });
  const targetMember = getGroupMember(groupId, targetId);
  if (!targetMember) return res.status(404).json({ ok:false, error:'not_member' });
  if (targetMember.role === 'owner') return res.status(403).json({ ok:false, error:'cannot_remove_owner' });
  if (myMember.role === 'admin' && targetMember.role === 'admin')
    return res.status(403).json({ ok:false, error:'forbidden' });
  const targetUser = getUserById(targetId);
  removeGroupMember(groupId, targetId);
  io.to(`user:${targetId}`).emit('group:removed', { groupId });
  const sysmsg = sendGroupSystemMessage(groupId, sysMsgText(targetUser, 'удалён(а) из группы'));
  const remaining = listGroupMembers(groupId);
  for (const m of remaining) io.to(`user:${m.id}`).emit('group:new', { ...sysmsg, groupId });
  return res.json({ ok:true });
});

app.post('/api/groups/:id/leave', requireAuth, (req, res) => {
  const groupId = Number(req.params.id);
  const member = getGroupMember(groupId, req.user.id);
  if (!member) return res.status(403).json({ ok:false, error:'not_member' });

  // ПОЛУЧАЕМ СПИСОК ВСЕХ УЧАСТНИКОВ
  const currentMembers = listGroupMembers(groupId);

  // ИЗМЕНЕННОЕ УСЛОВИЕ: Блокируем только если владелец пытается выйти, а в группе есть кто-то еще
  if (member.role === 'owner' && currentMembers.length > 1) {
      return res.status(400).json({ ok:false, error:'owner_cannot_leave' });
  }

  const me = req.user;
  removeGroupMember(groupId, me.id);

  // Если это был последний участник, remaining будет пустым массивом,
  // поэтому системное сообщение отправлять уже некому.
  const remaining = listGroupMembers(groupId);

  if (remaining.length > 0) {
      const sysmsg = sendGroupSystemMessage(groupId, sysMsgText(me, 'покинул(а) группу'));
      for (const m of remaining) io.to(`user:${m.id}`).emit('group:new', { ...sysmsg, groupId });
  }

  io.to(`user:${me.id}`).emit('group:left', { groupId });
  return res.json({ ok:true });
});

app.post('/api/groups/:id/clear-me', requireAuth, (req, res) => {
  const groupId = Number(req.params.id);
  const member = getGroupMember(groupId, req.user.id);
  if (!member) return res.status(403).json({ ok:false, error:'not_member' });
  clearGroupMessagesForUser(groupId, req.user.id);
  io.to(`user:${req.user.id}`).emit('group:cleared', { groupId });
  return res.json({ ok:true });
});

app.post('/api/groups/:id/clear-all', requireAuth, (req, res) => {
  const groupId = Number(req.params.id);
  const member = getGroupMember(groupId, req.user.id);
  if (!member) return res.status(403).json({ ok:false, error:'not_member' });
  if (member.role !== 'owner' && member.role !== 'admin')
    return res.status(403).json({ ok:false, error:'forbidden' });
  clearGroupMessagesForAll(groupId);
  const members = listGroupMembers(groupId);
  for (const m of members) io.to(`user:${m.id}`).emit('group:cleared', { groupId });
  return res.json({ ok:true });
});

app.post('/api/groups/:id/set-role', requireAuth, (req, res) => {
  const groupId = Number(req.params.id);
  const myMember = getGroupMember(groupId, req.user.id);
  if (!myMember) return res.status(403).json({ ok:false, error:'not_member' });
  if (myMember.role !== 'owner') return res.status(403).json({ ok:false, error:'owner_only' });
  const targetId = Number(req.body?.userId);
  const role = String(req.body?.role || 'member');
  if (!['admin','member'].includes(role)) return res.status(400).json({ ok:false, error:'invalid_role' });
  const targetMember = getGroupMember(groupId, targetId);
  if (!targetMember) return res.status(404).json({ ok:false, error:'not_member' });
  if (targetMember.role === 'owner') return res.status(403).json({ ok:false, error:'cannot_change_owner' });
  setGroupMemberRole(groupId, targetId, role);
  const members = listGroupMembers(groupId);
  for (const m of members) io.to(`user:${m.id}`).emit('group:role_changed', { groupId, userId: targetId, role });
  return res.json({ ok:true });
});

app.post('/api/message/delete-group', requireAuth, (req, res) => {
  const msgId = Number(req.body?.id);
  const scope = String(req.body?.scope||'me');
  if (!msgId) return res.status(400).json({ ok:false, error:'missing_id' });
  const msg = getGroupMessageById(msgId);
  if (!msg) return res.status(404).json({ ok:false, error:'not_found' });
  const member = getGroupMember(msg.group_id, req.user.id);
  if (!member) return res.status(403).json({ ok:false, error:'not_member' });
  if (scope === 'all') {
    if (msg.sender_id !== req.user.id && member.role !== 'admin' && member.role !== 'owner')
      return res.status(403).json({ ok:false, error:'forbidden' });
    deleteGroupMessageForAll(msgId);
    const members = listGroupMembers(msg.group_id);
    for (const m of members) io.to(`user:${m.id}`).emit('msg:deleted', { id: msgId, scope:'all', groupId: msg.group_id });
  } else {
    hideGroupMessageForUser({ messageId: msgId, userId: req.user.id });
    io.to(`user:${req.user.id}`).emit('msg:deleted', { id: msgId, scope:'me', groupId: msg.group_id });
  }
  return res.json({ ok:true });
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[error]', err);
  if (res.headersSent) return next(err);
  return res.status(500).json({ ok:false, error:'internal_error' });
});

// ── Socket.io ─────────────────────────────────────────────────────────────────
io.use((socket, next) => {
  const token = getSocketToken(socket);
  const session = sessions.get(token);
  if (!session) return next(new Error('unauthorized'));
  const user = getUserByPhone(session.phone);
  if (!user) return next(new Error('unauthorized'));
  socket.data.user = user;
  return next();
});

io.on('connection', (socket) => {
  const me = socket.data.user;
  socket.join(`user:${me.id}`);

  socket.on('dm:send', ({ toUsername, text, attachments }) => {
    const dest = String(toUsername||'').trim();
    const msgText = String(text||'').trim().slice(0, 4000);
    const atts = Array.isArray(attachments) ? attachments.slice(0, 10) : [];
    if (!dest || (!msgText && !atts.length)) return;
    const other = getUserByUsername(dest);
    if (!other) return;
    if (isBlocked({ ownerUserId: other.id, blockedUserId: me.id })) {
      socket.emit('dm:error', { code: 'blocked_by_user' }); return;
    }
    const saved = insertMessage({ senderUserId: me.id, recipientUserId: other.id, text: msgText, attachments: atts });
    const payload = { id: saved.id, from: pub(me), to: pub(other), text: saved.text, attachments: saved.attachments, ts: saved.ts, reactions: [] };
    io.to(`user:${me.id}`).emit('dm:new', payload);
    io.to(`user:${other.id}`).emit('dm:new', payload);
  });

  socket.on('group:send', ({ groupId, text, attachments }) => {
    const gid = Number(groupId);
    const msgText = String(text||'').trim().slice(0, 4000);
    const atts = Array.isArray(attachments) ? attachments.slice(0, 10) : [];
    if (!gid || (!msgText && !atts.length)) return;
    const member = getGroupMember(gid, me.id);
    if (!member) return;
    const saved = sendGroupMessage({ groupId: gid, senderId: me.id, text: msgText, attachments: atts });
    const members = listGroupMembers(gid);
    const payload = { id: saved.id, groupId: gid, senderUserId: me.id, from: pub(me), text: saved.text, attachments: saved.attachments, ts: saved.ts, reactions: [], isSystem: false };
    for (const m of members) io.to(`user:${m.id}`).emit('group:new', payload);
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running at http://0.0.0.0:${PORT}`));

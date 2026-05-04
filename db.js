const path = require('path');
const Database = require('better-sqlite3');

const dbPath = path.join(__dirname, 'data.sqlite');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  create table if not exists users (
    id integer primary key autoincrement,
    phone text not null unique,
    username text unique,
    name text,
    avatar text,
    created_at integer not null
  );
  create table if not exists contacts (
    id integer primary key autoincrement,
    owner_user_id integer not null,
    contact_user_id integer not null,
    nickname text,
    created_at integer not null,
    unique(owner_user_id, contact_user_id)
  );
  create table if not exists messages (
    id integer primary key autoincrement,
    sender_user_id integer not null,
    recipient_user_id integer not null,
    text text not null default '',
    ts integer not null,
    deleted_for_all integer not null default 0
  );
  create index if not exists idx_messages_pair_ts on messages(sender_user_id, recipient_user_id, ts);
  create table if not exists chat_state (
    owner_user_id integer not null,
    peer_user_id integer not null,
    last_read_ts integer not null default 0,
    primary key(owner_user_id, peer_user_id)
  );
  create table if not exists blocks (
    owner_user_id integer not null,
    blocked_user_id integer not null,
    created_at integer not null,
    primary key(owner_user_id, blocked_user_id)
  );
  create table if not exists message_hidden (
    message_id integer not null,
    user_id integer not null,
    primary key(message_id, user_id)
  );
  create table if not exists chat_hidden (
    owner_user_id integer not null,
    peer_user_id integer not null,
    hidden_before_ts integer not null,
    primary key(owner_user_id, peer_user_id)
  );
  create table if not exists message_reactions (
    message_id integer not null,
    user_id integer not null,
    emoji text not null,
    primary key(message_id, user_id)
  );
  create table if not exists groups (
    id integer primary key autoincrement,
    name text not null,
    description text,
    avatar text,
    creator_id integer not null,
    created_at integer not null
  );
  create table if not exists group_members (
    group_id integer not null,
    user_id integer not null,
    role text not null default 'member',
    joined_at integer not null,
    primary key(group_id, user_id)
  );
  create table if not exists group_messages (
    id integer primary key autoincrement,
    group_id integer not null,
    sender_id integer not null,
    text text,
    attachments text,
    ts integer not null,
    deleted_for_all integer not null default 0
  );
  create index if not exists idx_gmsgs_group_ts on group_messages(group_id, ts);
  create table if not exists group_message_hidden (
    message_id integer not null,
    user_id integer not null,
    primary key(message_id, user_id)
  );
  create table if not exists group_chat_state (
    group_id integer not null,
    user_id integer not null,
    last_read_ts integer not null default 0,
    primary key(group_id, user_id)
  );
`);

const safeAlter = (sql) => { try { db.exec(sql); } catch {} };
safeAlter('alter table users add column last_name text');
safeAlter('alter table messages add column attachments text');
safeAlter('alter table messages add column deleted_for_all integer not null default 0');
safeAlter('alter table messages add column text text not null default \'\'');
safeAlter('alter table group_messages add column is_system integer not null default 0');

const stmtGetUserByPhone = db.prepare(
  'select id,phone,username,name,last_name,avatar,created_at as createdAt from users where phone=?'
);
const stmtGetUserById = db.prepare(
  'select id,phone,username,name,last_name,avatar,created_at as createdAt from users where id=?'
);
const stmtGetUserByUsername = db.prepare(
  'select id,phone,username,name,last_name,avatar,created_at as createdAt from users where lower(username)=lower(?)'
);
const stmtCreateUser = db.prepare(
  'insert into users (phone,username,name,last_name,avatar,created_at) values (?,?,?,?,?,?)'
);
const stmtSearchUsers = db.prepare(
  `select id,phone,username,name,last_name,avatar from users
   where username is not null
     and (lower(username) like lower(?) or lower(coalesce(name,'')) like lower(?) or lower(coalesce(last_name,'')) like lower(?))
   order by username limit 20`
);
const stmtListContacts = db.prepare(`
  select c.id,c.nickname,u.id as userId,u.phone,u.username,u.name,u.last_name,u.avatar
  from contacts c join users u on u.id=c.contact_user_id
  where c.owner_user_id=?
  order by coalesce(c.nickname,u.name,u.username,u.phone) asc
`);
const stmtAddContact = db.prepare(
  'insert into contacts (owner_user_id,contact_user_id,nickname,created_at) values (?,?,?,?)'
);
const stmtInsertMessage = db.prepare(
  'insert into messages (sender_user_id,recipient_user_id,text,attachments,ts) values (?,?,?,?,?)'
);
const stmtGetMessage = db.prepare('select * from messages where id=?');
const stmtMarkRead = db.prepare(`
  insert into chat_state (owner_user_id,peer_user_id,last_read_ts) values (?,?,?)
  on conflict(owner_user_id,peer_user_id) do update set last_read_ts=excluded.last_read_ts
`);
const stmtUpdateNickname = db.prepare(
  'update contacts set nickname=? where owner_user_id=? and contact_user_id=?'
);
const stmtDeleteContact = db.prepare(
  'delete from contacts where owner_user_id=? and contact_user_id=?'
);
const stmtBlockUser = db.prepare(
  'insert into blocks (owner_user_id,blocked_user_id,created_at) values (?,?,?) on conflict do nothing'
);
const stmtUnblockUser = db.prepare(
  'delete from blocks where owner_user_id=? and blocked_user_id=?'
);
const stmtIsBlocked = db.prepare(
  'select 1 from blocks where owner_user_id=? and blocked_user_id=? limit 1'
);

function getUserByPhone(p) { return stmtGetUserByPhone.get(p) || null; }
function getUserById(id) { return stmtGetUserById.get(id) || null; }
function getUserByUsername(u) { return stmtGetUserByUsername.get(u) || null; }
function isUsernameAvailable(username, excludeUserId) {
  const existing = getUserByUsername(username);
  if (!existing) return true;
  return excludeUserId ? existing.id === excludeUserId : false;
}
function searchUsersByUsername(q) {
  const s = String(q||'').trim(); if (!s) return [];
  const like = `%${s}%`;
  return stmtSearchUsers.all(like, like, like);
}
function createUser({ phone, username, name, lastName, avatar }) {
  const ts = Date.now();
  const r = stmtCreateUser.run(phone, username||null, name||null, lastName||null, avatar||null, ts);
  return { id: r.lastInsertRowid, phone, username:username||null, name:name||null, lastName:lastName||null, avatar:avatar||null, createdAt:ts };
}
function listContacts(ownerUserId) { return stmtListContacts.all(ownerUserId); }
function addContact({ ownerUserId, contactUserId, nickname }) {
  const r = stmtAddContact.run(ownerUserId, contactUserId, nickname||null, Date.now());
  return { id: r.lastInsertRowid };
}
function insertMessage({ senderUserId, recipientUserId, text, attachments }) {
  const ts = Date.now();
  const attJson = attachments && attachments.length ? JSON.stringify(attachments) : null;
  const r = stmtInsertMessage.run(senderUserId, recipientUserId, text||'', attJson, ts);
  return { id: r.lastInsertRowid, senderUserId, recipientUserId, text:text||'', attachments: attachments||[], ts };
}
function getMessageById(id) { return stmtGetMessage.get(id) || null; }

// Reactions
function toggleReaction(messageId, userId, emoji) {
  const existing = db.prepare('select emoji from message_reactions where message_id=? and user_id=?').get(messageId, userId);
  if (existing) {
    if (existing.emoji === emoji) {
      db.prepare('delete from message_reactions where message_id=? and user_id=?').run(messageId, userId);
      return null;
    } else {
      db.prepare('update message_reactions set emoji=? where message_id=? and user_id=?').run(emoji, messageId, userId);
      return emoji;
    }
  } else {
    db.prepare('insert into message_reactions(message_id,user_id,emoji) values(?,?,?)').run(messageId, userId, emoji);
    return emoji;
  }
}
function getReactionsForMessage(messageId) {
  return db.prepare('select emoji, count(*) as cnt, group_concat(user_id) as user_ids from message_reactions where message_id=? group by emoji').all(messageId);
}
function getReactionsForMessages(messageIds) {
  if (!messageIds.length) return {};
  const placeholders = messageIds.map(() => '?').join(',');
  const rows = db.prepare(`select message_id, emoji, count(*) as cnt, group_concat(user_id) as user_ids from message_reactions where message_id in (${placeholders}) group by message_id, emoji`).all(...messageIds);
  const map = {};
  for (const r of rows) {
    if (!map[r.message_id]) map[r.message_id] = [];
    map[r.message_id].push({ emoji: r.emoji, cnt: r.cnt, userIds: r.user_ids.split(',').map(Number) });
  }
  return map;
}

function listMessagesBetween(viewerUserId, aUserId, bUserId) {
  const rows = db.prepare(`
    select m.id, m.sender_user_id as senderUserId, m.recipient_user_id as recipientUserId,
           m.text, m.attachments, m.ts, m.deleted_for_all
    from messages m
    where ((m.sender_user_id=? and m.recipient_user_id=?) or (m.sender_user_id=? and m.recipient_user_id=?))
      and m.deleted_for_all=0
      and m.id not in (select message_id from message_hidden where user_id=?)
    order by m.ts asc limit 500
  `).all(aUserId, bUserId, bUserId, aUserId, viewerUserId);
  const msgs = rows.map(r => ({ ...r, attachments: r.attachments ? JSON.parse(r.attachments) : [] }));
  if (msgs.length) {
    const reactMap = getReactionsForMessages(msgs.map(m => m.id));
    for (const m of msgs) m.reactions = reactMap[m.id] || [];
  }
  return msgs;
}

function listChats(ownerUserId) {
  const rows = db.prepare(`
    with lastmsgs as (
      select id,sender_user_id,recipient_user_id,text,attachments,ts,
             case when sender_user_id=? then recipient_user_id else sender_user_id end as peer_id
      from messages
      where (sender_user_id=? or recipient_user_id=?) and deleted_for_all=0
        and id not in (select message_id from message_hidden where user_id=?)
    ),
    peers as (select peer_id, max(ts) as last_ts from lastmsgs group by peer_id)
    select
      p.peer_id as peerUserId, p.last_ts as lastTs,
      u.id,u.phone,u.username,u.name,u.last_name,u.avatar,
      c.nickname,
      coalesce((
        select count(1) from messages m
        left join chat_state s on s.owner_user_id=? and s.peer_user_id=p.peer_id
        where m.sender_user_id=p.peer_id and m.recipient_user_id=?
          and m.deleted_for_all=0
          and m.id not in (select message_id from message_hidden where user_id=?)
          and m.ts>coalesce(s.last_read_ts,0)
      ),0) as unreadCount,
      (select m2.text from messages m2
       where ((m2.sender_user_id=? and m2.recipient_user_id=p.peer_id) or (m2.sender_user_id=p.peer_id and m2.recipient_user_id=?))
         and m2.deleted_for_all=0
         and m2.id not in (select message_id from message_hidden where user_id=?)
       order by m2.ts desc limit 1) as lastText
    from peers p
    join users u on u.id=p.peer_id
    left join contacts c on c.owner_user_id=? and c.contact_user_id=p.peer_id
    left join chat_hidden h on h.owner_user_id=? and h.peer_user_id=p.peer_id
    where h.owner_user_id is null or p.last_ts > h.hidden_before_ts
    order by p.last_ts desc
  `).all(
    ownerUserId, ownerUserId, ownerUserId, ownerUserId,
    ownerUserId, ownerUserId, ownerUserId,
    ownerUserId, ownerUserId, ownerUserId,
    ownerUserId, ownerUserId
  );
  return rows.map(r => ({ ...r, chatType: 'dm' }));
}

function markChatRead({ ownerUserId, peerUserId, ts }) {
  stmtMarkRead.run(ownerUserId, peerUserId, Number(ts||Date.now()));
}
function hideChatForUser({ ownerUserId, peerUserId }) {
  db.prepare(`insert into chat_hidden(owner_user_id,peer_user_id,hidden_before_ts) values(?,?,?)
    on conflict(owner_user_id,peer_user_id) do update set hidden_before_ts=excluded.hidden_before_ts`
  ).run(ownerUserId, peerUserId, Date.now());
}
function deleteConversationForAll({ aUserId, bUserId }) {
  db.prepare(`delete from messages where (sender_user_id=? and recipient_user_id=?) or (sender_user_id=? and recipient_user_id=?)`
  ).run(aUserId, bUserId, bUserId, aUserId);
}
function hideMessageForUser({ messageId, userId }) {
  db.prepare('insert into message_hidden(message_id,user_id) values(?,?) on conflict do nothing').run(messageId, userId);
}
function deleteMessageForAll(messageId) {
  db.prepare('update messages set deleted_for_all=1 where id=?').run(messageId);
}
function updateContactNickname({ ownerUserId, contactUserId, nickname }) {
  stmtUpdateNickname.run(nickname||null, ownerUserId, contactUserId);
}
function deleteContact({ ownerUserId, contactUserId }) {
  stmtDeleteContact.run(ownerUserId, contactUserId);
}
function blockUser({ ownerUserId, blockedUserId }) {
  stmtBlockUser.run(ownerUserId, blockedUserId, Date.now());
}
function unblockUser({ ownerUserId, blockedUserId }) {
  stmtUnblockUser.run(ownerUserId, blockedUserId);
}
function isBlocked({ ownerUserId, blockedUserId }) {
  return Boolean(stmtIsBlocked.get(ownerUserId, blockedUserId));
}
function updateProfile({ id, name, lastName, username, phone, avatar }) {
  const sets = []; const vals = [];
  if (name !== undefined) { sets.push('name=?'); vals.push(name); }
  if (lastName !== undefined) { sets.push('last_name=?'); vals.push(lastName); }
  if (username !== undefined) { sets.push('username=?'); vals.push(username); }
  if (phone !== undefined) { sets.push('phone=?'); vals.push(phone); }
  if (avatar !== undefined) { sets.push('avatar=?'); vals.push(avatar); }
  if (!sets.length) return getUserById(id);
  vals.push(id);
  db.prepare(`update users set ${sets.join(',')} where id=?`).run(...vals);
  return getUserById(id);
}

// ── Groups ────────────────────────────────────────────────────────────────────
function createGroup({ name, description, avatar, creatorId }) {
  const ts = Date.now();
  const r = db.prepare('insert into groups(name,description,avatar,creator_id,created_at) values(?,?,?,?,?)').run(name, description||null, avatar||null, creatorId, ts);
  const groupId = r.lastInsertRowid;
  db.prepare('insert into group_members(group_id,user_id,role,joined_at) values(?,?,?,?)').run(groupId, creatorId, 'owner', ts);
  return getGroupById(groupId);
}
function getGroupById(id) {
  return db.prepare('select * from groups where id=?').get(id) || null;
}
function updateGroup({ id, name, description, avatar }) {
  const sets = []; const vals = [];
  if (name !== undefined) { sets.push('name=?'); vals.push(name); }
  if (description !== undefined) { sets.push('description=?'); vals.push(description); }
  if (avatar !== undefined) { sets.push('avatar=?'); vals.push(avatar); }
  if (!sets.length) return getGroupById(id);
  vals.push(id);
  db.prepare(`update groups set ${sets.join(',')} where id=?`).run(...vals);
  return getGroupById(id);
}
function addGroupMember({ groupId, userId, role }) {
  db.prepare('insert into group_members(group_id,user_id,role,joined_at) values(?,?,?,?) on conflict do nothing').run(groupId, userId, role||'member', Date.now());
}
function removeGroupMember(groupId, userId) {
  db.prepare('delete from group_members where group_id=? and user_id=?').run(groupId, userId);
}
function setGroupMemberRole(groupId, userId, role) {
  db.prepare('update group_members set role=? where group_id=? and user_id=?').run(role, groupId, userId);
}
function getGroupMember(groupId, userId) {
  return db.prepare('select * from group_members where group_id=? and user_id=?').get(groupId, userId) || null;
}
function listGroupMembers(groupId) {
  return db.prepare(`
    select u.id,u.phone,u.username,u.name,u.last_name,u.avatar, gm.role
    from group_members gm join users u on u.id=gm.user_id
    where gm.group_id=? order by
      case gm.role when 'owner' then 0 when 'admin' then 1 else 2 end, gm.joined_at asc
  `).all(groupId);
}
function listUserGroups(userId) {
  return db.prepare(`
    select g.*, mem.role,
      (select m2.text from group_messages m2 where m2.group_id=g.id and m2.deleted_for_all=0 and m2.is_system=0 order by m2.ts desc limit 1) as lastText,
      (select m2.ts from group_messages m2 where m2.group_id=g.id and m2.deleted_for_all=0 order by m2.ts desc limit 1) as lastTs,
      coalesce((
        select count(1) from group_messages m3
        left join group_chat_state gcs on gcs.group_id=g.id and gcs.user_id=?
        where m3.group_id=g.id and m3.sender_id!=? and m3.deleted_for_all=0 and m3.is_system=0
          and m3.id not in (select message_id from group_message_hidden where user_id=?)
          and m3.ts>coalesce(gcs.last_read_ts,0)
      ),0) as unreadCount
    from group_members mem join groups g on g.id=mem.group_id
    where mem.user_id=? order by coalesce(lastTs,g.created_at) desc
  `).all(userId, userId, userId, userId);
}
function sendGroupMessage({ groupId, senderId, text, attachments }) {
  const ts = Date.now();
  const attJson = attachments && attachments.length ? JSON.stringify(attachments) : null;
  const r = db.prepare('insert into group_messages(group_id,sender_id,text,attachments,ts) values(?,?,?,?,?)').run(groupId, senderId, text||'', attJson, ts);
  return { id: r.lastInsertRowid, groupId, senderId, text:text||'', attachments:attachments||[], ts };
}
function sendGroupSystemMessage(groupId, text) {
  const ts = Date.now();
  const r = db.prepare('insert into group_messages(group_id,sender_id,text,ts,is_system) values(?,0,?,?,1)').run(groupId, text, ts);
  return { id: r.lastInsertRowid, groupId, senderId: 0, text, attachments: [], ts, isSystem: true };
}
function listGroupMessages(groupId, viewerUserId) {
  const rows = db.prepare(`
    select gm.id, gm.group_id as groupId, gm.sender_id as senderUserId,
           gm.text, gm.attachments, gm.ts, gm.is_system as isSystem,
           u.name as senderName, u.last_name as senderLastName,
           u.username as senderUsername, u.avatar as senderAvatar
    from group_messages gm
    left join users u on u.id=gm.sender_id and gm.is_system=0
    where gm.group_id=? and gm.deleted_for_all=0
      and gm.id not in (select message_id from group_message_hidden where user_id=?)
    order by gm.ts asc limit 500
  `).all(groupId, viewerUserId);
  const msgs = rows.map(r => ({ ...r, attachments: r.attachments ? JSON.parse(r.attachments) : [], reactions: [] }));
  return msgs;
}
function getGroupMessageById(id) {
  return db.prepare('select * from group_messages where id=?').get(id) || null;
}
function deleteGroupMessageForAll(id) {
  db.prepare('update group_messages set deleted_for_all=1 where id=?').run(id);
}
function hideGroupMessageForUser({ messageId, userId }) {
  db.prepare('insert into group_message_hidden(message_id,user_id) values(?,?) on conflict do nothing').run(messageId, userId);
}
function clearGroupMessagesForUser(groupId, userId) {
  const msgIds = db.prepare('select id from group_messages where group_id=? and deleted_for_all=0').all(groupId).map(r => r.id);
  if (!msgIds.length) return;
  const stmt = db.prepare('insert into group_message_hidden(message_id,user_id) values(?,?) on conflict do nothing');
  db.transaction(() => { for (const id of msgIds) stmt.run(id, userId); })();
}
function clearGroupMessagesForAll(groupId) {
  db.prepare('update group_messages set deleted_for_all=1 where group_id=?').run(groupId);
}
function markGroupChatRead({ groupId, userId }) {
  db.prepare(`insert into group_chat_state(group_id,user_id,last_read_ts) values(?,?,?)
    on conflict(group_id,user_id) do update set last_read_ts=excluded.last_read_ts`).run(groupId, userId, Date.now());
}
function getSharedGroups(user1Id, user2Id) {
  return db.prepare(`
    select g.id,g.name,g.avatar,g.description
    from groups g
    join group_members m1 on m1.group_id=g.id and m1.user_id=?
    join group_members m2 on m2.group_id=g.id and m2.user_id=?
    order by g.name
  `).all(user1Id, user2Id);
}
function getMediaBetween(user1Id, user2Id) {
  const rows = db.prepare(`
    select m.id, m.attachments, m.ts from messages m
    where ((m.sender_user_id=? and m.recipient_user_id=?) or (m.sender_user_id=? and m.recipient_user_id=?))
      and m.deleted_for_all=0 and m.attachments is not null
    order by m.ts desc limit 200
  `).all(user1Id, user2Id, user2Id, user1Id);
  const media = [];
  for (const r of rows) {
    const atts = r.attachments ? JSON.parse(r.attachments) : [];
    for (const a of atts) {
      if (a.mime && (a.mime.startsWith('image/') || a.mime.startsWith('video/'))) media.push(a);
    }
  }
  return media;
}
function getLinksBetween(user1Id, user2Id) {
  const rows = db.prepare(`
    select m.text, m.ts from messages m
    where ((m.sender_user_id=? and m.recipient_user_id=?) or (m.sender_user_id=? and m.recipient_user_id=?))
      and m.deleted_for_all=0 and m.text like '%http%'
    order by m.ts desc limit 200
  `).all(user1Id, user2Id, user2Id, user1Id);
  const urlRe = /https?:\/\/[^\s<>"]+/g;
  const links = [];
  for (const r of rows) {
    const found = r.text.match(urlRe);
    if (found) for (const url of found) links.push({ url, ts: r.ts });
  }
  return links.slice(0, 100);
}
function getGroupMedia(groupId) {
  const rows = db.prepare(`
    select gm.attachments, gm.ts from group_messages gm
    where gm.group_id=? and gm.deleted_for_all=0 and gm.attachments is not null and gm.is_system=0
    order by gm.ts desc limit 200
  `).all(groupId);
  const media = [];
  for (const r of rows) {
    const atts = r.attachments ? JSON.parse(r.attachments) : [];
    for (const a of atts) {
      if (a.mime && (a.mime.startsWith('image/') || a.mime.startsWith('video/'))) media.push(a);
    }
  }
  return media;
}
function getGroupLinks(groupId) {
  const rows = db.prepare(`
    select gm.text, gm.ts from group_messages gm
    where gm.group_id=? and gm.deleted_for_all=0 and gm.text like '%http%' and gm.is_system=0
    order by gm.ts desc limit 200
  `).all(groupId);
  const urlRe = /https?:\/\/[^\s<>"]+/g;
  const links = [];
  for (const r of rows) {
    if (!r.text) continue;
    const found = r.text.match(urlRe);
    if (found) for (const url of found) links.push({ url, ts: r.ts });
  }
  return links.slice(0, 100);
}

module.exports = {
  db, getUserByPhone, getUserById, getUserByUsername, isUsernameAvailable, searchUsersByUsername,
  createUser, listContacts, addContact,
  insertMessage, getMessageById, listMessagesBetween,
  listChats, markChatRead,
  hideChatForUser, deleteConversationForAll,
  hideMessageForUser, deleteMessageForAll,
  updateContactNickname, deleteContact,
  blockUser, unblockUser, isBlocked,
  updateProfile,
  toggleReaction, getReactionsForMessage,
  createGroup, getGroupById, updateGroup,
  addGroupMember, removeGroupMember, setGroupMemberRole, getGroupMember,
  listGroupMembers, listUserGroups,
  sendGroupMessage, sendGroupSystemMessage, listGroupMessages,
  getGroupMessageById, deleteGroupMessageForAll, hideGroupMessageForUser,
  clearGroupMessagesForUser, clearGroupMessagesForAll,
  markGroupChatRead, getSharedGroups, getMediaBetween, getLinksBetween,
  getGroupMedia, getGroupLinks,
};

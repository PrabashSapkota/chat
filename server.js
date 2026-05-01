const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*', methods: ['GET','POST'] } });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

/* ─── In-memory state ─────────────────────────────────────────────────────── */
const state = {
  messages:      [],   // {id,userId,username,text,type,ts,deleted,reactions,color,role}
  users:         {},   // socketId → user
  bannedIds:     new Set(),
  polls:         [],   // {id,question,options:[{text,votes:[]}],createdBy,active,ts}
  pinnedMsgId:   null,
  slowMode:      0,
  chatLocked:    false,
  lastMsgTime:   {},   // userId → timestamp
  maxMessages:   400,
};

const ADMIN_PASS  = 'prabashsapkota';
const ADMIN_COLOR = '#ff6b35';
const MOD_COLOR   = '#7ed321';
const COLORS = ['#61dafb','#c084fc','#fb923c','#34d399','#f472b6','#a78bfa','#38bdf8','#fbbf24','#e879f9','#4ade80','#f87171','#60a5fa'];

const BAD_WORDS = ['fuck','shit','bitch','asshole','bastard','cunt','dick','pussy','cock','motherfucker','fag','faggot','nigger','nigga','retard','whore','slut','twat','wanker','bollocks','shite','arse','prick'];

/* ─── Helpers ─────────────────────────────────────────────────────────────── */
function censor(text) {
  let r = text;
  for (const w of BAD_WORDS)
    r = r.replace(new RegExp(`\\b${w}\\b`, 'gi'), m => m[0] + '*'.repeat(m.length - 1));
  return r;
}
function randColor() { return COLORS[Math.floor(Math.random() * COLORS.length)]; }
function sysMsg(text) {
  return { id: uuidv4(), userId: 'system', username: 'System', text, type: 'system', ts: Date.now(), deleted: false, reactions: {} };
}
function push(msg) {
  state.messages.push(msg);
  if (state.messages.length > state.maxMessages) state.messages.shift();
}
function broadcastUsers() {
  io.emit('users_update', Object.values(state.users).map(u => ({
    id: u.id, username: u.username, role: u.role, color: u.color, muted: u.muted
  })));
}
function broadcastSettings() {
  io.emit('chat_settings', {
    slowMode:   state.slowMode,
    chatLocked: state.chatLocked,
    pinnedMsgId: state.pinnedMsgId,
  });
}

/* ─── GIF proxy (Tenor v2) ────────────────────────────────────────────────── */
const TENOR_KEY = process.env.TENOR_API_KEY || 'AIzaSyAyimkuYQYF_FXVALexQf7yGtx84Yygn-0';

function mapGifs(results = []) {
  return results
    .map(g => ({
      id:      g.id,
      preview: g.media_formats?.tinygif?.url || g.media_formats?.gif?.url || '',
      url:     g.media_formats?.gif?.url     || g.media_formats?.tinygif?.url || '',
      title:   g.content_description || '',
    }))
    .filter(g => g.preview && g.url);
}

app.get('/api/gifs/trending', async (_req, res) => {
  try {
    const r = await fetch(`https://tenor.googleapis.com/v2/featured?key=${TENOR_KEY}&limit=24&media_filter=gif`);
    const d = await r.json();
    res.json(mapGifs(d.results));
  } catch (e) { console.error('Tenor trending:', e.message); res.json([]); }
});

app.get('/api/gifs/search', async (req, res) => {
  try {
    const q = encodeURIComponent(req.query.q || 'funny');
    const r = await fetch(`https://tenor.googleapis.com/v2/search?key=${TENOR_KEY}&q=${q}&limit=24&media_filter=gif`);
    const d = await r.json();
    res.json(mapGifs(d.results));
  } catch (e) { console.error('Tenor search:', e.message); res.json([]); }
});

/* ─── Socket.IO ───────────────────────────────────────────────────────────── */
io.on('connection', socket => {

  /* JOIN */
  socket.on('join', ({ username, userId }) => {
    if (state.bannedIds.has(userId)) { socket.emit('banned'); socket.disconnect(); return; }
    const prev  = Object.values(state.users).find(u => u.id === userId);
    const color = prev?.color || randColor();
    const role  = prev?.role  || 'user';
    state.users[socket.id] = { id: userId, username, role, color, muted: false, socketId: socket.id };
    socket.emit('joined', { userId, role, color });
    socket.emit('chat_history',  state.messages.slice(-100));
    socket.emit('polls_update',  state.polls);
    socket.emit('chat_settings', { slowMode: state.slowMode, chatLocked: state.chatLocked, pinnedMsgId: state.pinnedMsgId });
    broadcastUsers();
    const m = sysMsg(`👋 ${username} joined`);
    push(m); io.emit('new_message', m);
  });

  /* SEND MESSAGE */
  socket.on('send_message', ({ text, type }) => {
    const msgType = type || 'text';
    const user = state.users[socket.id];
    if (!user) return;
    if (state.bannedIds.has(user.id))                        { socket.emit('banned'); return; }
    if (state.chatLocked && user.role === 'user')            { socket.emit('error_msg', '🔒 Chat is locked.'); return; }
    if (user.muted)                                          { socket.emit('error_msg', '🔇 You are muted.'); return; }
    if (state.slowMode > 0 && user.role === 'user') {
      const last = state.lastMsgTime[user.id] || 0;
      if (Date.now() - last < state.slowMode * 1000)         { socket.emit('error_msg', `⏱ Slow mode: wait ${state.slowMode}s.`); return; }
    }

    /* Admin promote */
    if (text.trim() === `/admin=${ADMIN_PASS}`) {
      user.role = 'admin'; user.color = ADMIN_COLOR;
      socket.emit('role_update', { role: 'admin', color: ADMIN_COLOR });
      broadcastUsers();
      const m = sysMsg(`🛡️ ${user.username} is now Admin`);
      push(m); io.emit('new_message', m);
      return;
    }

    const body = msgType === 'text' ? censor(text) : text;
    const msg  = { id: uuidv4(), userId: user.id, username: user.username, text: body, type: msgType, ts: Date.now(), deleted: false, reactions: {}, color: user.color, role: user.role };
    state.lastMsgTime[user.id] = Date.now();
    push(msg); io.emit('new_message', msg);
  });

  /* TYPING */
  socket.on('typing', isTyping => {
    const user = state.users[socket.id];
    if (user) socket.broadcast.emit('user_typing', { username: user.username, isTyping });
  });

  /* REACT */
  socket.on('react', ({ messageId, emoji }) => {
    const user = state.users[socket.id];
    if (!user) return;
    const msg = state.messages.find(m => m.id === messageId);
    if (!msg) return;
    if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
    const idx = msg.reactions[emoji].indexOf(user.id);
    if (idx === -1) msg.reactions[emoji].push(user.id);
    else            msg.reactions[emoji].splice(idx, 1);
    io.emit('reaction_update', { messageId, reactions: msg.reactions });
  });

  /* DELETE MESSAGE */
  socket.on('delete_message', id => {
    const user = state.users[socket.id];
    if (!user || !['admin','mod'].includes(user.role)) return;
    const msg = state.messages.find(m => m.id === id);
    if (msg) { msg.deleted = true; io.emit('message_deleted', id); }
  });

  /* PIN MESSAGE */
  socket.on('pin_message', id => {
    const user = state.users[socket.id];
    if (!user || !['admin','mod'].includes(user.role)) return;
    state.pinnedMsgId = id; broadcastSettings();
  });

  /* CLEAR CHAT */
  socket.on('clear_chat', () => {
    const user = state.users[socket.id];
    if (!user || user.role !== 'admin') return;
    state.messages.length = 0; state.pinnedMsgId = null;
    io.emit('chat_cleared');
    const m = sysMsg('🗑️ Chat cleared by admin'); push(m); io.emit('new_message', m);
  });

  /* BAN */
  socket.on('ban_user', targetId => {
    const user = state.users[socket.id];
    if (!user || !['admin','mod'].includes(user.role)) return;
    state.bannedIds.add(targetId);
    const t = Object.values(state.users).find(u => u.id === targetId);
    if (t) io.to(t.socketId).emit('banned');
    const m = sysMsg(`🔨 ${t?.username || targetId} was banned`); push(m); io.emit('new_message', m);
    broadcastUsers();
  });

  /* MUTE */
  socket.on('mute_user', ({ targetUserId, muted }) => {
    const user = state.users[socket.id];
    if (!user || !['admin','mod'].includes(user.role)) return;
    const t = Object.values(state.users).find(u => u.id === targetUserId);
    if (!t) return;
    t.muted = muted;
    io.to(t.socketId).emit('muted', muted);
    const m = sysMsg(`${muted ? '🔇' : '🔊'} ${t.username} ${muted ? 'muted' : 'unmuted'}`); push(m); io.emit('new_message', m);
    broadcastUsers();
  });

  /* SET ROLE */
  socket.on('set_role', ({ targetUserId, role }) => {
    const user = state.users[socket.id];
    if (!user || user.role !== 'admin') return;
    const t = Object.values(state.users).find(u => u.id === targetUserId);
    if (!t) return;
    t.role = role; t.color = role === 'mod' ? MOD_COLOR : randColor();
    io.to(t.socketId).emit('role_update', { role: t.role, color: t.color });
    const m = sysMsg(`⭐ ${t.username} is now ${role}`); push(m); io.emit('new_message', m);
    broadcastUsers();
  });

  /* SLOW MODE */
  socket.on('set_slow_mode', secs => {
    const user = state.users[socket.id];
    if (!user || !['admin','mod'].includes(user.role)) return;
    state.slowMode = Math.max(0, parseInt(secs) || 0); broadcastSettings();
    const m = sysMsg(state.slowMode > 0 ? `⏱ Slow mode: ${state.slowMode}s` : '⏱ Slow mode off'); push(m); io.emit('new_message', m);
  });

  /* LOCK */
  socket.on('set_chat_locked', locked => {
    const user = state.users[socket.id];
    if (!user || !['admin','mod'].includes(user.role)) return;
    state.chatLocked = locked; broadcastSettings();
    const m = sysMsg(locked ? '🔒 Chat locked' : '🔓 Chat unlocked'); push(m); io.emit('new_message', m);
  });

  /* CREATE POLL */
  socket.on('create_poll', ({ question, options }) => {
    const user = state.users[socket.id];
    if (!user || !['admin','mod'].includes(user.role)) return;
    const poll = { id: uuidv4(), question, options: options.map(t => ({ text: t, votes: [] })), createdBy: user.username, active: true, ts: Date.now() };
    state.polls.push(poll);
    io.emit('polls_update', state.polls);
    const m = sysMsg(`📊 New poll: "${question}"`); push(m); io.emit('new_message', m);
  });

  /* VOTE POLL */
  socket.on('vote_poll', ({ pollId, optionIndex }) => {
    const user = state.users[socket.id];
    if (!user) return;
    const poll = state.polls.find(p => p.id === pollId);
    if (!poll || !poll.active) return;
    poll.options.forEach(o => { const i = o.votes.indexOf(user.id); if (i !== -1) o.votes.splice(i, 1); });
    if (poll.options[optionIndex]) poll.options[optionIndex].votes.push(user.id);
    io.emit('polls_update', state.polls);
  });

  /* CLOSE / DELETE POLL */
  socket.on('close_poll', id => {
    const user = state.users[socket.id];
    if (!user || !['admin','mod'].includes(user.role)) return;
    const p = state.polls.find(p => p.id === id);
    if (p) { p.active = false; io.emit('polls_update', state.polls); }
  });
  socket.on('delete_poll', id => {
    const user = state.users[socket.id];
    if (!user || user.role !== 'admin') return;
    const i = state.polls.findIndex(p => p.id === id);
    if (i !== -1) { state.polls.splice(i, 1); io.emit('polls_update', state.polls); }
  });

  /* WHISPER */
  socket.on('whisper', ({ targetUserId, text }) => {
    const user = state.users[socket.id];
    if (!user) return;
    const t = Object.values(state.users).find(u => u.id === targetUserId);
    if (!t) return;
    const base = { id: uuidv4(), userId: user.id, username: user.username, type: 'whisper', ts: Date.now(), deleted: false, reactions: {}, color: user.color, role: user.role };
    socket.emit('new_message',       { ...base, text: `💌 [to ${t.username}] ${censor(text)}` });
    io.to(t.socketId).emit('new_message', { ...base, text: `💌 [from ${user.username}] ${censor(text)}` });
  });

  /* DISCONNECT */
  socket.on('disconnect', () => {
    const user = state.users[socket.id];
    if (user) {
      const m = sysMsg(`👋 ${user.username} left`); push(m); io.emit('new_message', m);
      delete state.users[socket.id];
      broadcastUsers();
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀  LiveChat  →  http://localhost:${PORT}`));

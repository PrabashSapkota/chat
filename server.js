const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ── In-memory state ──────────────────────────────────────────────────────────
const state = {
  messages: [],          // { id, userId, username, text, type, ts, deleted, pinned, reactions }
  users: {},             // socketId → { id, username, role, color, joinedAt, muted, banned }
  bannedIds: new Set(),  // persistent user ids (stored in cookie)
  mutedIds: new Set(),
  polls: [],             // { id, question, options:[{text,votes:[userId]}], createdBy, active, ts }
  pinnedMessageId: null,
  slowMode: 0,           // seconds between messages, 0 = off
  chatLocked: false,
  lastMessageTime: {},   // userId → timestamp
  maxMessages: 200,
};

const ADMIN_PASS = 'prabashsapkota';
const ADMIN_COLOR = '#ff6b35';
const MOD_COLOR   = '#7ed321';
const USER_COLORS = ['#61dafb','#c084fc','#fb923c','#34d399','#f472b6','#a78bfa','#38bdf8','#fbbf24'];

// ── Bad-words filter (manual list for reliability) ───────────────────────────
const BAD_WORDS = [
  'fuck','shit','bitch','asshole','bastard','cunt','dick','pussy','cock',
  'motherfucker','fag','faggot','nigger','nigga','retard','whore','slut',
  'damn','ass','piss','crap','hell','idiot','moron','stupid','loser',
  'twat','wanker','bollocks','shite','arse','prick'
];

function censorText(text) {
  let result = text;
  for (const word of BAD_WORDS) {
    const re = new RegExp(`\\b${word}\\b`, 'gi');
    result = result.replace(re, m => m[0] + '*'.repeat(m.length - 1));
  }
  return result;
}

function randomColor() {
  return USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)];
}

function systemMsg(text, extra = {}) {
  return {
    id: uuidv4(), userId: 'system', username: 'System',
    text, type: 'system', ts: Date.now(), deleted: false, pinned: false,
    reactions: {}, ...extra
  };
}

function pushMessage(msg) {
  state.messages.push(msg);
  if (state.messages.length > state.maxMessages) state.messages.shift();
}

function broadcastUsers() {
  const list = Object.values(state.users).map(u => ({
    id: u.id, username: u.username, role: u.role,
    color: u.color, muted: u.muted
  }));
  io.emit('users_update', list);
}

function broadcastState(socket) {
  const target = socket || io;
  target.emit('chat_history', state.messages.slice(-100));
  target.emit('polls_update', state.polls);
  target.emit('chat_settings', {
    slowMode: state.slowMode,
    chatLocked: state.chatLocked,
    pinnedMessageId: state.pinnedMessageId
  });
}

// ── GIF proxy (Tenor) ────────────────────────────────────────────────────────
app.get('/api/gifs/search', async (req, res) => {
  const { q, limit = 20 } = req.query;
  const key = process.env.TENOR_API_KEY || 'AIzaSyAyimkuYQYF_FXVALexQf7yGtx84Yygn-0'; // public demo key
  try {
    const fetch = require('node-fetch');
    const url = `https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(q)}&key=${key}&limit=${limit}&media_filter=gif`;
    const r = await fetch(url);
    const data = await r.json();
    const results = (data.results || []).map(g => ({
      id: g.id,
      preview: g.media_formats?.tinygif?.url,
      url: g.media_formats?.gif?.url || g.media_formats?.tinygif?.url,
      title: g.content_description
    }));
    res.json(results);
  } catch (e) {
    res.json([]);
  }
});

app.get('/api/gifs/trending', async (req, res) => {
  const key = process.env.TENOR_API_KEY || 'AIzaSyAyimkuYQYF_FXVALexQf7yGtx84Yygn-0';
  try {
    const fetch = require('node-fetch');
    const url = `https://tenor.googleapis.com/v2/featured?key=${key}&limit=20&media_filter=gif`;
    const r = await fetch(url);
    const data = await r.json();
    const results = (data.results || []).map(g => ({
      id: g.id,
      preview: g.media_formats?.tinygif?.url,
      url: g.media_formats?.gif?.url || g.media_formats?.tinygif?.url,
      title: g.content_description
    }));
    res.json(results);
  } catch (e) {
    res.json([]);
  }
});

// ── Socket.IO ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {

  // ── Join ──────────────────────────────────────────────────────────────────
  socket.on('join', ({ username, userId }) => {
    const uid = userId || uuidv4();

    if (state.bannedIds.has(uid)) {
      socket.emit('banned');
      socket.disconnect();
      return;
    }

    const existing = Object.values(state.users).find(u => u.id === uid);
    const color = existing?.color || randomColor();
    const role  = existing?.role  || 'user';

    state.users[socket.id] = {
      id: uid, username, role, color,
      joinedAt: Date.now(), muted: false, socketId: socket.id
    };

    socket.emit('joined', { userId: uid, role, color });
    broadcastState(socket);
    broadcastUsers();

    const joinMsg = systemMsg(`👋 ${username} joined the chat`);
    pushMessage(joinMsg);
    io.emit('new_message', joinMsg);
  });

  // ── Chat message ──────────────────────────────────────────────────────────
  socket.on('send_message', ({ text, type = 'text' }) => {
    const user = state.users[socket.id];
    if (!user) return;
    if (state.bannedIds.has(user.id)) { socket.emit('banned'); return; }
    if (state.chatLocked && user.role === 'user') {
      socket.emit('error_msg', 'Chat is locked by admin.');
      return;
    }
    if (user.muted) { socket.emit('error_msg', 'You are muted.'); return; }

    // Slow mode
    if (state.slowMode > 0 && user.role === 'user') {
      const last = state.lastMessageTime[user.id] || 0;
      if (Date.now() - last < state.slowMode * 1000) {
        socket.emit('error_msg', `Slow mode: wait ${state.slowMode}s between messages.`);
        return;
      }
    }

    // Admin login via chat
    if (text.trim() === `/admin=${ADMIN_PASS}`) {
      user.role = 'admin';
      user.color = ADMIN_COLOR;
      socket.emit('role_update', { role: 'admin', color: ADMIN_COLOR });
      broadcastUsers();
      const m = systemMsg(`🛡️ ${user.username} is now Admin`);
      pushMessage(m); io.emit('new_message', m);
      return;
    }

    const censored = type === 'text' ? censorText(text) : text;
    const msg = {
      id: uuidv4(), userId: user.id, username: user.username,
      text: censored, type, ts: Date.now(),
      deleted: false, pinned: false, reactions: {},
      color: user.color, role: user.role
    };

    state.lastMessageTime[user.id] = Date.now();
    pushMessage(msg);
    io.emit('new_message', msg);
  });

  // ── Typing ────────────────────────────────────────────────────────────────
  socket.on('typing', (isTyping) => {
    const user = state.users[socket.id];
    if (!user) return;
    socket.broadcast.emit('user_typing', { username: user.username, isTyping });
  });

  // ── Reactions ─────────────────────────────────────────────────────────────
  socket.on('react', ({ messageId, emoji }) => {
    const user = state.users[socket.id];
    if (!user) return;
    const msg = state.messages.find(m => m.id === messageId);
    if (!msg) return;
    if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
    const idx = msg.reactions[emoji].indexOf(user.id);
    if (idx === -1) msg.reactions[emoji].push(user.id);
    else msg.reactions[emoji].splice(idx, 1);
    io.emit('reaction_update', { messageId, reactions: msg.reactions });
  });

  // ── Admin: delete message ─────────────────────────────────────────────────
  socket.on('delete_message', (messageId) => {
    const user = state.users[socket.id];
    if (!user || !['admin','mod'].includes(user.role)) return;
    const msg = state.messages.find(m => m.id === messageId);
    if (msg) { msg.deleted = true; io.emit('message_deleted', messageId); }
  });

  // ── Admin: pin message ────────────────────────────────────────────────────
  socket.on('pin_message', (messageId) => {
    const user = state.users[socket.id];
    if (!user || !['admin','mod'].includes(user.role)) return;
    state.pinnedMessageId = messageId;
    io.emit('chat_settings', { slowMode: state.slowMode, chatLocked: state.chatLocked, pinnedMessageId: messageId });
  });

  // ── Admin: clear chat ─────────────────────────────────────────────────────
  socket.on('clear_chat', () => {
    const user = state.users[socket.id];
    if (!user || user.role !== 'admin') return;
    state.messages.length = 0;
    state.pinnedMessageId = null;
    io.emit('chat_cleared');
    const m = systemMsg('🗑️ Chat was cleared by admin');
    pushMessage(m); io.emit('new_message', m);
  });

  // ── Admin: ban ────────────────────────────────────────────────────────────
  socket.on('ban_user', (targetUserId) => {
    const user = state.users[socket.id];
    if (!user || !['admin','mod'].includes(user.role)) return;
    state.bannedIds.add(targetUserId);
    const targetSocket = Object.values(state.users).find(u => u.id === targetUserId);
    const targetName = targetSocket?.username || targetUserId;
    if (targetSocket) {
      io.to(targetSocket.socketId).emit('banned');
    }
    const m = systemMsg(`🔨 ${targetName} was banned`);
    pushMessage(m); io.emit('new_message', m);
    broadcastUsers();
  });

  // ── Admin: mute / unmute ──────────────────────────────────────────────────
  socket.on('mute_user', ({ targetUserId, muted }) => {
    const user = state.users[socket.id];
    if (!user || !['admin','mod'].includes(user.role)) return;
    const target = Object.values(state.users).find(u => u.id === targetUserId);
    if (target) {
      target.muted = muted;
      io.to(target.socketId).emit('muted', muted);
      const m = systemMsg(`${muted ? '🔇' : '🔊'} ${target.username} was ${muted ? 'muted' : 'unmuted'}`);
      pushMessage(m); io.emit('new_message', m);
      broadcastUsers();
    }
  });

  // ── Admin: appoint mod ────────────────────────────────────────────────────
  socket.on('set_role', ({ targetUserId, role }) => {
    const user = state.users[socket.id];
    if (!user || user.role !== 'admin') return;
    const target = Object.values(state.users).find(u => u.id === targetUserId);
    if (target) {
      target.role = role;
      target.color = role === 'mod' ? MOD_COLOR : randomColor();
      io.to(target.socketId).emit('role_update', { role: target.role, color: target.color });
      const m = systemMsg(`⭐ ${target.username} is now ${role}`);
      pushMessage(m); io.emit('new_message', m);
      broadcastUsers();
    }
  });

  // ── Admin: slow mode ──────────────────────────────────────────────────────
  socket.on('set_slow_mode', (seconds) => {
    const user = state.users[socket.id];
    if (!user || !['admin','mod'].includes(user.role)) return;
    state.slowMode = seconds;
    io.emit('chat_settings', { slowMode: state.slowMode, chatLocked: state.chatLocked, pinnedMessageId: state.pinnedMessageId });
    const m = systemMsg(seconds > 0 ? `⏱️ Slow mode set to ${seconds}s` : '⏱️ Slow mode disabled');
    pushMessage(m); io.emit('new_message', m);
  });

  // ── Admin: lock chat ──────────────────────────────────────────────────────
  socket.on('set_chat_locked', (locked) => {
    const user = state.users[socket.id];
    if (!user || !['admin','mod'].includes(user.role)) return;
    state.chatLocked = locked;
    io.emit('chat_settings', { slowMode: state.slowMode, chatLocked: state.chatLocked, pinnedMessageId: state.pinnedMessageId });
    const m = systemMsg(locked ? '🔒 Chat locked by admin' : '🔓 Chat unlocked');
    pushMessage(m); io.emit('new_message', m);
  });

  // ── Polls ─────────────────────────────────────────────────────────────────
  socket.on('create_poll', ({ question, options }) => {
    const user = state.users[socket.id];
    if (!user || !['admin','mod'].includes(user.role)) return;
    const poll = {
      id: uuidv4(), question,
      options: options.map(t => ({ text: t, votes: [] })),
      createdBy: user.username, active: true, ts: Date.now()
    };
    state.polls.push(poll);
    io.emit('polls_update', state.polls);
    const m = systemMsg(`📊 Poll: "${question}"`);
    pushMessage(m); io.emit('new_message', m);
  });

  socket.on('vote_poll', ({ pollId, optionIndex }) => {
    const user = state.users[socket.id];
    if (!user) return;
    const poll = state.polls.find(p => p.id === pollId);
    if (!poll || !poll.active) return;
    // Remove previous vote
    poll.options.forEach(o => { const i = o.votes.indexOf(user.id); if (i !== -1) o.votes.splice(i,1); });
    if (poll.options[optionIndex]) poll.options[optionIndex].votes.push(user.id);
    io.emit('polls_update', state.polls);
  });

  socket.on('close_poll', (pollId) => {
    const user = state.users[socket.id];
    if (!user || !['admin','mod'].includes(user.role)) return;
    const poll = state.polls.find(p => p.id === pollId);
    if (poll) { poll.active = false; io.emit('polls_update', state.polls); }
  });

  socket.on('delete_poll', (pollId) => {
    const user = state.users[socket.id];
    if (!user || user.role !== 'admin') return;
    const idx = state.polls.findIndex(p => p.id === pollId);
    if (idx !== -1) { state.polls.splice(idx, 1); io.emit('polls_update', state.polls); }
  });

  // ── DM (whisper) ──────────────────────────────────────────────────────────
  socket.on('whisper', ({ targetUserId, text }) => {
    const user = state.users[socket.id];
    if (!user) return;
    const target = Object.values(state.users).find(u => u.id === targetUserId);
    if (!target) return;
    const msg = {
      id: uuidv4(), userId: user.id, username: user.username,
      text: `[DM to ${target.username}] ${censorText(text)}`,
      type: 'whisper', ts: Date.now(), deleted: false, pinned: false,
      reactions: {}, color: user.color, role: user.role
    };
    socket.emit('new_message', msg);
    io.to(target.socketId).emit('new_message', {
      ...msg, text: `[DM from ${user.username}] ${censorText(text)}`
    });
  });

  // ── Disconnect ────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const user = state.users[socket.id];
    if (user) {
      const m = systemMsg(`👋 ${user.username} left the chat`);
      pushMessage(m);
      io.emit('new_message', m);
      delete state.users[socket.id];
      broadcastUsers();
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 LiveChat running on http://localhost:${PORT}`));

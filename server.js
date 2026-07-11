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

const fs = require('fs');
const DATA_FILE = path.join(__dirname, 'chat-data.json');

/* ─── In-memory state (defined first) ────────────────────────────────────── */
const state = {
  messages:      [],
  users:         {},
  bannedIds:     new Set(),
  polls:         [],
  pinnedMsgId:   null,
  slowMode:      0,
  lastMsgTime:   {},
  lastMsgContent:{},
  burstHistory:  {},
  userIps:       {},
  maxMessages:   50,
};

/* ─── File-based Persistence ─────────────────────────────────────────────── */
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      state.messages = data.messages || [];
      state.bannedIds = new Set(data.bannedIds || []);
      state.polls = data.polls || [];
      state.pinnedMsgId = data.pinnedMsgId || null;
      state.slowMode = data.slowMode || 0;
      console.log(`[DB] Loaded ${state.messages.length} messages, ${state.polls.length} polls`);
    }
  } catch (e) { console.error('[DB] Load error:', e.message); }
}

function saveData() {
  try {
    const data = {
      messages: state.messages.slice(-50),
      bannedIds: Array.from(state.bannedIds),
      polls: state.polls,
      pinnedMsgId: state.pinnedMsgId,
      slowMode: state.slowMode
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (e) { console.error('[DB] Save error:', e.message); }
}

loadData();
setInterval(saveData, 30000);


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
function randColor(seed) {
  if (!seed) return COLORS[Math.floor(Math.random() * COLORS.length)];
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = seed.charCodeAt(i) + ((hash << 5) - hash);
  const h = Math.abs(hash) % 360;
  return `hsl(${h}, 70%, 65%)`;
}
function sysMsg(text) {
  return { id: uuidv4(), userId: 'system', username: 'System', text, type: 'system', ts: Date.now(), deleted: false, reactions: {} };
}
function getIp(socket) {
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return socket.handshake.address;
}
function autoBan(userId, socketId) {
  state.bannedIds.add(userId);
  const s = io.sockets.sockets.get(socketId);
  if (s) {
    s.emit('banned');
    s.disconnect();
  }
}
function push(msg) {
  state.messages.push(msg);
  while (state.messages.length > state.maxMessages) state.messages.shift();
  saveData();
}
function broadcastUsers() {
  const allUsers = Object.values(state.users);
  
  // Prioritize admins, mods, and muted users (they must always be sent)
  const priorityUsers = allUsers.filter(u => ['admin', 'mod'].includes(u.role) || u.muted);
  
  // Limit regular unmuted users to 50
  const regularUsers = allUsers.filter(u => u.role === 'user' && !u.muted);
  const limitedRegular = regularUsers.slice(0, 50);
  
  const uniqueUsersMap = new Map();
  [...priorityUsers, ...limitedRegular].forEach(u => {
    if (!uniqueUsersMap.has(u.id)) {
      uniqueUsersMap.set(u.id, {
        id: u.id, username: u.username, role: u.role, color: u.color, muted: u.muted
      });
    }
  });

  io.emit('users_update', {
    list: Array.from(uniqueUsersMap.values()),
    totalCount: new Set(allUsers.map(u => u.id)).size
  });
}
function broadcastSettings() {
  io.emit('chat_settings', {
    slowMode:   state.slowMode,
    pinnedMsgId: state.pinnedMsgId,
  });
}

/* ── GIF proxy (Giphy) ────────────────────────────────────────────────────── */
const GIPHY_KEY = process.env.GIPHY_API_KEY || 'x2NUFYUd98RwHScVZJbOLSBtereb5gZ5';

function mapGiphy(results = []) {
  return (results || [])
    .map(g => ({
      id:      g.id,
      preview: g.images?.fixed_height_small?.url || g.images?.fixed_height?.url || g.images?.preview_gif?.url || '',
      url:     g.images?.original?.url || g.images?.fixed_height?.url || '',
      title:   g.title || '',
    }))
    .filter(g => g.preview && g.url);
}

app.get('/api/gifs/trending', async (_req, res) => {
  try {
    const r = await fetch(`https://api.giphy.com/v1/gifs/trending?api_key=${GIPHY_KEY}&limit=24`);
    const d = await r.json();
    res.json(mapGiphy(d.data));
  } catch (e) { console.error('Giphy trending:', e.message); res.json([]); }
});

app.get('/api/gifs/search', async (req, res) => {
  try {
    const q = encodeURIComponent(req.query.q || 'funny');
    const r = await fetch(`https://api.giphy.com/v1/gifs/search?api_key=${GIPHY_KEY}&q=${q}&limit=24`);
    const d = await r.json();
    res.json(mapGiphy(d.data));
  } catch (e) { console.error('Giphy search:', e.message); res.json([]); }
});

/* ─── Socket.IO ───────────────────────────────────────────────────────────── */
io.on('connection', socket => {

  /* JOIN */
  socket.on('join', ({ username, userId }) => {
    const ip = getIp(socket);
    state.userIps[userId] = ip;

    if (state.bannedIds.has(userId)) {
      socket.emit('banned');
      socket.disconnect();
      return;
    }

    let finalUsername = username;
    const isNameTaken = (name) => Object.values(state.users).some(u => u.id !== userId && u.username.toLowerCase() === name.toLowerCase());
    
    if (isNameTaken(finalUsername)) {
      const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
      let suffix = '';
      for (let i = 0; i < 3; i++) {
        suffix += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      finalUsername = `${username}_${suffix}`;
      while (isNameTaken(finalUsername)) {
        suffix = '';
        for (let i = 0; i < 3; i++) {
          suffix += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        finalUsername = `${username}_${suffix}`;
      }
    }

    const prev  = Object.values(state.users).find(u => u.id === userId);
    const color = prev?.color || randColor(userId);
    const role  = prev?.role  || 'user';
    state.users[socket.id] = { id: userId, username: finalUsername, role, color, muted: false, socketId: socket.id };
    socket.emit('joined', { userId, role, color, username: finalUsername });
    socket.emit('chat_history',  state.messages.slice(-50));
    socket.emit('polls_update',  state.polls);
    socket.emit('chat_settings', { slowMode: state.slowMode, chatLocked: state.chatLocked, pinnedMsgId: state.pinnedMsgId });
    broadcastUsers();
  });

  /* SEND MESSAGE */
  socket.on('send_message', ({ text, type, replyToId }) => {
    const msgType = type || 'text';
    const user = state.users[socket.id];
    if (!user) return;
    if (state.bannedIds.has(user.id)) { socket.emit('banned'); return; }
    if (user.muted)                                          { socket.emit('error_msg', '🔇 You are muted.'); return; }

    // --- Anti-Spam ---
    if (!['admin','mod'].includes(user.role)) {
      // 1. Length Check
      if (text.length > 1000) { socket.emit('error_msg', '📏 Message too long.'); return; }

      // 2. Link Check (skip for GIFs - everyone can send GIFs)
      if (msgType !== 'gif') {
        const urlRegex = /(https?:\/\/[^\s<"]+)/i;
        if (urlRegex.test(text)) { socket.emit('error_msg', '🚫 Only moderators can send links.'); return; }
      }

      // 3. Duplicate Check
      if (text.trim() === state.lastMsgContent[user.id] && msgType === 'text') {
        socket.emit('error_msg', '🚫 Please don\'t repeat yourself.'); return;
      }

      // 4. Burst Protection (Auto-mute)
      const now = Date.now();
      if (!state.burstHistory[user.id]) state.burstHistory[user.id] = [];
      state.burstHistory[user.id] = state.burstHistory[user.id].filter(ts => now - ts < 5000); 
      state.burstHistory[user.id].push(now);

      if (state.burstHistory[user.id].length > 5) {
        autoBan(user.id, socket.id);
        const m = sysMsg(`🔨 ${user.username} has been auto-banned for spamming.`);
        push(m); io.emit('new_message', m);
        return;
      }

      // 5. Caps Check
      if (text.length > 20) {
        const caps = text.replace(/[^A-Z]/g, "").length;
        if (caps / text.length > 0.7) text = text.toLowerCase();
      }
    }

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
    const msg  = { 
      id: uuidv4(), 
      userId: user.id, 
      username: user.username, 
      text: body, 
      type: msgType, 
      ts: Date.now(), 
      deleted: false, 
      reactions: {}, 
      color: user.color, 
      role: user.role,
      replyTo: replyToId ? state.messages.find(m => m.id === replyToId && !m.deleted) : null
    };
    state.lastMsgTime[user.id] = Date.now();
    state.lastMsgContent[user.id] = msgType === 'text' ? text.trim() : null;
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

  /* DELETE ALL BY USER */
  socket.on('delete_all_by_user', targetUserId => {
    const user = state.users[socket.id];
    if (!user || !['admin','mod'].includes(user.role)) return;
    
    let deletedCount = 0;
    state.messages.forEach(msg => {
      if (msg.userId === targetUserId && !msg.deleted) {
        msg.deleted = true;
        deletedCount++;
      }
    });
    
    if (deletedCount > 0) {
      saveData();
      io.emit('refresh_chat', state.messages.slice(-50));
      const m = sysMsg(`🗑️ Deleted all messages by user ${targetUserId}`);
      push(m);
      io.emit('new_message', m);
    }
  });

  /* BAN USER */
  socket.on('ban_user', targetUserId => {
    const user = state.users[socket.id];
    if (!user || !['admin','mod'].includes(user.role)) return;
    
    const targetUser = Object.values(state.users).find(u => u.id === targetUserId);
    if (!targetUser) return;
    if (targetUser.role === 'admin') return; // Cannot ban admins
    
    state.bannedIds.add(targetUserId);
    saveData();
    
    // Disconnect all sockets of the banned user
    for (const [sid, u] of Object.entries(state.users)) {
      if (u.id === targetUserId) {
        const s = io.sockets.sockets.get(sid);
        if (s) {
          s.emit('banned');
          s.disconnect();
        }
        delete state.users[sid];
      }
    }
    
    const m = sysMsg(`🔨 ${targetUser.username} has been banned by ${user.username}.`);
    push(m);
    io.emit('new_message', m);
    broadcastUsers();
  });

  /* UNBAN USER */
  socket.on('unban_user', targetUserId => {
    const user = state.users[socket.id];
    if (!user || !['admin','mod'].includes(user.role)) return;
    
    if (state.bannedIds.has(targetUserId)) {
      state.bannedIds.delete(targetUserId);
      saveData();
      const m = sysMsg(`🔊 User ID ${targetUserId} has been unbanned by ${user.username}.`);
      push(m);
      io.emit('new_message', m);
    } else {
      socket.emit('error_msg', 'User ID not found in ban list.');
    }
  });

  /* PIN / UNPIN MESSAGE */
  socket.on('pin_message', id => {
    const user = state.users[socket.id];
    if (!user || !['admin','mod'].includes(user.role)) return;
    state.pinnedMsgId = id;
    saveData();
    broadcastSettings();
  });

  /* CLEAR CHAT */
  socket.on('clear_chat', () => {
    const user = state.users[socket.id];
    if (!user || !['admin','mod'].includes(user.role)) return;
    state.messages.length = 0; state.pinnedMsgId = null;
    io.emit('chat_cleared');
    const m = sysMsg('🗑️ Chat cleared by admin'); push(m); io.emit('new_message', m);
  });


  /* MUTE */
  socket.on('mute_user', ({ targetUserId, muted }) => {
    const user = state.users[socket.id];
    if (!user || !['admin','mod'].includes(user.role)) return;
    const t = Object.values(state.users).find(u => u.id === targetUserId);
    if (!t) return;
    t.muted = muted;
    io.to(t.socketId).emit('muted', muted);
    broadcastUsers();
  });

  /* SET ROLE */
  socket.on('set_role', ({ targetUserId, role }) => {
    const user = state.users[socket.id];
    if (!user || !['admin','mod'].includes(user.role)) return;
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
    state.slowMode = Math.max(0, parseInt(secs) || 0);
    saveData();
    broadcastSettings();
    const m = sysMsg(state.slowMode > 0 ? `⏱ Slow mode: ${state.slowMode}s` : '⏱ Slow mode off'); push(m); io.emit('new_message', m);
  });


  socket.on('create_poll', ({ question, options }) => {
    const user = state.users[socket.id];
    if (!user || !['admin','mod'].includes(user.role)) return;
    const poll = { id: uuidv4(), question, options: options.map(t => ({ text: t, votes: [] })), createdBy: user.username, active: true, ts: Date.now() };
    state.polls.push(poll);
    io.emit('polls_update', state.polls);
    saveData();
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
    if (p) { p.active = false; saveData(); io.emit('polls_update', state.polls); }
  });
  socket.on('delete_poll', id => {
    const user = state.users[socket.id];
    if (!user || !['admin','mod'].includes(user.role)) return;
    const i = state.polls.findIndex(p => p.id === id);
    if (i !== -1) { state.polls.splice(i, 1); saveData(); io.emit('polls_update', state.polls); }
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
      delete state.users[socket.id];
      // Clean up tracking maps if user has no more active sessions
      const stillConnected = Object.values(state.users).some(u => u.id === user.id);
      if (!stillConnected) {
        delete state.lastMsgTime[user.id];
        delete state.lastMsgContent[user.id];
        delete state.burstHistory[user.id];
        delete state.userIps[user.id];
      }
      broadcastUsers();
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀  LiveChat  →  http://localhost:${PORT}`));

# 💬 LiveChat — Full-Featured Real-Time Chat

A beautiful, feature-packed live chat application with admin controls, polls, GIFs, emoji, and content moderation.

---

## 🚀 Deploy to Render (Free)

1. Push this folder to a GitHub repo
2. Go to [render.com](https://render.com) → New → Web Service
3. Connect your GitHub repo
4. Render auto-detects `render.yaml` — just click **Deploy**
5. Your chat is live at `https://your-app.onrender.com`

Or manually:
- **Build Command:** `npm install`
- **Start Command:** `npm start`
- **Environment:** Node

---

## 🖥️ Run Locally

```bash
npm install
npm start
# Open http://localhost:3000
```

For development with auto-reload:
```bash
npm install -g nodemon
npm run dev
```

---

## 🔑 Admin Access

Type in the chat box:
```
/admin=prabashsapkota
```
You will immediately be promoted to Admin with full controls.

---

## ✨ Features

### 👤 Users
- **Name entry** with persistence (localStorage + UUID)
- **Auto-assigned colors** per user
- **Custom avatar** initials
- **Role badges** (Admin 🛡️, Mod ⭐)

### 💬 Messaging
- Real-time Socket.IO messaging
- **Markdown-lite**: `**bold**`, `*italic*`, `` `code` ``
- **Auto-link** detection
- **Character counter** (max 1,000)
- **Auto-resize** textarea
- **Enter to send**, Shift+Enter for newline
- **Typing indicators** ("Alice is typing…")
- **Sound notification** for new messages

### 😊 Emoji
- Full emoji picker with **9 categories**
- 500+ emojis browseable + **search**
- Click to insert at cursor

### 🎬 GIF Support
- Trending GIFs via Tenor API
- **Search GIFs** with debounced input
- Click to send inline

### ⚡ Reactions
- Quick-react menu on hover
- 10 quick reactions (❤️ 😂 😮 etc.)
- **Toggle** your own reaction
- **Live reaction counts**

### 📊 Polls (Admin/Mod)
- Create polls with up to 10 options
- **Real-time vote counts** with progress bars
- Single-vote with ability to change vote
- End/delete polls

### 🛡️ Admin Panel
- **Clear all messages** from chat
- **Lock chat** (only admin/mod can send)
- **Slow mode** (enforce cooldown in seconds)
- **Export chat** as .txt
- Right-click users for actions

### 🔨 Moderation
- **Ban users** (by persistent UUID — survives refresh)
- **Mute users** (can't send messages)
- **Appoint Mods** from any user
- **Remove Mod** status
- **Delete any message**
- **Pin messages** (shown in pinned bar)

### 🚫 Profanity Filter
- 30+ bad words automatically censored with `*`
- Applies to all text messages
- GIF/system messages excluded

### 💌 Whispers (DMs)
- Private whisper between two users
- Visually distinct message style
- Only sender and receiver see it

### 📱 Responsive Design
- Full mobile support
- Slide-in sidebar on mobile
- Tap-friendly buttons

---

## 🔧 Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Server port |
| `TENOR_API_KEY` | demo key | Get your own at [tenor.com/developer](https://tenor.com/gifapi) |

---

## 📁 File Structure

```
livechat/
├── server.js          # Express + Socket.IO server
├── package.json       # Dependencies
├── render.yaml        # Render deploy config
├── public/
│   └── index.html     # Single-page frontend (all JS/CSS included)
└── README.md
```

---

## 🔌 Embed in Any Site

```html
<iframe 
  src="https://your-chat.onrender.com" 
  width="100%" 
  height="600px" 
  frameborder="0"
  allow="autoplay">
</iframe>
```

Or as a fullscreen overlay:
```html
<script>
window.open('https://your-chat.onrender.com', 'chat', 'width=400,height=700');
</script>
```

---

## 🏗️ Tech Stack

- **Backend:** Node.js + Express + Socket.IO
- **Frontend:** Vanilla HTML/CSS/JS (no framework)
- **GIFs:** Tenor API
- **Deployment:** Render.com (free tier)

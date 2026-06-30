// Jeopardy Buzzer — backend
// Stack: Express (HTTP routes) + Socket.io (real-time events)
// All room state lives in memory; rooms vanish on server restart (acceptable).

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

// ── Static files & JSON body parsing ──────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ── In-memory store: roomCode → room object ───────────────────────────────────
// Room shape:
// {
//   code, password, hostName,
//   players: { socketId: { name, score } },
//   buzzOrder: [socketId, ...],   // oldest first
//   answeringPlayer: socketId | null,
//   timerEndsAt: epoch-ms | null
// }
const rooms = {};

// ── Helpers ───────────────────────────────────────────────────────────────────

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // omit O/0, I/1 — easy to misread
  let code;
  do {
    code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms[code]); // retry on (extremely unlikely) collision
  return code;
}

// Send the full room state to every socket currently in the room.
// This is the only broadcast function — keeps the state machine simple.
function broadcastState(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  io.to(roomCode).emit('room_state', {
    players:         room.players,
    buzzOrder:       room.buzzOrder,
    answeringPlayer: room.answeringPlayer,
    timerEndsAt:     room.timerEndsAt,
    hostName:        room.hostName,
  });
}

// ── HTTP routes ───────────────────────────────────────────────────────────────

// POST /create-room  →  { roomCode }
// Called from the landing page "Create Game" form.
app.post('/create-room', (req, res) => {
  const { hostName, password } = req.body;
  if (!hostName || !password)
    return res.status(400).json({ error: 'hostName and password are required' });

  const code = generateRoomCode();
  rooms[code] = {
    code,
    password,
    hostName,
    players:         {},
    buzzOrder:       [],
    answeringPlayer: null,
    timerEndsAt:     null,
  };

  console.log(`Room created: ${code} by ${hostName}`);
  res.json({ roomCode: code });
});

// POST /validate-join  →  { ok: true } or 400 error
// Lets the join form check password + existence before redirecting.
app.post('/validate-join', (req, res) => {
  const { roomCode, password } = req.body;
  const room = rooms[roomCode?.toUpperCase()];
  if (!room)    return res.status(404).json({ error: 'Room not found' });
  if (room.password !== password) return res.status(403).json({ error: 'Wrong password' });
  res.json({ ok: true });
});

// Serve host/play pages; redirect with error if room is gone.
app.get('/host/:roomCode', (req, res) => {
  if (!rooms[req.params.roomCode.toUpperCase()])
    return res.redirect('/?error=room_not_found');
  res.sendFile(path.join(__dirname, 'public', 'host.html'));
});

app.get('/play/:roomCode', (req, res) => {
  if (!rooms[req.params.roomCode.toUpperCase()])
    return res.redirect('/?error=room_not_found');
  res.sendFile(path.join(__dirname, 'public', 'play.html'));
});

// ── Socket.io events ──────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  // Track which room this socket belongs to, and whether it is the host socket.
  let currentRoom = null;
  let isHost      = false;

  // ── Player joins a room ──────────────────────────────────────────────────
  socket.on('join_room', ({ roomCode, playerName, password }) => {
    roomCode = roomCode?.toUpperCase();
    const room = rooms[roomCode];
    if (!room)                  return socket.emit('error', { message: 'Room not found' });
    if (room.password !== password) return socket.emit('error', { message: 'Wrong password' });
    if (!playerName?.trim())    return socket.emit('error', { message: 'Name required' });

    currentRoom = roomCode;
    socket.join(roomCode);
    room.players[socket.id] = { name: playerName.trim(), score: 0 };

    console.log(`${playerName} joined room ${roomCode}`);
    broadcastState(roomCode);
  });

  // ── Host socket identifies itself (no password re-check — room was already created) ──
  socket.on('host_join', ({ roomCode }) => {
    roomCode = roomCode?.toUpperCase();
    const room = rooms[roomCode];
    if (!room) return socket.emit('error', { message: 'Room not found' });

    currentRoom = roomCode;
    isHost      = true;
    socket.join(roomCode);
    broadcastState(roomCode);
  });

  // ── Player buzzes ────────────────────────────────────────────────────────
  socket.on('buzz', ({ roomCode }) => {
    roomCode = roomCode?.toUpperCase();
    const room = rooms[roomCode];
    if (!room || room.buzzOrder.includes(socket.id)) return; // already buzzed → ignore

    room.buzzOrder.push(socket.id);
    broadcastState(roomCode);
  });

  // ── Host selects a player to answer ─────────────────────────────────────
  socket.on('host_select_player', ({ roomCode, socketId }) => {
    roomCode = roomCode?.toUpperCase();
    const room = rooms[roomCode];
    if (!room) return;

    room.answeringPlayer = socketId;
    room.timerEndsAt     = Date.now() + 60_000; // 60-second countdown
    broadcastState(roomCode);
  });

  // ── Host resets the buzzer ───────────────────────────────────────────────
  socket.on('host_reset_buzzer', ({ roomCode }) => {
    roomCode = roomCode?.toUpperCase();
    const room = rooms[roomCode];
    if (!room) return;

    room.buzzOrder       = [];
    room.answeringPlayer = null;
    room.timerEndsAt     = null;
    broadcastState(roomCode);
  });

  // ── Host updates a player's score ────────────────────────────────────────
  socket.on('host_update_score', ({ roomCode, socketId, newScore }) => {
    roomCode = roomCode?.toUpperCase();
    const room = rooms[roomCode];
    if (!room || !room.players[socketId]) return;

    room.players[socketId].score = parseInt(newScore, 10) || 0;
    broadcastState(roomCode);
  });

  // ── Disconnect cleanup ───────────────────────────────────────────────────
  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const room = rooms[currentRoom];
    if (!room) return;

    if (!isHost) {
      // Remove player from state
      delete room.players[socket.id];
      room.buzzOrder = room.buzzOrder.filter(id => id !== socket.id);
      if (room.answeringPlayer === socket.id) {
        room.answeringPlayer = null;
        room.timerEndsAt     = null;
      }
      broadcastState(currentRoom);
    }

    // Delete the room if no sockets remain (host left or last player left)
    const sockets = io.sockets.adapter.rooms.get(currentRoom);
    if (!sockets || sockets.size === 0) {
      console.log(`Room ${currentRoom} deleted (all sockets gone)`);
      delete rooms[currentRoom];
    }
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Jeopardy Buzzer running on http://localhost:${PORT}`));

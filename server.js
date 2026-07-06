// Jeopardy Buzzer — backend
// Stack: Express (HTTP routes) + Socket.io (real-time events)
// All room state lives in memory; rooms vanish on server restart (acceptable).

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');
const imposterGame = require('./imposter-game');
const rps9Game = require('./rps9-game');

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
//   mode: 'buzzer' | 'wordle' | 'imposter', // set at creation, never changes
//   hostSocketId: socketId | null, // the host's current socket — also used to authorize host-only actions
//   players: { socketId: { name, score, color } },  // color is a "#RRGGBB" hex string
//   buzzOrder: [socketId, ...],   // oldest first
//   answeringPlayer: socketId | null,
//   timerEndsAt: epoch-ms | null,
//   wordle: {                      // present only when mode === 'wordle'
//     word: "STRING" | null,       // uppercase secret word; null = not pushed yet
//     pushed: bool,
//     guesses: { socketId: [ { guess, result: ["correct"|"present"|"absent", ...] } ] },
//     solved: { socketId: true },
//   },
//   imposterSettings / imposterRound: present only when mode === 'imposter' — see imposter-game.js
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
// This is the only uniform broadcast function — keeps the state machine simple.
// (Wordle mode needs per-recipient visibility, so it has its own broadcaster below.)
function broadcastState(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  io.to(roomCode).emit('room_state', {
    players:         room.players,
    buzzOrder:       room.buzzOrder,
    answeringPlayer: room.answeringPlayer,
    timerEndsAt:     room.timerEndsAt,
    hostName:        room.hostName,
    mode:            room.mode,
    serverNow:       Date.now(),
  });
}

// Score a Wordle guess against the secret word using the standard two-pass
// algorithm — this correctly handles repeated letters (e.g. secret "SPEED"
// vs guess "ERASE": both E's come back "present" because SPEED has two E's
// to give out). Pass 1 must fully finish (all exact matches found and
// removed from the letter pool) before pass 2 starts, or duplicate-letter
// cases score incorrectly.
function scoreGuess(secret, guess) {
  const len = secret.length;
  const result = new Array(len).fill('absent');
  const freq = {};
  for (const ch of secret) freq[ch] = (freq[ch] || 0) + 1;

  for (let i = 0; i < len; i++) {           // pass 1: exact position matches
    if (guess[i] === secret[i]) {
      result[i] = 'correct';
      freq[guess[i]]--;
    }
  }
  for (let i = 0; i < len; i++) {           // pass 2: right letter, wrong spot
    if (result[i] === 'correct') continue;
    if (freq[guess[i]] > 0) {
      result[i] = 'present';
      freq[guess[i]]--;
    }
  }
  return result;
}

// Wordle state is visibility-restricted per recipient — the host sees every
// board, but a player only ever sees their own board. Nothing about another
// player (their guesses, their letters, or even whether they've solved it)
// reaches a player's client until the host reveals, at which point everyone
// gets the secret word plus a name-only "solved by" list — never anyone
// else's actual guesses. Unlike broadcastState this sends a different
// payload to each socket; io.to(oneSocketId) works because Socket.io
// auto-joins every socket to a private room named after its own id.
function broadcastWordleState(roomCode) {
  const room = rooms[roomCode];
  if (!room || room.mode !== 'wordle') return;
  const w = room.wordle;

  // Only populated once revealed — before that, no player ever learns
  // anything about who else has (or hasn't) solved it.
  const solvedList = w.revealed
    ? Object.keys(w.solved)
        .filter(id => w.solved[id] && room.players[id])
        .map(id => ({ id, name: room.players[id].name, color: room.players[id].color, attempts: (w.guesses[id] || []).length }))
    : [];

  if (room.hostSocketId) {
    const allBoards = {};
    for (const id of Object.keys(room.players)) {
      allBoards[id] = {
        name:    room.players[id].name,
        color:   room.players[id].color,
        guesses: w.guesses[id] || [],
        solved:  !!w.solved[id],
      };
    }
    io.to(room.hostSocketId).emit('wordle_state', {
      pushed:     w.pushed,
      wordLength: w.word ? w.word.length : null,
      revealed:   w.revealed,
      allBoards,
    });
  }

  for (const id of Object.keys(room.players)) {
    io.to(id).emit('wordle_state', {
      pushed:      w.pushed,
      wordLength:  w.word ? w.word.length : null,
      myGuesses:   w.guesses[id] || [],
      mySolved:    !!w.solved[id],
      revealed:    w.revealed,
      word:        w.revealed ? w.word : null,
      solvedList,
    });
  }
}

// ── HTTP routes ───────────────────────────────────────────────────────────────

// POST /create-room  →  { roomCode }
// Called from the landing page "Create Game" form.
app.post('/create-room', (req, res) => {
  const { hostName, password, mode } = req.body;
  if (!hostName || !password)
    return res.status(400).json({ error: 'hostName and password are required' });

  const code = generateRoomCode();
  rooms[code] = {
    code,
    password,
    hostName,
    mode:            mode === 'wordle' ? 'wordle' : mode === 'imposter' ? 'imposter' : mode === 'rps9' ? 'rps9' : 'buzzer',
    hostSocketId:    null,
    players:         {},
    buzzOrder:       [],
    answeringPlayer: null,
    timerEndsAt:     null,
  };
  if (rooms[code].mode === 'wordle') {
    rooms[code].wordle = { word: null, pushed: false, guesses: {}, solved: {}, revealed: false };
  }
  if (rooms[code].mode === 'imposter') {
    Object.assign(rooms[code], imposterGame.createImposterRoomState());
  }
  if (rooms[code].mode === 'rps9') {
    Object.assign(rooms[code], rps9Game.createRps9RoomState());
  }

  console.log(`Room created: ${code} by ${hostName} (${rooms[code].mode} mode)`);
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
  socket.on('join_room', ({ roomCode, playerName, password, color }) => {
    roomCode = roomCode?.toUpperCase();
    const room = rooms[roomCode];
    if (!room)                  return socket.emit('error', { message: 'Room not found' });
    if (room.password !== password) return socket.emit('error', { message: 'Wrong password' });
    if (!playerName?.trim())    return socket.emit('error', { message: 'Name required' });
    if (room.mode === 'rps9' && Object.keys(room.players).length >= rps9Game.MAX_PLAYERS)
      return socket.emit('error', { message: `This room is full (${rps9Game.MAX_PLAYERS} players max)` });

    // Name color is chosen once, in the join form — fall back to the default if missing/invalid
    const nameColor = /^#[0-9A-Fa-f]{6}$/.test(color || '') ? color : '#E8EAF0';

    currentRoom = roomCode;
    socket.join(roomCode);
    room.players[socket.id] = { name: playerName.trim(), score: 0, color: nameColor };

    console.log(`${playerName} joined room ${roomCode}`);
    broadcastState(roomCode);
    if (room.mode === 'wordle')   broadcastWordleState(roomCode);
    if (room.mode === 'imposter') imposterGame.broadcastImposterState(io, rooms, roomCode);
    if (room.mode === 'rps9')     rps9Game.broadcastRps9State(io, rooms, roomCode);
  });

  // ── Host socket identifies itself (no password re-check — room was already created) ──
  socket.on('host_join', ({ roomCode }) => {
    roomCode = roomCode?.toUpperCase();
    const room = rooms[roomCode];
    if (!room) return socket.emit('error', { message: 'Room not found' });

    currentRoom = roomCode;
    isHost      = true;
    room.hostSocketId = socket.id; // self-heals on host page refresh — new socket just overwrites the old id
    socket.join(roomCode);
    broadcastState(roomCode);
    if (room.mode === 'wordle')   broadcastWordleState(roomCode);
    if (room.mode === 'imposter') imposterGame.broadcastImposterState(io, rooms, roomCode);
    if (room.mode === 'rps9')     rps9Game.broadcastRps9State(io, rooms, roomCode);
  });

  // ── Sus (Imposter) mode — all handlers live in imposter-game.js ─────────
  imposterGame.registerSocketHandlers(io, socket, rooms);
  rps9Game.registerSocketHandlers(io, socket, rooms);

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

  // ── Host unselects the current answering player (keeps buzz order intact) ──
  socket.on('host_unselect_player', ({ roomCode }) => {
    roomCode = roomCode?.toUpperCase();
    const room = rooms[roomCode];
    if (!room) return;

    room.answeringPlayer = null;
    room.timerEndsAt     = null;
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

    let parsedScore = parseFloat(newScore);
    if (isNaN(parsedScore)) parsedScore = 0;
    if (room.mode === 'rps9') parsedScore = Math.max(0, parsedScore); // RPS9 scores never go negative
    room.players[socketId].score = parsedScore;
    broadcastState(roomCode);
    if (room.mode === 'imposter') imposterGame.broadcastImposterState(io, rooms, roomCode);
    if (room.mode === 'rps9')     rps9Game.broadcastRps9State(io, rooms, roomCode);
  });

  // ── Host pushes the secret word live — starts a fresh round ─────────────
  socket.on('wordle_push_word', ({ roomCode, word }) => {
    roomCode = roomCode?.toUpperCase();
    const room = rooms[roomCode];
    if (!room || room.mode !== 'wordle' || socket.id !== room.hostSocketId) return;

    const cleaned = String(word || '').trim().toUpperCase().replace(/[^A-Z]/g, '');
    if (!cleaned) return;

    room.wordle.word     = cleaned;
    room.wordle.pushed   = true;
    room.wordle.guesses  = {};
    room.wordle.solved   = {};
    room.wordle.revealed = false;
    broadcastWordleState(roomCode);
  });

  // ── Host unpushes: clears the word back to an editable state ─────────────
  socket.on('wordle_unpush_word', ({ roomCode }) => {
    roomCode = roomCode?.toUpperCase();
    const room = rooms[roomCode];
    if (!room || room.mode !== 'wordle' || socket.id !== room.hostSocketId) return;

    room.wordle.word     = null;
    room.wordle.pushed   = false;
    room.wordle.guesses  = {};
    room.wordle.solved   = {};
    room.wordle.revealed = false;
    broadcastWordleState(roomCode);
  });

  // ── Host resets all players' boards but keeps the same word active ──────
  socket.on('wordle_reset_players', ({ roomCode }) => {
    roomCode = roomCode?.toUpperCase();
    const room = rooms[roomCode];
    if (!room || room.mode !== 'wordle' || socket.id !== room.hostSocketId) return;

    room.wordle.guesses  = {};
    room.wordle.solved   = {};
    room.wordle.revealed = false;
    broadcastWordleState(roomCode);
  });

  // ── Host reveals the word — shows it (and who solved it) to every player,
  // and locks further guessing. Nothing about other players is ever visible
  // to players before this point.
  socket.on('wordle_reveal', ({ roomCode }) => {
    roomCode = roomCode?.toUpperCase();
    const room = rooms[roomCode];
    if (!room || room.mode !== 'wordle' || socket.id !== room.hostSocketId) return;
    if (!room.wordle.pushed || room.wordle.revealed) return;

    room.wordle.revealed = true;
    broadcastWordleState(roomCode);
  });

  // ── Player submits a guess ────────────────────────────────────────────────
  socket.on('wordle_guess', ({ roomCode, guess }) => {
    roomCode = roomCode?.toUpperCase();
    const room = rooms[roomCode];
    if (!room || room.mode !== 'wordle' || !room.wordle.pushed || room.wordle.revealed) return;
    if (!room.players[socket.id] || room.wordle.solved[socket.id]) return;

    const cleaned = String(guess || '').trim().toUpperCase().replace(/[^A-Z]/g, '');
    const secret  = room.wordle.word;
    if (!secret || cleaned.length !== secret.length) return;

    const result = scoreGuess(secret, cleaned);
    if (!room.wordle.guesses[socket.id]) room.wordle.guesses[socket.id] = [];
    room.wordle.guesses[socket.id].push({ guess: cleaned, result });

    if (cleaned === secret) room.wordle.solved[socket.id] = true;

    broadcastWordleState(roomCode);
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
      if (room.mode === 'wordle' && room.wordle) {
        delete room.wordle.guesses[socket.id];
        delete room.wordle.solved[socket.id];
      }
      if (room.mode === 'imposter') imposterGame.handleDisconnect(io, rooms, currentRoom, socket.id);
      if (room.mode === 'rps9')     rps9Game.handleDisconnect(io, rooms, currentRoom, socket.id);
      broadcastState(currentRoom);
      if (room.mode === 'wordle') broadcastWordleState(currentRoom);
    }

    // Delete the room if no sockets remain (host left or last player left)
    const sockets = io.sockets.adapter.rooms.get(currentRoom);
    if (!sockets || sockets.size === 0) {
      console.log(`Room ${currentRoom} deleted (all sockets gone)`);
      delete rooms[currentRoom];
      imposterGame.clearRoomTimer(currentRoom); // harmless no-op for non-imposter rooms
    }
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Jeopardy Buzzer running on http://localhost:${PORT}`));

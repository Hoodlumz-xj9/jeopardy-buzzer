// RPS9 (nine-item Rock Paper Scissors) — backend
// One flat CommonJS module, required directly by server.js — same shape as imposter-game.js.
// Free-for-all: every connected player picks each round; the server resolves every
// pairwise matchup and each player scores 1 point per opponent beaten that round.

const MAX_PLAYERS = 6;
const MIN_PLAYERS = 2;

// ── Rules table — verified elsewhere, used verbatim. Do not re-derive at runtime. ──

const ITEMS = [
  'rock', 'wizard', 'scissors', 'dragon', 'lizard',
  'paper', 'supernova', 'spock', 'time',
];

const BEATS = {
  rock:      ['wizard', 'scissors', 'dragon', 'lizard'],
  wizard:    ['scissors', 'dragon', 'lizard', 'paper'],
  scissors:  ['dragon', 'lizard', 'paper', 'supernova'],
  dragon:    ['lizard', 'paper', 'supernova', 'spock'],
  lizard:    ['paper', 'supernova', 'spock', 'time'],
  paper:     ['supernova', 'spock', 'time', 'rock'],
  supernova: ['spock', 'time', 'rock', 'wizard'],
  spock:     ['time', 'rock', 'wizard', 'scissors'],
  time:      ['rock', 'wizard', 'scissors', 'dragon'],
};

// Flavor text for the 18 "signature" matchups (10 classic + 8 introduced by the new
// items). Any matchup not listed here falls back to a generic "<Winner> beats <loser>."
const FLAVOR = {
  'scissors>paper':     "Scissors cuts Paper.",
  'paper>rock':         "Paper covers Rock.",
  'rock>lizard':        "Rock crushes Lizard.",
  'lizard>spock':       "Lizard poisons Spock.",
  'spock>scissors':     "Spock smashes Scissors.",
  'scissors>lizard':    "Scissors decapitates Lizard.",
  'lizard>paper':       "Lizard eats Paper.",
  'paper>spock':        "Paper disproves Spock.",
  'spock>rock':         "Spock vaporizes Rock.",
  'rock>scissors':      "Rock crushes Scissors.",
  'rock>wizard':        "Rock buries the Wizard's spellbook before he finishes the incantation.",
  'wizard>scissors':    "Wizard snaps his fingers and turns Scissors into confetti.",
  'scissors>dragon':    "Scissors clips a hole in the Dragon's wing before it takes off.",
  'dragon>lizard':      "Dragon swallows the Lizard whole, professional reptile courtesy be damned.",
  'paper>supernova':    "Paper survives the Supernova by hiding in a fireproof archive.",
  'supernova>spock':    "Supernova fries Spock's logic circuits before he can log the reading.",
  'spock>time':         "Spock calmly predicts every move Time will make, three steps ahead.",
  'time>rock':          "Time erodes Rock down to sand — patience beats everything eventually.",
};

function resolveRound(pickA, pickB) {
  if (!ITEMS.includes(pickA) || !ITEMS.includes(pickB)) {
    throw new Error(`Invalid pick: ${pickA} or ${pickB}`);
  }
  if (pickA === pickB) {
    return { result: 'tie', pickA, pickB };
  }
  const aWins = BEATS[pickA].includes(pickB);
  const winner = aWins ? pickA : pickB;
  const loser = aWins ? pickB : pickA;
  const key = `${winner}>${loser}`;
  const flavor = FLAVOR[key] ||
    `${winner[0].toUpperCase()}${winner.slice(1)} beats ${loser}.`;
  return { result: aWins ? 'a' : 'b', winner, loser, flavor };
}

// ── Room state ──────────────────────────────────────────────────────────────

function createRps9RoomState() {
  return {
    rps9Round: {
      phase: 'waiting', // 'waiting' | 'picking' | 'results'
      roundNumber: 1,
      picks: {},        // socketId -> item; cleared at the start of each picking phase
      lastResults: null,
    },
  };
}

function connectedCount(room) {
  return Object.keys(room.players).length;
}

// Every unordered pair among the players who picked this round.
function allPairs(ids) {
  const pairs = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      pairs.push([ids[i], ids[j]]);
    }
  }
  return pairs;
}

// The one place that flips 'picking' -> 'results'. Called from both the pick handler
// (once everyone connected has picked) and disconnect handling (if the now-smaller
// pool means everyone remaining has already picked).
function resolveRps9Round(room) {
  const r = room.rps9Round;
  const pickerIds = Object.keys(r.picks);
  const pointsGained = {};
  const matchups = [];

  for (const [aId, bId] of allPairs(pickerIds)) {
    const aPick = r.picks[aId];
    const bPick = r.picks[bId];
    const outcome = resolveRound(aPick, bPick);
    const aName = room.players[aId]?.name || '?';
    const bName = room.players[bId]?.name || '?';

    if (outcome.result === 'tie') {
      matchups.push({ aId, bId, aName, bName, aPick, bPick, result: 'tie' });
      continue;
    }

    const winnerId = outcome.winner === aPick ? aId : bId;
    const loserId  = outcome.winner === aPick ? bId : aId;
    room.players[winnerId].score = (room.players[winnerId].score || 0) + 1;
    pointsGained[winnerId] = (pointsGained[winnerId] || 0) + 1;
    matchups.push({
      aId, bId, aName, bName, aPick, bPick,
      result: winnerId === aId ? 'a' : 'b',
      winnerId, loserId, flavor: outcome.flavor,
    });
  }

  const allTied = pickerIds.length > 1 && new Set(pickerIds.map(id => r.picks[id])).size === 1;

  r.lastResults = { allTied, matchups, pointsGained };
  r.phase = 'results';
}

// Re-check whether the (possibly now smaller) pool of connected players means every
// remaining player has picked — used after a disconnect during 'picking'.
function maybeResolveAfterDisconnect(room) {
  const r = room.rps9Round;
  const ids = Object.keys(room.players);
  if (ids.length >= MIN_PLAYERS && ids.every(id => r.picks[id] !== undefined)) {
    resolveRps9Round(room);
  }
}

// ── Broadcast ───────────────────────────────────────────────────────────────

function broadcastRps9State(io, rooms, roomCode) {
  const room = rooms[roomCode];
  if (!room || room.mode !== 'rps9') return;
  const r = room.rps9Round;

  io.to(roomCode).emit('rps9_room_state', {
    phase: r.phase,
    roundNumber: r.roundNumber,
    pickedCount: Object.keys(r.picks).length,
    totalConnectedPlayers: connectedCount(room),
    minPlayersNeeded: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    players: room.players,
    hostName: room.hostName,
    lastResults: r.phase === 'results' ? r.lastResults : null,
    items: ITEMS,
  });
}

// ── Socket handlers ─────────────────────────────────────────────────────────

function registerSocketHandlers(io, socket, rooms) {
  socket.on('start_rps9_round', ({ roomCode }) => {
    roomCode = roomCode?.toUpperCase();
    const room = rooms[roomCode];
    if (!room || room.mode !== 'rps9') return;
    if (room.hostSocketId !== socket.id) return;
    const r = room.rps9Round;
    if (r.phase !== 'waiting') return;
    if (connectedCount(room) < MIN_PLAYERS) return;

    r.picks = {};
    r.phase = 'picking';
    broadcastRps9State(io, rooms, roomCode);
  });

  socket.on('rps9_pick', ({ roomCode, choice }) => {
    roomCode = roomCode?.toUpperCase();
    const room = rooms[roomCode];
    if (!room || room.mode !== 'rps9') return;
    if (!room.players[socket.id]) return;
    const r = room.rps9Round;
    if (r.phase !== 'picking') return;
    if (!ITEMS.includes(choice)) return;

    r.picks[socket.id] = choice;

    const ids = Object.keys(room.players);
    if (ids.length >= MIN_PLAYERS && ids.every(id => r.picks[id] !== undefined)) {
      resolveRps9Round(room);
    }
    broadcastRps9State(io, rooms, roomCode);
  });

  socket.on('next_rps9_round', ({ roomCode }) => {
    roomCode = roomCode?.toUpperCase();
    const room = rooms[roomCode];
    if (!room || room.mode !== 'rps9') return;
    if (room.hostSocketId !== socket.id) return;
    const r = room.rps9Round;
    if (r.phase !== 'results') return;

    r.picks = {};
    r.lastResults = null;
    r.roundNumber += 1;
    r.phase = 'picking';
    broadcastRps9State(io, rooms, roomCode);
  });

  socket.on('cancel_rps9_round', ({ roomCode }) => {
    roomCode = roomCode?.toUpperCase();
    const room = rooms[roomCode];
    if (!room || room.mode !== 'rps9') return;
    if (room.hostSocketId !== socket.id) return;
    const r = room.rps9Round;
    if (r.phase !== 'picking') return;

    r.picks = {};
    r.phase = 'waiting';
    broadcastRps9State(io, rooms, roomCode);
  });

  socket.on('rps9_reset_scores', ({ roomCode }) => {
    roomCode = roomCode?.toUpperCase();
    const room = rooms[roomCode];
    if (!room || room.mode !== 'rps9') return;
    if (room.hostSocketId !== socket.id) return;

    for (const id of Object.keys(room.players)) room.players[id].score = 0;
    broadcastRps9State(io, rooms, roomCode);
  });
}

// ── Disconnect handling ──────────────────────────────────────────────────────
// Called after the player has already been removed from room.players by server.js's
// generic disconnect handler — just clean up their buffered pick and re-check.
function handleDisconnect(io, rooms, roomCode, socketId) {
  const room = rooms[roomCode];
  if (!room || room.mode !== 'rps9') return;
  const r = room.rps9Round;
  if (r.phase !== 'picking') return;

  delete r.picks[socketId];
  maybeResolveAfterDisconnect(room);
  broadcastRps9State(io, rooms, roomCode);
}

module.exports = {
  MAX_PLAYERS,
  MIN_PLAYERS,
  ITEMS,
  BEATS,
  FLAVOR,
  resolveRound,
  createRps9RoomState,
  registerSocketHandlers,
  broadcastRps9State,
  handleDisconnect,
};

// Dice roller mode — backend
// No setup, no phases, no rounds: as soon as the room exists, the host and every
// player can roll any combination of the seven standard D&D dice at any time.
// Results are server-rolled (never trust a client-supplied result) and appended
// to a shared running log. The only host-specific behavior is a visibility
// toggle: while it's off, the host's own rolls still land in their own log in
// full, but every player instead sees a redacted "rolled privately" stub —
// same shape as a GM rolling behind a screen.

const DICE_TYPES = ['d4', 'd6', 'd8', 'd10', 'd12', 'd20', 'd100'];
const DICE_SIDES  = { d4: 4, d6: 6, d8: 8, d10: 10, d12: 12, d20: 20, d100: 100 };

const MAX_PER_TYPE   = 20;  // per die type, per roll
const MAX_TOTAL_DICE = 50;  // across all types, per roll — spam/abuse guard
const MAX_LOG_ENTRIES = 100; // rooms are memory-only; cap so a long session can't grow unbounded

function createDiceRoomState() {
  return {
    diceRoom: {
      hostRollsVisible: true, // toggled by the host; applies to rolls made from this point forward, not retroactively
      log: [],                // newest last; capped at MAX_LOG_ENTRIES
      nextId: 1,
    },
  };
}

function rollOne(sides) {
  return 1 + Math.floor(Math.random() * sides);
}

// ── Broadcast ───────────────────────────────────────────────────────────────
// Per-recipient like broadcastWordleState: the host always sees every roll in
// full (including their own hidden ones, so they know what they rolled), but
// players never receive the dice/results/total of a hidden host roll — only
// enough to know a roll happened.
function broadcastDiceState(io, rooms, roomCode) {
  const room = rooms[roomCode];
  if (!room || room.mode !== 'dice') return;
  const d = room.diceRoom;

  if (room.hostSocketId) {
    io.to(room.hostSocketId).emit('dice_state', {
      hostRollsVisible: d.hostRollsVisible,
      log: d.log,
    });
  }

  const redactedLog = d.log.map(entry => entry.hidden
    ? { id: entry.id, socketId: entry.socketId, name: entry.name, isHost: true, hidden: true, rolledAt: entry.rolledAt }
    : entry);
  for (const id of Object.keys(room.players)) {
    io.to(id).emit('dice_state', { hostRollsVisible: d.hostRollsVisible, log: redactedLog });
  }
}

// ── Socket handlers ──────────────────────────────────────────────────────────

function registerSocketHandlers(io, socket, rooms) {

  socket.on('dice_roll', ({ roomCode, dice }) => {
    roomCode = roomCode?.toUpperCase();
    const room = rooms[roomCode];
    if (!room || room.mode !== 'dice') return;

    // The host has no entry in room.players (it's tracked separately via
    // hostSocketId), so it must be checked as its own case rather than folded
    // into the player lookup below.
    const isHost = socket.id === room.hostSocketId;
    const player = room.players[socket.id];
    if (!isHost && !player) return;
    if (!dice || typeof dice !== 'object') return;

    const cleaned = {};
    let totalDiceCount = 0;
    for (const type of DICE_TYPES) {
      const n = parseInt(dice[type], 10);
      if (!Number.isFinite(n) || n <= 0) continue;
      const clamped = Math.min(MAX_PER_TYPE, n);
      cleaned[type] = clamped;
      totalDiceCount += clamped;
    }
    if (totalDiceCount === 0 || totalDiceCount > MAX_TOTAL_DICE) return;

    const results = {};
    let total = 0;
    for (const [type, count] of Object.entries(cleaned)) {
      const sides = DICE_SIDES[type];
      const rolls = Array.from({ length: count }, () => rollOne(sides));
      results[type] = rolls;
      total += rolls.reduce((sum, r) => sum + r, 0);
    }

    const d = room.diceRoom;
    const entry = {
      id: d.nextId++,
      socketId: socket.id,
      name: isHost ? room.hostName : player.name,
      color: isHost ? null : player.color, // the host has no chosen name color — client falls back to the gold accent
      isHost,
      hidden: isHost && !d.hostRollsVisible,
      dice: cleaned,
      results,
      total,
      rolledAt: Date.now(),
    };
    d.log.push(entry);
    if (d.log.length > MAX_LOG_ENTRIES) d.log.shift();

    broadcastDiceState(io, rooms, roomCode);
  });

  socket.on('dice_set_host_visibility', ({ roomCode, visible }) => {
    roomCode = roomCode?.toUpperCase();
    const room = rooms[roomCode];
    if (!room || room.mode !== 'dice' || socket.id !== room.hostSocketId) return;

    room.diceRoom.hostRollsVisible = !!visible;
    broadcastDiceState(io, rooms, roomCode);
  });
}

module.exports = {
  DICE_TYPES,
  DICE_SIDES,
  createDiceRoomState,
  registerSocketHandlers,
  broadcastDiceState,
};

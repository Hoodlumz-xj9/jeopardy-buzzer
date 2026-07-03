// Sus (Imposter) mode — social deduction game.
// One player secretly gets a different discussion prompt and does not know
// they're the imposter; the group votes on who it is; scoring is automatic.
// This is the first mode where the server itself must act on a timeout —
// buzzer/wordle timers are purely client-side displays of a timestamp the
// host set once, but discussion and voting here must advance on their own
// even if nobody in the room sends another event.

// ── Timer bookkeeping ──────────────────────────────────────────────────────
// At most one active phase-timer per room. clearRoomTimer is called as the
// first action of every function that advances a phase away from
// 'discussing' or 'voting', regardless of which trigger reached it — that's
// what prevents a superseded timer from firing again later and corrupting a
// later round.
const activeTimers = new Map(); // roomCode -> { phase, handle }

function clearRoomTimer(roomCode) {
  const entry = activeTimers.get(roomCode);
  if (entry) {
    clearTimeout(entry.handle);
    activeTimers.delete(roomCode);
  }
}

function schedulePhaseTimer(roomCode, phase, delayMs, onFire) {
  clearRoomTimer(roomCode);
  const handle = setTimeout(() => {
    activeTimers.delete(roomCode); // consume the slot before running the callback
    onFire();
  }, delayMs);
  activeTimers.set(roomCode, { phase, handle });
}

// ── State shape ──────────────────────────────────────────────────────────

function createImposterRoomState() {
  return {
    imposterSettings: {
      promptSetterMode: 'host_fixed', // 'host_fixed' | 'rotating'
      discussionDurationSeconds: 180,
      votingDurationSeconds: 45,
      imposterPointsPerMiss: 1,
      correctGuessPoints: 1,
    },
    imposterRound: {
      // '_results_pending' is an internal-only sentinel (see advanceToResults)
      // never sent to clients as-is — broadcastImposterState translates it
      // back to 'voting' so the client keeps showing the countdown/waiting
      // view through the brief reveal pause.
      phase: 'waiting', // waiting | prompt_setting | discussing | voting | _results_pending | results
      promptSetter: null,        // socketId, or null when host_fixed (host sets prompts)
      mainPrompt: '',
      imposterPrompt: '',
      imposter: null,             // socketId — never broadcast to the room, only revealed in imposter_results
      imposterName: '',           // captured at selection time, in case the imposter disconnects before results
      discussionEndsAt: null,
      votingEndsAt: null,
      votes: {},                  // { voterSocketId: votedForSocketId }
      roundNumber: 1,
      promptSetterHistory: [],    // rotating-mode fairness; persists across rounds
      eligiblePlayerIds: [],      // frozen snapshot of room.players at round start
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────

// Players who were present when this round started AND are still connected.
// Every consumer (imposter draw, vote targets, all-voted check, scoring)
// reads this instead of the raw snapshot or room.players directly — this one
// function is what makes every disconnect rule apply automatically, without
// needing separate cleanup logic scattered through the round handlers.
function liveEligiblePlayerIds(room) {
  return room.imposterRound.eligiblePlayerIds.filter(id => room.players[id]);
}

function minPlayersNeeded(room) {
  return room.imposterSettings.promptSetterMode === 'rotating' ? 3 : 2;
}

function pickPromptSetter(room) {
  if (room.imposterSettings.promptSetterMode !== 'rotating') return null; // host_fixed: host sets prompts, not a players{} id
  const connected = Object.keys(room.players);
  let pool = connected.filter(id => !room.imposterRound.promptSetterHistory.includes(id));
  if (pool.length === 0) {
    room.imposterRound.promptSetterHistory = []; // everyone's had a turn — reset and draw from the full pool
    pool = connected;
  }
  return pool[Math.floor(Math.random() * pool.length)];
}

function resolveSetterName(room) {
  const setterId = room.imposterRound.promptSetter;
  if (!setterId) return room.hostName;
  return room.players[setterId]?.name || 'Unknown';
}

// Resolves a display name even if the player has since disconnected — the
// only id that can outlive room.players within a round is the imposter's,
// whose name is captured up front specifically so RESULTS can still name
// them correctly.
function resolvePlayerName(room, id) {
  if (room.players[id]) return room.players[id].name;
  if (id === room.imposterRound.imposter) return room.imposterRound.imposterName || 'Unknown';
  return 'Unknown';
}

function resetRoundFields(r) {
  r.promptSetter = null;
  r.mainPrompt = '';
  r.imposterPrompt = '';
  r.imposter = null;
  r.imposterName = '';
  r.votes = {};
  r.discussionEndsAt = null;
  r.votingEndsAt = null;
  r.eligiblePlayerIds = [];
}

// ── Broadcasts ───────────────────────────────────────────────────────────

function broadcastImposterState(io, rooms, roomCode) {
  const room = rooms[roomCode];
  if (!room || room.mode !== 'imposter') return;
  const r = room.imposterRound;
  const eligible = liveEligiblePlayerIds(room);

  io.to(roomCode).emit('imposter_room_state', {
    phase: r.phase === '_results_pending' ? 'voting' : r.phase,
    promptSetter: r.promptSetter,
    promptSetterName: resolveSetterName(room),
    discussionEndsAt: r.discussionEndsAt,
    votingEndsAt: r.votingEndsAt,
    votesCastCount: eligible.filter(id => r.votes[id]).length,
    totalConnectedPlayers: eligible.length,
    eligiblePlayerIds: eligible, // who's actually part of this round — a mid-round joiner won't be in here
    players: room.players,
    settings: room.imposterSettings,
    roundNumber: r.roundNumber,
    hostName: room.hostName,
    minPlayersNeeded: minPlayersNeeded(room),
    serverNow: Date.now(),
    // Deliberately excluded: imposter, imposterName, mainPrompt, imposterPrompt.
  });

  // Host-only moderation aid during discussion: who currently has which
  // prompt. Targeted emit only, never folded into the broadcast above.
  if (room.hostSocketId && r.phase === 'discussing') {
    const promptsByPlayer = {};
    for (const id of eligible) {
      promptsByPlayer[id] = {
        name: room.players[id].name,
        prompt: id === r.imposter ? r.imposterPrompt : r.mainPrompt,
        isImposter: id === r.imposter,
      };
    }
    io.to(room.hostSocketId).emit('imposter_host_prompts', { promptsByPlayer });
  }
}

function sendYourPrompt(io, room, playerSocketId) {
  const r = room.imposterRound;
  const prompt = playerSocketId === r.imposter ? r.imposterPrompt : r.mainPrompt;
  io.to(playerSocketId).emit('imposter_your_prompt', { prompt });
}

// ── Phase transitions ────────────────────────────────────────────────────
// Both triggers for each transition (timer firing vs. host/player action)
// call the same shared function below, so there is exactly one place that
// clears the superseded timer and one place that guards against a stale
// callback acting on a phase that's already moved on.

function advanceToVoting(io, rooms, roomCode) {
  const room = rooms[roomCode];
  if (!room || room.mode !== 'imposter' || room.imposterRound.phase !== 'discussing') return;
  clearRoomTimer(roomCode);

  const r = room.imposterRound;
  r.phase = 'voting';
  r.votes = {};
  r.votingEndsAt = Date.now() + room.imposterSettings.votingDurationSeconds * 1000;

  schedulePhaseTimer(roomCode, 'voting', room.imposterSettings.votingDurationSeconds * 1000, () => {
    advanceToResults(io, rooms, roomCode);
  });

  broadcastImposterState(io, rooms, roomCode);
}

function advanceToResults(io, rooms, roomCode) {
  const room = rooms[roomCode];
  if (!room || room.mode !== 'imposter' || room.imposterRound.phase !== 'voting') return; // already advanced elsewhere — no-op
  clearRoomTimer(roomCode);

  const r = room.imposterRound;
  const eligible = liveEligiblePlayerIds(room);

  // Flip the internal phase away from 'voting' immediately (synchronously),
  // before the reveal pause below — this closes a real race where a vote
  // already in flight over the network could otherwise land during the
  // 2s pause and be silently ignored by the scoring already computed here.
  // broadcastImposterState translates this sentinel back to 'voting' for
  // clients, so the countdown/waiting view keeps rendering through the pause.
  r.phase = '_results_pending';

  const scoreChanges = {};
  let missCount = 0;
  const voteBreakdown = eligible.map(id => {
    const votedFor = r.votes[id] || null;
    if (votedFor === r.imposter) {
      room.players[id].score += room.imposterSettings.correctGuessPoints;
      scoreChanges[id] = (scoreChanges[id] || 0) + room.imposterSettings.correctGuessPoints;
    } else {
      missCount++;
    }
    return {
      voterId: id,
      voterName: room.players[id].name,
      votedFor,
      votedForName: votedFor ? resolvePlayerName(room, votedFor) : null,
    };
  });

  if (room.players[r.imposter]) {
    room.players[r.imposter].score += room.imposterSettings.imposterPointsPerMiss * missCount;
    scoreChanges[r.imposter] = (scoreChanges[r.imposter] || 0) + room.imposterSettings.imposterPointsPerMiss * missCount;
  }

  if (r.promptSetter) r.promptSetterHistory.push(r.promptSetter); // host_fixed rounds have no player to record

  const resultsPayload = {
    imposter: r.imposter,
    imposterName: r.imposterName,
    mainPrompt: r.mainPrompt,
    imposterPrompt: r.imposterPrompt,
    voteBreakdown,
    scoreChanges,
    players: room.players,
  };

  setTimeout(() => {
    const room2 = rooms[roomCode];
    if (!room2 || room2.mode !== 'imposter') return;
    room2.imposterRound.phase = 'results';
    io.to(roomCode).emit('imposter_results', resultsPayload);
    broadcastImposterState(io, rooms, roomCode);
  }, 2000); // brief "time's up! / all votes in!" beat before the reveal
}

// ── Socket handlers ──────────────────────────────────────────────────────

function registerSocketHandlers(io, socket, rooms) {

  socket.on('start_imposter_round', ({ roomCode }) => {
    roomCode = roomCode?.toUpperCase();
    const room = rooms[roomCode];
    if (!room || room.mode !== 'imposter' || socket.id !== room.hostSocketId) return;
    if (room.imposterRound.phase !== 'waiting') return;
    if (Object.keys(room.players).length < minPlayersNeeded(room)) return;

    const r = room.imposterRound;
    resetRoundFields(r);
    r.eligiblePlayerIds = Object.keys(room.players);
    r.promptSetter = pickPromptSetter(room);
    r.phase = 'prompt_setting';

    broadcastImposterState(io, rooms, roomCode);
  });

  socket.on('submit_prompts', ({ roomCode, mainPrompt, imposterPrompt }) => {
    roomCode = roomCode?.toUpperCase();
    const room = rooms[roomCode];
    if (!room || room.mode !== 'imposter') return;
    const r = room.imposterRound;
    if (r.phase !== 'prompt_setting') return;

    const isSetter = r.promptSetter === null
      ? socket.id === room.hostSocketId
      : socket.id === r.promptSetter;
    if (!isSetter) return;

    const main = String(mainPrompt || '').trim().slice(0, 300);
    const imp  = String(imposterPrompt || '').trim().slice(0, 300);
    if (!main || !imp) return;

    const candidates = liveEligiblePlayerIds(room).filter(id => id !== r.promptSetter);
    if (candidates.length === 0) return; // shouldn't happen given the min-player guard, but don't corrupt state if it does

    r.mainPrompt = main;
    r.imposterPrompt = imp;
    r.imposter = candidates[Math.floor(Math.random() * candidates.length)];
    r.imposterName = room.players[r.imposter].name; // captured now — safe even if they disconnect before results
    r.discussionEndsAt = Date.now() + room.imposterSettings.discussionDurationSeconds * 1000;
    r.phase = 'discussing';

    schedulePhaseTimer(roomCode, 'discussing', room.imposterSettings.discussionDurationSeconds * 1000, () => {
      advanceToVoting(io, rooms, roomCode);
    });

    broadcastImposterState(io, rooms, roomCode);
    for (const id of liveEligiblePlayerIds(room)) sendYourPrompt(io, room, id);
  });

  socket.on('skip_to_voting', ({ roomCode }) => {
    roomCode = roomCode?.toUpperCase();
    const room = rooms[roomCode];
    if (!room || room.mode !== 'imposter' || socket.id !== room.hostSocketId) return;
    if (room.imposterRound.phase !== 'discussing') return;
    advanceToVoting(io, rooms, roomCode);
  });

  socket.on('cast_vote', ({ roomCode, votedForSocketId }) => {
    roomCode = roomCode?.toUpperCase();
    const room = rooms[roomCode];
    if (!room || room.mode !== 'imposter') return;
    const r = room.imposterRound;
    if (r.phase !== 'voting') return; // also correctly rejects votes arriving during the '_results_pending' reveal pause

    const eligible = liveEligiblePlayerIds(room);
    if (!eligible.includes(socket.id)) return;        // voter must be a live eligible player
    if (!eligible.includes(votedForSocketId)) return; // target must be a live eligible player
    if (votedForSocketId === socket.id) return;        // can't vote for self

    r.votes[socket.id] = votedForSocketId;
    broadcastImposterState(io, rooms, roomCode);

    const votedCount = eligible.filter(id => r.votes[id]).length;
    if (votedCount >= eligible.length) advanceToResults(io, rooms, roomCode);
  });

  socket.on('next_round', ({ roomCode }) => {
    roomCode = roomCode?.toUpperCase();
    const room = rooms[roomCode];
    if (!room || room.mode !== 'imposter' || socket.id !== room.hostSocketId) return;
    if (room.imposterRound.phase !== 'results') return;

    const r = room.imposterRound;
    const nextRoundNumber = r.roundNumber + 1;
    resetRoundFields(r);
    r.phase = 'waiting';
    r.roundNumber = nextRoundNumber;

    broadcastImposterState(io, rooms, roomCode);
  });

  socket.on('update_imposter_settings', (data) => {
    const roomCode = data?.roomCode?.toUpperCase();
    const room = rooms[roomCode];
    if (!room || room.mode !== 'imposter' || socket.id !== room.hostSocketId) return;
    if (room.imposterRound.phase !== 'waiting') return; // settings only editable pre-round — this guard alone is
                                                          // what makes changes apply "next round, never retroactively"
    const s = room.imposterSettings;
    if (data.promptSetterMode === 'host_fixed' || data.promptSetterMode === 'rotating') {
      s.promptSetterMode = data.promptSetterMode;
    }
    const clampInt = (val, min, max) => {
      const n = parseInt(val, 10);
      return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null;
    };
    const discussion = clampInt(data.discussionDurationSeconds, 10, 1800);
    if (discussion !== null) s.discussionDurationSeconds = discussion;
    const voting = clampInt(data.votingDurationSeconds, 5, 600);
    if (voting !== null) s.votingDurationSeconds = voting;
    const imposterPts = clampInt(data.imposterPointsPerMiss, 0, 100);
    if (imposterPts !== null) s.imposterPointsPerMiss = imposterPts;
    const correctPts = clampInt(data.correctGuessPoints, 0, 100);
    if (correctPts !== null) s.correctGuessPoints = correctPts;

    broadcastImposterState(io, rooms, roomCode);
  });

  socket.on('imposter_reset_scores', ({ roomCode }) => {
    roomCode = roomCode?.toUpperCase();
    const room = rooms[roomCode];
    if (!room || room.mode !== 'imposter' || socket.id !== room.hostSocketId) return;

    for (const id of Object.keys(room.players)) room.players[id].score = 0;
    broadcastImposterState(io, rooms, roomCode);
  });

  socket.on('cancel_round', ({ roomCode }) => {
    roomCode = roomCode?.toUpperCase();
    const room = rooms[roomCode];
    if (!room || room.mode !== 'imposter' || socket.id !== room.hostSocketId) return;

    clearRoomTimer(roomCode);
    const r = room.imposterRound;
    resetRoundFields(r);
    r.phase = 'waiting'; // roundNumber deliberately NOT incremented — this round never completed

    broadcastImposterState(io, rooms, roomCode);
  });
}

// ── Disconnect handling ──────────────────────────────────────────────────
// Called from server.js's existing disconnect handler for every departing
// socket (guarded by room.mode === 'imposter' at the call site). Room-level
// timer cleanup on full-room deletion is separate — see clearRoomTimer's
// export and server.js's own room-deletion branch.

function handleDisconnect(io, rooms, roomCode, socketId) {
  const room = rooms[roomCode];
  if (!room || room.mode !== 'imposter') return;
  const r = room.imposterRound;

  delete r.votes[socketId];

  // If voting is in progress, this disconnect may be exactly what completes
  // the live-eligible set (the spec's "don't stall waiting for a vote that
  // will never come" rule) — check immediately rather than waiting for the
  // full votingDurationSeconds timeout.
  if (r.phase === 'voting') {
    const eligible = liveEligiblePlayerIds(room);
    const votedCount = eligible.filter(id => r.votes[id]).length;
    if (eligible.length > 0 && votedCount >= eligible.length) {
      advanceToResults(io, rooms, roomCode);
      return; // advanceToResults already re-broadcasts
    }
  }

  broadcastImposterState(io, rooms, roomCode);
}

module.exports = {
  createImposterRoomState,
  registerSocketHandlers,
  broadcastImposterState,
  handleDisconnect,
  clearRoomTimer,
};

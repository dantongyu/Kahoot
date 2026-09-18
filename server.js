'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const QUIZ_DIR = path.join(__dirname, 'quizzes');

// Scoring constants
const BASE_POINTS = 1000;
const STREAK_BONUS = 100;
const STREAK_CAP = 500;
const DEFAULT_TIME_LIMIT = 20;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Quizzes
// ---------------------------------------------------------------------------

const QUIZ_ID_RE = /^[\w-]+$/;

/** Returns { quiz } with normalized questions, or { error } describing the first problem. */
function validateQuiz(data) {
  if (!data || typeof data !== 'object') return { error: 'Quiz must be an object' };
  const title = typeof data.title === 'string' ? data.title.trim() : '';
  if (!title) return { error: 'Title is required' };
  if (!Array.isArray(data.questions) || data.questions.length === 0) return { error: 'At least one question is required' };

  const questions = [];
  for (const [i, q] of data.questions.entries()) {
    const n = i + 1;
    if (!q || typeof q.text !== 'string' || !q.text.trim()) return { error: `Question ${n}: text is required` };
    if (!Array.isArray(q.options) || q.options.length !== 4) return { error: `Question ${n}: exactly 4 options are required` };
    const options = q.options.map((o) => String(o ?? '').trim());
    if (options.some((o) => !o)) return { error: `Question ${n}: all 4 options must be filled in` };
    if (!Number.isInteger(q.correct) || q.correct < 0 || q.correct > 3) return { error: `Question ${n}: pick the correct answer` };
    const timeLimit = q.timeLimit === undefined || q.timeLimit === null || q.timeLimit === '' ? DEFAULT_TIME_LIMIT : Number(q.timeLimit);
    if (!Number.isFinite(timeLimit) || timeLimit < 5 || timeLimit > 300) return { error: `Question ${n}: time limit must be 5–300 seconds` };
    questions.push({ text: q.text.trim(), options, correct: q.correct, timeLimit });
  }
  return { quiz: { title, questions } };
}

function quizFile(id) {
  return path.join(QUIZ_DIR, `${id}.json`);
}

function loadQuiz(id) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(quizFile(id), 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`Skipping quiz ${id}: ${err.message}`);
    return null;
  }
  const { quiz, error } = validateQuiz(data);
  if (error) {
    console.warn(`Skipping quiz ${id}: ${error}`);
    return null;
  }
  return { id, ...quiz };
}

function listQuizzes() {
  let files = [];
  try {
    files = fs.readdirSync(QUIZ_DIR).filter((f) => f.endsWith('.json'));
  } catch (err) {
    console.warn(`Cannot read quiz dir: ${err.message}`);
  }
  return files
    .map((f) => loadQuiz(f.slice(0, -5)))
    .filter(Boolean)
    .map((q) => ({ id: q.id, title: q.title, questionCount: q.questions.length }));
}

function slugify(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'quiz';
}

function saveQuiz(id, quiz) {
  fs.mkdirSync(QUIZ_DIR, { recursive: true });
  fs.writeFileSync(quizFile(id), JSON.stringify(quiz, null, 2) + '\n');
}

// ---- Quiz API (used by host page and editor) ----

app.use('/api', express.json({ limit: '1mb' }));

function requireQuizId(req, res, next) {
  if (!QUIZ_ID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid quiz id' });
  next();
}

app.get('/api/quizzes', (req, res) => {
  res.json(listQuizzes());
});

app.get('/api/quizzes/:id', requireQuizId, (req, res) => {
  const quiz = loadQuiz(req.params.id);
  if (!quiz) return res.status(404).json({ error: 'Quiz not found' });
  res.json(quiz);
});

app.post('/api/quizzes', (req, res) => {
  const { quiz, error } = validateQuiz(req.body);
  if (error) return res.status(400).json({ error });
  const base = slugify(quiz.title);
  let id = base;
  for (let n = 2; fs.existsSync(quizFile(id)); n++) id = `${base}-${n}`;
  saveQuiz(id, quiz);
  res.status(201).json({ id, ...quiz });
});

app.put('/api/quizzes/:id', requireQuizId, (req, res) => {
  if (!fs.existsSync(quizFile(req.params.id))) return res.status(404).json({ error: 'Quiz not found' });
  const { quiz, error } = validateQuiz(req.body);
  if (error) return res.status(400).json({ error });
  saveQuiz(req.params.id, quiz);
  res.json({ id: req.params.id, ...quiz });
});

app.delete('/api/quizzes/:id', requireQuizId, (req, res) => {
  try {
    fs.unlinkSync(quizFile(req.params.id));
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'Quiz not found' });
    throw err;
  }
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------

/** @type {Map<string, Game>} */
const games = new Map();

function generatePin() {
  let pin;
  do {
    pin = String(Math.floor(100000 + Math.random() * 900000));
  } while (games.has(pin));
  return pin;
}

function createGame(hostSocketId, quiz) {
  const game = {
    pin: generatePin(),
    hostSocketId,
    quiz,
    state: 'LOBBY',
    currentIndex: -1,
    players: new Map(), // nickKey -> Player
    questionStartedAt: 0,
    questionEndsAt: 0,
    questionTimer: null,
    answers: new Map(), // nickKey -> { choice, responseMs }
  };
  games.set(game.pin, game);
  return game;
}

function destroyGame(game, reason) {
  clearTimeout(game.questionTimer);
  io.to(game.pin).emit('game:ended', { reason });
  games.delete(game.pin);
  console.log(`Game ${game.pin} ended (${reason}); ${games.size} active`);
}

function hostRoom(game) {
  return `${game.pin}:host`;
}

function connectedPlayers(game) {
  return [...game.players.values()].filter((p) => p.socketId !== null);
}

function lobbyPayload(game) {
  return {
    players: [...game.players.values()].map((p) => ({ nickname: p.nickname, connected: p.socketId !== null })),
  };
}

function broadcastLobby(game) {
  io.to(game.pin).emit('lobby:update', lobbyPayload(game));
}

function sortedPlayers(game) {
  return [...game.players.values()].sort(
    (a, b) => b.score - a.score || a.nickname.localeCompare(b.nickname)
  );
}

function leaderboard(game, limit) {
  const list = sortedPlayers(game).map((p) => ({ nickname: p.nickname, score: p.score }));
  return limit ? list.slice(0, limit) : list;
}

function currentQuestion(game) {
  return game.quiz.questions[game.currentIndex];
}

// ---------------------------------------------------------------------------
// Question flow
// ---------------------------------------------------------------------------

function startQuestion(game, index) {
  const q = game.quiz.questions[index];
  game.state = 'QUESTION';
  game.currentIndex = index;
  game.answers.clear();
  game.questionStartedAt = Date.now();
  game.questionEndsAt = game.questionStartedAt + q.timeLimit * 1000;
  clearTimeout(game.questionTimer);
  game.questionTimer = setTimeout(() => endQuestion(game), q.timeLimit * 1000);

  io.to(hostRoom(game)).emit('question:start', {
    index,
    total: game.quiz.questions.length,
    text: q.text,
    options: q.options,
    timeLimit: q.timeLimit,
    endsAt: game.questionEndsAt,
  });
  for (const p of connectedPlayers(game)) {
    io.to(p.socketId).emit('question:start', playerQuestionPayload(game));
  }
  io.to(hostRoom(game)).emit('question:answerCount', { answered: 0, total: connectedPlayers(game).length });
}

function playerQuestionPayload(game) {
  const q = currentQuestion(game);
  return {
    index: game.currentIndex,
    total: game.quiz.questions.length,
    timeLimit: q.timeLimit,
    endsAt: game.questionEndsAt,
  };
}

function scoreAnswer(player, answer, q) {
  if (!answer || answer.choice !== q.correct) {
    player.streak = 0;
    return 0;
  }
  const frac = Math.min(1, answer.responseMs / (q.timeLimit * 1000));
  const base = Math.round(BASE_POINTS * (1 - frac / 2));
  player.streak += 1;
  const bonus = Math.min(STREAK_CAP, STREAK_BONUS * (player.streak - 1));
  const points = base + bonus;
  player.score += points;
  return points;
}

function endQuestion(game) {
  if (game.state !== 'QUESTION') return;
  clearTimeout(game.questionTimer);
  game.questionTimer = null;
  game.state = 'RESULTS';

  const q = currentQuestion(game);
  const distribution = [0, 0, 0, 0];
  const pointsByKey = new Map();

  for (const [key, player] of game.players) {
    const answer = game.answers.get(key) || null;
    if (answer) distribution[answer.choice] += 1;
    pointsByKey.set(key, scoreAnswer(player, answer, q));
  }

  const ranked = sortedPlayers(game);
  const totalPlayers = ranked.length;
  ranked.forEach((player, i) => {
    const key = player.nickname.toLowerCase();
    const answer = game.answers.get(key) || null;
    player.lastResult = {
      index: game.currentIndex,
      correct: !!answer && answer.choice === q.correct,
      choice: answer ? answer.choice : null,
      correctChoice: q.correct,
      points: pointsByKey.get(key),
      streak: player.streak,
      score: player.score,
      rank: i + 1,
      totalPlayers,
    };
    if (player.socketId) io.to(player.socketId).emit('question:result', player.lastResult);
  });

  io.to(hostRoom(game)).emit('question:results', {
    index: game.currentIndex,
    total: game.quiz.questions.length,
    text: q.text,
    options: q.options,
    correct: q.correct,
    distribution,
    leaderboard: leaderboard(game, 5),
    isLast: game.currentIndex >= game.quiz.questions.length - 1,
  });
}

function showPodium(game) {
  clearTimeout(game.questionTimer);
  game.questionTimer = null;
  game.state = 'PODIUM';
  const ranked = sortedPlayers(game);
  const podium = ranked.slice(0, 3).map((p) => ({ nickname: p.nickname, score: p.score }));
  io.to(hostRoom(game)).emit('game:podium', { podium, leaderboard: leaderboard(game) });
  ranked.forEach((p, i) => {
    p.finalRank = i + 1;
    if (p.socketId) io.to(p.socketId).emit('game:podium', playerPodiumPayload(game, p, podium));
  });
}

function playerPodiumPayload(game, player, podium) {
  return { rank: player.finalRank, score: player.score, totalPlayers: game.players.size, podium };
}

function resumeSnapshot(game, player) {
  const snap = { state: game.state };
  if (game.state === 'QUESTION') {
    snap.question = playerQuestionPayload(game);
    snap.answered = game.answers.has(player.nickname.toLowerCase());
  } else if (game.state === 'RESULTS' && player.lastResult) {
    snap.lastResult = player.lastResult;
  } else if (game.state === 'PODIUM') {
    const podium = sortedPlayers(game).slice(0, 3).map((p) => ({ nickname: p.nickname, score: p.score }));
    snap.podium = playerPodiumPayload(game, player, podium);
  }
  return snap;
}

// ---------------------------------------------------------------------------
// Sockets
// ---------------------------------------------------------------------------

io.on('connection', (socket) => {
  socket.data = { role: null, pin: null, nickKey: null };

  const gameOf = () => (socket.data.pin ? games.get(socket.data.pin) : undefined);
  const fail = (message) => socket.emit('error', { message });

  // ---- Host events ----

  socket.on('host:create', ({ quizId } = {}) => {
    if (socket.data.role) return fail('Already in a game');
    if (typeof quizId !== 'string' || !QUIZ_ID_RE.test(quizId)) return fail('Invalid quiz');
    const quiz = loadQuiz(quizId);
    if (!quiz) return fail('Quiz not found');

    const game = createGame(socket.id, quiz);
    socket.data = { role: 'host', pin: game.pin, nickKey: null };
    socket.join(game.pin);
    socket.join(hostRoom(game));
    socket.emit('host:created', { pin: game.pin, quizTitle: quiz.title, questionCount: quiz.questions.length });
    console.log(`Game ${game.pin} created with quiz "${quiz.title}"`);
  });

  socket.on('host:start', () => {
    const game = gameOf();
    if (!game || socket.data.role !== 'host') return fail('Not hosting a game');
    if (game.state !== 'LOBBY') return;
    if (game.players.size === 0) return fail('No players have joined yet');
    startQuestion(game, 0);
  });

  socket.on('host:next', () => {
    const game = gameOf();
    if (!game || socket.data.role !== 'host') return fail('Not hosting a game');
    if (game.state !== 'RESULTS') return;
    if (game.currentIndex + 1 < game.quiz.questions.length) startQuestion(game, game.currentIndex + 1);
    else showPodium(game);
  });

  socket.on('host:end', () => {
    const game = gameOf();
    if (!game || socket.data.role !== 'host') return fail('Not hosting a game');
    if (game.state === 'LOBBY' || game.state === 'PODIUM') return;
    if (game.state === 'QUESTION') endQuestion(game);
    showPodium(game);
  });

  // ---- Player events ----

  socket.on('player:join', ({ pin, nickname } = {}) => {
    if (socket.data.role) return fail('Already in a game');
    const game = typeof pin === 'string' ? games.get(pin.trim()) : undefined;
    if (!game) return fail('Game not found');

    const name = typeof nickname === 'string' ? nickname.trim().slice(0, 20) : '';
    if (!name) return fail('Please enter a nickname');
    const nickKey = name.toLowerCase();

    let player = game.players.get(nickKey);
    if (player) {
      const stillConnected = player.socketId && io.sockets.sockets.has(player.socketId);
      if (stillConnected) return fail('That nickname is already taken');
      player.socketId = socket.id; // reconnect
    } else {
      if (game.state !== 'LOBBY') return fail('Game already started');
      player = { nickname: name, socketId: socket.id, score: 0, streak: 0, lastResult: null, finalRank: null };
      game.players.set(nickKey, player);
    }

    socket.data = { role: 'player', pin: game.pin, nickKey };
    socket.join(game.pin);
    socket.emit('player:joined', { pin: game.pin, nickname: player.nickname, resume: resumeSnapshot(game, player) });
    broadcastLobby(game);
    if (game.state === 'QUESTION') {
      io.to(hostRoom(game)).emit('question:answerCount', {
        answered: game.answers.size,
        total: connectedPlayers(game).length,
      });
    }
  });

  socket.on('player:answer', ({ index, choice } = {}) => {
    const game = gameOf();
    if (!game || socket.data.role !== 'player') return;
    if (game.state !== 'QUESTION' || index !== game.currentIndex) return;
    if (!Number.isInteger(choice) || choice < 0 || choice > 3) return;
    const key = socket.data.nickKey;
    if (game.answers.has(key)) return;

    const q = currentQuestion(game);
    const responseMs = Math.max(0, Math.min(q.timeLimit * 1000, Date.now() - game.questionStartedAt));
    game.answers.set(key, { choice, responseMs });
    socket.emit('answer:ack', { index });

    const total = connectedPlayers(game).length;
    io.to(hostRoom(game)).emit('question:answerCount', { answered: game.answers.size, total });
    if (game.answers.size >= total) endQuestion(game);
  });

  // ---- Disconnect ----

  socket.on('disconnect', () => {
    const game = gameOf();
    if (!game) return;
    if (socket.data.role === 'host') {
      destroyGame(game, 'host_left');
      return;
    }
    const player = game.players.get(socket.data.nickKey);
    if (!player || player.socketId !== socket.id) return;
    player.socketId = null;
    broadcastLobby(game);
    if (game.state === 'QUESTION') {
      const total = connectedPlayers(game).length;
      io.to(hostRoom(game)).emit('question:answerCount', { answered: game.answers.size, total });
      // A dropped player must not stall the round for everyone else.
      if (total > 0 && game.answers.size >= total) endQuestion(game);
    }
  });
});

// ---------------------------------------------------------------------------

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

server.listen(PORT, () => {
  console.log(`Quiz server running:`);
  console.log(`  Host:    http://localhost:${PORT}/host.html`);
  console.log(`  Players: http://localhost:${PORT}/player.html`);
  for (const addr of lanAddresses()) console.log(`  LAN:     http://${addr}:${PORT}/`);
});

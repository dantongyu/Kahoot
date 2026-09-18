'use strict';

const SHAPES = ['▲', '◆', '●', '■'];
const STORAGE_KEY = 'quiz-player';
const socket = io();
const $ = (id) => document.getElementById(id);

let timerInterval = null;
let currentIndex = -1;
let myName = '';

function show(id) {
  document.querySelectorAll('section.screen').forEach((s) => s.classList.toggle('hidden', s.id !== id));
  document.body.classList.remove('result-correct', 'result-wrong');
}

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 3000);
}

function saveSession(pin, nickname) {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ pin, nickname })); } catch (e) { /* ignore */ }
}
function loadSession() {
  try { return JSON.parse(sessionStorage.getItem(STORAGE_KEY)); } catch (e) { return null; }
}
function clearSession() {
  try { sessionStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
}

function setScore(score) {
  $('bar-score').textContent = `${score} pts`;
}

function runTimer(endsAt, timeLimit) {
  clearInterval(timerInterval);
  const tick = () => {
    const remaining = Math.max(0, endsAt - Date.now());
    $('p-timer-bar').style.width = `${(remaining / (timeLimit * 1000)) * 100}%`;
    $('p-timer').textContent = `${Math.ceil(remaining / 1000)}s`;
    if (remaining <= 0) {
      clearInterval(timerInterval);
      $('p-options').querySelectorAll('button').forEach((b) => (b.disabled = true));
    }
  };
  tick();
  timerInterval = setInterval(tick, 100);
}

function showQuestion({ index, total, timeLimit, endsAt }) {
  currentIndex = index;
  $('p-counter').textContent = `${index + 1} / ${total}`;
  const grid = $('p-options');
  grid.innerHTML = '';
  SHAPES.forEach((shape, i) => {
    const btn = document.createElement('button');
    btn.className = `answer c${i}`;
    btn.innerHTML = `<span class="shape">${shape}</span>`;
    btn.onclick = () => {
      grid.querySelectorAll('button').forEach((b) => (b.disabled = true));
      socket.emit('player:answer', { index, choice: i });
    };
    grid.appendChild(btn);
  });
  runTimer(endsAt, timeLimit);
  show('answer');
}

function showResult(r) {
  clearInterval(timerInterval);
  setScore(r.score);
  $('res-title').textContent = r.correct ? 'Correct!' : r.choice === null ? 'Too slow!' : 'Wrong';
  $('res-points').textContent = `+${r.points}`;
  $('res-streak').textContent = r.streak > 1 ? `🔥 ${r.streak} answer streak` : '';
  $('res-rank').textContent = `You're in ${ordinal(r.rank)} place of ${r.totalPlayers}`;
  show('result');
  document.body.classList.add(r.correct ? 'result-correct' : 'result-wrong');
}

function showFinal({ rank, score, totalPlayers, podium }) {
  clearInterval(timerInterval);
  setScore(score);
  $('final-rank').textContent = `${ordinal(rank)} place`;
  $('final-score').textContent = `${score} pts · ${totalPlayers} players`;
  const list = $('final-podium');
  list.innerHTML = '';
  podium.forEach((p, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span><span class="rank">${['🥇', '🥈', '🥉'][i]}</span><span class="name"></span></span><span class="score"></span>`;
    li.querySelector('.name').textContent = p.nickname;
    li.querySelector('.score').textContent = p.score;
    list.appendChild(li);
  });
  clearSession();
  show('final');
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// ---- Join form / auto-rejoin ----

$('join-form').onsubmit = (e) => {
  e.preventDefault();
  socket.emit('player:join', { pin: $('pin-input').value.trim(), nickname: $('nick-input').value.trim() });
};

const saved = loadSession();
if (saved && saved.pin && saved.nickname) {
  $('pin-input').value = saved.pin;
  $('nick-input').value = saved.nickname;
  socket.emit('player:join', saved);
}

// ---- Socket events ----

socket.on('player:joined', ({ pin, nickname, resume }) => {
  myName = nickname;
  saveSession(pin, nickname);
  $('my-name').textContent = nickname;
  $('bar-name').textContent = nickname;
  $('player-bar').classList.remove('hidden');

  switch (resume.state) {
    case 'QUESTION':
      if (resume.answered) show('locked');
      else showQuestion(resume.question);
      break;
    case 'RESULTS':
      if (resume.lastResult) showResult(resume.lastResult);
      else show('locked');
      break;
    case 'PODIUM':
      showFinal(resume.podium);
      break;
    default:
      show('lobby');
  }
});

socket.on('lobby:update', ({ players }) => {
  $('lobby-count').textContent = players.filter((p) => p.connected).length;
});

socket.on('question:start', showQuestion);

socket.on('answer:ack', ({ index }) => {
  if (index === currentIndex) show('locked');
});

socket.on('question:result', showResult);

socket.on('game:podium', showFinal);

socket.on('game:ended', ({ reason }) => {
  clearInterval(timerInterval);
  clearSession();
  $('ended-reason').textContent = reason === 'host_left' ? 'The host left the game.' : 'The game was ended.';
  show('ended');
});

socket.on('error', ({ message }) => {
  toast(message);
  // A rejected auto-rejoin (e.g. game gone) should drop the stale session.
  if (saved && (message === 'Game not found' || message === 'Game already started')) clearSession();
});

socket.on('disconnect', () => toast('Connection lost — reconnecting…'));

// Socket.IO reconnected with a fresh socket (phone lock, wifi blip): rejoin transparently.
socket.on('connect', () => {
  if (myName) {
    const s = loadSession();
    if (s) socket.emit('player:join', s);
  }
});

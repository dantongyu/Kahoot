'use strict';

const SHAPES = ['▲', '◆', '●', '■'];
const socket = io();
const $ = (id) => document.getElementById(id);

let timerInterval = null;

function show(id) {
  document.querySelectorAll('section.screen').forEach((s) => s.classList.toggle('hidden', s.id !== id));
}

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 3000);
}

function answerEl(i, text, tag = 'div') {
  const el = document.createElement(tag);
  el.className = `answer c${i}`;
  el.innerHTML = `<span class="shape">${SHAPES[i]}</span><span class="label"></span>`;
  el.querySelector('.label').textContent = text;
  return el;
}

function runTimer(endsAt, timeLimit, barEl, numEl) {
  clearInterval(timerInterval);
  const tick = () => {
    const remaining = Math.max(0, endsAt - Date.now());
    barEl.style.width = `${(remaining / (timeLimit * 1000)) * 100}%`;
    if (numEl) numEl.textContent = Math.ceil(remaining / 1000);
    if (remaining <= 0) clearInterval(timerInterval);
  };
  tick();
  timerInterval = setInterval(tick, 100);
}

function renderLeaderboard(listEl, entries) {
  listEl.innerHTML = '';
  entries.forEach((e, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span><span class="rank">${i + 1}.</span><span class="name"></span></span><span class="score"></span>`;
    li.querySelector('.name').textContent = e.nickname;
    li.querySelector('.score').textContent = e.score;
    listEl.appendChild(li);
  });
}

// ---- Quiz picker ----

fetch('/api/quizzes')
  .then((r) => r.json())
  .then((quizzes) => {
    const list = $('quiz-list');
    if (quizzes.length === 0) {
      list.textContent = 'No quizzes found in quizzes/';
      return;
    }
    for (const q of quizzes) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-big';
      btn.textContent = `${q.title} (${q.questionCount} questions)`;
      btn.onclick = () => socket.emit('host:create', { quizId: q.id });
      list.appendChild(btn);
    }
  });

$('start-btn').onclick = () => socket.emit('host:start');
$('next-btn').onclick = () => socket.emit('host:next');
$('end-btn').onclick = () => {
  if (confirm('End the game now and show the podium?')) socket.emit('host:end');
};

// ---- Socket events ----

socket.on('host:created', ({ pin, quizTitle }) => {
  $('pin').textContent = pin;
  $('quiz-title').textContent = quizTitle;
  $('join-url').textContent = `${location.host}/player.html`;
  $('end-btn').classList.remove('hidden');
  show('lobby');
});

socket.on('lobby:update', ({ players }) => {
  $('player-count').textContent = players.filter((p) => p.connected).length;
  const list = $('player-list');
  list.innerHTML = '';
  for (const p of players) {
    const chip = document.createElement('div');
    chip.className = `player-chip${p.connected ? '' : ' disconnected'}`;
    chip.textContent = p.nickname;
    list.appendChild(chip);
  }
});

socket.on('question:start', ({ index, total, text, options, timeLimit, endsAt }) => {
  $('q-counter').textContent = `${index + 1} / ${total}`;
  $('q-text').textContent = text;
  const grid = $('q-options');
  grid.innerHTML = '';
  options.forEach((opt, i) => grid.appendChild(answerEl(i, opt)));
  runTimer(endsAt, timeLimit, $('timer-bar'), $('q-timer-num'));
  show('question');
});

socket.on('question:answerCount', ({ answered, total }) => {
  $('answer-count').textContent = `${answered} / ${total} answered`;
});

socket.on('question:results', ({ index, total, text, options, correct, distribution, leaderboard, isLast }) => {
  clearInterval(timerInterval);
  $('r-counter').textContent = `${index + 1} / ${total}`;
  $('r-text').textContent = text;
  $('next-btn').textContent = isLast ? 'Show podium' : 'Next';

  const chart = $('r-chart');
  chart.innerHTML = '';
  const max = Math.max(1, ...distribution);
  distribution.forEach((n, i) => {
    const wrap = document.createElement('div');
    wrap.className = `bar-wrap${i === correct ? ' correct' : ''}`;
    wrap.innerHTML = `<div class="bar-count">${n}</div><div class="bar c${i}"></div><div class="shape">${SHAPES[i]}</div>`;
    chart.appendChild(wrap);
    requestAnimationFrame(() => {
      wrap.querySelector('.bar').style.height = `${Math.max(3, (n / max) * 100)}%`;
    });
  });

  const grid = $('r-options');
  grid.innerHTML = '';
  options.forEach((opt, i) => {
    const el = answerEl(i, opt);
    el.classList.add(i === correct ? 'correct' : 'wrong');
    grid.appendChild(el);
  });

  renderLeaderboard($('r-leaderboard'), leaderboard);
  show('results');
});

socket.on('game:podium', ({ podium, leaderboard }) => {
  clearInterval(timerInterval);
  $('end-btn').classList.add('hidden');
  const stands = $('podium-stands');
  stands.innerHTML = '';
  // Render in visual order 2nd, 1st, 3rd
  const order = [1, 0, 2];
  for (const i of order) {
    const p = podium[i];
    if (!p) continue;
    const stand = document.createElement('div');
    stand.className = `stand p${i + 1}`;
    stand.innerHTML = `<div class="name"></div><div class="score"></div><div class="block">${i + 1}</div>`;
    stand.querySelector('.name').textContent = p.nickname;
    stand.querySelector('.score').textContent = `${p.score} pts`;
    stands.appendChild(stand);
  }
  renderLeaderboard($('final-leaderboard'), leaderboard);
  show('podium');
});

socket.on('error', ({ message }) => toast(message));

socket.on('disconnect', () => toast('Disconnected from server'));

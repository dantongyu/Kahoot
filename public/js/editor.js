'use strict';

const DEFAULT_TIME_LIMIT = 20;
const $ = (id) => document.getElementById(id);

let currentId = null; // null = unsaved new quiz
let dirty = false;

function toast(message, ok = false) {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('toast-ok', ok);
  el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 3000);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

function setDirty(v) {
  dirty = v;
  $('status').textContent = v ? 'Unsaved changes' : '';
}

// ---- Sidebar ----

async function refreshList() {
  const quizzes = await api('GET', '/api/quizzes');
  const list = $('quiz-list');
  list.innerHTML = '';
  for (const q of quizzes) {
    const btn = document.createElement('button');
    btn.className = `btn quiz-item${q.id === currentId ? ' active' : ''}`;
    btn.innerHTML = '<span class="name"></span><span class="muted count"></span>';
    btn.querySelector('.name').textContent = q.title;
    btn.querySelector('.count').textContent = `${q.questionCount} Q`;
    btn.onclick = () => openQuiz(q.id);
    list.appendChild(btn);
  }
}

function confirmDiscard() {
  return !dirty || confirm('You have unsaved changes. Discard them?');
}

async function openQuiz(id) {
  if (!confirmDiscard()) return;
  try {
    const quiz = await api('GET', `/api/quizzes/${id}`);
    currentId = id;
    renderQuiz(quiz);
    refreshList();
  } catch (err) {
    toast(err.message);
  }
}

function newQuiz() {
  if (!confirmDiscard()) return;
  currentId = null;
  renderQuiz({ title: '', questions: [blankQuestion()] });
  refreshList();
  $('title-input').focus();
}

// ---- Form ----

function blankQuestion() {
  return { text: '', options: ['', '', '', ''], correct: 0, timeLimit: DEFAULT_TIME_LIMIT };
}

function renderQuiz(quiz) {
  $('title-input').value = quiz.title;
  $('delete-btn').classList.toggle('hidden', currentId === null);
  const container = $('questions');
  container.innerHTML = '';
  quiz.questions.forEach((q) => container.appendChild(questionCard(q)));
  renumber();
  setDirty(false);
  $('empty').classList.add('hidden');
  $('form').classList.remove('hidden');
}

function questionCard(q) {
  const card = $('q-template').content.firstElementChild.cloneNode(true);
  card.querySelector('.q-text-input').value = q.text;
  card.querySelector('.time-input').value = q.timeLimit;
  const opts = card.querySelectorAll('.opt-input');
  const radios = card.querySelectorAll('.correct');
  q.options.forEach((o, i) => (opts[i].value = o));
  radios[q.correct].checked = true;

  card.querySelector('.remove').onclick = () => {
    card.remove();
    renumber();
    setDirty(true);
  };
  card.querySelector('.move-up').onclick = () => {
    if (card.previousElementSibling) card.parentNode.insertBefore(card, card.previousElementSibling);
    renumber();
    setDirty(true);
  };
  card.querySelector('.move-down').onclick = () => {
    if (card.nextElementSibling) card.parentNode.insertBefore(card.nextElementSibling, card);
    renumber();
    setDirty(true);
  };
  card.addEventListener('input', () => setDirty(true));
  return card;
}

function renumber() {
  const cards = $('questions').querySelectorAll('.q-card');
  cards.forEach((card, i) => {
    card.querySelector('.q-num').textContent = `Q${i + 1}`;
    // Radios need a per-card group name so only one option per question can be picked.
    card.querySelectorAll('.correct').forEach((r) => (r.name = `correct-${i}`));
    card.querySelector('.move-up').disabled = i === 0;
    card.querySelector('.move-down').disabled = i === cards.length - 1;
  });
}

function readForm() {
  const questions = [...$('questions').querySelectorAll('.q-card')].map((card) => {
    const radios = [...card.querySelectorAll('.correct')];
    return {
      text: card.querySelector('.q-text-input').value,
      options: [...card.querySelectorAll('.opt-input')].map((i) => i.value),
      correct: radios.findIndex((r) => r.checked),
      timeLimit: Number(card.querySelector('.time-input').value) || DEFAULT_TIME_LIMIT,
    };
  });
  return { title: $('title-input').value, questions };
}

async function save() {
  const body = readForm();
  try {
    let saved;
    if (currentId === null) {
      saved = await api('POST', '/api/quizzes', body);
      currentId = saved.id;
      $('delete-btn').classList.remove('hidden');
    } else {
      saved = await api('PUT', `/api/quizzes/${currentId}`, body);
    }
    setDirty(false);
    toast(`Saved "${saved.title}"`, true);
    refreshList();
  } catch (err) {
    toast(err.message);
  }
}

async function remove() {
  if (currentId === null) return;
  if (!confirm(`Delete "${$('title-input').value}"? This cannot be undone.`)) return;
  try {
    await api('DELETE', `/api/quizzes/${currentId}`);
    currentId = null;
    setDirty(false);
    $('form').classList.add('hidden');
    $('empty').classList.remove('hidden');
    toast('Quiz deleted', true);
    refreshList();
  } catch (err) {
    toast(err.message);
  }
}

// ---- Wire up ----

$('new-btn').onclick = newQuiz;
$('save-btn').onclick = save;
$('delete-btn').onclick = remove;
$('add-q-btn').onclick = () => {
  const card = questionCard(blankQuestion());
  $('questions').appendChild(card);
  renumber();
  setDirty(true);
  card.querySelector('.q-text-input').focus();
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
};
$('title-input').addEventListener('input', () => setDirty(true));
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault();
    if (!$('form').classList.contains('hidden')) save();
  }
});
window.addEventListener('beforeunload', (e) => {
  if (dirty) e.preventDefault();
});

refreshList().catch((err) => toast(err.message));

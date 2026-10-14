// 파티게임 유저 페이지 — Socket.io 실시간 (폴링 없음)
const $ = (s) => document.querySelector(s);

async function api(action, params = {}) {
  const res = await fetch('/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ action }, params)),
  });
  return res.json();
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- bottom-sheet 모달 ----------
function openModal(html) {
  const root = $('#modal-root');
  root.innerHTML = `
    <div class="fixed inset-0 z-30 flex items-end justify-center" id="m-back">
      <div class="absolute inset-0 bg-black/70" id="m-dim"></div>
      <div class="relative w-full max-w-md bg-slate-900 rounded-t-3xl p-5 pb-8 space-y-4 sheet-in">
        ${html}
      </div>
    </div>`;
  return root.firstElementChild;
}
function closeModal() { $('#modal-root').innerHTML = ''; }

function nickModal(mode) {
  const m = openModal(`
    <h3 class="font-bold text-lg">${mode === 'rename' ? '닉네임 바꾸기' : '닉네임을 입력해주세요'}</h3>
    <input type="text" id="nick-input" maxlength="20" placeholder="닉네임 (1~20자)"
      class="w-full min-h-[52px] px-4 rounded-xl bg-slate-800 border border-slate-700 text-base outline-none focus:border-indigo-500">
    <div class="flex gap-2">
      ${mode === 'rename' ? '<button class="flex-1 min-h-[52px] rounded-xl bg-slate-800 active:bg-slate-700 font-semibold" id="m-cancel">취소</button>' : ''}
      <button class="flex-1 min-h-[52px] rounded-xl bg-indigo-600 active:bg-indigo-500 font-semibold" id="m-ok">${mode === 'rename' ? '바꾸기' : '시작하기'}</button>
    </div>`);
  const input = m.querySelector('#nick-input');
  input.focus();
  const submit = async () => {
    const nick = input.value.trim();
    if (!nick) { alert('닉네임을 입력해주세요'); return; }
    const r = await api(mode === 'rename' ? 'rename' : 'register', { nickname: nick });
    if (!r.ok) { alert(r.error); return; }
    location.reload();
  };
  m.querySelector('#m-ok').onclick = submit;
  input.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
  const c = m.querySelector('#m-cancel');
  if (c) c.onclick = closeModal;
}

function questionModal(gameType) {
  const label = gameType === 'image' ? '이미지게임' : 'OX게임';
  const m = openModal(`
    <h3 class="font-bold text-lg">${label} 질문 추가</h3>
    <textarea id="q-text" maxlength="500" placeholder="질문을 입력하세요" rows="3"
      class="w-full px-4 py-3 rounded-xl bg-slate-800 border border-slate-700 text-base outline-none focus:border-indigo-500"></textarea>
    <div class="flex gap-2">
      <button class="flex-1 min-h-[52px] rounded-xl bg-slate-800 active:bg-slate-700 font-semibold" id="m-cancel">취소</button>
      <button class="flex-1 min-h-[52px] rounded-xl bg-indigo-600 active:bg-indigo-500 font-semibold" id="m-ok">추가</button>
    </div>`);
  m.querySelector('#m-cancel').onclick = closeModal;
  m.querySelector('#m-ok').onclick = async () => {
    const text = m.querySelector('#q-text').value.trim();
    if (!text) { alert('질문을 입력해주세요'); return; }
    const r = await api('add_question', { game_type: gameType, text });
    if (!r.ok) { alert(r.error); return; }
    closeModal();
    alert('질문이 등록됐습니다');
  };
}

async function startPickModal(gameType) {
  const label = gameType === 'image' ? '이미지게임' : 'OX게임';
  const r = await api('list_new_questions', { game_type: gameType });
  if (!r.ok) { alert(r.error); return; }
  if (!r.questions.length) { alert('시작할 수 있는 질문이 없습니다 (status=new 질문 없음)'); return; }
  const items = r.questions.map((q, i) =>
    `<label class="flex items-center gap-3 p-3 rounded-xl bg-slate-800 active:bg-slate-700 min-h-[52px]">
      <input type="radio" name="qpick" value="${q.question_id}" class="w-5 h-5 accent-indigo-500" ${i === 0 ? 'checked' : ''}>
      <span class="text-sm">${esc(q.question_text)}</span>
    </label>`
  ).join('');
  const m = openModal(`
    <h3 class="font-bold text-lg">${label} 질문 선택</h3>
    <div class="space-y-2 max-h-[40vh] overflow-y-auto">${items}</div>
    <div class="flex gap-2">
      <button class="flex-1 min-h-[52px] rounded-xl bg-slate-800 active:bg-slate-700 font-semibold" id="m-cancel">취소</button>
      <button class="flex-1 min-h-[52px] rounded-xl bg-emerald-600 active:bg-emerald-500 font-semibold" id="m-ok">시작</button>
    </div>`);
  m.querySelector('#m-cancel').onclick = closeModal;
  m.querySelector('#m-ok').onclick = async () => {
    const sel = m.querySelector('input[name=qpick]:checked');
    if (!sel) { alert('질문을 선택해주세요'); return; }
    const r2 = await api('start_game', { question_id: sel.value });
    if (!r2.ok) { alert(r2.error); return; }
    closeModal();
  };
}

// ---------- 게임 패널 ----------
let currentGame = null;

function renderGamePanel(g) {
  currentGame = g;
  const panel = $('#game-panel');
  const typeLabel = g.game_type === 'image' ? '🖼️ 이미지게임' : '⭕❌ OX게임';
  let body = '';
  if (g.voted) {
    body = `<div class="text-center py-4 text-emerald-400 font-bold text-lg">✅ 선택완료</div>`;
  } else if (g.game_type === 'image') {
    body = `<div class="grid grid-cols-2 gap-2">` + g.candidates.map((c) =>
      `<button class="min-h-[56px] px-2 rounded-xl bg-slate-800 active:bg-indigo-600 font-semibold text-sm truncate" data-vote-user="${c.user_id}">${esc(c.nickname)}</button>`
    ).join('') + `</div>`;
  } else {
    body = `<div class="grid grid-cols-2 gap-2">
      <button class="min-h-[72px] rounded-xl bg-slate-800 active:bg-indigo-600 text-4xl font-black" data-vote-choice="O">O</button>
      <button class="min-h-[72px] rounded-xl bg-slate-800 active:bg-indigo-600 text-4xl font-black" data-vote-choice="X">X</button>
    </div>`;
  }
  const pct = g.total > 0 ? Math.round((g.votes_cast / g.total) * 100) : 0;
  panel.innerHTML = `
    <div class="bg-indigo-950 border-b border-indigo-800 px-4 py-3 space-y-2">
      <div class="flex items-center justify-between">
        <span class="text-xs font-semibold text-indigo-300">${typeLabel}</span>
        <span class="text-xs text-indigo-300" id="gp-count">${g.votes_cast} / ${g.total} 투표</span>
      </div>
      <div class="text-base font-semibold leading-snug">${esc(g.question_text)}</div>
      <div class="h-2 rounded-full bg-slate-800 overflow-hidden">
        <div id="gp-bar" class="h-full bg-indigo-500 rounded-full transition-all" style="width:${pct}%"></div>
      </div>
      <div id="gp-body">${body}</div>
    </div>`;
  panel.classList.remove('hidden');
  $('#game-overlay').classList.remove('hidden');

  panel.querySelectorAll('[data-vote-user]').forEach((b) => {
    b.onclick = () => doVote(g.game_id, { target_user_id: +b.dataset.voteUser });
  });
  panel.querySelectorAll('[data-vote-choice]').forEach((b) => {
    b.onclick = () => doVote(g.game_id, { choice: b.dataset.voteChoice });
  });
}

function updateProgress(voted, total) {
  const c = $('#gp-count');
  if (c) c.textContent = `${voted} / ${total} 투표`;
  const bar = $('#gp-bar');
  if (bar) bar.style.width = (total > 0 ? Math.round((voted / total) * 100) : 0) + '%';
}

async function doVote(gameId, params) {
  const r = await api('vote', Object.assign({ game_id: gameId }, params));
  if (!r.ok) { alert(r.error); return; }
  // 내 투표 반영("선택완료")은 1회 동기화로, 전원 투표 종료는 소켓 이벤트로
  if (!r.finished) syncState();
}

function hideGamePanel() {
  currentGame = null;
  $('#game-panel').classList.add('hidden');
  $('#game-panel').innerHTML = '';
  $('#game-overlay').classList.add('hidden');
}

// ---------- 결과 ----------
function showResults(f) {
  const typeLabel = f.game_type === 'image' ? '🖼️ 이미지게임 결과' : '⭕❌ OX게임 결과';
  let body = '';
  if (f.game_type === 'image') {
    body = f.results.rows.length
      ? f.results.rows.map((r, i) =>
          `<div class="flex items-center justify-between px-4 py-3 rounded-xl ${i === 0 ? 'bg-amber-500/20 border border-amber-500/50' : 'bg-slate-800'}">
            <span class="font-semibold">${i === 0 ? '👑 ' : ''}${esc(r.nickname)}</span>
            <span class="text-amber-300 font-bold">${r.votes}표</span>
          </div>`
        ).join('')
      : '<div class="text-slate-400 text-sm">투표 없음</div>';
  } else {
    const total = f.results.o + f.results.x;
    const op = total > 0 ? Math.round((f.results.o / total) * 100) : 50;
    body = `
      <div class="space-y-2">
        <div class="flex h-14 rounded-xl overflow-hidden text-xl font-black">
          <div class="bg-sky-600 flex items-center justify-center transition-all" style="width:${op}%">O ${f.results.o}</div>
          <div class="bg-rose-600 flex items-center justify-center transition-all" style="width:${100 - op}%">X ${f.results.x}</div>
        </div>
      </div>`;
  }
  const m = openModal(`
    <h3 class="font-bold text-lg">${typeLabel}</h3>
    <div class="text-sm text-slate-400">${esc(f.question_text)}</div>
    <div class="space-y-2">${body}</div>
    <button class="w-full min-h-[52px] rounded-xl bg-indigo-600 active:bg-indigo-500 font-semibold" id="m-ok">확인</button>`);
  m.querySelector('#m-ok').onclick = () => {
    localStorage.setItem('dismissed_' + f.game_id, '1');
    closeModal();
  };
}

// ---------- 상태 동기화 (소켓 재접속 시 1회) ----------
async function syncState() {
  try {
    const r = await api('game_state');
    if (!r.ok) return;
    if (r.active) {
      renderGamePanel(r.active);
    } else {
      hideGamePanel();
      const f = r.last_finished;
      if (f && !localStorage.getItem('dismissed_' + f.game_id)) showResults(f);
    }
  } catch (e) { /* 무시 */ }
}

// ---------- 소켓 ----------
function connectSocket() {
  const socket = io();

  socket.on('connect', () => syncState());

  socket.on('game_started', (d) => {
    renderGamePanel({
      game_id: d.game_id,
      game_type: d.game_type,
      question_text: d.question_text,
      voted: false,
      votes_cast: 0,
      total: d.total,
      candidates: d.candidates || [],
    });
  });

  socket.on('vote_progress', (d) => {
    if (currentGame && currentGame.game_id === d.game_id) {
      updateProgress(d.voted, d.total);
    }
  });

  socket.on('game_finished', (d) => {
    hideGamePanel();
    if (!localStorage.getItem('dismissed_' + d.game_id)) showResults(d);
  });

  return socket;
}

// ---------- 초기화 ----------
async function init() {
  const r = await api('me');
  if (r.ok && r.user) {
    $('#nickname').textContent = r.user.nickname;
    connectSocket();
  } else {
    nickModal('register');
  }
  $('#btn-rename').onclick = () => nickModal('rename');
  $('#btn-add-image').onclick = () => questionModal('image');
  $('#btn-add-ox').onclick = () => questionModal('ox');
  $('#btn-start-image').onclick = () => startPickModal('image');
  $('#btn-start-ox').onclick = () => startPickModal('ox');
}
document.addEventListener('DOMContentLoaded', init);

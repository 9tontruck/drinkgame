// 파티게임 v3 유저 페이지 — 그룹 기반, Socket.io 실시간 (폴링 없음)
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
    const r = await api('add_question', { group_id: currentGroupId, game_type: gameType, text });
    if (!r.ok) { alert(r.error); return; }
    closeModal();
    alert('질문이 등록됐습니다');
  };
}

// ---------- 그룹 목록 ----------
let socket = null;
let currentGroupId = null;
let currentGame = null;

async function loadGroups() {
  const r = await api('list_groups');
  if (!r.ok) { alert(r.error); return; }
  const list = $('#group-list');
  if (!r.groups.length) {
    list.innerHTML = '<div class="text-slate-500 text-sm text-center py-8">아직 그룹이 없습니다.<br>어드민에서 그룹을 만들어주세요.</div>';
    return;
  }
  list.innerHTML = '';
  for (const g of r.groups) {
    const card = document.createElement('button');
    card.className = 'w-full text-left bg-slate-900 rounded-2xl p-4 space-y-1 active:bg-slate-800 min-h-[76px]';
    card.innerHTML = `
      <div class="font-bold text-base">${esc(g.name)}</div>
      <div class="text-xs text-slate-400">👥 ${g.members}명 참가 중</div>`;
    card.onclick = () => onTapGroup(g.group_id);
    list.appendChild(card);
  }
}

async function onTapGroup(gid) {
  const r = await api('group_state', { group_id: gid });
  if (!r.ok) { alert(r.error); return; }
  if (!r.is_member) {
    // 참가 확인 모달
    const m = openModal(`
      <h3 class="font-bold text-lg">${esc(r.group.name)}</h3>
      <div class="text-sm text-slate-400">👥 ${r.members}명 참가 중</div>
      <div class="flex gap-2">
        <button class="flex-1 min-h-[52px] rounded-xl bg-slate-800 active:bg-slate-700 font-semibold" id="m-cancel">취소</button>
        <button class="flex-1 min-h-[52px] rounded-xl bg-emerald-600 active:bg-emerald-500 font-semibold" id="m-ok">참가하기</button>
      </div>`);
    m.querySelector('#m-cancel').onclick = closeModal;
    m.querySelector('#m-ok').onclick = async () => {
      const j = await api('join_group', { group_id: gid });
      if (!j.ok) { alert(j.error); return; }
      closeModal();
      enterGroup(gid);
    };
    return;
  }
  enterGroup(gid);
}

function enterGroup(gid) {
  if (currentGroupId) socket.emit('leave_room', { group_id: currentGroupId });
  currentGroupId = gid;
  hideGamePanel();
  $('#view-groups').classList.add('hidden');
  const vg = $('#view-group');
  vg.classList.remove('hidden');
  vg.classList.add('flex');
  $('#btn-back').classList.remove('hidden');
  socket.emit('join_room', { group_id: gid });
  syncGroup();
}

function exitGroup() {
  socket.emit('leave_room', { group_id: currentGroupId });
  currentGroupId = null;
  hideGamePanel();
  const vg = $('#view-group');
  vg.classList.add('hidden');
  vg.classList.remove('flex');
  $('#view-groups').classList.remove('hidden');
  $('#btn-back').classList.add('hidden');
  $('#title').textContent = '🎮 파티게임';
  loadGroups();
}

// ---------- 그룹 로비 ----------
async function syncGroup() {
  if (!currentGroupId) return;
  try {
    const r = await api('group_state', { group_id: currentGroupId });
    if (!r.ok) return;
    $('#title').textContent = '🎮 ' + r.group.name;
    $('#group-name').textContent = r.group.name;
    $('#group-members').textContent = `👥 ${r.members}명`;
    const bi = $('#btn-start-image');
    const bo = $('#btn-start-ox');
    bi.textContent = `🖼️ 이미지 게임 시작 (질문 ${r.new_counts.image}개)`;
    bo.textContent = `⭕❌ OX 게임 시작 (질문 ${r.new_counts.ox}개)`;
    bi.disabled = r.new_counts.image === 0;
    bo.disabled = r.new_counts.ox === 0;
    if (r.active) {
      renderGamePanel(r.active);
    } else {
      hideGamePanel();
    }
  } catch (e) { /* 무시 */ }
}

async function startGame(gameType) {
  const r = await api('start_game', { group_id: currentGroupId, game_type: gameType });
  if (!r.ok) { alert(r.error); return; }
  // 게임 시작은 소켓 이벤트(game_started)로 패널 표시
}

// ---------- 게임 패널 ----------
function renderGamePanel(g) {
  currentGame = g;
  const panel = $('#game-panel');
  const typeLabel = g.game_type === 'image' ? '🖼️ 이미지게임' : '⭕❌ OX게임';
  let body = '';
  if (g.voted) {
    body = `<div class="text-center py-4 text-emerald-400 font-bold text-lg">✅ 선택완료</div>`;
  } else if (g.game_type === 'image') {
    body = `<div class="grid grid-cols-2 gap-2">` + g.candidates.map((c) =>
      `<button class="min-h-[56px] px-2 rounded-xl bg-slate-800 active:bg-indigo-600 font-semibold text-sm truncate" data-vote-pid="${c.participant_id}">${esc(c.name)}</button>`
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

  panel.querySelectorAll('[data-vote-pid]').forEach((b) => {
    b.onclick = () => doVote(g.game_id, { target_participant_id: +b.dataset.votePid });
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
  if (r.finished) {
    // 내가 마지막 투표자면 소켓 이벤트를 기다리지 않고 결과보기 버튼을 바로 띄움
    const g = await api('game_results', { game_id: gameId });
    if (g.ok && !localStorage.getItem('dismissed_' + gameId)) showResultButton(g);
  } else {
    syncGroup();
  }
}

function hideGamePanel() {
  currentGame = null;
  const panel = $('#game-panel');
  if (panel) { panel.classList.add('hidden'); panel.innerHTML = ''; }
  const ov = $('#game-overlay');
  if (ov) ov.classList.add('hidden');
}

// ---------- 결과 ----------
// 투표 종료 시 결과를 바로 보여주지 않고 "결과보기" 버튼을 먼저 띄움 (각자 눌러서 확인)
// OX게임은 10초 카운트다운 후 버튼 활성화
let pendingResult = null;
let resultCountdownTimer = null;
function clearResultCountdown() {
  if (resultCountdownTimer) { clearTimeout(resultCountdownTimer); resultCountdownTimer = null; }
}
function showResultButton(f) {
  clearResultCountdown();
  pendingResult = f;
  const typeLabel = f.game_type === 'image' ? '🖼️ 이미지게임' : '⭕❌ OX게임';
  const m = openModal(`
    <h3 class="font-bold text-lg">🎉 투표 종료!</h3>
    <div class="text-sm text-slate-400">${typeLabel} · ${esc(f.question_text)}</div>
    <button class="w-full min-h-[52px] rounded-xl bg-amber-500 active:bg-amber-400 text-slate-950 font-bold text-lg disabled:opacity-50" id="m-ok">결과보기</button>`);
  const btn = m.querySelector('#m-ok');
  const reveal = () => {
    clearResultCountdown();
    pendingResult = null;
    showResults(f);
  };
  if (f.game_type !== 'ox') {
    btn.textContent = '결과보기';
    btn.onclick = reveal;
    return;
  }
  let n = 10;
  btn.disabled = true;
  const tick = () => {
    if (!document.contains(btn)) return; // 모달이 닫혔으면 중단
    if (n <= 0) {
      btn.textContent = '결과보기';
      btn.disabled = false;
      btn.onclick = reveal;
      return;
    }
    btn.textContent = `결과보기(${n})`;
    n--;
    resultCountdownTimer = setTimeout(tick, 1000);
  };
  tick();
}
function showResults(f) {
  const typeLabel = f.game_type === 'image' ? '🖼️ 이미지게임 결과' : '⭕❌ OX게임 결과';
  let body = '';
  if (f.game_type === 'image') {
    body = f.results.rows.length
      ? f.results.rows.map((r, i) =>
          `<div class="flex items-center justify-between px-4 py-3 rounded-xl ${i === 0 ? 'bg-amber-500/20 border border-amber-500/50' : 'bg-slate-800'}">
            <span class="font-semibold">${i === 0 ? '👑 ' : ''}${esc(r.name)}</span>
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

// ---------- 소켓 ----------
function connectSocket() {
  socket = io();

  socket.on('connect', () => {
    if (currentGroupId) {
      socket.emit('join_room', { group_id: currentGroupId });
      syncGroup();
    }
  });

  socket.on('groups_changed', () => {
    if (!currentGroupId) loadGroups();
  });

  socket.on('questions_changed', () => syncGroup());
  socket.on('users_changed', () => syncGroup());
  socket.on('participants_changed', () => syncGroup());

  socket.on('game_started', (d) => {
    if (pendingResult) { pendingResult = null; clearResultCountdown(); closeModal(); }
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
    syncGroup();
    if (pendingResult && pendingResult.game_id === d.game_id) return;
    if (!localStorage.getItem('dismissed_' + d.game_id)) showResultButton(d);
  });

  return socket;
}

// ---------- 초기화 ----------
async function init() {
  const r = await api('me');
  if (r.ok && r.user) {
    $('#nickname').textContent = r.user.nickname;
    connectSocket();
    loadGroups();
  } else {
    nickModal('register');
  }
  $('#btn-rename').onclick = () => nickModal('rename');
  $('#btn-back').onclick = exitGroup;
  $('#btn-add-image').onclick = () => questionModal('image');
  $('#btn-add-ox').onclick = () => questionModal('ox');
  $('#btn-start-image').onclick = () => startGame('image');
  $('#btn-start-ox').onclick = () => startGame('ox');
}
document.addEventListener('DOMContentLoaded', init);

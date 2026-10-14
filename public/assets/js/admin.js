// 어드민 페이지 — Socket.io 실시간 갱신
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

// ---------- 질문 관리 ----------
async function loadQuestions() {
  const type = document.body.dataset.gameType;
  const r = await api('list_questions', { game_type: type });
  if (!r.ok) { alert(r.error); return; }
  const groups = { new: [], complete: [], hidden: [] };
  r.questions.forEach((q) => groups[q.status].push(q));
  const tags = {
    new: '<span class="text-[10px] font-bold px-2 py-1 rounded bg-emerald-600">NEW</span>',
    complete: '<span class="text-[10px] font-bold px-2 py-1 rounded bg-slate-600">완료</span>',
    hidden: '<span class="text-[10px] font-bold px-2 py-1 rounded bg-slate-700 text-slate-400">숨김</span>',
  };
  for (const [status, list] of Object.entries(groups)) {
    const el = document.getElementById('list-' + status);
    el.innerHTML = list.length ? '' : '<div class="text-slate-500 text-xs">없음</div>';
    list.forEach((q) => {
      const div = document.createElement('div');
      div.className = 'p-3 rounded-xl bg-slate-900 flex items-center justify-between gap-2' +
        (status === 'complete' ? ' opacity-50' : '');
      const btn = status === 'hidden'
        ? `<button class="shrink-0 text-xs px-3 py-2 min-h-[44px] rounded-lg bg-emerald-600 active:bg-emerald-500 font-semibold" data-act="new" data-id="${q.question_id}">활성화</button>`
        : `<button class="shrink-0 text-xs px-3 py-2 min-h-[44px] rounded-lg bg-slate-800 active:bg-slate-700 text-slate-300" data-act="hidden" data-id="${q.question_id}">비활성화</button>`;
      div.innerHTML = `<div class="flex items-start gap-2 text-sm">${tags[status]}<span>${esc(q.question_text)}</span></div><div>${btn}</div>`;
      el.appendChild(div);
    });
  }
  document.querySelectorAll('[data-act]').forEach((b) => {
    b.onclick = async () => {
      const r2 = await api('set_question_status', { question_id: +b.dataset.id, status: b.dataset.act });
      if (!r2.ok) { alert(r2.error); return; }
      // questions_changed 소켓 이벤트로 자동 갱신됨
    };
  });
}

// ---------- 유저 관리 (카드형 스택) ----------
async function loadUsers() {
  const r = await api('list_users');
  if (!r.ok) { alert(r.error); return; }
  const box = document.getElementById('user-list');
  box.innerHTML = '';
  if (!r.users.length) {
    box.innerHTML = '<div class="text-slate-500 text-sm">등록된 유저 없음</div>';
    return;
  }
  r.users.forEach((u) => {
    const voted = u.voted === '1' || u.voted === 1;
    const div = document.createElement('div');
    div.className = 'p-3 rounded-xl bg-slate-900 flex items-center justify-between gap-2';
    div.innerHTML = `
      <div class="min-w-0">
        <div class="font-semibold truncate">${esc(u.nickname)}</div>
        <div class="text-xs text-slate-500">${esc(u.created_at)} · 투표 ${voted ? '✅' : '—'}</div>
      </div>
      <button class="shrink-0 text-xs px-3 py-2 min-h-[44px] rounded-lg bg-rose-700 active:bg-rose-600 font-semibold" data-del="${u.user_id}">삭제</button>`;
    box.appendChild(div);
  });
  box.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('이 유저를 삭제할까요? 진행 중인 게임의 종료 조건에서 제외됩니다.')) return;
      const r2 = await api('delete_user', { user_id: +b.dataset.del });
      if (!r2.ok) { alert(r2.error); return; }
      // users_changed 소켓 이벤트로 자동 갱신됨
    };
  });
}

// ---------- 소켓 ----------
function connectSocket(onQuestions, onUsers) {
  const socket = io();
  socket.on('questions_changed', () => { if (onQuestions) loadQuestions(); });
  socket.on('users_changed', () => { if (onUsers) loadUsers(); });
  socket.on('connect', () => {
    if (onQuestions) loadQuestions();
    if (onUsers) loadUsers();
  });
}

document.addEventListener('DOMContentLoaded', () => {
  const page = document.body.dataset.page;
  const isQ = page === 'questions';
  const isU = page === 'users';
  if (isQ) loadQuestions();
  if (isU) loadUsers();
  if (isQ || isU) connectSocket(isQ, isU);
});

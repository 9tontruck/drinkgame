// 어드민 페이지 v3 — Socket.io 실시간 갱신
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

// ---------- 그룹 목록 + 만들기 ----------
async function loadAdminGroups() {
  const r = await api('list_groups');
  if (!r.ok) { alert(r.error); return; }
  const list = document.getElementById('group-list');
  list.innerHTML = r.groups.length ? '' : '<div class="text-slate-500 text-sm">그룹 없음</div>';
  for (const g of r.groups) {
    const b = document.createElement('button');
    b.className = 'w-full text-left bg-slate-900 rounded-2xl p-4 space-y-1 active:bg-slate-800';
    b.innerHTML = `
      <div class="font-bold">${esc(g.name)}</div>
      <div class="text-xs text-slate-400">👥 ${g.members}명 참가 중</div>`;
    b.onclick = () => { location.href = 'groups/?gid=' + g.group_id; };
    list.appendChild(b);
  }
}

async function createGroup() {
  const name = document.getElementById('g-name').value.trim();
  const participants = document.getElementById('g-participants').value
    .split('\n').map((s) => s.trim()).filter((s) => s !== '');
  if (!name) { alert('그룹명을 입력해주세요'); return; }
  if (!participants.length) { alert('참가자를 1명 이상 입력해주세요'); return; }
  const r = await api('create_group', { name, participants });
  if (!r.ok) { alert(r.error); return; }
  document.getElementById('g-name').value = '';
  document.getElementById('g-participants').value = '';
  alert('그룹이 만들어졌습니다');
  loadAdminGroups();
}

// ---------- 그룹 상세 ----------
function groupIdFromQuery() {
  return parseInt(new URLSearchParams(location.search).get('gid') || '0', 10);
}

async function loadGroupDetail() {
  const gid = groupIdFromQuery();
  const gs = await api('group_state', { group_id: gid });
  if (!gs.ok) { alert(gs.error); location.href = '../'; return; }
  document.getElementById('g-title').textContent = '⚙️ ' + gs.group.name;

  // 참가자 = 그룹에 조인한 유저 (투표자)
  const mr = await api('list_group_members', { group_id: gid });
  if (mr.ok) {
    const box = document.getElementById('m-list');
    box.innerHTML = mr.members.length ? '' : '<div class="text-slate-500 text-xs">없음</div>';
    for (const m of mr.members) {
      const div = document.createElement('div');
      div.className = 'p-3 rounded-xl bg-slate-800 flex items-center justify-between gap-2';
      const joined = (m.joined_at || '').slice(0, 16).replace('T', ' ');
      div.innerHTML = `
        <div class="min-w-0">
          <div class="font-semibold text-sm truncate">${esc(m.nickname)}</div>
          <div class="text-[11px] text-slate-500">조인 ${esc(joined)}</div>
        </div>
        <button class="shrink-0 text-xs px-3 py-2 min-h-[44px] rounded-lg bg-rose-600 active:bg-rose-500 font-semibold"
          data-uid="${m.user_id}">삭제</button>`;
      box.appendChild(div);
    }
    box.querySelectorAll('[data-uid]').forEach((b) => {
      b.onclick = async () => {
        if (!confirm('이 참가자를 그룹에서 삭제할까요? (투표 카운트에서 제외됩니다)')) return;
        const r2 = await api('remove_group_member', { group_id: gid, user_id: +b.dataset.uid });
        if (!r2.ok) { alert(r2.error); return; }
      };
    });
  }

  const pr = await api('list_participants', { group_id: gid });
  if (pr.ok) {
    const box = document.getElementById('p-list');
    box.innerHTML = pr.participants.length ? '' : '<div class="text-slate-500 text-xs">없음</div>';
    for (const p of pr.participants) {
      const div = document.createElement('div');
      div.className = 'p-3 rounded-xl bg-slate-800 flex items-center justify-between gap-2' +
        (p.active ? '' : ' opacity-50');
      div.innerHTML = `
        <span class="font-semibold text-sm">${esc(p.name)}</span>
        <button class="shrink-0 text-xs px-3 py-2 min-h-[44px] rounded-lg font-semibold ${p.active ? 'bg-slate-700 active:bg-slate-600 text-slate-300' : 'bg-emerald-600 active:bg-emerald-500'}"
          data-pid="${p.participant_id}" data-active="${p.active ? 0 : 1}">
          ${p.active ? '비활성화' : '활성화'}
        </button>`;
      box.appendChild(div);
    }
    box.querySelectorAll('[data-pid]').forEach((b) => {
      b.onclick = async () => {
        const r2 = await api('set_participant_status', {
          participant_id: +b.dataset.pid, active: +b.dataset.active,
        });
        if (!r2.ok) { alert(r2.error); return; }
      };
    });
  }

  for (const type of ['image', 'ox']) {
    const qr = await api('list_questions', { group_id: gid, game_type: type });
    const box = document.getElementById(type === 'image' ? 'q-image' : 'q-ox');
    if (!qr.ok) { box.innerHTML = '<div class="text-rose-400 text-xs">불러오기 실패</div>'; continue; }
    const groups = { new: [], complete: [], hidden: [] };
    qr.questions.forEach((q) => groups[q.status].push(q));
    const tags = {
      new: '<span class="text-[10px] font-bold px-2 py-1 rounded bg-emerald-600">NEW</span>',
      complete: '<span class="text-[10px] font-bold px-2 py-1 rounded bg-slate-600">완료</span>',
      hidden: '<span class="text-[10px] font-bold px-2 py-1 rounded bg-slate-700 text-slate-400">숨김</span>',
    };
    box.innerHTML = '';
    let any = false;
    for (const [status, list] of Object.entries(groups)) {
      for (const q of list) {
        any = true;
        const div = document.createElement('div');
        div.className = 'p-3 rounded-xl bg-slate-800 flex items-center justify-between gap-2' +
          (status === 'complete' ? ' opacity-50' : '');
        const btn = status === 'hidden'
          ? `<button class="shrink-0 text-xs px-3 py-2 min-h-[44px] rounded-lg bg-emerald-600 active:bg-emerald-500 font-semibold" data-act="new" data-id="${q.question_id}">활성화</button>`
          : `<button class="shrink-0 text-xs px-3 py-2 min-h-[44px] rounded-lg bg-slate-700 active:bg-slate-600 text-slate-300" data-act="hidden" data-id="${q.question_id}">비활성화</button>`;
        div.innerHTML = `<div class="flex items-start gap-2 text-sm">${tags[status]}<span>${esc(q.question_text)}</span></div><div>${btn}</div>`;
        box.appendChild(div);
      }
    }
    if (!any) box.innerHTML = '<div class="text-slate-500 text-xs">없음</div>';
    box.querySelectorAll('[data-act]').forEach((b) => {
      b.onclick = async () => {
        const r2 = await api('set_question_status', { question_id: +b.dataset.id, status: b.dataset.act });
        if (!r2.ok) { alert(r2.error); return; }
      };
    });
  }
}

async function addParticipant() {
  const gid = groupIdFromQuery();
  const input = document.getElementById('p-name');
  const name = input.value.trim();
  if (!name) { alert('참가자 이름을 입력해주세요'); return; }
  const r = await api('add_participant', { group_id: gid, name });
  if (!r.ok) { alert(r.error); return; }
  input.value = '';
}

// ---------- 유저 관리 ----------
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
    const votedGames = (u.voted_game_ids || []).length;
    const div = document.createElement('div');
    div.className = 'p-3 rounded-xl bg-slate-900 flex items-center justify-between gap-2';
    div.innerHTML = `
      <div class="min-w-0">
        <div class="font-semibold truncate">${esc(u.nickname)}</div>
        <div class="text-xs text-slate-500">진행 중 게임 투표 ${votedGames > 0 ? '✅' : '—'}</div>
      </div>
      <button class="shrink-0 text-xs px-3 py-2 min-h-[44px] rounded-lg bg-rose-700 active:bg-rose-600 font-semibold" data-del="${u.user_id}">삭제</button>`;
    box.appendChild(div);
  });
  box.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('이 유저를 삭제할까요? 진행 중인 게임의 종료 조건에서 제외됩니다.')) return;
      const r2 = await api('delete_user', { user_id: +b.dataset.del });
      if (!r2.ok) { alert(r2.error); return; }
    };
  });
}

// ---------- 소켓 ----------
function connectSocket() {
  const page = document.body.dataset.page;
  const socket = io();
  const reload = () => {
    if (page === 'groups') loadAdminGroups();
    else if (page === 'group-detail') loadGroupDetail();
    else if (page === 'users') loadUsers();
  };
  socket.on('connect', () => {
    if (page === 'group-detail') socket.emit('join_room', { group_id: groupIdFromQuery() });
    reload();
  });
  socket.on('groups_changed', () => { if (page === 'groups') loadAdminGroups(); });
  socket.on('questions_changed', () => { if (page === 'group-detail') loadGroupDetail(); });
  socket.on('participants_changed', () => { if (page === 'group-detail') loadGroupDetail(); });
  socket.on('members_changed', () => { if (page === 'group-detail') loadGroupDetail(); });
  socket.on('users_changed', reload);
}

document.addEventListener('DOMContentLoaded', () => {
  const page = document.body.dataset.page;
  if (page === 'groups') {
    loadAdminGroups();
    document.getElementById('btn-create').onclick = createGroup;
  } else if (page === 'group-detail') {
    loadGroupDetail();
    document.getElementById('btn-add-p').onclick = addParticipant;
    document.getElementById('p-name').onkeydown = (e) => { if (e.key === 'Enter') addParticipant(); };
  } else if (page === 'users') {
    loadUsers();
  }
  connectSocket();
});

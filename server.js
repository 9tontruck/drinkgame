// drinkgame v3 — 파티게임 웹서버 (Node.js 단일 프로세스)
// HTTP API + 정적 파일 서빙 + Socket.io 실시간 브로드캐스트 (그룹별 룸)
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mysql = require('mysql2/promise');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '3000', 10);

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  database: process.env.DB_NAME || 'partygame',
  user: process.env.DB_USER || 'party',
  password: process.env.DB_PASS || '',
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4',
});

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- 응답 헬퍼 ----------
function fail(res, msg, code = 400) {
  res.status(code).json({ ok: false, error: msg });
}
function ok(res, data = {}) {
  res.json({ ok: true, ...data });
}

// ---------- 액션 로깅 (CloudWatch) ----------
// user_action + error만 기록. debug/info는 저장하지 않음.
const LOG_FILE = process.env.ACTION_LOG_FILE || '/var/log/drinkgame/app.log';
function writeLogLine(obj) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFile(LOG_FILE, JSON.stringify(obj) + '\n', () => {});
  } catch (e) { /* best effort — 로깅 실패가 API를 망가뜨리면 안 됨 */ }
}
function logUserAction(user, action, value) {
  writeLogLine({
    ts: new Date().toISOString(),
    type: 'user_action',
    session_id: user ? user.session_id : null,
    nickname: user ? user.nickname : null,
    action,
    ...(value !== undefined ? { value } : {}),
  });
}
function logError(action, err, extra) {
  writeLogLine({
    ts: new Date().toISOString(),
    type: 'error',
    action: action || null,
    msg: err && err.message,
    stack: err && err.stack,
    ...(extra || {}),
  });
}
process.on('uncaughtException', (e) => logError(null, e));
process.on('unhandledRejection', (e) => logError(null, e));

// ---------- 쿠키 ----------
function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (!h) return out;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function loginCookies(token, nickname) {
  const exp = new Date(Date.now() + 86400 * 1000).toUTCString();
  return [
    `pg_token=${token}; Path=/; HttpOnly; SameSite=Lax; Expires=${exp}`,
    `pg_nick=${encodeURIComponent(nickname)}; Path=/; SameSite=Lax; Expires=${exp}`,
  ];
}

// ---------- 유저 인증 ----------
async function currentUser(req) {
  const token = parseCookies(req).pg_token || '';
  if (!token) return null;
  const [rows] = await pool.query(
    'SELECT * FROM users WHERE token_id = ? AND deleted_at IS NULL', [token]);
  const u = rows[0];
  if (!u) return null;
  if (new Date(u.token_expires_at).getTime() < Date.now()) return null;
  // 슬라이딩 만료: 활동 시 1일 연장 (미확정 설계 — 고정 1일과 비교 중)
  await pool.query(
    'UPDATE users SET token_expires_at = DATE_ADD(NOW(), INTERVAL 1 DAY) WHERE user_id = ?',
    [u.user_id]);
  return u;
}
async function requireUser(req, res) {
  const u = await currentUser(req);
  if (!u) { fail(res, '닉네임을 먼저 등록해주세요', 401); return null; }
  return u;
}
function validNickname(nick) {
  nick = (nick || '').trim();
  return nick !== '' && [...nick].length <= 20;
}
async function nicknameTaken(nick, exceptId = null) {
  let sql = 'SELECT user_id FROM users WHERE nickname = ? AND deleted_at IS NULL';
  const args = [nick];
  if (exceptId) { sql += ' AND user_id != ?'; args.push(exceptId); }
  const [rows] = await pool.query(sql, args);
  return rows.length > 0;
}

// ---------- 그룹 헬퍼 ----------
const roomOf = (gid) => `group:${gid}`;

async function getGroup(gid) {
  const [rows] = await pool.query('SELECT * FROM `groups` WHERE group_id = ?', [gid]);
  return rows[0] || null;
}
async function isMember(userId, groupId) {
  const [rows] = await pool.query(
    'SELECT 1 FROM group_members WHERE user_id = ? AND group_id = ?', [userId, groupId]);
  return rows.length > 0;
}
async function requireMember(req, res, groupId) {
  const u = await requireUser(req, res);
  if (!u) return null;
  if (!(await isMember(u.user_id, groupId))) {
    fail(res, '그룹에 먼저 참가해주세요', 403);
    return null;
  }
  return u;
}
async function userGroupIds(userId) {
  const [rows] = await pool.query(
    'SELECT group_id FROM group_members WHERE user_id = ?', [userId]);
  return rows.map((r) => r.group_id);
}
// 유저가 속한 그룹 룸들에 이벤트 전송 (닉네임 변경 등)
async function emitToUserGroups(userId, event, data) {
  for (const gid of await userGroupIds(userId)) {
    io.to(roomOf(gid)).emit(event, data);
  }
}
async function memberCount(groupId) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) c FROM group_members gm
     JOIN users u ON u.user_id = gm.user_id
     WHERE gm.group_id = ? AND u.deleted_at IS NULL`, [groupId]);
  return Number(rows[0].c);
}

// ---------- 게임 로직 (그룹 단위) ----------
async function activeGame(groupId) {
  const [rows] = await pool.query(
    `SELECT g.*, q.question_text FROM games g
     JOIN questions q ON q.question_id = g.question_id
     WHERE g.group_id = ? AND g.status = 'active' ORDER BY g.game_id DESC LIMIT 1`,
    [groupId]);
  return rows[0] || null;
}
// 투표 자격자 = 그룹에 참가한, 삭제되지 않은 유저 (게임 중 들어온 사람도 투표해야 끝남)
async function eligibleVoterCount(groupId) {
  return memberCount(groupId);
}
async function votesCast(gameId) {
  const [rows] = await pool.query('SELECT COUNT(*) c FROM answers WHERE game_id = ?', [gameId]);
  return Number(rows[0].c);
}
async function userVoted(gameId, userId) {
  const [rows] = await pool.query(
    'SELECT answer_id FROM answers WHERE game_id = ? AND voter_user_id = ?', [gameId, userId]);
  return rows.length > 0;
}
// 전원 투표 시 게임 종료 + 질문 complete 처리
async function finishGameIfComplete(gameId) {
  const [rows] = await pool.query(
    "SELECT * FROM games WHERE game_id = ? AND status = 'active'", [gameId]);
  const g = rows[0];
  if (!g) return null;
  if ((await votesCast(gameId)) >= (await eligibleVoterCount(g.group_id))) {
    await pool.query(
      'UPDATE games SET status = ?, finished_at = NOW() WHERE game_id = ?',
      ['finished', gameId]);
    await pool.query('UPDATE questions SET status = ? WHERE question_id = ?',
      ['complete', g.question_id]);
    return g;
  }
  return null;
}
// 이미지게임 후보 = 그룹의 활성 참가자
async function candidates(groupId) {
  const [rows] = await pool.query(
    'SELECT participant_id, name FROM participants WHERE group_id = ? AND active = 1 ORDER BY name',
    [groupId]);
  return rows;
}
async function newQuestionCounts(groupId) {
  const [rows] = await pool.query(
    `SELECT game_type, COUNT(*) c FROM questions
     WHERE group_id = ? AND status = 'new' GROUP BY game_type`, [groupId]);
  const out = { image: 0, ox: 0 };
  for (const r of rows) out[r.game_type] = Number(r.c);
  return out;
}
async function buildResults(game) {
  if (game.game_type === 'image') {
    const [rows] = await pool.query(
      `SELECT target_participant_id, MAX(target_name) name, COUNT(*) votes
       FROM answers WHERE game_id = ? AND target_participant_id IS NOT NULL
       GROUP BY target_participant_id HAVING votes >= 1 ORDER BY votes DESC, name`,
      [game.game_id]);
    return { rows };
  }
  const [rows] = await pool.query(
    'SELECT choice, COUNT(*) c FROM answers WHERE game_id = ? GROUP BY choice', [game.game_id]);
  let o = 0, x = 0;
  for (const r of rows) {
    if (r.choice === 'O') o = Number(r.c);
    if (r.choice === 'X') x = Number(r.c);
  }
  return { o, x };
}
async function finishedPayload(gameId) {
  const [rows] = await pool.query(
    `SELECT g.*, q.question_text FROM games g
     JOIN questions q ON q.question_id = g.question_id WHERE g.game_id = ?`, [gameId]);
  const fg = rows[0];
  return {
    game_id: gameId,
    game_type: fg.game_type,
    question_text: fg.question_text,
    results: await buildResults(fg),
  };
}
async function activePayload(game, userId) {
  const total = await eligibleVoterCount(game.group_id);
  return {
    game_id: Number(game.game_id),
    game_type: game.game_type,
    question_text: game.question_text,
    voted: userId ? await userVoted(Number(game.game_id), userId) : false,
    votes_cast: await votesCast(Number(game.game_id)),
    total,
    candidates: game.game_type === 'image' ? await candidates(game.group_id) : [],
  };
}

// ---------- 소켓 (그룹별 룸) ----------
const server = http.createServer(app);
const io = new Server(server);
io.on('connection', (socket) => {
  socket.join('lobby'); // 그룹 목록 변경 수신용
  socket.on('join_room', (msg) => {
    const gid = parseInt((msg && msg.group_id) || '0', 10);
    if (gid > 0) socket.join(roomOf(gid));
  });
  socket.on('leave_room', (msg) => {
    const gid = parseInt((msg && msg.group_id) || '0', 10);
    if (gid > 0) socket.leave(roomOf(gid));
  });
});

// ---------- API: POST /api {action, ...} ----------
app.post('/api', async (req, res) => {
  const input = req.body || {};
  const action = input.action || '';
  try {
    // ----- 유저 -----
    if (action === 'register') {
      const nick = (input.nickname || '').trim();
      if (!validNickname(nick)) return fail(res, '닉네임은 1~20자로 입력해주세요');
      if (await nicknameTaken(nick)) return fail(res, '이미 사용 중인 닉네임입니다');
      const sessionId = crypto.randomBytes(16).toString('hex');
      const token = crypto.randomBytes(32).toString('hex');
      await pool.query(
        `INSERT INTO users (nickname, session_id, token_id, token_expires_at)
         VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 1 DAY))`,
        [nick, sessionId, token]);
      res.setHeader('Set-Cookie', loginCookies(token, nick));
      logUserAction({ session_id: sessionId, nickname: nick }, 'register', { nickname: nick });
      return ok(res, { nickname: nick });
    }

    if (action === 'rename') {
      const u = await requireUser(req, res);
      if (!u) return;
      const nick = (input.nickname || '').trim();
      if (!validNickname(nick)) return fail(res, '닉네임은 1~20자로 입력해주세요');
      if (nick === u.nickname) return ok(res, { nickname: nick });
      if (await nicknameTaken(nick, u.user_id)) return fail(res, '이미 사용 중인 닉네임입니다');
      await pool.query('UPDATE users SET nickname = ? WHERE user_id = ?', [nick, u.user_id]);
      res.setHeader('Set-Cookie', loginCookies(parseCookies(req).pg_token, nick));
      logUserAction(u, 'rename', { from: u.nickname, to: nick });
      await emitToUserGroups(u.user_id, 'users_changed', {});
      return ok(res, { nickname: nick });
    }

    if (action === 'me') {
      const u = await currentUser(req);
      if (!u) return ok(res, { user: null });
      return ok(res, { user: { user_id: u.user_id, nickname: u.nickname } });
    }

    // ----- 그룹 -----
    if (action === 'list_groups') {
      const [rows] = await pool.query(
        `SELECT g.group_id, g.name, g.created_at,
                (SELECT COUNT(*) FROM group_members gm
                 JOIN users u ON u.user_id = gm.user_id
                 WHERE gm.group_id = g.group_id AND u.deleted_at IS NULL) AS members
         FROM \`groups\` g ORDER BY g.group_id DESC`);
      return ok(res, {
        groups: rows.map((r) => ({
          group_id: r.group_id,
          name: r.name,
          members: Number(r.members),
          created_at: r.created_at,
        })),
      });
    }

    if (action === 'create_group') {
      const u = await requireUser(req, res);
      if (!u) return;
      const name = (input.name || '').trim();
      if (!name || [...name].length > 100) return fail(res, '그룹명을 1~100자로 입력해주세요');
      const names = [...new Set(
        (Array.isArray(input.participants) ? input.participants : [])
          .map((s) => (s || '').trim())
          .filter((s) => s !== '' && [...s].length <= 50)
      )];
      if (names.length === 0) return fail(res, '참가자를 1명 이상 입력해주세요');
      const [r] = await pool.query('INSERT INTO `groups` (name) VALUES (?)', [name]);
      const gid = r.insertId;
      for (const n of names) {
        await pool.query(
          'INSERT IGNORE INTO participants (group_id, name) VALUES (?, ?)', [gid, n]);
      }
      logUserAction(u, 'create_group', { group_id: gid, name, participants: names });
      io.to('lobby').emit('groups_changed', {});
      return ok(res, { group_id: gid });
    }

    if (action === 'join_group') {
      const u = await requireUser(req, res);
      if (!u) return;
      const gid = parseInt(input.group_id || '0', 10);
      const g = await getGroup(gid);
      if (!g) return fail(res, '그룹을 찾을 수 없습니다', 404);
      await pool.query(
        'INSERT IGNORE INTO group_members (user_id, group_id) VALUES (?, ?)',
        [u.user_id, gid]);
      logUserAction(u, 'join_group', { group_id: gid, name: g.name });
      io.to(roomOf(gid)).emit('users_changed', {});
      return ok(res, { joined: true });
    }

    if (action === 'group_state') {
      const u = await currentUser(req);
      const gid = parseInt(input.group_id || '0', 10);
      const g = await getGroup(gid);
      if (!g) return fail(res, '그룹을 찾을 수 없습니다', 404);
      const ag = await activeGame(gid);
      return ok(res, {
        group: { group_id: g.group_id, name: g.name },
        is_member: u ? await isMember(u.user_id, gid) : false,
        members: await memberCount(gid),
        new_counts: await newQuestionCounts(gid),
        active: ag ? await activePayload(ag, u ? u.user_id : null) : null,
      });
    }

    // ----- 질문 -----
    if (action === 'add_question') {
      const gid = parseInt(input.group_id || '0', 10);
      const u = await requireMember(req, res, gid);
      if (!u) return;
      const type = input.game_type === 'ox' ? 'ox' : 'image';
      const text = (input.text || '').trim();
      if (!text || [...text].length > 300) return fail(res, '질문은 1~300자로 입력해주세요');
      await pool.query(
        'INSERT INTO questions (group_id, game_type, question_text, created_by) VALUES (?, ?, ?, ?)',
        [gid, type, text, u.user_id]);
      logUserAction(u, 'add_question', { group_id: gid, game_type: type, text });
      io.to(roomOf(gid)).emit('questions_changed', {});
      return ok(res);
    }

    if (action === 'list_questions') {
      const gid = parseInt(input.group_id || '0', 10);
      const u = await requireUser(req, res);
      if (!u) return;
      if (!(await getGroup(gid))) return fail(res, '그룹을 찾을 수 없습니다', 404);
      let sql = 'SELECT * FROM questions WHERE group_id = ?';
      const args = [gid];
      if (input.game_type === 'image' || input.game_type === 'ox') {
        sql += ' AND game_type = ?';
        args.push(input.game_type);
      }
      if (['new', 'complete', 'hidden'].includes(input.status)) {
        sql += ' AND status = ?';
        args.push(input.status);
      }
      sql += ' ORDER BY question_id DESC';
      const [rows] = await pool.query(sql, args);
      return ok(res, { questions: rows });
    }

    if (action === 'set_question_status') {
      const u = await requireUser(req, res);
      if (!u) return;
      const qid = parseInt(input.question_id || '0', 10);
      const status = input.status;
      if (!['new', 'complete', 'hidden'].includes(status)) return fail(res, '잘못된 상태입니다');
      const [qrows] = await pool.query('SELECT group_id FROM questions WHERE question_id = ?', [qid]);
      if (!qrows[0]) return fail(res, '질문을 찾을 수 없습니다', 404);
      await pool.query('UPDATE questions SET status = ? WHERE question_id = ?', [status, qid]);
      logUserAction(u, 'set_question_status', { question_id: qid, status });
      io.to(roomOf(qrows[0].group_id)).emit('questions_changed', {});
      return ok(res);
    }

    // ----- 참가자 (어드민) -----
    if (action === 'list_participants') {
      const gid = parseInt(input.group_id || '0', 10);
      if (!(await getGroup(gid))) return fail(res, '그룹을 찾을 수 없습니다', 404);
      const [rows] = await pool.query(
        'SELECT participant_id, name, active FROM participants WHERE group_id = ? ORDER BY name',
        [gid]);
      return ok(res, { participants: rows });
    }

    if (action === 'add_participant') {
      const u = await requireUser(req, res);
      if (!u) return;
      const gid = parseInt(input.group_id || '0', 10);
      if (!(await getGroup(gid))) return fail(res, '그룹을 찾을 수 없습니다', 404);
      const name = (input.name || '').trim();
      if (!name || [...name].length > 50) return fail(res, '참가자 이름은 1~50자로 입력해주세요');
      const [r] = await pool.query(
        'INSERT IGNORE INTO participants (group_id, name) VALUES (?, ?)', [gid, name]);
      logUserAction(u, 'add_participant', { group_id: gid, name });
      io.to(roomOf(gid)).emit('participants_changed', {});
      return ok(res, { participant_id: r.insertId || null });
    }

    if (action === 'set_participant_status') {
      const u = await requireUser(req, res);
      if (!u) return;
      const pid = parseInt(input.participant_id || '0', 10);
      const active = input.active ? 1 : 0;
      const [prows] = await pool.query(
        'SELECT group_id FROM participants WHERE participant_id = ?', [pid]);
      if (!prows[0]) return fail(res, '참가자를 찾을 수 없습니다', 404);
      await pool.query('UPDATE participants SET active = ? WHERE participant_id = ?',
        [active, pid]);
      logUserAction(u, 'set_participant_status', { participant_id: pid, active });
      io.to(roomOf(prows[0].group_id)).emit('participants_changed', {});
      return ok(res);
    }

    // ----- 게임 -----
    if (action === 'start_game') {
      const gid = parseInt(input.group_id || '0', 10);
      const u = await requireMember(req, res, gid);
      if (!u) return;
      const type = input.game_type === 'ox' ? 'ox' : 'image';
      // new 질문 중 랜덤 1개
      const [qrows] = await pool.query(
        `SELECT question_id, question_text FROM questions
         WHERE group_id = ? AND game_type = ? AND status = 'new'
         ORDER BY RAND() LIMIT 1`,
        [gid, type]);
      const q = qrows[0];
      if (!q) return fail(res, '시작할 수 있는 질문이 없습니다');
      let gidNew;
      try {
        const [r] = await pool.query(
          'INSERT INTO games (group_id, question_id, game_type) VALUES (?, ?, ?)',
          [gid, q.question_id, type]);
        gidNew = r.insertId;
      } catch (e) {
        if (e.errno === 1062) return fail(res, '이미 진행 중인 게임이 있습니다');
        throw e;
      }
      const total = await eligibleVoterCount(gid);
      io.to(roomOf(gid)).emit('game_started', {
        game_id: gidNew,
        game_type: type,
        question_text: q.question_text,
        total,
        candidates: type === 'image' ? await candidates(gid) : [],
      });
      logUserAction(u, 'start_game',
        { group_id: gid, game_id: gidNew, question_id: q.question_id, game_type: type });
      return ok(res, { game_id: gidNew });
    }

    if (action === 'game_state') {
      const u = await currentUser(req);
      const gid = parseInt(input.group_id || '0', 10);
      if (!(await getGroup(gid))) return fail(res, '그룹을 찾을 수 없습니다', 404);
      const ag = await activeGame(gid);
      const out = { active: null, last_finished: null };
      if (ag) {
        out.active = await activePayload(ag, u ? u.user_id : null);
      } else {
        const [frows] = await pool.query(
          `SELECT g.*, q.question_text FROM games g
           JOIN questions q ON q.question_id = g.question_id
           WHERE g.group_id = ? AND g.status = 'finished'
           ORDER BY g.game_id DESC LIMIT 1`,
          [gid]);
        const f = frows[0];
        if (f) {
          out.last_finished = {
            game_id: Number(f.game_id),
            game_type: f.game_type,
            question_text: f.question_text,
            results: await buildResults(f),
          };
        }
      }
      return ok(res, out);
    }

    if (action === 'vote') {
      const u = await requireUser(req, res);
      if (!u) return;
      const gameId = parseInt(input.game_id || '0', 10);
      const [grows] = await pool.query(
        "SELECT g.*, q.question_text FROM games g JOIN questions q ON q.question_id = g.question_id WHERE g.game_id = ? AND g.status = 'active'",
        [gameId]);
      const g = grows[0];
      if (!g) return fail(res, '진행 중인 게임이 아닙니다');
      if (!(await isMember(u.user_id, g.group_id))) return fail(res, '그룹에 먼저 참가해주세요', 403);
      if (await userVoted(gameId, u.user_id)) return fail(res, '이미 투표했습니다');
      let voteDetail;
      if (g.game_type === 'image') {
        const pid = parseInt(input.target_participant_id || '0', 10);
        const [prows] = await pool.query(
          'SELECT name FROM participants WHERE participant_id = ? AND group_id = ? AND active = 1',
          [pid, g.group_id]);
        const p = prows[0];
        if (!p) return fail(res, '투표 대상이 올바르지 않습니다');
        await pool.query(
          `INSERT INTO answers (game_id, voter_user_id, target_participant_id, target_name)
           VALUES (?, ?, ?, ?)`,
          [gameId, u.user_id, pid, p.name]);
        voteDetail = { target_participant_id: pid, target_name: p.name };
      } else {
        const choice = input.choice || '';
        if (!['O', 'X'].includes(choice)) return fail(res, 'O 또는 X를 선택해주세요');
        await pool.query(
          'INSERT INTO answers (game_id, voter_user_id, choice) VALUES (?, ?, ?)',
          [gameId, u.user_id, choice]);
        voteDetail = { choice };
      }
      const finishedGame = await finishGameIfComplete(gameId);
      if (finishedGame) {
        io.to(roomOf(g.group_id)).emit('game_finished', await finishedPayload(gameId));
      } else {
        io.to(roomOf(g.group_id)).emit('vote_progress', {
          game_id: gameId,
          voted: await votesCast(gameId),
          total: await eligibleVoterCount(g.group_id),
        });
      }
      logUserAction(u, 'vote', { game_id: gameId, ...voteDetail, finished: !!finishedGame });
      return ok(res, { finished: !!finishedGame });
    }

    if (action === 'game_results') {
      const gameId = parseInt(input.game_id || '0', 10);
      const [rows] = await pool.query('SELECT game_id FROM games WHERE game_id = ?', [gameId]);
      if (!rows[0]) return fail(res, '게임을 찾을 수 없습니다', 404);
      return ok(res, await finishedPayload(gameId));
    }

    // ----- 어드민: 유저 -----
    if (action === 'list_users') {
      const u = await requireUser(req, res);
      if (!u) return;
      const [rows] = await pool.query(
        `SELECT user_id, nickname, created_at FROM users
         WHERE deleted_at IS NULL ORDER BY created_at DESC`);
      const [vrows] = await pool.query(
        `SELECT a.voter_user_id AS user_id, a.game_id, g.status
         FROM answers a JOIN games g ON g.game_id = a.game_id`);
      const votedByGame = {};
      for (const r of vrows) {
        votedByGame[r.game_id] = votedByGame[r.game_id] || {};
        votedByGame[r.game_id][r.user_id] = true;
      }
      const [agrows] = await pool.query(
        "SELECT game_id, group_id FROM games WHERE status = 'active'");
      const activeGames = agrows.map((r) => ({
        game_id: Number(r.game_id),
        group_id: Number(r.group_id),
      }));
      return ok(res, {
        users: rows.map((x) => ({
          user_id: x.user_id,
          nickname: x.nickname,
          created_at: x.created_at,
          voted_game_ids: activeGames
            .filter((g) => votedByGame[g.game_id] && votedByGame[g.game_id][x.user_id])
            .map((g) => g.game_id),
        })),
        active_games: activeGames,
      });
    }

    if (action === 'delete_user') {
      const u = await requireUser(req, res);
      if (!u) return;
      const uid = parseInt(input.user_id || '0', 10);
      const [ur] = await pool.query(
        'UPDATE users SET deleted_at = NOW() WHERE user_id = ? AND deleted_at IS NULL', [uid]);
      if (ur.affectedRows === 0) return fail(res, '유저를 찾을 수 없습니다', 404);
      // 진행 중인 모든 게임의 종료 조건 재계산 (orphan 방지)
      const [agrows] = await pool.query("SELECT game_id FROM games WHERE status = 'active'");
      for (const ar of agrows) {
        const fg = await finishGameIfComplete(Number(ar.game_id));
        if (fg) io.to(roomOf(fg.group_id)).emit('game_finished', await finishedPayload(fg.game_id));
      }
      logUserAction(u, 'delete_user', { user_id: uid });
      await emitToUserGroups(uid, 'users_changed', {});
      return ok(res);
    }

    return fail(res, '알 수 없는 action입니다', 404);
  } catch (e) {
    console.error('API error:', e.message);
    logError(action, e);
    return fail(res, '서버 오류가 발생했습니다', 500);
  }
});

// ---------- 정적 파일 ----------
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

server.listen(PORT, () => console.log(`drinkgame v3 listening on :${PORT}`));

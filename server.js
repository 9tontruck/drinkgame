// drinkgame — 파티게임 웹서버 (Node.js 단일 프로세스)
// HTTP API + 정적 파일 서빙 + Socket.io 실시간 브로드캐스트
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

// ---------- 게임 로직 ----------
async function activeGame() {
  const [rows] = await pool.query(
    `SELECT g.*, q.question_text FROM games g
     JOIN questions q ON q.question_id = g.question_id
     WHERE g.status = 'active' ORDER BY g.game_id DESC LIMIT 1`);
  return rows[0] || null;
}
// 투표 자격자 = 현재 삭제되지 않은 모든 유저 (게임 중 들어온 사람도 투표해야 게임이 끝남)
async function eligibleVoterCount() {
  const [rows] = await pool.query('SELECT COUNT(*) c FROM users WHERE deleted_at IS NULL');
  return Number(rows[0].c);
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
// 전원 투표 시 게임 종료 + 질문 complete 처리 (투표 후, 유저 삭제 후 호출)
async function finishGameIfComplete(gameId) {
  const [rows] = await pool.query(
    "SELECT * FROM games WHERE game_id = ? AND status = 'active'", [gameId]);
  const g = rows[0];
  if (!g) return false;
  if ((await votesCast(gameId)) >= (await eligibleVoterCount())) {
    await pool.query(
      'UPDATE games SET status = ? , finished_at = NOW() WHERE game_id = ?',
      ['finished', gameId]);
    await pool.query('UPDATE questions SET status = ? WHERE question_id = ?',
      ['complete', g.question_id]);
    return true;
  }
  return false;
}
async function candidates() {
  const [rows] = await pool.query(
    'SELECT user_id, nickname FROM users WHERE deleted_at IS NULL ORDER BY nickname');
  return rows;
}
async function buildResults(game) {
  if (game.game_type === 'image') {
    const [rows] = await pool.query(
      `SELECT target_user_id, MAX(target_nickname) nickname, COUNT(*) votes
       FROM answers WHERE game_id = ? AND target_user_id IS NOT NULL
       GROUP BY target_user_id HAVING votes >= 1 ORDER BY votes DESC, nickname`,
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

// ---------- 소켓 ----------
const server = http.createServer(app);
const io = new Server(server);
io.on('connection', () => { /* 서버 푸시 전용 — 클라이언트 게임 액션은 listen하지 않음 */ });

// ---------- API: POST /api {action, ...} ----------
app.post('/api', async (req, res) => {
  const input = req.body || {};
  const action = input.action || '';
  try {
    switch (action) {
      case 'register': {
        const nick = (input.nickname || '').trim();
        if (!validNickname(nick)) return fail(res, '닉네임을 1~20자로 입력해주세요');
        if (await nicknameTaken(nick)) return fail(res, '이미 사용 중인 닉네임입니다');
        const token = crypto.randomBytes(32).toString('hex');
        const sessionId = crypto.randomBytes(16).toString('hex');
        await pool.query(
          `INSERT INTO users (session_id, nickname, token_id, token_expires_at)
           VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 1 DAY))`,
          [sessionId, nick, token]);
        res.setHeader('Set-Cookie', loginCookies(token, nick));
        io.emit('users_changed');
        logUserAction({ session_id: sessionId, nickname: nick }, 'register', { nickname: nick });
        return ok(res, { nickname: nick });
      }

      case 'rename': {
        const u = await requireUser(req, res);
        if (!u) return;
        const nick = (input.nickname || '').trim();
        if (!validNickname(nick)) return fail(res, '닉네임을 1~20자로 입력해주세요');
        if (nick !== u.nickname && await nicknameTaken(nick, u.user_id)) {
          return fail(res, '이미 사용 중인 닉네임입니다');
        }
        await pool.query('UPDATE users SET nickname = ? WHERE user_id = ?', [nick, u.user_id]);
        res.setHeader('Set-Cookie', loginCookies(parseCookies(req).pg_token, nick));
        io.emit('users_changed');
        logUserAction(u, 'rename', { from: u.nickname, to: nick });
        return ok(res, { nickname: nick });
      }

      case 'me': {
        const u = await currentUser(req);
        return ok(res, { user: u ? { nickname: u.nickname } : null });
      }

      case 'add_question': {
        const u = await requireUser(req, res);
        if (!u) return;
        const type = input.game_type || '';
        const text = (input.text || '').trim();
        if (!['image', 'ox'].includes(type)) return fail(res, '게임 타입이 올바르지 않습니다');
        if (text === '' || [...text].length > 500) return fail(res, '질문을 1~500자로 입력해주세요');
        await pool.query(
          'INSERT INTO questions (game_type, question_text, created_by) VALUES (?, ?, ?)',
          [type, text, u.user_id]);
        io.emit('questions_changed');
        logUserAction(u, 'add_question', { game_type: type, text });
        return ok(res);
      }

      case 'list_questions': { // 어드민용: new → complete → hidden 순
        const u = await requireUser(req, res);
        if (!u) return;
        const type = input.game_type || '';
        if (!['image', 'ox'].includes(type)) return fail(res, '게임 타입이 올바르지 않습니다');
        const [rows] = await pool.query(
          `SELECT question_id, game_type, question_text, status, created_at
           FROM questions WHERE game_type = ?
           ORDER BY FIELD(status, 'new', 'complete', 'hidden'), created_at DESC`,
          [type]);
        return ok(res, { questions: rows });
      }

      case 'set_question_status': {
        const u = await requireUser(req, res);
        if (!u) return;
        const qid = parseInt(input.question_id || '0', 10);
        const status = input.status || '';
        if (!['new', 'complete', 'hidden'].includes(status)) {
          return fail(res, '상태값이 올바르지 않습니다');
        }
        const [r] = await pool.query('UPDATE questions SET status = ? WHERE question_id = ?',
          [status, qid]);
        if (r.affectedRows === 0) return fail(res, '질문을 찾을 수 없습니다', 404);
        io.emit('questions_changed');
        logUserAction(u, 'set_question_status', { question_id: qid, status });
        return ok(res);
      }

      case 'list_new_questions': { // 게임 시작 선택용
        const u = await requireUser(req, res);
        if (!u) return;
        const type = input.game_type || '';
        if (!['image', 'ox'].includes(type)) return fail(res, '게임 타입이 올바르지 않습니다');
        const [rows] = await pool.query(
          `SELECT question_id, question_text FROM questions
           WHERE game_type = ? AND status = 'new' ORDER BY created_at DESC`, [type]);
        return ok(res, { questions: rows });
      }

      case 'start_game': {
        const u = await requireUser(req, res);
        if (!u) return;
        const qid = parseInt(input.question_id || '0', 10);
        const [qrows] = await pool.query(
          "SELECT * FROM questions WHERE question_id = ? AND status = 'new'", [qid]);
        const q = qrows[0];
        if (!q) return fail(res, '시작할 수 있는 질문이 아닙니다');
        try {
          await pool.query('INSERT INTO games (question_id, game_type) VALUES (?, ?)',
            [qid, q.game_type]);
        } catch (e) {
          if (e.errno === 1062) return fail(res, '이미 진행 중인 게임이 있습니다');
          throw e;
        }
        const [grows] = await pool.query('SELECT LAST_INSERT_ID() gid');
        const gid = Number(grows[0].gid);
        const g = await activeGame();
        io.emit('game_started', {
          game_id: gid,
          game_type: g.game_type,
          question_text: g.question_text,
          total: await eligibleVoterCount(),
          candidates: g.game_type === 'image' ? await candidates() : [],
        });
        logUserAction(u, 'start_game', { game_id: gid, question_id: qid, game_type: g.game_type });
        return ok(res, { game_id: gid });
      }

      case 'game_state': { // 소켓 (재)접속 시 1회 동기화용
        const u = await requireUser(req, res);
        if (!u) return;
        const out = { active: null, last_finished: null };
        const g = await activeGame();
        if (g) {
          out.active = {
            game_id: Number(g.game_id),
            game_type: g.game_type,
            question_text: g.question_text,
            voted: await userVoted(Number(g.game_id), u.user_id),
            votes_cast: await votesCast(Number(g.game_id)),
            total: await eligibleVoterCount(),
            candidates: g.game_type === 'image' ? await candidates() : [],
          };
        } else {
          const [frows] = await pool.query(
            `SELECT g.*, q.question_text FROM games g
             JOIN questions q ON q.question_id = g.question_id
             WHERE g.status = 'finished' ORDER BY g.finished_at DESC LIMIT 1`);
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

      case 'vote': {
        const u = await requireUser(req, res);
        if (!u) return;
        const gid = parseInt(input.game_id || '0', 10);
        const g = await activeGame();
        if (!g || Number(g.game_id) !== gid) return fail(res, '진행 중인 게임이 아닙니다');
        if (await userVoted(gid, u.user_id)) return fail(res, '이미 투표했습니다');
        let voteDetail;
        if (g.game_type === 'image') {
          const tid = parseInt(input.target_user_id || '0', 10);
          const [trows] = await pool.query(
            'SELECT nickname FROM users WHERE user_id = ? AND deleted_at IS NULL', [tid]);
          const t = trows[0];
          if (!t) return fail(res, '투표 대상이 올바르지 않습니다');
          await pool.query(
            `INSERT INTO answers (game_id, voter_user_id, target_user_id, target_nickname)
             VALUES (?, ?, ?, ?)`,
            [gid, u.user_id, tid, t.nickname]);
          voteDetail = { target_user_id: tid, target_nickname: t.nickname };
        } else {
          const choice = input.choice || '';
          if (!['O', 'X'].includes(choice)) return fail(res, 'O 또는 X를 선택해주세요');
          await pool.query(
            'INSERT INTO answers (game_id, voter_user_id, choice) VALUES (?, ?, ?)',
            [gid, u.user_id, choice]);
          voteDetail = { choice };
        }
        const finished = await finishGameIfComplete(gid);
        if (finished) {
          io.emit('game_finished', await finishedPayload(gid));
        } else {
          io.emit('vote_progress', {
            game_id: gid,
            voted: await votesCast(gid),
            total: await eligibleVoterCount(),
          });
        }
        logUserAction(u, 'vote', { game_id: gid, ...voteDetail, finished });
        return ok(res, { finished });
      }

      case 'game_results': {
        const u = await requireUser(req, res);
        if (!u) return;
        const gid = parseInt(input.game_id || '0', 10);
        const [grows] = await pool.query(
          `SELECT g.*, q.question_text FROM games g
           JOIN questions q ON q.question_id = g.question_id WHERE g.game_id = ?`, [gid]);
        const gm = grows[0];
        if (!gm) return fail(res, '게임을 찾을 수 없습니다', 404);
        return ok(res, {
          game_id: Number(gm.game_id),
          game_type: gm.game_type,
          question_text: gm.question_text,
          status: gm.status,
          results: await buildResults(gm),
        });
      }

      case 'list_users': { // 어드민 유저 관리
        const u = await requireUser(req, res);
        if (!u) return;
        const g = await activeGame();
        const votedSel = g ? ', (a.answer_id IS NOT NULL) AS voted' : ', 0 AS voted';
        const join = g
          ? ` LEFT JOIN answers a ON a.game_id = ${Number(g.game_id)} AND a.voter_user_id = u.user_id`
          : '';
        const [rows] = await pool.query(
          `SELECT u.user_id, u.nickname, u.session_id, u.created_at, u.token_expires_at${votedSel}
           FROM users u${join}
           WHERE u.deleted_at IS NULL ORDER BY u.created_at`);
        return ok(res, { users: rows });
      }

      case 'delete_user': { // orphan 유저 삭제 → 진행 중 게임 종료 조건 재계산
        const u = await requireUser(req, res);
        if (!u) return;
        const uid = parseInt(input.user_id || '0', 10);
        const [r] = await pool.query(
          'UPDATE users SET deleted_at = NOW(), token_expires_at = NOW() WHERE user_id = ? AND deleted_at IS NULL',
          [uid]);
        if (r.affectedRows === 0) return fail(res, '유저를 찾을 수 없습니다', 404);
        const g = await activeGame();
        if (g && await finishGameIfComplete(Number(g.game_id))) {
          io.emit('game_finished', await finishedPayload(Number(g.game_id)));
        }
        io.emit('users_changed');
        logUserAction(u, 'delete_user', { user_id: uid });
        return ok(res);
      }

      default:
        return fail(res, '알 수 없는 요청입니다', 404);
    }
  } catch (e) {
    console.error('API error:', e.message);
    logError(action, e);
    return fail(res, '서버 오류가 발생했습니다', 500);
  }
});

server.listen(PORT, () => {
  console.log(`drinkgame listening on :${PORT}`);
});

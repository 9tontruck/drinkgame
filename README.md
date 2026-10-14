# drinkgame — 파티게임 (Node.js)

모바일 실시간 투표 파티게임. 단일 Node.js 프로세스가 HTTP API + 정적 파일 + Socket.io를 모두 처리한다.

## 구조

```
server.js          Express + Socket.io 서버 (API 13개 액션)
public/            정적 파일 (index.html, admin/, assets/)
  index.html       유저 메인 화면
  admin/           어드민 (질문 관리, 유저 관리)
  assets/js/       app.js, admin.js (Tailwind + Socket.io 클라이언트)
schema.sql         MySQL 8.0 스키마
```

## 실행

```bash
cp .env.example .env   # DB 정보 입력
npm install
npm start              # PORT 기본 3000
```

DB 준비:

```bash
mysql -u root -p -e "CREATE DATABASE partygame CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
mysql -u root -p partygame < schema.sql
# + partygame 유저 생성/권한 부여
```

## API

`POST /api` — JSON `{action, ...}` → `{ok:true/false, ...}`

유저: `register`, `rename`, `me`
질문: `add_question`, `list_questions`, `set_question_status`, `list_new_questions`
게임: `start_game`, `game_state`, `vote`, `game_results`
어드민: `list_users`, `delete_user`

## 실시간 이벤트 (Socket.io)

`users_changed`, `questions_changed`, `game_started`, `vote_progress`, `game_finished`

게임 로직은 서버에만 있고, 소켓은 브로드캐스트 전용이다.
투표 자격자 = 현재 삭제되지 않은 모든 유저. 투표 수 ≥ 자격자 수면 자동 종료.

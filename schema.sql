-- 파티게임 DB 스키마 (MySQL 8.0)
-- 사용 전 CREATE DATABASE partygame ... 후 이 파일을 해당 DB에 적용

-- 유저: session_id = PHP 세션 ID (unique user id 역할), token 1일 유효
CREATE TABLE users (
  user_id INT AUTO_INCREMENT PRIMARY KEY,
  session_id VARCHAR(128) NOT NULL,
  nickname VARCHAR(50) NOT NULL,
  nickname_active VARCHAR(50) GENERATED ALWAYS AS (IF(deleted_at IS NULL, nickname, NULL)) VIRTUAL,
  token_id VARCHAR(64) NOT NULL,
  token_expires_at DATETIME NOT NULL,
  deleted_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_token (token_id),
  UNIQUE KEY uq_nickname_active (nickname_active)
) ENGINE=InnoDB;

-- 질문: 이미지게임 / OX게임, 상태 new → complete(게임 종료 시) / hidden(관리자 비활성화)
CREATE TABLE questions (
  question_id INT AUTO_INCREMENT PRIMARY KEY,
  game_type ENUM('image','ox') NOT NULL,
  question_text TEXT NOT NULL,
  status ENUM('new','complete','hidden') NOT NULL DEFAULT 'new',
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(user_id)
) ENGINE=InnoDB;

-- 게임: 동시 진행 1개만 허용 (active_lock 유니크 트릭)
CREATE TABLE games (
  game_id INT AUTO_INCREMENT PRIMARY KEY,
  question_id INT NOT NULL,
  game_type ENUM('image','ox') NOT NULL,
  status ENUM('active','finished') NOT NULL DEFAULT 'active',
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at DATETIME NULL,
  active_lock VARCHAR(10) GENERATED ALWAYS AS (IF(status='active','x',NULL)) VIRTUAL,
  UNIQUE KEY uq_one_active (active_lock),
  FOREIGN KEY (question_id) REFERENCES questions(question_id)
) ENGINE=InnoDB;

-- 투표: 게임당 유저당 1표. 이미지=target_user_id, OX=choice
CREATE TABLE answers (
  answer_id INT AUTO_INCREMENT PRIMARY KEY,
  game_id INT NOT NULL,
  voter_user_id INT NOT NULL,
  target_user_id INT NULL,
  target_nickname VARCHAR(50) NULL,
  choice CHAR(1) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_vote_once (game_id, voter_user_id),
  FOREIGN KEY (game_id) REFERENCES games(game_id),
  FOREIGN KEY (voter_user_id) REFERENCES users(user_id)
) ENGINE=InnoDB;

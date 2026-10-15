-- drinkgame 스키마 v3 (그룹 지원)
-- MySQL 8.0 / utf8mb4

CREATE TABLE IF NOT EXISTS users (
  user_id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  nickname VARCHAR(20) NOT NULL,
  session_id CHAR(32) NOT NULL,
  token_id CHAR(64) NOT NULL,
  token_expires_at DATETIME NOT NULL,
  deleted_at DATETIME NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_nickname_live (nickname, deleted_at),
  UNIQUE KEY uq_token (token_id),
  INDEX idx_session (session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `groups` (
  group_id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 이미지게임 투표 후보 (이름만, 로그인 없음)
CREATE TABLE IF NOT EXISTS participants (
  participant_id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  group_id INT UNSIGNED NOT NULL,
  name VARCHAR(50) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_participant (group_id, name),
  INDEX idx_group (group_id),
  FOREIGN KEY (group_id) REFERENCES `groups` (group_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 그룹에 참가한 유저 = 투표자
CREATE TABLE IF NOT EXISTS group_members (
  user_id INT UNSIGNED NOT NULL,
  group_id INT UNSIGNED NOT NULL,
  joined_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, group_id),
  INDEX idx_group (group_id),
  FOREIGN KEY (user_id) REFERENCES users (user_id) ON DELETE CASCADE,
  FOREIGN KEY (group_id) REFERENCES `groups` (group_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS questions (
  question_id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  group_id INT UNSIGNED NOT NULL,
  game_type ENUM('image','ox') NOT NULL,
  question_text VARCHAR(300) NOT NULL,
  status ENUM('new','complete','hidden') NOT NULL DEFAULT 'new',
  created_by INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_group_type_status (group_id, game_type, status),
  FOREIGN KEY (group_id) REFERENCES `groups` (group_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS games (
  game_id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  group_id INT UNSIGNED NOT NULL,
  question_id INT UNSIGNED NOT NULL,
  game_type ENUM('image','ox') NOT NULL,
  status ENUM('active','finished') NOT NULL DEFAULT 'active',
  active_lock VARCHAR(32) GENERATED ALWAYS AS
    (IF(status = 'active', CONCAT(group_id, ':'), NULL)) VIRTUAL,
  started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at DATETIME NULL DEFAULT NULL,
  UNIQUE KEY uq_active (active_lock),
  INDEX idx_group_status (group_id, status),
  FOREIGN KEY (group_id) REFERENCES `groups` (group_id) ON DELETE CASCADE,
  FOREIGN KEY (question_id) REFERENCES questions (question_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS answers (
  answer_id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  game_id INT UNSIGNED NOT NULL,
  voter_user_id INT UNSIGNED NOT NULL,
  target_participant_id INT UNSIGNED NULL,
  target_name VARCHAR(50) NULL,
  choice CHAR(1) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_vote (game_id, voter_user_id),
  INDEX idx_game (game_id),
  FOREIGN KEY (game_id) REFERENCES games (game_id) ON DELETE CASCADE,
  FOREIGN KEY (target_participant_id) REFERENCES participants (participant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

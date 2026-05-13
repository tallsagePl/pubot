-- Pubot SQLite: пользователи, чаты, workspace по (user_id, context_id), глобальное состояние дня.
-- context_id = String(telegram_chat_id): группа — отрицательный id, личка с ботом — обычно id пользователя.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY NOT NULL,
  display_name TEXT NOT NULL DEFAULT 'Пользователь',
  stats_initialized_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chats (
  chat_id TEXT PRIMARY KEY NOT NULL,
  group_best_value INTEGER,
  group_best_owner_user_id TEXT
);

CREATE TABLE IF NOT EXISTS chat_members (
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (chat_id, user_id),
  FOREIGN KEY (user_id) REFERENCES users (user_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS user_workspaces (
  user_id TEXT NOT NULL,
  context_id TEXT NOT NULL,
  goal_per_day INTEGER,
  carry_over INTEGER NOT NULL DEFAULT 0,
  remaining_today INTEGER NOT NULL DEFAULT 0,
  current_date_key TEXT,
  best_day INTEGER NOT NULL DEFAULT 0,
  total_done INTEGER NOT NULL DEFAULT 0,
  daily_done_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (user_id, context_id),
  FOREIGN KEY (user_id) REFERENCES users (user_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS day_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  active_day_key TEXT,
  updated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_workspaces_user ON user_workspaces (user_id);
CREATE INDEX IF NOT EXISTS idx_members_user ON chat_members (user_id);

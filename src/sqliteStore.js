const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { SQLITE_DB_PATH, SCHEMA_SQL_PATH } = require("./config");
const { normalizeDailyDoneForStorage } = require("./dailyDoneEntries");

let dbInstance = null;
let appStateCache = null;

function getDb() {
  if (!dbInstance) {
    const dir = path.dirname(SQLITE_DB_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    dbInstance = new Database(SQLITE_DB_PATH);
    dbInstance.pragma("journal_mode = WAL");
    dbInstance.pragma("foreign_keys = ON");
    const schema = fs.readFileSync(SCHEMA_SQL_PATH, "utf-8");
    dbInstance.exec(schema);
  }
  return dbInstance;
}

function loadAppStateFromSqlite() {
  const db = getDb();
  const users = {};

  for (const row of db.prepare("SELECT user_id, display_name, stats_initialized_at FROM users").all()) {
    users[row.user_id] = {
      profile: { name: row.display_name },
      statsInitializedAt: Number(row.stats_initialized_at) || Date.now(),
      chatWorkspaces: {},
    };
  }

  for (const row of db
    .prepare(
      `SELECT user_id, context_id, goal_per_day, carry_over, remaining_today,
              current_date_key, best_day, total_done, daily_done_json
       FROM user_workspaces`
    )
    .all()) {
    if (!users[row.user_id]) {
      users[row.user_id] = {
        profile: { name: "Пользователь" },
        statsInitializedAt: Date.now(),
        chatWorkspaces: {},
      };
    }
    let dailyDone = {};
    try {
      dailyDone = JSON.parse(row.daily_done_json || "{}");
      if (!dailyDone || typeof dailyDone !== "object" || Array.isArray(dailyDone)) {
        dailyDone = {};
      }
    } catch {
      dailyDone = {};
    }
    dailyDone = normalizeDailyDoneForStorage(dailyDone);
    users[row.user_id].chatWorkspaces[row.context_id] = {
      goalPerDay: row.goal_per_day != null ? Number(row.goal_per_day) : null,
      carryOver: Number(row.carry_over || 0),
      remainingToday: Number(row.remaining_today || 0),
      currentDateKey: row.current_date_key != null ? String(row.current_date_key) : null,
      bestDay: Number(row.best_day || 0),
      totalDone: Number(row.total_done || 0),
      dailyDone,
    };
  }

  const chats = {};
  for (const row of db
    .prepare("SELECT chat_id, group_best_value, group_best_owner_user_id FROM chats")
    .all()) {
    const entry = { userIds: [] };
    if (row.group_best_value != null || row.group_best_owner_user_id != null) {
      entry.groupBestDayRecord = {
        value: Number(row.group_best_value || 0),
        ownerId: row.group_best_owner_user_id != null ? String(row.group_best_owner_user_id) : "",
      };
    }
    chats[row.chat_id] = entry;
  }

  for (const row of db.prepare("SELECT chat_id, user_id FROM chat_members").all()) {
    if (!chats[row.chat_id]) {
      chats[row.chat_id] = { userIds: [] };
    }
    if (!chats[row.chat_id].userIds.includes(row.user_id)) {
      chats[row.chat_id].userIds.push(row.user_id);
    }
  }

  return { users, chats };
}

function persistAppStateToSqlite(state) {
  const db = getDb();
  const insertUser = db.prepare(`
    INSERT INTO users (user_id, display_name, stats_initialized_at)
    VALUES (@user_id, @display_name, @stats_initialized_at)
  `);
  const insertWorkspace = db.prepare(`
    INSERT INTO user_workspaces (
      user_id, context_id, goal_per_day, carry_over, remaining_today,
      current_date_key, best_day, total_done, daily_done_json
    ) VALUES (
      @user_id, @context_id, @goal_per_day, @carry_over, @remaining_today,
      @current_date_key, @best_day, @total_done, @daily_done_json
    )
  `);
  const insertChat = db.prepare(`
    INSERT INTO chats (chat_id, group_best_value, group_best_owner_user_id)
    VALUES (@chat_id, @group_best_value, @group_best_owner_user_id)
  `);
  const insertMember = db.prepare(`
    INSERT INTO chat_members (chat_id, user_id) VALUES (@chat_id, @user_id)
  `);

  const txn = db.transaction(() => {
    db.exec(`
      DELETE FROM chat_members;
      DELETE FROM user_workspaces;
      DELETE FROM chats;
      DELETE FROM users;
    `);

    for (const [userId, u] of Object.entries(state.users || {})) {
      const name = (u.profile && u.profile.name) || "Пользователь";
      const statsAt = Number(u.statsInitializedAt) || Date.now();
      insertUser.run({
        user_id: String(userId),
        display_name: name,
        stats_initialized_at: statsAt,
      });

      const wss = u.chatWorkspaces && typeof u.chatWorkspaces === "object" ? u.chatWorkspaces : {};
      for (const [ctx, ws] of Object.entries(wss)) {
        if (!ws || typeof ws !== "object") continue;
        insertWorkspace.run({
          user_id: String(userId),
          context_id: String(ctx),
          goal_per_day: ws.goalPerDay != null ? Number(ws.goalPerDay) : null,
          carry_over: Math.max(0, Number(ws.carryOver || 0)),
          remaining_today: Math.max(0, Number(ws.remainingToday || 0)),
          current_date_key: ws.currentDateKey != null ? String(ws.currentDateKey) : null,
          best_day: Math.max(0, Number(ws.bestDay || 0)),
          total_done: Math.max(0, Number(ws.totalDone || 0)),
          daily_done_json: JSON.stringify(
            normalizeDailyDoneForStorage(ws.dailyDone && typeof ws.dailyDone === "object" ? ws.dailyDone : {})
          ),
        });
      }
    }

    for (const [chatId, ch] of Object.entries(state.chats || {})) {
      const rec = ch.groupBestDayRecord;
      insertChat.run({
        chat_id: String(chatId),
        group_best_value: rec && rec.value != null ? Number(rec.value) : null,
        group_best_owner_user_id: rec && rec.ownerId != null ? String(rec.ownerId) : null,
      });
      for (const uid of ch.userIds || []) {
        insertMember.run({ chat_id: String(chatId), user_id: String(uid) });
      }
    }
  });

  txn();
}

function readDb() {
  if (!appStateCache) {
    appStateCache = loadAppStateFromSqlite();
  }
  if (!appStateCache.users || typeof appStateCache.users !== "object") {
    appStateCache.users = {};
  }
  if (!appStateCache.chats) {
    appStateCache.chats = {};
  }
  return appStateCache;
}

function writeDb(db) {
  if (db !== appStateCache) {
    appStateCache = db;
  }
  persistAppStateToSqlite(appStateCache);
}

function readDayState() {
  const db = getDb();
  const row = db.prepare("SELECT active_day_key, updated_at FROM day_state WHERE id = 1").get();
  if (!row) {
    return { activeDayKey: null, updatedAt: null };
  }
  return {
    activeDayKey: row.active_day_key != null ? String(row.active_day_key) : null,
    updatedAt: row.updated_at != null ? Number(row.updated_at) : null,
  };
}

function writeDayState(dayState) {
  const db = getDb();
  db.prepare(
    `INSERT INTO day_state (id, active_day_key, updated_at)
     VALUES (1, @active_day_key, @updated_at)
     ON CONFLICT(id) DO UPDATE SET
       active_day_key = excluded.active_day_key,
       updated_at = excluded.updated_at`
  ).run({
    active_day_key: dayState.activeDayKey != null ? String(dayState.activeDayKey) : null,
    updated_at: dayState.updatedAt != null ? Number(dayState.updatedAt) : Date.now(),
  });
}

module.exports = {
  getDb,
  readDb,
  writeDb,
  readDayState,
  writeDayState,
};

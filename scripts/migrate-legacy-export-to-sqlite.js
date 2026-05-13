/**
 * Импорт экспорта (старый JSON или уже с chatWorkspaces) в SQLite.
 *
 * Использование:
 *   node scripts/migrate-legacy-export-to-sqlite.js [путь-к-json] [--db путь-к.sqlite]
 *
 * По умолчанию (без аргументов): scripts/fixtures/legacy-export-sample.json -> data/pubot.db
 *
 * На сервере: положи старые данные в bd.json в корне репозитория и выполни: npm run db:migrate:bd
 *
 * Принимает формы:
 *   { database: { users, chats }, dayState? }
 *   { users, chats }  (как в data/users.json)
 */

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { sliceLegacyUserStats, cloneWorkspaceData } = require("../src/chatWorkspaces");
const { normalizeDailyDoneForStorage } = require("../src/dailyDoneEntries");

const ROOT = path.join(__dirname, "..");
const DEFAULT_INPUT = path.join(ROOT, "scripts", "fixtures", "legacy-export-sample.json");
const DEFAULT_DB = path.join(ROOT, "data", "pubot.db");
const SCHEMA_PATH = path.join(ROOT, "db", "schema.sql");

function parseArgs(argv) {
  let inputPath = DEFAULT_INPUT;
  let dbPath = DEFAULT_DB;
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--db" && argv[i + 1]) {
      dbPath = path.resolve(argv[i + 1]);
      i += 1;
    } else if (!argv[i].startsWith("--")) {
      inputPath = path.resolve(argv[i]);
    }
  }
  return { inputPath, dbPath };
}

function normalizePayload(raw) {
  const users = raw.database?.users ?? raw.users;
  const chats = raw.database?.chats ?? raw.chats;
  const dayState = raw.dayState ?? raw.day_state ?? null;
  if (!users || typeof users !== "object") {
    throw new Error("В JSON нет users (или database.users)");
  }
  if (!chats || typeof chats !== "object") {
    throw new Error("В JSON нет chats (или database.chats)");
  }
  return { users, chats, dayState };
}

function isLegacyFlatUser(user) {
  return user && !user.chatWorkspaces && (user.goalPerDay != null || user.dailyDone != null || user.totalDone != null);
}

function workspaceToRow(userId, contextId, ws) {
  return {
    user_id: userId,
    context_id: contextId,
    goal_per_day: ws.goalPerDay != null ? Number(ws.goalPerDay) : null,
    carry_over: Math.max(0, Number(ws.carryOver || 0)),
    remaining_today: Math.max(0, Number(ws.remainingToday || 0)),
    current_date_key: ws.currentDateKey != null ? String(ws.currentDateKey) : null,
    best_day: Math.max(0, Number(ws.bestDay || 0)),
    total_done: Math.max(0, Number(ws.totalDone || 0)),
    daily_done_json: JSON.stringify(
      normalizeDailyDoneForStorage(ws.dailyDone && typeof ws.dailyDone === "object" ? ws.dailyDone : {})
    ),
  };
}

function collectWorkspacesForUser(userId, user, chatsMap) {
  const rows = [];
  if (user.chatWorkspaces && typeof user.chatWorkspaces === "object") {
    for (const [ctx, ws] of Object.entries(user.chatWorkspaces)) {
      if (!ws || typeof ws !== "object") continue;
      rows.push(workspaceToRow(userId, ctx, ws));
    }
    return rows;
  }
  if (isLegacyFlatUser(user)) {
    const legacy = sliceLegacyUserStats(user);
    for (const [cid, ch] of Object.entries(chatsMap)) {
      if (Array.isArray(ch.userIds) && ch.userIds.includes(userId)) {
        rows.push(workspaceToRow(userId, cid, cloneWorkspaceData(legacy)));
      }
    }
    rows.push(workspaceToRow(userId, String(userId), cloneWorkspaceData(legacy)));
    return rows;
  }
  rows.push(
    workspaceToRow(userId, String(userId), {
      goalPerDay: null,
      carryOver: 0,
      remainingToday: 0,
      currentDateKey: null,
      bestDay: 0,
      dailyDone: {},
      totalDone: 0,
    })
  );
  return rows;
}

function run() {
  const { inputPath, dbPath } = parseArgs(process.argv);
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Файл не найден: ${inputPath}`);
  }
  const raw = JSON.parse(fs.readFileSync(inputPath, "utf-8"));
  const { users, chats, dayState } = normalizePayload(raw);

  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(fs.readFileSync(SCHEMA_PATH, "utf-8"));

  const clear = db.transaction(() => {
    db.exec(`
      DELETE FROM chat_members;
      DELETE FROM user_workspaces;
      DELETE FROM chats;
      DELETE FROM users;
      DELETE FROM day_state;
    `);
  });
  clear();

  const insertUser = db.prepare(`
    INSERT INTO users (user_id, display_name, stats_initialized_at)
    VALUES (@user_id, @display_name, @stats_initialized_at)
  `);
  const insertChat = db.prepare(`
    INSERT INTO chats (chat_id, group_best_value, group_best_owner_user_id)
    VALUES (@chat_id, @group_best_value, @group_best_owner_user_id)
  `);
  const insertMember = db.prepare(`
    INSERT INTO chat_members (chat_id, user_id) VALUES (@chat_id, @user_id)
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
  const insertDayState = db.prepare(`
    INSERT INTO day_state (id, active_day_key, updated_at)
    VALUES (1, @active_day_key, @updated_at)
  `);

  const importAll = db.transaction(() => {
    for (const [userId, user] of Object.entries(users)) {
      const name = (user.profile && user.profile.name) || "Пользователь";
      const statsAt = Number(user.statsInitializedAt) || Date.now();
      insertUser.run({
        user_id: String(userId),
        display_name: name,
        stats_initialized_at: statsAt,
      });

      const wsRows = collectWorkspacesForUser(String(userId), user, chats);
      const seen = new Set();
      for (const row of wsRows) {
        const key = `${row.user_id}:${row.context_id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        insertWorkspace.run(row);
      }
    }

    for (const [chatId, ch] of Object.entries(chats)) {
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

    insertDayState.run({
      active_day_key: dayState && dayState.activeDayKey != null ? String(dayState.activeDayKey) : null,
      updated_at: dayState && dayState.updatedAt != null ? Number(dayState.updatedAt) : Date.now(),
    });
  });

  importAll();
  db.close();

  console.log(`Миграция завершена: ${inputPath} -> ${dbPath}`);
}

try {
  run();
} catch (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
}

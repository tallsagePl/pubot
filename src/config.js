require("dotenv").config();
const path = require("path");

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  throw new Error("TELEGRAM_BOT_TOKEN not set in environment");
}

const ROOT = path.join(__dirname, "..");

module.exports = {
  token,
  botTimezone: process.env.BOT_TIMEZONE || "Europe/Moscow",
  DATA_DIR: path.join(ROOT, "data"),
  DATA_FILE: path.join(ROOT, "data", "users.json"),
  DAY_STATE_FILE: path.join(ROOT, "data", "day-state.json"),
  SQLITE_DB_PATH: process.env.PUBOT_SQLITE_PATH || path.join(ROOT, "data", "pubot.db"),
  SCHEMA_SQL_PATH: path.join(ROOT, "db", "schema.sql"),
  REMINDER_HOURS: new Set([13, 16, 19, 22]),
  RESET_HOUR: 4,
  NEW_DAY_DEFAULT_GOAL: Number(process.env.NEW_DAY_DEFAULT_GOAL || 100),
  FORCE_NEW_DAY_ON_START: process.argv.includes("--newday"),
  CLEAR_LEADERBOARD_ON_START: process.argv.includes("--clearleader"),
  BUTTONS: {
    add: "/add",
    remove: "/remove",
    left: "/left",
    record: "/record",
    allFrom: "/allfrom",
    leaderboard: "/leaderboard",
  },
};

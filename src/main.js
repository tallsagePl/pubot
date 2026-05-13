const TelegramBot = require("node-telegram-bot-api");
const {
  token,
  CLEAR_LEADERBOARD_ON_START,
  FORCE_NEW_DAY_ON_START,
  NEW_DAY_DEFAULT_GOAL,
} = require("./config");
const { ensureDataFiles } = require("./bootstrapDataFiles");
const { readDb, writeDb } = require("./persistence");
const { clearLeaderboardAndRecords, forceNewDayReset } = require("./dayEngine");
const { nowDateInTimezone } = require("./time");
const { registerBot } = require("./telegram/registerBot");
const { createDailyReminderTick } = require("./jobs/dailyReminder");

ensureDataFiles();

const bot = new TelegramBot(token, { polling: true });
bot.on("polling_error", (err) => {
  console.error("[polling_error]", err && err.message ? err.message : err);
});
registerBot(bot);

const processDailyRollAndReminders = createDailyReminderTick(bot);

setInterval(processDailyRollAndReminders, 30 * 1000);

if (CLEAR_LEADERBOARD_ON_START) {
  const db = readDb();
  clearLeaderboardAndRecords(db);
  writeDb(db);
  console.log("Leaderboard and records have been cleared.");
  process.exit(0);
}

if (FORCE_NEW_DAY_ON_START) {
  const db = readDb();
  forceNewDayReset(db, nowDateInTimezone(), NEW_DAY_DEFAULT_GOAL);
  writeDb(db);
  console.log(`Forced new day applied. Base goal: ${NEW_DAY_DEFAULT_GOAL}`);
}

processDailyRollAndReminders();

console.log("Push-up bot is running...");

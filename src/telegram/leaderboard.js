const { readDb } = require("../persistence");
const { buildChatTotalLeaderboardText } = require("../ratings");
const { getReplyKeyboard } = require("./keyboards");

function createReplyTotalLeaderboard(bot) {
  return function replyTotalLeaderboard(msg) {
    const chatType = msg.chat.type;
    if (chatType !== "group" && chatType !== "supergroup") {
      bot.sendMessage(
        msg.chat.id,
        "Таблица лидеров строится в групповом чате, где бот видит участников.",
        getReplyKeyboard()
      );
      return;
    }

    const chatId = String(msg.chat.id);
    const db = readDb();
    const text = buildChatTotalLeaderboardText(db, chatId);
    if (!text) {
      bot.sendMessage(
        msg.chat.id,
        "Пока пусто: пусть участники напишут боту в этом чате (любое сообщение или команду), чтобы попасть в рейтинг.",
        getReplyKeyboard()
      );
      return;
    }

    bot.sendMessage(msg.chat.id, text, getReplyKeyboard());
  };
}

module.exports = {
  createReplyTotalLeaderboard,
};

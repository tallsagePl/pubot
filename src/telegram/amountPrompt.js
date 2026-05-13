const { getAmountInlineKeyboard } = require("./keyboards");

function createAmountPromptService(bot) {
  const pendingAmountPrompt = new Map();

  function clearPendingAmountPrompt(userId) {
    const prompt = pendingAmountPrompt.get(userId);
    if (!prompt) {
      return;
    }
    pendingAmountPrompt.delete(userId);
    bot
      .editMessageReplyMarkup(
        { inline_keyboard: [] },
        {
          chat_id: prompt.chatId,
          message_id: prompt.messageId,
        }
      )
      .catch(() => null);
  }

  function sendAmountPrompt(chatId, userId, mode) {
    clearPendingAmountPrompt(userId);
    return bot
      .sendMessage(chatId, "Выбери число или напиши свое", getAmountInlineKeyboard(mode))
      .then((sentMsg) => {
        pendingAmountPrompt.set(userId, { chatId, messageId: sentMsg.message_id });
        return sentMsg;
      });
  }

  return {
    clearPendingAmountPrompt,
    sendAmountPrompt,
  };
}

module.exports = {
  createAmountPromptService,
};

const { BUTTONS } = require("../config");

function getReplyKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        [BUTTONS.add, BUTTONS.remove],
        [BUTTONS.left, BUTTONS.record],
        [BUTTONS.allFrom, BUTTONS.leaderboard],
      ],
      resize_keyboard: true,
      persistent: true,
    },
  };
}

function getAmountInlineKeyboard(mode) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "5", callback_data: `amount:${mode}:5` },
          { text: "10", callback_data: `amount:${mode}:10` },
          { text: "15", callback_data: `amount:${mode}:15` },
        ],
        [
          { text: "20", callback_data: `amount:${mode}:20` },
          { text: "25", callback_data: `amount:${mode}:25` },
          { text: "30", callback_data: `amount:${mode}:30` },
        ],
      ],
    },
  };
}

module.exports = {
  getReplyKeyboard,
  getAmountInlineKeyboard,
};

const { dayEntryTotal } = require("./dailyDoneEntries");

function parsePositiveInt(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    return null;
  }
  return n;
}

function recalculateBestDay(dailyDone) {
  let max = 0;
  for (const dayEntry of Object.values(dailyDone || {})) {
    const t = dayEntryTotal(dayEntry);
    if (t > max) {
      max = t;
    }
  }
  return max;
}

function getTodayTargetTotal(workspace) {
  const goal = Math.max(0, Number(workspace.goalPerDay || 0));
  const carry = Math.max(0, Number(workspace.carryOver || 0));
  return goal + carry;
}

function sumFromDate(workspace, fromDateKey) {
  return Object.entries(workspace.dailyDone || {})
    .filter(([dateKey]) => dateKey >= fromDateKey)
    .reduce((acc, [, dayEntry]) => acc + dayEntryTotal(dayEntry), 0);
}

function normalizeDateInput(input) {
  if (!input) return null;
  const trimmed = input.trim().toLowerCase();
  if (trimmed === "начало") {
    return { type: "beginning" };
  }

  const dotMatch = trimmed.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (dotMatch) {
    const [, dd, mm, yyyy] = dotMatch;
    return { type: "date", dateKey: `${yyyy}-${mm}-${dd}` };
  }

  const dashMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dashMatch) {
    const [, yyyy, mm, dd] = dashMatch;
    return { type: "date", dateKey: `${yyyy}-${mm}-${dd}` };
  }

  return null;
}

module.exports = {
  parsePositiveInt,
  recalculateBestDay,
  getTodayTargetTotal,
  sumFromDate,
  normalizeDateInput,
};

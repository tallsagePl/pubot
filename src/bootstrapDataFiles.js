const fs = require("fs");
const path = require("path");
const { SQLITE_DB_PATH } = require("./config");

/**
 * Гарантирует каталог для SQLite. Схема и файл БД создаются при первом обращении (sqliteStore.getDb).
 */
function ensureDataFiles() {
  const dir = path.dirname(SQLITE_DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

module.exports = { ensureDataFiles };

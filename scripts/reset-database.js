/**
 * Полный сброс SQLite: удаляет файл БД (и -wal/-shm) и создаёт пустую по db/schema.sql.
 *
 * Путь: PUBOT_SQLITE_PATH из .env или data/pubot.db от корня репозитория.
 *
 * Использование:
 *   node scripts/reset-database.js --yes
 *   npm run db:reset -- --yes
 *
 * Без флага --yes скрипт ничего не делает (защита от случайного запуска).
 */

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const ROOT = path.join(__dirname, "..");
const DEFAULT_DB = path.join(ROOT, "data", "pubot.db");
const SCHEMA_PATH = path.join(ROOT, "db", "schema.sql");

function parseArgs(argv) {
  return argv.includes("--yes") || argv.includes("-y");
}

function removeDbFiles(dbPath) {
  const base = path.resolve(dbPath);
  const variants = [base, `${base}-wal`, `${base}-shm`];
  for (const p of variants) {
    try {
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
      }
    } catch (err) {
      throw new Error(`Не удалось удалить ${p}: ${err.message}`);
    }
  }
}

function run() {
  const confirmed = parseArgs(process.argv);
  if (!confirmed) {
    console.error(
      "Сброс БД уничтожит все данные. Запусти с флагом подтверждения:\n" +
        "  node scripts/reset-database.js --yes\n" +
        "  npm run db:reset -- --yes"
    );
    process.exitCode = 1;
    return;
  }

  const dbPath = process.env.PUBOT_SQLITE_PATH
    ? path.resolve(process.env.PUBOT_SQLITE_PATH)
    : DEFAULT_DB;

  if (!fs.existsSync(SCHEMA_PATH)) {
    console.error(`Не найден файл схемы: ${SCHEMA_PATH}`);
    process.exitCode = 1;
    return;
  }

  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  removeDbFiles(dbPath);

  const schema = fs.readFileSync(SCHEMA_PATH, "utf-8");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(schema);
  db.close();

  console.log(`База сброшена и пересоздана: ${dbPath}`);
}

try {
  run();
} catch (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
}

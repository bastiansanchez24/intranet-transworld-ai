const db = require("../db");
const {
  MAX_MESSAGES_PER_DAY,
  MAX_FILES_PER_DAY,
} = require("../constants/claudeLimits");

let tablesReady = null;

async function ensureTables() {
  if (tablesReady) return tablesReady;
  tablesReady = (async () => {
    await db.query(`
      CREATE TABLE IF NOT EXISTS claude_daily_usage (
        user_id INTEGER NOT NULL,
        usage_date DATE NOT NULL DEFAULT CURRENT_DATE,
        message_count INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0),
        file_count INTEGER NOT NULL DEFAULT 0 CHECK (file_count >= 0),
        PRIMARY KEY (user_id, usage_date)
      )
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS claude_user_settings (
        user_id INTEGER PRIMARY KEY,
        limits_notice_seen_at TIMESTAMPTZ
      )
    `);
  })();
  return tablesReady;
}

function formatUsage(row) {
  const messageCount = row?.message_count ?? 0;
  const fileCount = row?.file_count ?? 0;
  return {
    messageCount,
    fileCount,
    maxMessages: MAX_MESSAGES_PER_DAY,
    maxFiles: MAX_FILES_PER_DAY,
    messagesRemaining: Math.max(0, MAX_MESSAGES_PER_DAY - messageCount),
    filesRemaining: Math.max(0, MAX_FILES_PER_DAY - fileCount),
  };
}

async function countUsageFromMessages(userId) {
  const result = await db.query(
    `SELECT
       COUNT(*)::int AS message_count,
       COUNT(*) FILTER (WHERE m.role = 'user' AND m.content LIKE '📎%')::int AS file_count
     FROM claude_messages m
     INNER JOIN claude_conversations c ON c.id = m.conversation_id
     WHERE c.user_id = $1
       AND m.created_at >= CURRENT_DATE
       AND m.created_at < CURRENT_DATE + INTERVAL '1 day'`,
    [userId]
  );
  return result.rows[0] || { message_count: 0, file_count: 0 };
}

async function seedDailyUsageFromMessages(userId) {
  const counts = await countUsageFromMessages(userId);
  if (counts.message_count === 0 && counts.file_count === 0) {
    return null;
  }

  const result = await db.query(
    `INSERT INTO claude_daily_usage (user_id, usage_date, message_count, file_count)
     VALUES ($1, CURRENT_DATE, $2, $3)
     ON CONFLICT (user_id, usage_date) DO NOTHING
     RETURNING message_count, file_count`,
    [userId, counts.message_count, counts.file_count]
  );

  if (result.rows[0]) return result.rows[0];

  const existing = await db.query(
    `SELECT message_count, file_count
     FROM claude_daily_usage
     WHERE user_id = $1 AND usage_date = CURRENT_DATE`,
    [userId]
  );
  return existing.rows[0] || counts;
}

async function getDailyUsage(userId) {
  await ensureTables();

  const result = await db.query(
    `SELECT message_count, file_count
     FROM claude_daily_usage
     WHERE user_id = $1 AND usage_date = CURRENT_DATE`,
    [userId]
  );

  if (result.rows[0]) {
    return formatUsage(result.rows[0]);
  }

  const seeded = await seedDailyUsageFromMessages(userId);
  return formatUsage(seeded || { message_count: 0, file_count: 0 });
}

async function recordUsage(userId, { messages = 0, files = 0 } = {}) {
  if (messages <= 0 && files <= 0) return getDailyUsage(userId);

  await ensureTables();

  const result = await db.query(
    `INSERT INTO claude_daily_usage (user_id, usage_date, message_count, file_count)
     VALUES ($1, CURRENT_DATE, $2, $3)
     ON CONFLICT (user_id, usage_date) DO UPDATE SET
       message_count = claude_daily_usage.message_count + EXCLUDED.message_count,
       file_count = claude_daily_usage.file_count + EXCLUDED.file_count
     RETURNING message_count, file_count`,
    [userId, messages, files]
  );

  return formatUsage(result.rows[0]);
}

async function hasSeenLimitsNotice(userId) {
  await ensureTables();
  const result = await db.query(
    `SELECT limits_notice_seen_at IS NOT NULL AS seen
     FROM claude_user_settings
     WHERE user_id = $1`,
    [userId]
  );
  return Boolean(result.rows[0]?.seen);
}

async function markLimitsNoticeSeen(userId) {
  await ensureTables();
  await db.query(
    `INSERT INTO claude_user_settings (user_id, limits_notice_seen_at)
     VALUES ($1, NOW())
     ON CONFLICT (user_id) DO UPDATE SET limits_notice_seen_at = COALESCE(
       claude_user_settings.limits_notice_seen_at,
       EXCLUDED.limits_notice_seen_at
     )`,
    [userId]
  );
}

function messageLimitError(usage) {
  return {
    status: 429,
    error: `Alcanzaste el límite diario de ${usage.maxMessages} mensajes. Podrás usar el asistente nuevamente mañana.`,
    code: "MESSAGE_LIMIT",
    usage,
  };
}

function fileLimitError(usage) {
  return {
    status: 429,
    error: `Alcanzaste el límite diario de ${usage.maxFiles} archivos analizados. Podrás usar el asistente nuevamente mañana.`,
    code: "FILE_LIMIT",
    usage,
  };
}

async function assertCanSendMessage(userId, { withAttachment = false } = {}) {
  const usage = await getDailyUsage(userId);

  if (usage.messageCount >= usage.maxMessages) {
    return { ok: false, ...messageLimitError(usage) };
  }

  const messagesNeeded = 2;
  if (usage.messageCount + messagesNeeded > usage.maxMessages) {
    return { ok: false, ...messageLimitError(usage) };
  }

  if (withAttachment && usage.fileCount >= usage.maxFiles) {
    return { ok: false, ...fileLimitError(usage) };
  }

  return { ok: true, usage };
}

async function assertCanAnalyzeFile(userId) {
  const usage = await getDailyUsage(userId);

  if (usage.fileCount >= usage.maxFiles) {
    return { ok: false, ...fileLimitError(usage) };
  }

  return { ok: true, usage };
}

module.exports = {
  getDailyUsage,
  recordUsage,
  hasSeenLimitsNotice,
  markLimitsNoticeSeen,
  assertCanSendMessage,
  assertCanAnalyzeFile,
  messageLimitError,
  fileLimitError,
};

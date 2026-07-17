const express = require("express");
const crypto = require("crypto");
const path = require("path");
const multer = require("multer");
const db = require("../db");
const claudeService = require("../services/claudeService");
const officeDocumentBuilder = require("../services/officeDocumentBuilder");
const officeExcelFormat = require("../services/officeExcelFormat");
const {
  getDailyUsage,
  recordUsage,
  hasSeenLimitsNotice,
  markLimitsNoticeSeen,
  assertCanSendMessage,
  assertCanAnalyzeFile,
} = require("../services/claudeDailyLimits");
const { attachClaudeUsageContext } = require("../middlewares/claudeLimits");
const {
  MAX_MESSAGES_PER_DAY,
  MAX_FILES_PER_DAY,
  CONTEXT_WINDOW_MESSAGES,
  LIMITS_NOTICE,
} = require("../constants/claudeLimits");
const { isAdministrador } = require("../constants/roles");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// Middleware: Verificar autenticación
const requireAuth = (req, res, next) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: "No autenticado" });
  }
  next();
};

router.use(requireAuth);
router.use(attachClaudeUsageContext);

// Almacén temporal en memoria para adjuntos pendientes de enviar al chat.
// Evita transportar PDFs en base64 dentro del cuerpo JSON del chat.
const pendingAttachments = new Map(); // id -> { buffer, mimeType, filename, userId, expires }
const ATTACHMENT_TTL_MS = 15 * 60 * 1000;
const exportTemplates = new Map(); // key -> { buffer, filename, userId, conversationId, expires }
const EXPORT_TEMPLATE_TTL_MS = 2 * 60 * 60 * 1000;

function templateKey(userId, conversationId, filename) {
  return `${userId}:${conversationId}:${filename}`;
}

function storeExportTemplate({ userId, conversationId, buffer, filename }) {
  if (!buffer?.length || !conversationId || !filename) return;
  exportTemplates.set(templateKey(userId, conversationId, filename), {
    buffer,
    filename,
    userId,
    conversationId,
    expires: Date.now() + EXPORT_TEMPLATE_TTL_MS,
  });
}

function resolveExportTemplate({ userId, conversationId, filename }) {
  if (!conversationId || !filename) return null;
  const candidates = new Set([filename]);
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  const normalizedBase = base.replace(/-(editado|actualizado|modificado|final)$/i, "");
  if (normalizedBase !== base) {
    candidates.add(`${normalizedBase}${ext}`);
  }

  for (const candidate of candidates) {
    const entry = exportTemplates.get(templateKey(userId, conversationId, candidate));
    if (!entry) continue;
    if (entry.expires < Date.now()) {
      exportTemplates.delete(templateKey(userId, conversationId, candidate));
      continue;
    }
    if (entry.userId !== userId) continue;
    return entry;
  }

  for (const [key, entry] of exportTemplates) {
    if (entry.userId !== userId || entry.conversationId !== conversationId) continue;
    if (entry.expires < Date.now()) {
      exportTemplates.delete(key);
      continue;
    }
    if (officeExcelFormat.isExcelFile(entry.filename)) {
      return entry;
    }
  }

  return null;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, att] of pendingAttachments) {
    if (att.expires < now) pendingAttachments.delete(id);
  }
  for (const [key, entry] of exportTemplates) {
    if (entry.expires < now) exportTemplates.delete(key);
  }
}, 60 * 1000).unref?.();

const userIsAdmin = (req) => isAdministrador(req.session.user?.role);
const unlimitedUsage = (req) => Boolean(req.claudeUnlimitedUsage);

// GET /claude - Abrir asistente como modal en la intranet
router.get("/", (req, res) => {
  res.redirect("/?openClaude=1");
});

// GET /claude/api/bootstrap - Datos iniciales para el modal
router.get("/api/bootstrap", async (req, res) => {
  try {
    const conversations = await db.query(
      "SELECT id, title, created_at FROM claude_conversations WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 50",
      [req.session.user.id]
    );

    const canChangeModel = userIsAdmin(req);
    const isUnlimited = unlimitedUsage(req);
    const defaultModel = canChangeModel
      ? claudeService.getDefaultModel()
      : claudeService.getEconomicModel();

    const userId = req.session.user.id;
    const dailyUsage = await getDailyUsage(userId, { isAdmin: isUnlimited });
    const limitsNoticeSeen = isUnlimited ? true : await hasSeenLimitsNotice(userId);

    res.json({
      conversations: conversations.rows,
      models: canChangeModel ? claudeService.getAvailableModels() : [],
      defaultModel,
      defaultModelName: claudeService.getModelName(defaultModel),
      canChangeModel,
      userId,
      dailyUsage,
      limitsNoticeSeen,
      limits: isUnlimited
        ? { unlimited: true }
        : {
            maxMessages: MAX_MESSAGES_PER_DAY,
            maxFiles: MAX_FILES_PER_DAY,
            notice: LIMITS_NOTICE,
          },
    });
  } catch (error) {
    console.error("[Claude Bootstrap] Error:", error);
    res.status(500).json({ error: "Error al cargar el asistente" });
  }
});

// GET /api/claude/models - Listar modelos
router.get("/api/models", (req, res) => {
  if (!userIsAdmin(req)) {
    const economicModel = claudeService.getEconomicModel();
    return res.json([
      {
        id: economicModel,
        name: claudeService.getModelName(economicModel),
        locked: true,
      },
    ]);
  }
  res.json(claudeService.getAvailableModels());
});

// GET /claude/api/usage - Uso diario actual (refresco al reabrir el asistente)
router.get("/api/usage", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const isUnlimited = unlimitedUsage(req);
    const dailyUsage = await getDailyUsage(userId, { isAdmin: isUnlimited });
    const limitsNoticeSeen = isUnlimited ? true : await hasSeenLimitsNotice(userId);
    res.json({ dailyUsage, limitsNoticeSeen, userId });
  } catch (error) {
    console.error("[Claude Usage] Error:", error);
    res.status(500).json({ error: "Error al obtener uso diario" });
  }
});

// POST /claude/api/limits-notice-seen - Marcar aviso de marcha blanca como visto
router.post("/api/limits-notice-seen", async (req, res) => {
  try {
    const userId = req.session.user.id;
    await markLimitsNoticeSeen(userId);
    res.json({ success: true });
  } catch (error) {
    console.error("[Claude Limits Notice] Error:", error);
    res.status(500).json({ error: "Error al guardar preferencia" });
  }
});

async function resolveConversationId({ conversationId, userId }) {
  if (conversationId) {
    const conv = await db.query(
      "SELECT user_id FROM claude_conversations WHERE id = $1",
      [conversationId]
    );
    if (conv.rows.length === 0 || conv.rows[0].user_id !== userId) {
      return { error: { status: 403, message: "No autorizado" } };
    }
    return { conversationId };
  }

  const result = await db.query(
    "INSERT INTO claude_conversations (user_id, title, created_at, updated_at) VALUES ($1, $2, NOW(), NOW()) RETURNING id",
    [userId, "Nueva conversación"]
  );
  return { conversationId: result.rows[0].id, isNew: true };
}

// POST /api/claude/upload - Subir un adjunto para usar en el chat
router.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No se proporcionó archivo" });
    }
    const isUnlimited = unlimitedUsage(req);
    const validation = await claudeService.validateAttachment(req.file, { isAdmin: isUnlimited });
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }

    const userId = req.session.user.id;
    const fileCheck = await assertCanAnalyzeFile(userId, { isAdmin: isUnlimited });
    if (!fileCheck.ok) {
      return res.status(fileCheck.status).json({
        error: fileCheck.error,
        code: fileCheck.code,
        usage: fileCheck.usage,
      });
    }

    const id = crypto.randomUUID();
    pendingAttachments.set(id, {
      buffer: req.file.buffer,
      mimeType: req.file.mimetype,
      filename: req.file.originalname,
      userId,
      expires: Date.now() + ATTACHMENT_TTL_MS,
    });

    res.json({
      id,
      fileName: req.file.originalname,
      fileSize: req.file.size,
      mimeType: req.file.mimetype,
    });
  } catch (error) {
    console.error("[Claude Upload] Error:", error);
    res.status(500).json({ error: "Error al procesar archivo" });
  }
});

// POST /api/claude/chat - Enviar mensaje (respuesta en streaming SSE)
router.post("/api/chat", async (req, res) => {
  const { conversationId, message, model, systemPrompt, attachmentId, attachmentIds } = req.body;
  const userId = req.session.user.id;
  const isUnlimited = unlimitedUsage(req);

  // Soporta tanto un ID único (legacy) como un array de IDs
  const ids = Array.isArray(attachmentIds)
    ? attachmentIds
    : attachmentId
    ? [attachmentId]
    : [];

  if ((!message || !message.trim()) && !ids.length) {
    return res.status(400).json({ error: "Mensaje requerido" });
  }
  const selectedModel = claudeService.resolveModel(model, userIsAdmin(req));

  try {
    // Obtener o crear conversación
    let convId = conversationId;
    let isNewConversation = false;
    if (!convId) {
      isNewConversation = true;
      const result = await db.query(
        "INSERT INTO claude_conversations (user_id, title, created_at, updated_at) VALUES ($1, $2, NOW(), NOW()) RETURNING id",
        [userId, "Nueva conversación"]
      );
      convId = result.rows[0].id;
    } else {
      const conv = await db.query(
        "SELECT user_id FROM claude_conversations WHERE id = $1",
        [convId]
      );
      if (conv.rows.length === 0 || conv.rows[0].user_id !== userId) {
        return res.status(403).json({ error: "No autorizado" });
      }
    }

    const limitCheck = await assertCanSendMessage(userId, {
      withAttachment: ids.length > 0,
      isAdmin: isUnlimited,
    });
    if (!limitCheck.ok) {
      return res.status(limitCheck.status).json({
        error: limitCheck.error,
        code: limitCheck.code,
        usage: limitCheck.usage,
      });
    }

    // Recuperar adjuntos pendientes antes de modificar la BD
    const attachments = [];
    for (const id of ids) {
      const att = pendingAttachments.get(id);
      if (att && att.userId === userId) {
        attachments.push(att);
        pendingAttachments.delete(id);
      }
    }

    for (const att of attachments) {
      if (officeExcelFormat.isExcelFile(att.filename)) {
        storeExportTemplate({
          userId,
          conversationId: convId,
          buffer: att.buffer,
          filename: att.filename,
        });
      }
    }

    // Verificar cuota para todos los archivos de este envío
    if (attachments.length > 0 && !isUnlimited) {
      const usage = await getDailyUsage(userId, { isAdmin: false });
      if (usage.fileCount + attachments.length > usage.maxFiles) {
        return res.status(429).json({
          error: `Alcanzaste el límite diario de ${usage.maxFiles} archivos analizados. Podrás usar el asistente nuevamente mañana.`,
          code: "FILE_LIMIT",
          usage,
        });
      }
    }

    // Historial previo para contexto — ventana de mensajes
    const history = await db.query(
      `SELECT role, content FROM (
         SELECT role, content, created_at
         FROM claude_messages
         WHERE conversation_id = $1
         ORDER BY created_at DESC
         LIMIT $2
       ) recent ORDER BY created_at ASC`,
      [convId, CONTEXT_WINDOW_MESSAGES]
    );
    const messages = history.rows.map((row) => ({ role: row.role, content: row.content }));

    // Construir el turno del usuario (con adjuntos si aplica)
    const userText = (message || "").trim();
    let currentContent;
    if (attachments.length > 0) {
      const blocks = await Promise.all(
        attachments.map((att) => claudeService.buildAttachmentBlock(att))
      );
      currentContent = [
        ...blocks,
        { type: "text", text: userText || "Analiza los documentos adjuntos." },
      ];
    } else {
      currentContent = userText;
    }
    messages.push({ role: "user", content: currentContent });

    // Guardar mensaje del usuario (texto + lista de adjuntos)
    const attachmentPrefix = attachments.map((a) => `[Adjunto] ${a.filename}`).join("\n");
    const storedUserText = (attachmentPrefix ? `${attachmentPrefix}\n\n` : "") + userText;
    await db.query(
      "INSERT INTO claude_messages (conversation_id, role, content, created_at) VALUES ($1, $2, $3, NOW())",
      [convId, "user", storedUserText]
    );

    // Cabeceras SSE
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const sse = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    const provisionalTitle = claudeService.provisionalTitle(userText, attachments[0]?.filename);
    sse({
      type: "meta",
      conversationId: convId,
      title: provisionalTitle,
      isNew: isNewConversation,
    });

    if (isNewConversation) {
      await db.query("UPDATE claude_conversations SET title = $1 WHERE id = $2", [
        provisionalTitle,
        convId,
      ]);
    }

    const system = claudeService.buildSystemPrompt({
      customPrompt: systemPrompt,
      attachments,
    });

    let fullText = "";
    const final = await claudeService.streamMessage(messages, selectedModel, {
      system,
      onEvent: (ev) => {
        if (ev.type === "text") fullText += ev.text;
        sse(ev);
      },
    });

    // Guardar respuesta del asistente
    if (fullText.trim()) {
      await db.query(
        "INSERT INTO claude_messages (conversation_id, role, content, created_at) VALUES ($1, $2, $3, NOW())",
        [convId, "assistant", fullText]
      );
    }
    await db.query("UPDATE claude_conversations SET updated_at = NOW() WHERE id = $1", [convId]);

    const filesUsed = attachments.length;
    const messagesUsed = fullText.trim() ? 2 : 1;
    const dailyUsage = await recordUsage(userId, {
      messages: messagesUsed,
      files: filesUsed,
      isAdmin: isUnlimited,
    });

    if (isNewConversation) {
      const generatedTitle = await claudeService.generateConversationTitle({
        userText,
        assistantText: fullText,
        attachmentName: attachments[0]?.filename,
      });
      await db.query("UPDATE claude_conversations SET title = $1 WHERE id = $2", [
        generatedTitle,
        convId,
      ]);
      sse({ type: "title", title: generatedTitle });
    }

    sse({ type: "done", usage: final.usage, stopReason: final.stop_reason, dailyUsage });
    res.end();
  } catch (error) {
    console.error("[Claude Chat] Error:", error);
    if (!res.headersSent) {
      return res.status(500).json({ error: "Error al procesar el mensaje: " + error.message });
    }
    res.write(`data: ${JSON.stringify({ type: "error", error: error.message })}\n\n`);
    res.end();
  }
});

// POST /api/claude/extract - Extracción estructurada de un documento
router.post("/api/extract", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No se proporcionó archivo" });
    }
    const isUnlimited = unlimitedUsage(req);
    const validation = await claudeService.validateAttachment(req.file, { isAdmin: isUnlimited });
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }

    const userId = req.session.user.id;
    const resolved = await resolveConversationId({
      conversationId: req.body?.conversationId || null,
      userId,
    });
    if (resolved.error) {
      return res.status(resolved.error.status).json({ error: resolved.error.message });
    }
    const convId = resolved.conversationId;

    const limitCheck = await assertCanSendMessage(userId, {
      withAttachment: true,
      isAdmin: isUnlimited,
    });
    if (!limitCheck.ok) {
      return res.status(limitCheck.status).json({
        error: limitCheck.error,
        code: limitCheck.code,
        usage: limitCheck.usage,
      });
    }

    const result = await claudeService.extractDocumentData(
      {
        buffer: req.file.buffer,
        mimeType: req.file.mimetype,
        filename: req.file.originalname,
      },
      claudeService.resolveModel(req.body.model, userIsAdmin(req)),
      (req.body.instructions || "").trim()
    );

    if (!result.success) {
      return res.status(500).json({ error: result.error, raw: result.raw });
    }

    const userText = "Extraer información estructurada del documento";
    const storedUserText = `[Adjunto] ${req.file.originalname}\n\n${userText}`;
    const assistantText = claudeService.formatExtractAsMarkdown(result.data);

    await db.query(
      "INSERT INTO claude_messages (conversation_id, role, content, created_at) VALUES ($1, $2, $3, NOW()), ($1, $4, $5, NOW())",
      [convId, "user", storedUserText, "assistant", assistantText]
    );
    await db.query("UPDATE claude_conversations SET updated_at = NOW() WHERE id = $1", [convId]);

    const dailyUsage = await recordUsage(userId, {
      messages: 2,
      files: 1,
      isAdmin: isUnlimited,
    });

    res.json({
      conversationId: convId,
      isNewConversation: Boolean(resolved.isNew),
      fileName: req.file.originalname,
      data: result.data,
      usage: result.usage,
      dailyUsage,
    });
  } catch (error) {
    console.error("[Claude Extract] Error:", error);
    res.status(500).json({ error: "Error al extraer información: " + error.message });
  }
});

// GET /api/claude/history/:conversationId - Obtener historial
router.get("/api/history/:conversationId", async (req, res) => {
  try {
    const { conversationId } = req.params;
    const conv = await db.query(
      "SELECT user_id FROM claude_conversations WHERE id = $1",
      [conversationId]
    );
    if (conv.rows.length === 0 || conv.rows[0].user_id !== req.session.user.id) {
      return res.status(403).json({ error: "No autorizado" });
    }

    const messages = await db.query(
      "SELECT role, content, created_at FROM claude_messages WHERE conversation_id = $1 ORDER BY created_at ASC",
      [conversationId]
    );
    const dailyUsage = await getDailyUsage(req.session.user.id, {
      isAdmin: unlimitedUsage(req),
    });
    res.json({ messages: messages.rows, dailyUsage });
  } catch (error) {
    console.error("[Claude History] Error:", error);
    res.status(500).json({ error: "Error al obtener historial" });
  }
});

// PATCH /api/claude/conversation/:id - Renombrar conversación
router.patch("/api/conversation/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const title = String(req.body?.title || "").trim();
    if (!title) {
      return res.status(400).json({ error: "El título no puede estar vacío" });
    }
    if (title.length > 255) {
      return res.status(400).json({ error: "El título es demasiado largo (máx. 255 caracteres)" });
    }

    const conv = await db.query(
      "SELECT user_id FROM claude_conversations WHERE id = $1",
      [id]
    );
    if (conv.rows.length === 0 || conv.rows[0].user_id !== req.session.user.id) {
      return res.status(403).json({ error: "No autorizado" });
    }

    await db.query(
      "UPDATE claude_conversations SET title = $1, updated_at = NOW() WHERE id = $2",
      [title, id]
    );
    res.json({ success: true, title });
  } catch (error) {
    console.error("[Claude Rename] Error:", error);
    res.status(500).json({ error: "Error al renombrar conversación" });
  }
});

// DELETE /api/claude/conversation/:id - Eliminar conversación
router.delete("/api/conversation/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const conv = await db.query(
      "SELECT user_id FROM claude_conversations WHERE id = $1",
      [id]
    );
    if (conv.rows.length === 0 || conv.rows[0].user_id !== req.session.user.id) {
      return res.status(403).json({ error: "No autorizado" });
    }

    await db.query("DELETE FROM claude_messages WHERE conversation_id = $1", [id]);
    await db.query("DELETE FROM claude_conversations WHERE id = $1", [id]);
    res.json({ success: true });
  } catch (error) {
    console.error("[Claude Delete] Error:", error);
    res.status(500).json({ error: "Error al eliminar conversación" });
  }
});

// POST /api/claude/conversation/new - Nueva conversación
router.post("/api/conversation/new", async (req, res) => {
  try {
    const result = await db.query(
      "INSERT INTO claude_conversations (user_id, title, created_at, updated_at) VALUES ($1, $2, NOW(), NOW()) RETURNING id, created_at",
      [req.session.user.id, "Nueva conversación"]
    );
    res.json({
      conversationId: result.rows[0].id,
      createdAt: result.rows[0].created_at,
    });
  } catch (error) {
    console.error("[Claude New Conv] Error:", error);
    res.status(500).json({ error: "Error al crear conversación" });
  }
});

const MAX_EXPORT_CONTENT_CHARS = parseInt(process.env.CLAUDE_MAX_EXPORT_CHARS || "500000", 10);

// POST /api/claude/export-file - Genera un archivo Office/PDF real para descarga
router.post("/api/export-file", async (req, res) => {
  try {
    const filename = String(req.body?.filename || "").trim();
    const content = String(req.body?.content ?? "");
    const conversationId = req.body?.conversationId ? String(req.body.conversationId) : null;
    const sourceFilename = String(req.body?.sourceFilename || filename).trim();
    const userId = req.session.user.id;

    if (!filename) {
      return res.status(400).json({ error: "Nombre de archivo requerido" });
    }
    if (!content.trim()) {
      return res.status(400).json({ error: "Contenido del archivo vacío" });
    }
    if (content.length > MAX_EXPORT_CONTENT_CHARS) {
      return res.status(400).json({ error: "El contenido del archivo es demasiado grande" });
    }

    const template = officeExcelFormat.isExcelFile(filename)
      ? resolveExportTemplate({ userId, conversationId, filename: sourceFilename })
      : null;

    const result = await officeDocumentBuilder.buildFromContent(filename, content, {
      templateBuffer: template?.buffer || null,
    });
    res.setHeader("Content-Type", result.mimeType);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(result.filename)}"`
    );
    res.send(result.buffer);
  } catch (error) {
    console.error("[Claude Export] Error:", error);
    res.status(500).json({ error: error.message || "No se pudo generar el archivo" });
  }
});

module.exports = router;

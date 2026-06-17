const express = require("express");
const crypto = require("crypto");
const multer = require("multer");
const db = require("../db");
const claudeService = require("../services/claudeService");
const {
  getDailyUsage,
  recordUsage,
  hasSeenLimitsNotice,
  markLimitsNoticeSeen,
  assertCanSendMessage,
  assertCanAnalyzeFile,
} = require("../services/claudeDailyLimits");
const {
  MAX_MESSAGES_PER_DAY,
  MAX_FILES_PER_DAY,
  CONTEXT_WINDOW_MESSAGES,
  LIMITS_NOTICE,
} = require("../constants/claudeLimits");
const { isAdministrador } = require("../constants/roles");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// Almacén temporal en memoria para adjuntos pendientes de enviar al chat.
// Evita transportar PDFs en base64 dentro del cuerpo JSON del chat.
const pendingAttachments = new Map(); // id -> { buffer, mimeType, filename, userId, expires }
const ATTACHMENT_TTL_MS = 15 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [id, att] of pendingAttachments) {
    if (att.expires < now) pendingAttachments.delete(id);
  }
}, 60 * 1000).unref?.();

// Middleware: Verificar autenticación
const requireAuth = (req, res, next) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: "No autenticado" });
  }
  next();
};

const userIsAdmin = (req) => isAdministrador(req.session.user?.role);

// GET /claude - Abrir asistente como modal en la intranet
router.get("/", requireAuth, (req, res) => {
  res.redirect("/?openClaude=1");
});

// GET /claude/api/bootstrap - Datos iniciales para el modal
router.get("/api/bootstrap", requireAuth, async (req, res) => {
  try {
    const conversations = await db.query(
      "SELECT id, title, created_at FROM claude_conversations WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 50",
      [req.session.user.id]
    );

    const canChangeModel = userIsAdmin(req);
    const defaultModel = canChangeModel
      ? claudeService.getDefaultModel()
      : claudeService.getEconomicModel();

    const userId = req.session.user.id;
    const dailyUsage = await getDailyUsage(userId);
    const limitsNoticeSeen = await hasSeenLimitsNotice(userId);

    res.json({
      conversations: conversations.rows,
      models: canChangeModel ? claudeService.getAvailableModels() : [],
      defaultModel,
      defaultModelName: claudeService.getModelName(defaultModel),
      canChangeModel,
      userId,
      dailyUsage,
      limitsNoticeSeen,
      limits: {
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
router.get("/api/models", requireAuth, (req, res) => {
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
router.get("/api/usage", requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const dailyUsage = await getDailyUsage(userId);
    const limitsNoticeSeen = await hasSeenLimitsNotice(userId);
    res.json({ dailyUsage, limitsNoticeSeen, userId });
  } catch (error) {
    console.error("[Claude Usage] Error:", error);
    res.status(500).json({ error: "Error al obtener uso diario" });
  }
});

// POST /claude/api/limits-notice-seen - Marcar aviso de marcha blanca como visto
router.post("/api/limits-notice-seen", requireAuth, async (req, res) => {
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
router.post("/api/upload", requireAuth, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No se proporcionó archivo" });
    }
    const validation = await claudeService.validateAttachment(req.file);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }

    const userId = req.session.user.id;
    const fileCheck = await assertCanAnalyzeFile(userId);
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
router.post("/api/chat", requireAuth, async (req, res) => {
  const { conversationId, message, model, systemPrompt, attachmentId } = req.body;
  const userId = req.session.user.id;

  if ((!message || !message.trim()) && !attachmentId) {
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
      // Verificar propiedad
      const conv = await db.query(
        "SELECT user_id FROM claude_conversations WHERE id = $1",
        [convId]
      );
      if (conv.rows.length === 0 || conv.rows[0].user_id !== userId) {
        return res.status(403).json({ error: "No autorizado" });
      }
    }

    const limitCheck = await assertCanSendMessage(userId, { withAttachment: Boolean(attachmentId) });
    if (!limitCheck.ok) {
      return res.status(limitCheck.status).json({
        error: limitCheck.error,
        code: limitCheck.code,
        usage: limitCheck.usage,
      });
    }

    // Recuperar adjunto pendiente (si lo hay) antes de modificar la BD
    let attachment = null;
    if (attachmentId) {
      const att = pendingAttachments.get(attachmentId);
      if (att && att.userId === userId) {
        attachment = att;
        pendingAttachments.delete(attachmentId);
      }
    }

    if (attachment) {
      const fileCheck = await assertCanAnalyzeFile(userId);
      if (!fileCheck.ok) {
        return res.status(fileCheck.status).json({
          error: fileCheck.error,
          code: fileCheck.code,
          usage: fileCheck.usage,
        });
      }
    }

    // Historial previo (texto plano) para contexto — ventana de 20 mensajes
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

    // Construir el turno actual del usuario (con adjunto si aplica)
    const userText = (message || "").trim();
    let currentContent;
    if (attachment) {
      currentContent = [
        await claudeService.buildAttachmentBlock(attachment),
        { type: "text", text: userText || "Analiza el documento adjunto." },
      ];
    } else {
      currentContent = userText;
    }
    messages.push({ role: "user", content: currentContent });

    // Guardar mensaje del usuario (texto + nota de adjunto)
    const storedUserText =
      (attachment ? `📎 ${attachment.filename}\n\n` : "") + userText;
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
    const provisionalTitle = claudeService.provisionalTitle(userText, attachment?.filename);
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

    let fullText = "";
    const final = await claudeService.streamMessage(messages, selectedModel, {
      system: systemPrompt,
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

    const filesUsed = attachment ? 1 : 0;
    const messagesUsed = fullText.trim() ? 2 : 1;
    const dailyUsage = await recordUsage(userId, {
      messages: messagesUsed,
      files: filesUsed,
    });

    if (isNewConversation) {
      const generatedTitle = await claudeService.generateConversationTitle({
        userText,
        assistantText: fullText,
        attachmentName: attachment?.filename,
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
    // Si aún no se enviaron cabeceras, responder JSON; si no, emitir error por SSE
    if (!res.headersSent) {
      return res.status(500).json({ error: "Error al procesar el mensaje: " + error.message });
    }
    res.write(`data: ${JSON.stringify({ type: "error", error: error.message })}\n\n`);
    res.end();
  }
});

// POST /api/claude/extract - Extracción estructurada de un documento
router.post("/api/extract", requireAuth, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No se proporcionó archivo" });
    }
    const validation = await claudeService.validateAttachment(req.file);
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

    const limitCheck = await assertCanSendMessage(userId, { withAttachment: true });
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
    const storedUserText = `📎 ${req.file.originalname}\n\n${userText}`;
    const assistantText = claudeService.formatExtractAsMarkdown(result.data);

    await db.query(
      "INSERT INTO claude_messages (conversation_id, role, content, created_at) VALUES ($1, $2, $3, NOW()), ($1, $4, $5, NOW())",
      [convId, "user", storedUserText, "assistant", assistantText]
    );
    await db.query("UPDATE claude_conversations SET updated_at = NOW() WHERE id = $1", [convId]);

    const dailyUsage = await recordUsage(userId, { messages: 2, files: 1 });

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
router.get("/api/history/:conversationId", requireAuth, async (req, res) => {
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
    const dailyUsage = await getDailyUsage(req.session.user.id);
    res.json({ messages: messages.rows, dailyUsage });
  } catch (error) {
    console.error("[Claude History] Error:", error);
    res.status(500).json({ error: "Error al obtener historial" });
  }
});

// PATCH /api/claude/conversation/:id - Renombrar conversación
router.patch("/api/conversation/:id", requireAuth, async (req, res) => {
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
router.delete("/api/conversation/:id", requireAuth, async (req, res) => {
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
router.post("/api/conversation/new", requireAuth, async (req, res) => {
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

module.exports = router;

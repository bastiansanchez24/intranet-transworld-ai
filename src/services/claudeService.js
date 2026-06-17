const Anthropic = require("@anthropic-ai/sdk");
const path = require("path");
const officeDocumentParser = require("./officeDocumentParser");

// Modelo por defecto: Haiku 4.5 (el más económico). Los administradores pueden elegir otro modelo.
const DEFAULT_SYSTEM_PROMPT =
  "Eres Claude, el asistente de IA integrado en la intranet de Transworld. " +
  "Respondes en español, de forma clara, precisa y profesional. " +
  "Usas formato Markdown (encabezados, listas, tablas y bloques de código) cuando mejora la lectura. " +
  "Cuando el usuario adjunta un documento (PDF, Word, Excel, imagen o texto), lo analizas con cuidado y citas la información relevante.";

class ClaudeService {
  constructor() {
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY no configurada en .env");
    }
    this.client = new Anthropic({ apiKey });

    this.economicModel = "claude-haiku-4-5";
    this.models = [
      { id: "claude-haiku-4-5", name: "Claude Haiku 4.5 (Económico)", tokens: 200000 },
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Balanceado)", tokens: 1000000 },
      { id: "claude-opus-4-8", name: "Claude Opus 4.8 (Máxima capacidad)", tokens: 1000000 },
    ];

    this.defaultModel = this.economicModel;
  }

  getAvailableModels() {
    return this.models;
  }

  getDefaultModel() {
    return this.defaultModel;
  }

  getEconomicModel() {
    return this.economicModel;
  }

  getModelName(modelId) {
    return this.models.find((m) => m.id === modelId)?.name || modelId;
  }

  /** Usuarios normales siempre usan el modelo económico; solo administradores pueden elegir otro. */
  resolveModel(requestedModel, isAdmin) {
    if (!isAdmin) return this.economicModel;
    if (requestedModel && this.models.some((m) => m.id === requestedModel)) {
      return requestedModel;
    }
    return this.defaultModel;
  }

  // Haiku 4.5 no soporta adaptive thinking ni el parámetro effort.
  _supportsThinking(model) {
    return !model.includes("haiku");
  }

  // Construye los parámetros opcionales según las capacidades del modelo.
  _modelParams(model) {
    const params = {};
    if (this._supportsThinking(model)) {
      params.thinking = { type: "adaptive", display: "summarized" };
      params.output_config = { effort: "high" };
    }
    return params;
  }

  /**
   * Envía una conversación a Claude en modo streaming.
   * Invoca onEvent({ type: "thinking" | "text", text }) por cada delta.
   * Devuelve el mensaje final (incluye usage y stop_reason).
   */
  async streamMessage(messages, model = this.defaultModel, { system, onEvent } = {}) {
    const stream = this.client.messages.stream({
      model,
      max_tokens: 16000,
      system: system?.trim() || DEFAULT_SYSTEM_PROMPT,
      messages,
      ...this._modelParams(model),
    });

    for await (const event of stream) {
      if (event.type !== "content_block_delta") continue;
      if (event.delta.type === "text_delta") {
        onEvent?.({ type: "text", text: event.delta.text });
      } else if (event.delta.type === "thinking_delta") {
        onEvent?.({ type: "thinking", text: event.delta.thinking });
      }
    }

    return stream.finalMessage();
  }

  /**
   * Construye un bloque de contenido a partir de un archivo subido (buffer + mime).
   * Soporta PDF, imágenes, texto plano, Word (.doc/.docx) y Excel (.xls/.xlsx).
   */
  async buildAttachmentBlock({ buffer, mimeType, filename }) {
    const base64 = buffer.toString("base64");
    const officeKind = officeDocumentParser.getOfficeKind(filename, mimeType);

    if (mimeType === "application/pdf" || extensionOf(filename) === ".pdf") {
      return {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: base64 },
        title: filename,
      };
    }

    if (mimeType?.startsWith("image/")) {
      return {
        type: "image",
        source: { type: "base64", media_type: mimeType, data: base64 },
      };
    }

    if (officeKind) {
      const text = await officeDocumentParser.extractOfficeText(buffer, filename, mimeType);
      const label = officeKind === "word" ? "documento Word" : "hoja de cálculo Excel";
      return {
        type: "text",
        text: `Contenido extraído del ${label} "${filename}":\n\n${text}`,
      };
    }

    return {
      type: "text",
      text: `Contenido del archivo "${filename}":\n\n${buffer.toString("utf-8")}`,
    };
  }

  /** Valida tipo y tamaño de un adjunto antes de aceptarlo en el chat. */
  async validateAttachment(file) {
    if (!file?.buffer?.length) {
      return { valid: false, error: "Archivo vacío o no proporcionado" };
    }
    if (!this.validateFileSize(file.size)) {
      const maxSizeMB = parseInt(process.env.CLAUDE_MAX_FILE_SIZE || "10", 10);
      return { valid: false, error: `Archivo demasiado grande. Máximo ${maxSizeMB}MB` };
    }
    if (!this.isAllowedAttachment(file.originalname, file.mimetype)) {
      return {
        valid: false,
        error:
          "Tipo de archivo no soportado. Usa PDF, Word, Excel, imagen o texto (txt, csv, md, json).",
      };
    }

    const officeKind = officeDocumentParser.getOfficeKind(file.originalname, file.mimetype);
    if (officeKind) {
      try {
        await officeDocumentParser.extractOfficeText(file.buffer, file.originalname, file.mimetype);
      } catch (err) {
        return { valid: false, error: err.message || "No se pudo leer el documento Office" };
      }
    }

    return { valid: true };
  }

  isAllowedAttachment(filename, mimeType = "") {
    const ext = extensionOf(filename);
    const allowedExtensions = new Set([
      ".pdf",
      ".png",
      ".jpg",
      ".jpeg",
      ".webp",
      ".gif",
      ".txt",
      ".csv",
      ".md",
      ".json",
      ...officeDocumentParser.WORD_EXTENSIONS,
      ...officeDocumentParser.EXCEL_EXTENSIONS,
    ]);

    if (allowedExtensions.has(ext)) return true;
    if (mimeType === "application/pdf") return true;
    if (mimeType?.startsWith("image/")) return true;
    if (mimeType?.startsWith("text/")) return true;
    if (officeDocumentParser.getOfficeKind(filename, mimeType)) return true;

    return false;
  }

  /**
   * Extrae información estructurada de un PDF (o imagen) usando salidas
   * estructuradas (output_config.format). Devuelve un objeto validado.
   */
  async extractDocumentData({ buffer, mimeType, filename }, model = this.defaultModel, instructions = "") {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        titulo: { type: "string", description: "Título o nombre del documento" },
        tipo_documento: {
          type: "string",
          description: "Tipo de documento (contrato, factura, informe, carta, etc.)",
        },
        resumen: { type: "string", description: "Resumen ejecutivo en 2-4 frases" },
        puntos_clave: {
          type: "array",
          description: "Puntos más importantes del documento",
          items: { type: "string" },
        },
        datos_importantes: {
          type: "array",
          description: "Pares campo/valor relevantes (números de referencia, partes, etc.)",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              campo: { type: "string" },
              valor: { type: "string" },
            },
            required: ["campo", "valor"],
          },
        },
        fechas_relevantes: {
          type: "array",
          description: "Fechas mencionadas y su significado",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              descripcion: { type: "string" },
              fecha: { type: "string" },
            },
            required: ["descripcion", "fecha"],
          },
        },
        montos: {
          type: "array",
          description: "Importes o cifras económicas mencionadas",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              concepto: { type: "string" },
              valor: { type: "string" },
            },
            required: ["concepto", "valor"],
          },
        },
        acciones_requeridas: {
          type: "array",
          description: "Acciones, plazos o pasos a seguir derivados del documento",
          items: { type: "string" },
        },
      },
      required: [
        "titulo",
        "tipo_documento",
        "resumen",
        "puntos_clave",
        "datos_importantes",
        "fechas_relevantes",
        "montos",
        "acciones_requeridas",
      ],
    };

    const promptText =
      "Analiza el documento adjunto y extrae la información importante de forma estructurada. " +
      "Rellena cada campo del esquema; si un campo no aplica, usa un arreglo vacío o el texto \"No especificado\". " +
      (instructions ? `Indicaciones adicionales del usuario: ${instructions}` : "");

    const response = await this.client.messages.create({
      model,
      max_tokens: 8000,
      system:
        "Eres un analista documental experto. Extraes información de documentos de negocio en español con precisión.",
      messages: [
        {
          role: "user",
          content: [
            await this.buildAttachmentBlock({ buffer, mimeType, filename }),
            { type: "text", text: promptText },
          ],
        },
      ],
      output_config: { format: { type: "json_schema", schema } },
    });

    const textBlock = response.content.find((b) => b.type === "text");
    const raw = textBlock?.text || "{}";

    try {
      return { success: true, data: JSON.parse(raw), usage: response.usage };
    } catch (err) {
      return { success: false, error: "No se pudo interpretar la respuesta estructurada", raw };
    }
  }

  validateFileSize(sizeInBytes) {
    const maxSizeMB = parseInt(process.env.CLAUDE_MAX_FILE_SIZE || "10", 10);
    return sizeInBytes <= maxSizeMB * 1024 * 1024;
  }

  provisionalTitle(userText, attachmentName) {
    const text = String(userText || "").trim();
    if (text) return text.slice(0, 60);
    if (attachmentName) return `Análisis: ${attachmentName}`.slice(0, 60);
    return "Nueva conversación";
  }

  sanitizeTitle(title) {
    return String(title || "")
      .replace(/^["'«]+|["'»]+$/g, "")
      .replace(/[.?!]+$/g, "")
      .trim()
      .slice(0, 60);
  }

  /** Convierte el resultado de extracción en texto Markdown para persistir en el historial. */
  formatExtractAsMarkdown(data) {
    const d = data || {};
    const lines = [];
    const pushSection = (title, items) => {
      if (!items?.length) return;
      lines.push(`### ${title}`);
      items.forEach((item) => lines.push(`- ${item}`));
      lines.push("");
    };
    const pushKv = (title, arr, k, v) => {
      if (!arr?.length) return;
      lines.push(`### ${title}`);
      arr.forEach((item) => lines.push(`- **${item[k]}:** ${item[v]}`));
      lines.push("");
    };

    lines.push(`**${d.tipo_documento || "Documento"}:** ${d.titulo || "Sin título"}`);
    lines.push("");
    if (d.resumen) {
      lines.push("### Resumen");
      lines.push(d.resumen);
      lines.push("");
    }
    pushSection("Puntos clave", d.puntos_clave);
    pushKv("Datos importantes", d.datos_importantes, "campo", "valor");
    pushKv("Fechas relevantes", d.fechas_relevantes, "descripcion", "fecha");
    pushKv("Montos", d.montos, "concepto", "valor");
    pushSection("Acciones requeridas", d.acciones_requeridas);
    return lines.join("\n").trim() || "Extracción completada.";
  }

  /** Genera un título corto a partir del primer intercambio de la conversación. */
  async generateConversationTitle({ userText, assistantText, attachmentName }) {
    const parts = [];
    if (attachmentName) parts.push(`Archivo adjunto: ${attachmentName}`);
    if (userText?.trim()) parts.push(`Mensaje del usuario: ${userText.trim()}`);
    if (assistantText?.trim()) {
      parts.push(`Respuesta del asistente: ${assistantText.trim().slice(0, 500)}`);
    }
    const context = parts.join("\n");
    if (!context.trim()) return this.provisionalTitle(userText, attachmentName);

    try {
      const response = await this.client.messages.create({
        model: this.economicModel,
        max_tokens: 40,
        system:
          "Generas títulos breves para conversaciones de chat empresarial. " +
          "Responde solo con el título: sin comillas, sin explicación, máximo 8 palabras, en español.",
        messages: [
          {
            role: "user",
            content: `Asigna un título descriptivo a esta conversación:\n\n${context}`,
          },
        ],
      });
      const raw = response.content.find((b) => b.type === "text")?.text || "";
      return this.sanitizeTitle(raw) || this.provisionalTitle(userText, attachmentName);
    } catch (err) {
      console.error("[ClaudeService] Error generando título:", err.message);
      return this.provisionalTitle(userText, attachmentName);
    }
  }
}

module.exports = new ClaudeService();

function extensionOf(filename) {
  return path.extname(filename || "").toLowerCase();
}

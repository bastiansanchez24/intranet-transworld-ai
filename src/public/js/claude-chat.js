/* Claude AI – cliente de chat (streaming SSE + Markdown + extracción de PDF) */
class ClaudeChat {
  constructor() {
    this.currentConversationId = null;
    this.attachment = null;
    this.isStreaming = false;
    this.bootstrapped = false;
    this.config = window.CLAUDE_CONFIG || {};
    this.usage = { messageCount: 0, fileCount: 0, maxMessages: 30, maxFiles: 5 };
    this.cache();
    this.clearAttachment();
    this.bind();
    if (this.modelBadge) {
      this.modelBadge.textContent = "Modelo: " + this.getSelectedModelName();
    }
    if (window.marked) marked.setOptions({ breaks: true, gfm: true });
  }

  async ensureBootstrap() {
    if (this.bootstrapped) {
      await this.refreshDailyUsage();
      return;
    }

    const res = await fetch("/claude/api/bootstrap");
    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(data.error || "Error al cargar el asistente");
    }

    this.applyBootstrapData(data);
    this.bootstrapped = true;
  }

  applyBootstrapData(data) {
    window.CLAUDE_CONFIG = {
      defaultModel: data.defaultModel,
      defaultModelName: data.defaultModelName,
      canChangeModel: data.canChangeModel,
      limits: data.limits,
      userId: data.userId,
      limitsNoticeSeen: data.limitsNoticeSeen,
    };
    this.config = window.CLAUDE_CONFIG;
    if (data.limits) {
      this.usage.maxMessages = data.limits.maxMessages;
      this.usage.maxFiles = data.limits.maxFiles;
    }
    if (data.dailyUsage) this.applyUsage(data.dailyUsage);

    this.renderModelControls(data);
    this.renderConversations(data.conversations || []);
    if (this.modelBadge) {
      this.modelBadge.textContent = "Modelo: " + this.getSelectedModelName();
    }
  }

  async refreshDailyUsage() {
    try {
      const res = await fetch("/claude/api/usage");
      const data = await res.json();
      if (!res.ok || data.error) return;
      if (data.userId) {
        window.CLAUDE_CONFIG = { ...window.CLAUDE_CONFIG, userId: data.userId };
        this.config = window.CLAUDE_CONFIG;
      }
      if (data.dailyUsage) this.applyUsage(data.dailyUsage);
      if (typeof data.limitsNoticeSeen === "boolean") {
        window.CLAUDE_CONFIG = {
          ...window.CLAUDE_CONFIG,
          limitsNoticeSeen: data.limitsNoticeSeen,
        };
        this.config = window.CLAUDE_CONFIG;
      }
    } catch (err) {
      console.error("Error al refrescar uso diario:", err);
    }
  }

  renderModelControls({ canChangeModel, models, defaultModel, defaultModelName }) {
    const slot = document.getElementById("modelControlSlot");
    if (!slot) return;

    if (canChangeModel && models?.length) {
      const options = models
        .map(
          (m) =>
            `<option value="${this.escapeHtml(m.id)}"${m.id === defaultModel ? " selected" : ""}>${this.escapeHtml(m.name)}</option>`
        )
        .join("");
      slot.innerHTML = `<select id="modelSelect" class="model-selector" title="Modelo (solo administradores)">${options}</select>`;
      this.modelSelect = document.getElementById("modelSelect");
      this.lockedModel = null;
      this.modelLockedLabel = null;
      this.bindModelSelect();
    } else {
      slot.innerHTML = `
        <span class="model-locked" title="Modelo fijo de la organización">${this.escapeHtml(defaultModelName)}</span>
        <input type="hidden" id="lockedModel" value="${this.escapeHtml(defaultModel)}" />`;
      this.modelSelect = null;
      this.lockedModel = document.getElementById("lockedModel");
      this.modelLockedLabel = slot.querySelector(".model-locked");
    }
  }

  bindModelSelect() {
    if (!this.modelSelect) return;
    this.modelSelect.addEventListener("change", () => {
      if (this.modelBadge) {
        this.modelBadge.textContent = "Modelo: " + this.getSelectedModelName();
      }
    });
  }

  renderConversations(conversations) {
    if (!this.convList) return;
    this.convList.innerHTML = "";

    if (!conversations.length) {
      this.convList.innerHTML = '<p class="empty-text">Sin conversaciones todavía</p>';
      return;
    }

    conversations.forEach((conv) => {
      const item = document.createElement("div");
      item.className = "conversation-item";
      item.dataset.convId = String(conv.id);
      item.innerHTML = this.conversationItemHtml(conv.id, conv.title);
      this.convList.appendChild(item);
    });
  }

  cache() {
    this.thread = document.getElementById("chatThread");
    this.scroll = document.getElementById("chatScroll");
    this.welcome = document.getElementById("welcomeSection");
    this.input = document.getElementById("messageInput");
    this.sendBtn = document.getElementById("sendBtn");
    this.modelSelect = document.getElementById("modelSelect");
    this.lockedModel = document.getElementById("lockedModel");
    this.modelLockedLabel = document.querySelector(".model-locked");
    this.modelBadge = document.getElementById("modelBadge");
    this.btnNewChat = document.getElementById("btnNewChat");
    this.convList = document.getElementById("conversationsList");
    this.btnAttach = document.getElementById("btnAttach");
    this.btnExtract = document.getElementById("btnExtract");
    this.fileInputChat = document.getElementById("fileInputChat");
    this.fileInputExtract = document.getElementById("fileInputExtract");
    this.attachmentChip = document.getElementById("attachmentChip");
    this.attachmentName = document.getElementById("attachmentName");
    this.btnRemoveAttachment = document.getElementById("btnRemoveAttachment");
    this.usageEl = document.getElementById("dailyUsage");
  }

  applyUsage(usage) {
    if (!usage) return;
    this.usage = { ...this.usage, ...usage };
    this.renderUsageIndicator();
    this.onInput();
  }

  renderUsageIndicator() {
    if (!this.usageEl) return;
    const { messageCount, fileCount, maxMessages, maxFiles } = this.usage;
    const atMessageLimit = messageCount >= maxMessages || messageCount + 2 > maxMessages;
    const atFileLimit = fileCount >= maxFiles;
    const nearMessageLimit = messageCount + 2 >= maxMessages;
    const nearFileLimit = fileCount + 1 >= maxFiles;

    this.usageEl.hidden = false;
    this.usageEl.textContent = `Uso diario: ${messageCount}/${maxMessages} mensajes · ${fileCount}/${maxFiles} archivos`;
    this.usageEl.classList.toggle("is-limit", atMessageLimit || atFileLimit);
    this.usageEl.classList.toggle("is-warning", !atMessageLimit && !atFileLimit && (nearMessageLimit || nearFileLimit));
  }

  canSendMessage({ withAttachment = false } = {}) {
    const { messageCount, fileCount, maxMessages, maxFiles } = this.usage;
    if (messageCount >= maxMessages || messageCount + 2 > maxMessages) {
      return {
        ok: false,
        message: `Alcanzaste el límite diario de ${maxMessages} mensajes. Podrás usar el asistente nuevamente mañana.`,
      };
    }
    if (withAttachment && fileCount >= maxFiles) {
      return {
        ok: false,
        message: `Alcanzaste el límite diario de ${maxFiles} archivos analizados. Podrás usar el asistente nuevamente mañana.`,
      };
    }
    return { ok: true };
  }

  canAnalyzeFile() {
    const { fileCount, maxFiles } = this.usage;
    if (fileCount >= maxFiles) {
      return {
        ok: false,
        message: `Alcanzaste el límite diario de ${maxFiles} archivos analizados. Podrás usar el asistente nuevamente mañana.`,
      };
    }
    return { ok: true };
  }

  showLimitAlert(message) {
    alert(message);
  }

  bind() {
    this.input.addEventListener("input", () => this.onInput());
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this.send(); }
    });
    this.sendBtn.addEventListener("click", () => this.send());
    this.btnNewChat.addEventListener("click", () => this.newConversation());
    this.bindModelSelect();

    this.btnAttach.addEventListener("click", () => this.fileInputChat.click());
    this.fileInputChat.addEventListener("change", (e) => this.uploadAttachment(e.target.files[0]));
    this.btnExtract.addEventListener("click", () => this.fileInputExtract.click());
    this.fileInputExtract.addEventListener("change", (e) => this.extractPdf(e.target.files[0]));
    this.btnRemoveAttachment.addEventListener("click", () => this.clearAttachment());

    this.convList.addEventListener("click", (e) => {
      const rename = e.target.closest(".btn-rename-conv");
      if (rename) { e.stopPropagation(); return this.startRename(rename.dataset.convId); }
      const del = e.target.closest(".btn-delete-conv");
      if (del) { e.stopPropagation(); return this.deleteConversation(del.dataset.convId); }
      const item = e.target.closest(".conversation-item");
      if (item && !item.classList.contains("is-editing")) this.loadConversation(item.dataset.convId);
    });

    this.thread.addEventListener("click", (e) => {
      const prompt = e.target.closest("[data-prompt]");
      if (prompt) { this.input.value = prompt.dataset.prompt; this.onInput(); this.input.focus(); }
      const extract = e.target.closest('[data-action="extract"]');
      if (extract) this.fileInputExtract.click();
      const toggle = e.target.closest(".thinking-toggle");
      if (toggle) {
        const c = toggle.nextElementSibling;
        c.hidden = !c.hidden;
      }
    });
  }

  getSelectedModel() {
    if (this.modelSelect) return this.modelSelect.value;
    return this.lockedModel?.value || this.config.defaultModel || "claude-haiku-4-5";
  }

  getSelectedModelName() {
    if (this.modelSelect) {
      return this.modelSelect.options[this.modelSelect.selectedIndex].text;
    }
    return this.modelLockedLabel?.textContent || this.config.defaultModelName || "Claude Haiku 4.5";
  }

  onInput() {
    this.input.style.height = "auto";
    this.input.style.height = Math.min(this.input.scrollHeight, 180) + "px";
    const sendCheck = this.canSendMessage({ withAttachment: Boolean(this.attachment) });
    this.sendBtn.disabled =
      this.isStreaming || (!this.input.value.trim() && !this.attachment) || !sendCheck.ok;
  }

  scrollToBottom() { this.scroll.scrollTop = this.scroll.scrollHeight; }

  hideWelcome() { if (this.welcome) { this.welcome.remove(); this.welcome = null; } }

  escapeHtml(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  renderMarkdown(text) {
    if (window.marked && window.DOMPurify) {
      return DOMPurify.sanitize(marked.parse(text));
    }
    return this.escapeHtml(text).replace(/\n/g, "<br>");
  }

  addUserMessage(text, attachmentName) {
    this.hideWelcome();
    const el = document.createElement("div");
    el.className = "msg user";
    const att = attachmentName
      ? `<div class="msg-attachment">📎 ${this.escapeHtml(attachmentName)}</div>`
      : "";
    el.innerHTML = `<div class="msg-body">${att}${this.escapeHtml(text)}</div>`;
    this.thread.appendChild(el);
    this.scrollToBottom();
  }

  // Crea el contenedor del mensaje del asistente y devuelve sus partes.
  createAssistantMessage() {
    this.hideWelcome();
    const el = document.createElement("div");
    el.className = "msg assistant";
    el.innerHTML = `
      <div class="msg-avatar">✦</div>
      <div class="msg-body">
        <div class="thinking-block" hidden>
          <button class="thinking-toggle">💭 Razonamiento</button>
          <div class="thinking-content" hidden></div>
        </div>
        <div class="typing-dots"><span></span><span></span><span></span></div>
        <div class="msg-text"></div>
      </div>`;
    this.thread.appendChild(el);
    this.scrollToBottom();
    return {
      el,
      thinkingBlock: el.querySelector(".thinking-block"),
      thinkingContent: el.querySelector(".thinking-content"),
      dots: el.querySelector(".typing-dots"),
      textEl: el.querySelector(".msg-text"),
    };
  }

  async send() {
    const text = this.input.value.trim();
    if (this.isStreaming || (!text && !this.attachment)) return;

    const sendCheck = this.canSendMessage({ withAttachment: Boolean(this.attachment) });
    if (!sendCheck.ok) {
      this.showLimitAlert(sendCheck.message);
      return;
    }

    const attName = this.attachment?.fileName || null;
    const attachmentId = this.attachment?.id || null;
    this.addUserMessage(text, attName);
    this.input.value = "";
    this.clearAttachment();
    this.onInput();

    this.isStreaming = true;
    this.sendBtn.disabled = true;
    const parts = this.createAssistantMessage();
    parts.textEl.classList.add("stream-cursor");

    let acc = "";
    let firstText = true;
    try {
      const res = await fetch("/claude/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: this.currentConversationId,
          message: text,
          model: this.getSelectedModel(),
          attachmentId,
        }),
      });

      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({}));
        if (err.usage) this.applyUsage(err.usage);
        throw new Error(err.error || "Error de conexión");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop();

        for (const block of lines) {
          const line = block.trim();
          if (!line.startsWith("data:")) continue;
          const payload = JSON.parse(line.slice(5).trim());

          if (payload.type === "meta") {
            if (!this.currentConversationId) {
              this.currentConversationId = payload.conversationId;
              this.upsertSidebarItem(payload.conversationId, payload.title);
            }
          } else if (payload.type === "title") {
            this.updateSidebarTitle(payload.conversationId, payload.title);
          } else if (payload.type === "thinking") {
            parts.thinkingBlock.hidden = false;
            parts.thinkingContent.hidden = false;
            parts.thinkingContent.textContent += payload.text;
          } else if (payload.type === "text") {
            if (firstText) { parts.dots.remove(); firstText = false; }
            acc += payload.text;
            parts.textEl.innerHTML = this.renderMarkdown(acc);
            this.scrollToBottom();
          } else if (payload.type === "error") {
            throw new Error(payload.error);
          } else if (payload.type === "done" && payload.dailyUsage) {
            this.applyUsage(payload.dailyUsage);
          }
        }
      }
      if (firstText) parts.dots.remove();
      parts.thinkingContent.hidden = true; // colapsar al terminar
    } catch (err) {
      parts.dots.remove();
      parts.textEl.innerHTML = `<span style="color:#c0392b">⚠️ ${this.escapeHtml(err.message)}</span>`;
      if (err.message.includes("límite")) this.thread.lastElementChild?.querySelector(".msg-body")?.prepend(
        Object.assign(document.createElement("p"), {
          style: "color:#b45309;font-size:13px;margin:0 0 8px",
          textContent: "Has alcanzado tu cuota diaria. Vuelve mañana para continuar usando el asistente.",
        })
      );
    } finally {
      parts.textEl.classList.remove("stream-cursor");
      this.isStreaming = false;
      this.onInput();
      this.input.focus();
    }
  }

  async uploadAttachment(file) {
    if (!file) return;

    const fileCheck = this.canAnalyzeFile();
    if (!fileCheck.ok) {
      this.showLimitAlert(fileCheck.message);
      this.fileInputChat.value = "";
      return;
    }

    const fd = new FormData();
    fd.append("file", file);
    this.attachmentName.textContent = "Subiendo " + file.name + "…";
    this.attachmentChip.hidden = false;
    try {
      const res = await fetch("/claude/api/upload", { method: "POST", body: fd });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      this.attachment = { id: data.id, fileName: data.fileName, mimeType: data.mimeType };
      this.attachmentName.textContent = data.fileName;
      this.onInput();
    } catch (err) {
      this.attachmentChip.hidden = true;
      alert("Error al subir: " + err.message);
    }
    this.fileInputChat.value = "";
  }

  clearAttachment() {
    this.attachment = null;
    this.attachmentChip.hidden = true;
    this.attachmentName.textContent = "";
  }

  async extractPdf(file) {
    if (!file) return;

    const fileCheck = this.canAnalyzeFile();
    if (!fileCheck.ok) {
      this.showLimitAlert(fileCheck.message);
      this.fileInputExtract.value = "";
      return;
    }

    const sendCheck = this.canSendMessage({ withAttachment: true });
    if (!sendCheck.ok) {
      this.showLimitAlert(sendCheck.message);
      this.fileInputExtract.value = "";
      return;
    }

    this.fileInputExtract.value = "";
    this.hideWelcome();
    this.addUserMessage("Extraer información estructurada del documento", file.name);

    const parts = this.createAssistantMessage();
    parts.thinkingBlock.remove();

    const fd = new FormData();
    fd.append("file", file);
    fd.append("model", this.getSelectedModel());
    if (this.currentConversationId) {
      fd.append("conversationId", this.currentConversationId);
    }

    try {
      const res = await fetch("/claude/api/extract", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok || data.error) {
        if (data.dailyUsage) this.applyUsage(data.dailyUsage);
        throw new Error(data.error || "Error en la extracción");
      }
      if (data.conversationId && !this.currentConversationId) {
        this.currentConversationId = data.conversationId;
        this.upsertSidebarItem(data.conversationId, `Extracción: ${file.name}`.slice(0, 60));
      }
      if (data.dailyUsage) this.applyUsage(data.dailyUsage);
      parts.dots.remove();
      parts.textEl.innerHTML = this.renderExtractCard(data.data);
      this.scrollToBottom();
    } catch (err) {
      parts.dots.remove();
      parts.textEl.innerHTML = `<span style="color:#c0392b">⚠️ ${this.escapeHtml(err.message)}</span>`;
    }
  }

  renderExtractCard(d) {
    const esc = (s) => this.escapeHtml(String(s ?? ""));
    const list = (arr) =>
      arr && arr.length
        ? `<ul>${arr.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`
        : '<p style="color:#76746e;font-size:13px">—</p>';
    const kv = (arr, k, v) =>
      arr && arr.length
        ? `<div class="kv-grid">${arr
            .map((i) => `<span class="k">${esc(i[k])}</span><span>${esc(i[v])}</span>`)
            .join("")}</div>`
        : '<p style="color:#76746e;font-size:13px">—</p>';

    const section = (title, html) =>
      `<div class="extract-section"><h5>${title}</h5>${html}</div>`;

    return `
      <div class="extract-card">
        <div class="extract-head">
          <span class="doc-type">${esc(d.tipo_documento) || "Documento"}</span>
          <h4>${esc(d.titulo) || "Sin título"}</h4>
        </div>
        <div class="extract-body">
          <div class="extract-section"><h5>Resumen</h5><div class="extract-resumen">${esc(d.resumen)}</div></div>
          ${section("Puntos clave", list(d.puntos_clave))}
          ${section("Datos importantes", kv(d.datos_importantes, "campo", "valor"))}
          ${section("Fechas relevantes", kv(d.fechas_relevantes, "descripcion", "fecha"))}
          ${section("Montos", kv(d.montos, "concepto", "valor"))}
          ${section("Acciones requeridas", list(d.acciones_requeridas))}
        </div>
      </div>`;
  }

  newConversation() {
    this.currentConversationId = null;
    this.clearAttachment();
    this.thread.innerHTML = "";
    const w = document.createElement("div");
    w.className = "welcome-section";
    w.id = "welcomeSection";
    w.innerHTML = `
      <div class="welcome-logo">✦</div>
      <h2>¡Empecemos con algo nuevo!</h2>
      <p>Pregúntame lo que quieras o adjunta un PDF, Word o Excel para analizarlo.</p>
      <div class="quick-actions">
        <button class="quick-action" data-prompt="Ayúdame a redactar un correo profesional sobre ">📝 Redactar un correo</button>
        <button class="quick-action" data-prompt="Resume y explica los puntos clave del siguiente texto: ">🔍 Resumir un texto</button>
        <button class="quick-action" data-prompt="Explícame de forma sencilla cómo funciona ">📚 Explicar un concepto</button>
        <button class="quick-action" data-action="extract">📄 Extraer datos de un documento</button>
      </div>`;
    this.thread.appendChild(w);
    this.welcome = w;
    document.querySelectorAll(".conversation-item").forEach((el) => el.classList.remove("active"));
    this.input.focus();
  }

  async loadConversation(convId) {
    if (this.isStreaming) return;
    this.currentConversationId = convId;
    this.thread.innerHTML = "";
    this.welcome = null;
    document.querySelectorAll(".conversation-item").forEach((el) =>
      el.classList.toggle("active", el.dataset.convId === String(convId))
    );

    try {
      const res = await fetch(`/claude/api/history/${convId}`);
      const data = await res.json();
      const messages = Array.isArray(data) ? data : data.messages || [];
      if (data.dailyUsage) this.applyUsage(data.dailyUsage);
      messages.forEach((m) => {
        if (m.role === "user") {
          this.addUserMessage(m.content);
        } else {
          const el = document.createElement("div");
          el.className = "msg assistant";
          el.innerHTML = `<div class="msg-avatar">✦</div><div class="msg-body"><div class="msg-text">${this.renderMarkdown(
            m.content
          )}</div></div>`;
          this.thread.appendChild(el);
        }
      });
      this.scrollToBottom();
    } catch (err) {
      console.error("Error al cargar conversación:", err);
    }
  }

  async deleteConversation(convId) {
    if (!confirm("¿Eliminar esta conversación?")) return;
    try {
      await fetch(`/claude/api/conversation/${convId}`, { method: "DELETE" });
      document.querySelector(`.conversation-item[data-conv-id="${convId}"]`)?.remove();
      if (String(this.currentConversationId) === String(convId)) this.newConversation();
    } catch (err) {
      console.error("Error al eliminar:", err);
    }
  }

  conversationItemHtml(convId, title) {
    const safeTitle = this.escapeHtml(title);
    return `
      <span class="conv-title">${safeTitle}</span>
      <div class="conv-actions">
        <button class="btn-rename-conv" data-conv-id="${convId}" title="Renombrar" type="button">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
        </button>
        <button class="btn-delete-conv" data-conv-id="${convId}" title="Eliminar" type="button">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>
        </button>
      </div>`;
  }

  getConversationItem(convId) {
    return this.convList.querySelector(`.conversation-item[data-conv-id="${convId}"]`);
  }

  upsertSidebarItem(convId, title) {
    const empty = this.convList.querySelector(".empty-text");
    if (empty) empty.remove();

    let item = this.getConversationItem(convId);
    if (!item) {
      item = document.createElement("div");
      item.className = "conversation-item";
      item.dataset.convId = String(convId);
      this.convList.prepend(item);
    }

    item.innerHTML = this.conversationItemHtml(convId, title);
    document.querySelectorAll(".conversation-item").forEach((el) => el.classList.remove("active"));
    item.classList.add("active");
  }

  updateSidebarTitle(convId, title) {
    const item = this.getConversationItem(convId);
    if (!item || item.classList.contains("is-editing")) return;
    const titleEl = item.querySelector(".conv-title");
    if (titleEl) titleEl.textContent = title;
  }

  startRename(convId) {
    const item = this.getConversationItem(convId);
    if (!item || item.classList.contains("is-editing")) return;

    const titleEl = item.querySelector(".conv-title");
    const currentTitle = titleEl?.textContent?.trim() || "";
    item.classList.add("is-editing");

    const input = document.createElement("input");
    input.type = "text";
    input.className = "conv-title-input";
    input.value = currentTitle;
    input.maxLength = 255;
    titleEl.replaceWith(input);
    input.focus();
    input.select();

    const cancel = () => {
      item.classList.remove("is-editing");
      input.replaceWith(this.createTitleSpan(currentTitle));
    };

    const save = async () => {
      const newTitle = input.value.trim();
      if (!newTitle) {
        cancel();
        return;
      }
      if (newTitle === currentTitle) {
        cancel();
        return;
      }
      try {
        const res = await fetch(`/claude/api/conversation/${convId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: newTitle }),
        });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || "No se pudo renombrar");
        item.classList.remove("is-editing");
        input.replaceWith(this.createTitleSpan(data.title));
      } catch (err) {
        alert("Error al renombrar: " + err.message);
        input.focus();
      }
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); save(); }
      if (e.key === "Escape") { e.preventDefault(); cancel(); }
    });
    input.addEventListener("blur", () => save());
  }

  createTitleSpan(title) {
    const span = document.createElement("span");
    span.className = "conv-title";
    span.textContent = title;
    return span;
  }
}

// Instancia creada al abrir el modal (ver claude-modal.js)

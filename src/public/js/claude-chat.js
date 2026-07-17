/* Claude AI – cliente de chat (streaming SSE + Markdown + extracción de PDF) */
const CLAUDE_LOGO_SVG = `<svg class="claude-ai-logo" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="m3.127 10.604 3.135-1.76.053-.153-.053-.085H6.11l-.525-.032-1.791-.048-1.554-.065-1.505-.08-.38-.081L0 7.832l.036-.234.32-.214.455.04 1.009.069 1.513.105 1.097.064 1.626.17h.259l.036-.105-.089-.065-.068-.064-1.566-1.062-1.695-1.121-.887-.646-.48-.327-.243-.306-.104-.67.435-.48.585.04.15.04.593.456 1.267.981 1.654 1.218.242.202.097-.068.012-.049-.109-.181-.9-1.626-.96-1.655-.428-.686-.113-.411a2 2 0 0 1-.068-.484l.496-.674L4.446 0l.662.089.279.242.411.94.666 1.48 1.033 2.014.302.597.162.553.06.17h.105v-.097l.085-1.134.157-1.392.154-1.792.052-.504.25-.605.497-.327.387.186.319.456-.045.294-.19 1.23-.37 1.93-.243 1.29h.142l.161-.16.654-.868 1.097-1.372.484-.545.565-.601.363-.287h.686l.505.751-.226.775-.707.895-.585.759-.839 1.13-.524.904.048.072.125-.012 1.897-.403 1.024-.186 1.223-.21.553.258.06.263-.218.536-1.307.323-1.533.307-2.284.54-.028.02.032.04 1.029.098.44.024h1.077l2.005.15.525.346.315.424-.053.323-.807.411-3.631-.863-.872-.218h-.12v.073l.726.71 1.331 1.202 1.667 1.55.084.383-.214.302-.226-.032-1.464-1.101-.565-.497-1.28-1.077h-.084v.113l.295.432 1.557 2.34.08.718-.112.234-.404.141-.444-.08-.911-1.28-.94-1.44-.759-1.291-.093.053-.448 4.821-.21.246-.484.186-.403-.307-.214-.496.214-.98.258-1.28.21-1.016.19-1.263.112-.42-.008-.028-.092.012-.953 1.307-1.448 1.957-1.146 1.227-.274.109-.477-.247.045-.44.266-.39 1.586-2.018.956-1.25.617-.723-.004-.105h-.036l-4.212 2.736-.75.096-.324-.302.04-.496.154-.162 1.267-.871z"/></svg>`;

class ClaudeChat {
  constructor() {
    this.currentConversationId = null;
    this.attachments = [];
    this.uploadedFilenamesInConversation = [];
    this.isStreaming = false;
    this.bootstrapped = false;
    this.config = window.CLAUDE_CONFIG || {};
    this.usage = { messageCount: 0, fileCount: 0, maxMessages: 30, maxFiles: 5, unlimited: false };
    this.cache();
    this.clearAttachments();
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
      this.usage.unlimited = Boolean(data.limits.unlimited);
      if (!this.usage.unlimited) {
        this.usage.maxMessages = data.limits.maxMessages;
        this.usage.maxFiles = data.limits.maxFiles;
      }
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
    this.attachmentsArea = document.getElementById("attachmentsArea");
    this.usageEl = document.getElementById("dailyUsage");
    this.dropOverlay = document.getElementById("dropZoneOverlay");
    this.dropZoneChat = document.getElementById("dropZoneChat");
    this.dropZoneExtract = document.getElementById("dropZoneExtract");
  }

  applyUsage(usage) {
    if (!usage) return;
    this.usage = { ...this.usage, ...usage };
    this.renderUsageIndicator();
    this.onInput();
  }

  renderUsageIndicator() {
    if (!this.usageEl) return;
    const { messageCount, fileCount, maxMessages, maxFiles, unlimited } = this.usage;

    if (unlimited) {
      this.usageEl.hidden = false;
      this.usageEl.textContent = `Uso diario: ${messageCount} mensajes · ${fileCount} archivos (sin límite)`;
      this.usageEl.classList.remove("is-limit", "is-warning");
      return;
    }

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
    if (this.usage.unlimited) return { ok: true };
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
    if (this.usage.unlimited) return { ok: true };
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
    this.fileInputChat.addEventListener("change", (e) => {
      this.handleFiles(e.target.files);
      this.fileInputChat.value = "";
    });
    this.btnExtract.addEventListener("click", () => this.fileInputExtract.click());
    this.fileInputExtract.addEventListener("change", (e) => {
      this.extractPdf(e.target.files[0]);
      this.fileInputExtract.value = "";
    });
    this.attachmentsArea.addEventListener("click", (e) => {
      const btn = e.target.closest(".btn-remove-attachment");
      if (btn) this.removeAttachment(btn.dataset.attId);
    });

    this.setupDropZone();

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
    const sendCheck = this.canSendMessage({ withAttachment: this.attachments.length > 0 });
    this.sendBtn.disabled =
      this.isStreaming || (!this.input.value.trim() && !this.attachments.length) || !sendCheck.ok;
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

  addUserMessage(text, attachmentNames) {
    this.hideWelcome();
    const el = document.createElement("div");
    el.className = "msg user";
    const names = Array.isArray(attachmentNames)
      ? attachmentNames
      : attachmentNames
      ? [attachmentNames]
      : [];
    const att = names
      .map((n) => `<div class="msg-attachment">Adjunto: ${this.escapeHtml(n)}</div>`)
      .join("");
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
      <div class="msg-avatar">${CLAUDE_LOGO_SVG}</div>
      <div class="msg-body">
        <div class="thinking-block" hidden>
          <button class="thinking-toggle">Razonamiento</button>
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
    if (this.isStreaming || (!text && !this.attachments.length)) return;

    const sendCheck = this.canSendMessage({ withAttachment: this.attachments.length > 0 });
    if (!sendCheck.ok) {
      this.showLimitAlert(sendCheck.message);
      return;
    }

    const attNames = this.attachments.map((a) => a.fileName);
    const attachmentIds = this.attachments.map((a) => a.id);
    this.uploadedFilenamesInConversation.push(...attNames);
    this.addUserMessage(text, attNames);
    this.input.value = "";
    this.clearAttachments();
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
          attachmentIds,
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
      parts.textEl.innerHTML = `<span style="color:#c0392b">Error: ${this.escapeHtml(err.message)}</span>`;
      if (err.message.includes("límite")) this.thread.lastElementChild?.querySelector(".msg-body")?.prepend(
        Object.assign(document.createElement("p"), {
          style: "color:#b45309;font-size:13px;margin:0 0 8px",
          textContent: "Has alcanzado tu cuota diaria. Vuelve mañana para continuar usando el asistente.",
        })
      );
    } finally {
      this.enhanceCodeBlocks(parts.textEl);
      parts.textEl.classList.remove("stream-cursor");
      this.isStreaming = false;
      this.onInput();
      this.input.focus();
    }
  }

  async handleFiles(fileList) {
    const MAX = 5;
    const remaining = MAX - this.attachments.length;
    if (remaining <= 0) {
      this.showLimitAlert(`Ya tienes ${MAX} archivos adjuntos (máximo por mensaje).`);
      return;
    }
    const files = [...fileList].slice(0, remaining);
    if ([...fileList].length > remaining) {
      alert(`Solo se añadirán ${files.length} archivo(s). El máximo es ${MAX} por mensaje.`);
    }
    await Promise.all(files.map((f) => this.uploadAttachment(f)));
  }

  async uploadAttachment(file) {
    if (!file) return;
    if (this.attachments.length >= 5) {
      this.showLimitAlert("Solo puedes adjuntar hasta 5 archivos por mensaje.");
      return;
    }

    const fileCheck = this.canAnalyzeFile();
    if (!fileCheck.ok) {
      this.showLimitAlert(fileCheck.message);
      return;
    }

    const loadingChip = document.createElement("div");
    loadingChip.className = "attachment-chip is-uploading";
    loadingChip.innerHTML = `<span class="attachment-chip-name">⏳ ${this.escapeHtml(file.name)}</span>`;
    this.attachmentsArea.appendChild(loadingChip);
    this.attachmentsArea.hidden = false;

    const fd = new FormData();
    fd.append("file", file);
    try {
      const res = await fetch("/claude/api/upload", { method: "POST", body: fd });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      loadingChip.replaceWith(this._buildChip(data.id, data.fileName));
      this.attachments.push({ id: data.id, fileName: data.fileName, mimeType: data.mimeType });
      this.onInput();
    } catch (err) {
      loadingChip.remove();
      if (!this.attachmentsArea.hasChildNodes()) this.attachmentsArea.hidden = true;
      alert("Error al subir: " + err.message);
    }
  }

  _buildChip(id, fileName) {
    const chip = document.createElement("div");
    chip.className = "attachment-chip";
    chip.dataset.attId = id;
    chip.innerHTML = `
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>
      <span class="attachment-chip-name">${this.escapeHtml(fileName)}</span>
      <button class="btn-remove-attachment" data-att-id="${id}" type="button" title="Quitar">✕</button>`;
    return chip;
  }

  removeAttachment(id) {
    this.attachments = this.attachments.filter((a) => a.id !== id);
    this.attachmentsArea.querySelector(`[data-att-id="${id}"]`)?.remove();
    if (!this.attachmentsArea.hasChildNodes()) this.attachmentsArea.hidden = true;
    this.onInput();
  }

  clearAttachments() {
    this.attachments = [];
    if (this.attachmentsArea) {
      this.attachmentsArea.innerHTML = "";
      this.attachmentsArea.hidden = true;
    }
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
      parts.textEl.innerHTML = `<span style="color:#c0392b">Error: ${this.escapeHtml(err.message)}</span>`;
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
    window.ClaudeModal?.closeSidebar?.();
    this.currentConversationId = null;
    this.uploadedFilenamesInConversation = [];
    this.clearAttachments();
    this.thread.innerHTML = "";
    const w = document.createElement("div");
    w.className = "welcome-section";
    w.id = "welcomeSection";
    w.innerHTML = `
      <div class="welcome-logo">${CLAUDE_LOGO_SVG}</div>
      <h2>¡Empecemos con algo nuevo!</h2>
      <p>Pregúntame lo que quieras o adjunta un PDF, Word o Excel para analizarlo.</p>
      <div class="quick-actions">
        <button class="quick-action" data-prompt="Ayúdame a redactar un correo profesional sobre ">Redactar un correo</button>
        <button class="quick-action" data-prompt="Resume y explica los puntos clave del siguiente texto: ">Resumir un texto</button>
        <button class="quick-action" data-prompt="Explícame de forma sencilla cómo funciona ">Explicar un concepto</button>
        <button class="quick-action" data-action="extract">Extraer datos de un documento</button>
      </div>`;
    this.thread.appendChild(w);
    this.welcome = w;
    document.querySelectorAll(".conversation-item").forEach((el) => el.classList.remove("active"));
    this.input.focus();
  }

  async loadConversation(convId) {
    if (this.isStreaming) return;
    window.ClaudeModal?.closeSidebar?.();
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
          el.innerHTML = `<div class="msg-avatar">${CLAUDE_LOGO_SVG}</div><div class="msg-body"><div class="msg-text">${this.renderMarkdown(m.content)}</div></div>`;
          this.thread.appendChild(el);
          const msgText = el.querySelector(".msg-text");
          if (msgText) this.enhanceCodeBlocks(msgText);
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

  // ---- Tarjetas de descarga y botones en bloques de código ----

  enhanceCodeBlocks(container) {
    if (!container) return;

    const LANG_EXT = {
      javascript: "js", typescript: "ts", python: "py", ruby: "rb",
      java: "java", csharp: "cs", cpp: "cpp", c: "c", go: "go",
      rust: "rs", php: "php", swift: "swift", kotlin: "kt",
      sql: "sql", json: "json", csv: "csv", xml: "xml", html: "html",
      css: "css", scss: "scss", markdown: "md", md: "md",
      bash: "sh", shell: "sh", sh: "sh", yaml: "yml", toml: "toml",
      txt: "txt", text: "txt", ini: "ini", env: "env",
    };
    const LANG_MIME = {
      json: "application/json", csv: "text/csv", html: "text/html",
      xml: "application/xml", svg: "image/svg+xml",
    };

    container.querySelectorAll("pre:not(.code-enhanced)").forEach((pre) => {
      pre.classList.add("code-enhanced");
      const code = pre.querySelector("code");
      const langClass = [...(code?.classList || [])].find((c) => c.startsWith("language-")) || "";
      const rawLang = langClass.replace("language-", "").toLowerCase();

      // Bloque de archivo descargable (```file) → tarjeta moderna, contenido oculto
      if (rawLang === "file") {
        const allText = code?.textContent || "";
        const newline = allText.indexOf("\n");
        const filename = (newline === -1 ? allText : allText.slice(0, newline)).trim();
        const content = newline === -1 ? "" : allText.slice(newline + 1);
        const ext = (filename.split(".").pop() || "file").toLowerCase();
        const sizeLabel = this._formatFileSize(content);

        const card = document.createElement("div");
        card.className = `file-download-card file-download-card--${ext} is-appearing`;
        card.innerHTML = `
          <div class="fdc-badge" aria-hidden="true">
            <svg class="fdc-badge-icon" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>
            <span class="fdc-badge-ext">${this.escapeHtml(ext)}</span>
          </div>
          <div class="fdc-body">
            <span class="fdc-name" title="${this.escapeHtml(filename || "archivo")}">${this.escapeHtml(filename || "archivo")}</span>
            <span class="fdc-meta">${this.escapeHtml(this._fileCardMeta(ext))}${sizeLabel ? ` · ${sizeLabel}` : ""}</span>
          </div>
          <button class="fdc-btn" type="button" aria-label="Descargar ${this.escapeHtml(filename)}">
            <span class="fdc-btn-icon">
              <svg class="fdc-icon-download" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              <svg class="fdc-icon-check" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4"><polyline points="20 6 9 17 4 12"/></svg>
              <span class="fdc-spinner" aria-hidden="true"></span>
            </span>
            <span class="fdc-btn-label">Descargar</span>
          </button>`;

        const btn = card.querySelector(".fdc-btn");
        btn.addEventListener("click", () => {
          this._downloadFile(filename, content, btn);
        });
        requestAnimationFrame(() => card.classList.remove("is-appearing"));

        pre.replaceWith(card);
        return;
      }

      // Bloques de código normales: solo acciones en hover (respuestas sin adjuntos)
      const lang = rawLang || "txt";
      const ext = LANG_EXT[lang] || lang || "txt";
      const mime = LANG_MIME[ext] || "text/plain";
      const copyIcon = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
      const dlIcon = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;

      const actions = document.createElement("div");
      actions.className = "code-block-actions";

      const copyBtn = document.createElement("button");
      copyBtn.className = "code-block-btn";
      copyBtn.title = "Copiar al portapapeles";
      copyBtn.innerHTML = `${copyIcon} Copiar`;
      copyBtn.addEventListener("click", () => {
        navigator.clipboard?.writeText(code?.textContent || "").then(() => {
          copyBtn.textContent = "✓ Copiado";
          setTimeout(() => { copyBtn.innerHTML = `${copyIcon} Copiar`; }, 1800);
        });
      });

      const dlBtn = document.createElement("button");
      dlBtn.className = "code-block-btn";
      dlBtn.title = `Descargar como .${ext}`;
      dlBtn.innerHTML = `${dlIcon} .${ext}`;
      dlBtn.addEventListener("click", () => {
        const blob = new Blob([code?.textContent || ""], { type: mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `archivo.${ext}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      });

      actions.appendChild(copyBtn);
      actions.appendChild(dlBtn);
      pre.appendChild(actions);
    });

    // Si hay tarjeta de archivo, ocultar bloques de código sueltos (solo entrega de documento)
    if (container.querySelector(".file-download-card")) {
      container.querySelectorAll("pre.code-enhanced").forEach((pre) => pre.remove());
    }
  }

  _formatFileSize(content) {
    const bytes = new Blob([content]).size;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  _fileCardMeta(ext) {
    const map = {
      xlsx: "Hoja de cálculo Excel", xls: "Hoja de cálculo Excel", xlsm: "Hoja de cálculo Excel",
      csv: "Datos CSV",
      docx: "Documento Word", doc: "Documento Word",
      pdf: "Documento PDF",
      json: "Archivo JSON", xml: "Archivo XML",
      html: "Página HTML", txt: "Texto plano", md: "Markdown",
      png: "Imagen PNG", jpg: "Imagen JPEG", jpeg: "Imagen JPEG", webp: "Imagen WebP", gif: "Imagen GIF",
    };
    return map[ext] || "Listo para descargar";
  }

  _downloadFile(filename, content, btn) {
    const card = btn?.closest(".file-download-card");
    const label = btn?.querySelector(".fdc-btn-label");
    if (btn?.classList.contains("is-loading")) return;

    const setState = (state, text) => {
      if (!btn) return;
      btn.classList.toggle("is-loading", state === "loading");
      btn.classList.toggle("is-done", state === "done");
      btn.disabled = state === "loading";
      card?.classList.toggle("is-loading", state === "loading");
      if (label && text) label.textContent = text;
    };

    setState("loading", "Generando…");
    this._exportAndDownload(filename, content)
      .then(() => {
        setState("done", "Descargado");
        setTimeout(() => setState("idle", "Descargar"), 2200);
      })
      .catch((err) => {
        console.error("[ClaudeChat] export-file:", err);
        setState("idle", "Descargar");
        alert(err.message || "No se pudo generar el archivo. Intenta de nuevo.");
      });
  }

  _guessSourceFilename(downloadFilename) {
    const ext = (downloadFilename.split(".").pop() || "").toLowerCase();
    const base = downloadFilename.replace(/\.[^.]+$/, "");
    const normalizedBase = base.replace(/-(editado|actualizado|modificado|final)$/i, "");

    const candidates = [
      downloadFilename,
      `${normalizedBase}.${ext}`,
    ];

    for (const candidate of candidates) {
      if (this.uploadedFilenamesInConversation.includes(candidate)) return candidate;
    }

    const fuzzy = this.uploadedFilenamesInConversation.find((name) => {
      const uploadedBase = name.replace(/\.[^.]+$/, "");
      return uploadedBase === normalizedBase;
    });
    return fuzzy || candidates[1] || downloadFilename;
  }

  async _exportAndDownload(filename, content) {
    const response = await fetch("/claude/api/export-file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        filename,
        content,
        conversationId: this.currentConversationId,
        sourceFilename: this._guessSourceFilename(filename),
      }),
    });

    if (!response.ok) {
      let message = "Error al generar el archivo";
      try {
        const data = await response.json();
        message = data.error || message;
      } catch {
        // ignore
      }
      throw new Error(message);
    }

    const blob = await response.blob();
    const disposition = response.headers.get("Content-Disposition") || "";
    const match = disposition.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
    const downloadName = match ? decodeURIComponent(match[1].replace(/"/g, "")) : filename;

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = downloadName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  _triggerDownload(filename, content, mime) {
    const blob = new Blob([content], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ---- Drag & Drop ----

  setupDropZone() {
    if (!this.dropOverlay || !this.dropZoneChat || !this.dropZoneExtract) return;

    const main = this.dropOverlay.closest(".claude-main");
    if (!main) return;

    const hasFiles = (e) => e.dataTransfer?.types?.includes("Files");

    // Show overlay when dragging files into the main area
    main.addEventListener("dragenter", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      this._showDropOverlay();
    });

    main.addEventListener("dragover", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    });

    // Drop anywhere on the overlay background → attach to chat
    this.dropOverlay.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
    this.dropOverlay.addEventListener("drop", (e) => {
      e.preventDefault();
      this._hideDropOverlay();
      const files = e.dataTransfer?.files;
      if (files?.length) this.handleFiles(files);
    });

    // Hide overlay when leaving the main area entirely
    this.dropOverlay.addEventListener("dragleave", (e) => {
      if (!this.dropOverlay.contains(e.relatedTarget)) {
        this._hideDropOverlay();
      }
    });

    // Zone: attach to chat
    this.dropZoneChat.addEventListener("dragenter", (e) => { e.preventDefault(); this.dropZoneChat.classList.add("is-active"); });
    this.dropZoneChat.addEventListener("dragleave", () => this.dropZoneChat.classList.remove("is-active"));
    this.dropZoneChat.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
    this.dropZoneChat.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.dropZoneChat.classList.remove("is-active");
      this._hideDropOverlay();
      const files = e.dataTransfer?.files;
      if (files?.length) this.handleFiles(files);
    });

    // Zone: extract data
    this.dropZoneExtract.addEventListener("dragenter", (e) => { e.preventDefault(); this.dropZoneExtract.classList.add("is-active"); });
    this.dropZoneExtract.addEventListener("dragleave", () => this.dropZoneExtract.classList.remove("is-active"));
    this.dropZoneExtract.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
    this.dropZoneExtract.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.dropZoneExtract.classList.remove("is-active");
      this._hideDropOverlay();
      const file = e.dataTransfer?.files?.[0];
      if (file) this.extractPdf(file);
    });
  }

  _showDropOverlay() {
    if (!this.dropOverlay) return;
    this.dropOverlay.hidden = false;
    this.dropOverlay.removeAttribute("aria-hidden");
  }

  _hideDropOverlay() {
    if (!this.dropOverlay) return;
    this.dropOverlay.hidden = true;
    this.dropOverlay.setAttribute("aria-hidden", "true");
    this.dropZoneChat?.classList.remove("is-active");
    this.dropZoneExtract?.classList.remove("is-active");
  }
}

// Instancia creada al abrir el modal (ver claude-modal.js)

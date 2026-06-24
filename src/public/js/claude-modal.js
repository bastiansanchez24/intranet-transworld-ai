(function () {
  const MODAL_ID = "claudeModal";

  function getOverlay() {
    return document.getElementById(MODAL_ID);
  }

  function getNoticeStorageKey(userId) {
    return `claude-limits-notice-seen:${userId ?? "unknown"}`;
  }

  function hasSeenLimitsNoticeLocally(userId) {
    if (!userId) return false;
    try {
      return localStorage.getItem(getNoticeStorageKey(userId)) === "1";
    } catch (_) {
      return false;
    }
  }

  function markLimitsNoticeSeenLocally(userId) {
    if (!userId) return;
    try {
      localStorage.setItem(getNoticeStorageKey(userId), "1");
    } catch (_) {
      /* ignore */
    }
  }

  async function markLimitsNoticeSeenOnServer() {
    try {
      await fetch("/claude/api/limits-notice-seen", { method: "POST" });
    } catch (err) {
      console.error("Error al guardar aviso de límites:", err);
    }
  }

  function shouldShowLimitsNotice() {
    const config = window.CLAUDE_CONFIG || {};
    if (config.limits?.unlimited) return false;
    const userId = config.userId;
    if (config.limitsNoticeSeen) return false;
    if (hasSeenLimitsNoticeLocally(userId)) return false;
    return true;
  }

  function showLimitsNoticeIfNeeded() {
    const notice = document.getElementById("claudeLimitsNotice");
    if (!notice || !shouldShowLimitsNotice()) return;

    const limits = window.CLAUDE_CONFIG?.limits?.notice;
    const intro = document.getElementById("claudeLimitsIntro");
    const list = document.getElementById("claudeLimitsList");
    const title = document.getElementById("claudeLimitsTitle");

    if (limits) {
      if (title) title.textContent = limits.title;
      if (intro) intro.textContent = limits.body;
      if (list) {
        list.innerHTML = limits.items.map((item) => `<li>${item}</li>`).join("");
      }
    }

    const dismiss = async () => {
      notice.hidden = true;
      notice.setAttribute("aria-hidden", "true");
      const userId = window.CLAUDE_CONFIG?.userId;
      markLimitsNoticeSeenLocally(userId);
      window.CLAUDE_CONFIG = { ...window.CLAUDE_CONFIG, limitsNoticeSeen: true };
      await markLimitsNoticeSeenOnServer();
    };

    notice.querySelectorAll("[data-limits-dismiss]").forEach((el) => {
      el.addEventListener("click", dismiss, { once: true });
    });

    notice.hidden = false;
    notice.setAttribute("aria-hidden", "false");
  }

  function getApp() {
    return document.getElementById("claudeApp");
  }

  function isMobileSidebarLayout() {
    return window.matchMedia("(max-width: 820px)").matches;
  }

  function setSidebarOpen(open) {
    const app = getApp();
    const toggle = document.getElementById("btnSidebarToggle");
    const backdrop = document.getElementById("claudeSidebarBackdrop");
    if (!app) return;

    app.classList.toggle("is-sidebar-open", open);
    toggle?.setAttribute("aria-expanded", open ? "true" : "false");

    if (backdrop) {
      if (open && isMobileSidebarLayout()) {
        backdrop.hidden = false;
        backdrop.setAttribute("aria-hidden", "false");
      } else {
        backdrop.hidden = true;
        backdrop.setAttribute("aria-hidden", "true");
      }
    }
  }

  function closeSidebar() {
    setSidebarOpen(false);
  }

  function initMobileSidebar() {
    const toggle = document.getElementById("btnSidebarToggle");
    const backdrop = document.getElementById("claudeSidebarBackdrop");

    toggle?.addEventListener("click", () => {
      const app = getApp();
      if (!app) return;
      setSidebarOpen(!app.classList.contains("is-sidebar-open"));
    });

    backdrop?.addEventListener("click", closeSidebar);

    window.addEventListener("resize", () => {
      if (!isMobileSidebarLayout()) closeSidebar();
    });
  }

  let openingPromise = null;
  const FAB_TOOLTIP_DEFAULT = "Trabajemos en un nuevo proyecto...";
  const FAB_TOOLTIP_LOADING = "Cargando asistente…";

  function setTriggerLoading(loading, trigger) {
    const el = trigger || document.getElementById("claudeFab");
    if (!el) return;

    el.classList.toggle("is-loading", loading);
    el.setAttribute("aria-busy", loading ? "true" : "false");

    const tooltip = el.querySelector(".claude-fab-tooltip");
    if (tooltip) {
      tooltip.textContent = loading ? FAB_TOOLTIP_LOADING : FAB_TOOLTIP_DEFAULT;
    }

    if (loading) {
      el.dataset.prevAriaLabel = el.getAttribute("aria-label") || "";
      el.setAttribute("aria-label", FAB_TOOLTIP_LOADING);
    } else if ("prevAriaLabel" in el.dataset) {
      el.setAttribute("aria-label", el.dataset.prevAriaLabel);
      delete el.dataset.prevAriaLabel;
    }
  }

  async function openClaudeModal(trigger) {
    if (openingPromise) return openingPromise;

    const overlay = getOverlay();
    if (!overlay) return;

    openingPromise = (async () => {
      setTriggerLoading(true, trigger);

      if (!window.claudeChat) {
        window.claudeChat = new ClaudeChat();
      }

      try {
        await window.claudeChat.ensureBootstrap();
      } catch (err) {
        console.error("Error al cargar Claude:", err);
        alert("No se pudo abrir el asistente. Intenta nuevamente.");
        return;
      } finally {
        setTriggerLoading(false, trigger);
        openingPromise = null;
      }

      if (window.IntranetModal) {
        window.IntranetModal.open(overlay);
      } else {
        overlay.style.display = "flex";
        overlay.classList.add("is-open");
        overlay.setAttribute("aria-hidden", "false");
        document.documentElement.classList.add("modal-open");
        document.body.classList.add("modal-open");
      }

      requestAnimationFrame(() => {
        showLimitsNoticeIfNeeded();
        if (!shouldShowLimitsNotice()) {
          document.getElementById("messageInput")?.focus();
        }
      });
    })();

    return openingPromise;
  }

  function closeClaudeModal() {
    closeSidebar();
    const overlay = getOverlay();
    if (!overlay) return;

    const notice = document.getElementById("claudeLimitsNotice");
    if (notice && !notice.hidden) {
      notice.hidden = true;
      notice.setAttribute("aria-hidden", "true");
    }

    if (window.IntranetModal) {
      window.IntranetModal.close(overlay);
    } else {
      overlay.classList.remove("is-open");
      overlay.style.display = "none";
      overlay.setAttribute("aria-hidden", "true");
      document.documentElement.classList.remove("modal-open");
      document.body.classList.remove("modal-open");
      document.body.style.top = "";
    }
  }

  function shouldAutoOpen() {
    const params = new URLSearchParams(window.location.search);
    return params.get("openClaude") === "1" || window.location.pathname === "/claude";
  }

  function clearAutoOpenParam() {
    const params = new URLSearchParams(window.location.search);
    if (!params.has("openClaude")) return;
    params.delete("openClaude");
    const qs = params.toString();
    const next = window.location.pathname + (qs ? `?${qs}` : "");
    window.history.replaceState({}, document.title, next);
  }

  document.addEventListener("click", (e) => {
    const trigger = e.target.closest("[data-claude-open]");
    if (trigger) {
      e.preventDefault();
      openClaudeModal(trigger);
    }
  });

  document.addEventListener("DOMContentLoaded", () => {
    initMobileSidebar();
    document.getElementById("claudeModalClose")?.addEventListener("click", closeClaudeModal);

    if (shouldAutoOpen()) {
      openClaudeModal();
      clearAutoOpenParam();
    }
  });

  window.ClaudeModal = { open: openClaudeModal, close: closeClaudeModal, closeSidebar };
})();

(function (global) {
  const ANIM_MS = 280;
  let scrollLockCount = 0;
  let savedScrollY = 0;

  function resolve(el) {
    if (!el) return null;
    return typeof el === 'string' ? document.getElementById(el) : el;
  }

  function getPanel(overlay) {
    return (
      overlay.querySelector('.modal-content') ||
      overlay.querySelector('.modal-content2') ||
      overlay.querySelector('.modal-imagen-contenido') ||
      overlay.firstElementChild
    );
  }

  function hasBlockingOverlay() {
    return !!document.querySelector(
      '.modal-overlay.is-open, .modal-imagen.is-open, .foto-crop-overlay.is-open',
    );
  }

  function lockScroll() {
    if (scrollLockCount === 0) {
      savedScrollY = window.scrollY || document.documentElement.scrollTop || 0;
      document.documentElement.classList.add('modal-open');
      document.body.classList.add('modal-open');
      document.body.style.top = `-${savedScrollY}px`;
    }
    scrollLockCount += 1;
  }

  function unlockScroll() {
    if (scrollLockCount <= 0) return;
    scrollLockCount -= 1;
    if (scrollLockCount > 0) return;

    document.documentElement.classList.remove('modal-open');
    document.body.classList.remove('modal-open');
    document.body.style.top = '';
    window.scrollTo(0, savedScrollY);
  }

  function syncScrollLock() {
    if (hasBlockingOverlay()) {
      if (scrollLockCount === 0) lockScroll();
      return;
    }
    if (scrollLockCount > 0) {
      scrollLockCount = 1;
      unlockScroll();
    }
  }

  function isOpen(overlay) {
    return overlay && overlay.classList.contains('is-open');
  }

  function open(target) {
    const overlay = resolve(target);
    if (!overlay) return;

    overlay.classList.remove('is-closing');
    overlay.style.display = 'flex';
    overlay.setAttribute('aria-hidden', 'false');
    lockScroll();

    requestAnimationFrame(() => {
      requestAnimationFrame(() => overlay.classList.add('is-open'));
    });
  }

  function close(target) {
    const overlay = resolve(target);
    if (!overlay || !overlay.classList.contains('is-open')) {
      if (overlay) {
        overlay.style.display = 'none';
        overlay.classList.remove('is-open', 'is-closing');
        overlay.setAttribute('aria-hidden', 'true');
      }
      syncScrollLock();
      return;
    }

    overlay.classList.remove('is-open');
    overlay.classList.add('is-closing');

    const finish = () => {
      overlay.style.display = 'none';
      overlay.classList.remove('is-closing');
      overlay.setAttribute('aria-hidden', 'true');
      syncScrollLock();
    };

    const panel = getPanel(overlay);
    const onEnd = (e) => {
      if (panel && e.target !== panel) return;
      panel?.removeEventListener('transitionend', onEnd);
      finish();
    };

    if (panel) {
      panel.addEventListener('transitionend', onEnd);
    }
    setTimeout(finish, ANIM_MS + 40);
  }

  function bindOverlayDismiss() {
    document.addEventListener('click', (e) => {
      const target = e.target;
      const closeButton = target.closest('[data-modal-close]');
      if (closeButton) {
        const overlay = closeButton.closest('.modal-overlay, .modal-imagen');
        if (overlay) {
          close(overlay);
          return;
        }
      }

      if (
        (target.classList.contains('modal-overlay') ||
          target.classList.contains('modal-imagen')) &&
        target.classList.contains('is-open') &&
        target.dataset.dismiss !== 'false'
      ) {
        close(target);
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const openOverlay = document.querySelector(
        '.modal-overlay.is-open, .modal-imagen.is-open',
      );
      if (openOverlay && openOverlay.dataset.dismiss !== 'false') close(openOverlay);
    });
  }

  global.IntranetModal = { open, close, isOpen, lockScroll, unlockScroll, ANIM_MS };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindOverlayDismiss);
  } else {
    bindOverlayDismiss();
  }
})(window);

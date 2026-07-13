(function () {
  const MAX_CHARS = 2000;
  const DEFAULT_STATUS_CLASS = 'ticket-modal-upload-status';

  function setStatus(statusEl, text, modifier) {
    if (!statusEl) return;
    statusEl.className = modifier
      ? `${DEFAULT_STATUS_CLASS} ${DEFAULT_STATUS_CLASS}--${modifier}`
      : DEFAULT_STATUS_CLASS;
    statusEl.textContent = text;
  }

  function resetForm(form) {
    form.reset();
    const fileInput = form.querySelector('[data-ticket-file-input]');
    const hiddenInput = form.querySelector('[data-ticket-attachments]');
    const statusEl = form.querySelector('[data-ticket-upload-status]');
    const counter = form.querySelector('[data-ticket-counter]');
    const submit = form.querySelector('[data-ticket-submit]');

    if (fileInput) fileInput.value = '';
    if (hiddenInput) hiddenInput.value = '[]';
    if (counter) {
      counter.textContent = `0 / ${MAX_CHARS}`;
      counter.classList.remove('limit-reached');
    }
    if (submit) {
      submit.disabled = false;
      submit.textContent = submit.dataset.defaultText || submit.textContent;
    }
    setStatus(statusEl, 'Sin archivos seleccionados');
  }

  function bindCounter(form) {
    const textarea = form.querySelector('[data-ticket-description]');
    const counter = form.querySelector('[data-ticket-counter]');
    if (!textarea || !counter) return;

    const refresh = () => {
      const currentLength = textarea.value.length;
      counter.textContent = `${currentLength} / ${MAX_CHARS}`;
      counter.classList.toggle('limit-reached', currentLength >= MAX_CHARS);
    };

    textarea.addEventListener('input', refresh);
    refresh();
  }

  function bindFiles(form) {
    const fileInput = form.querySelector('[data-ticket-file-input]');
    const selectFiles = form.querySelector('[data-ticket-select-files]');
    const statusEl = form.querySelector('[data-ticket-upload-status]');
    if (!fileInput) return;

    selectFiles?.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      setStatus(
        statusEl,
        fileInput.files.length
          ? `${fileInput.files.length} archivos listos para subir.`
          : 'Sin archivos seleccionados',
      );
    });
  }

  async function uploadFiles(files, statusEl) {
    const uploadedList = [];

    for (const file of files) {
      const formData = new FormData();
      formData.append('file', file);

      let dbType = 'doc';
      if (file.type.startsWith('video/')) dbType = 'video';
      else if (file.type.startsWith('image/')) dbType = 'image';
      else if (file.type === 'application/pdf') dbType = 'pdf';

      setStatus(statusEl, `Subiendo ${file.name}...`, 'warning');
      const resUp = await fetch('/sistemas/tickets/upload', { method: 'POST', body: formData });
      if (!resUp.ok) throw new Error('Fallo subida');
      const data = await resUp.json();
      uploadedList.push({ url: data.secure_url, nombre: file.name, tipo: dbType });
    }

    return uploadedList;
  }

  function bindSubmit(form) {
    const fileInput = form.querySelector('[data-ticket-file-input]');
    const hiddenInput = form.querySelector('[data-ticket-attachments]');
    const statusEl = form.querySelector('[data-ticket-upload-status]');
    const submit = form.querySelector('[data-ticket-submit]');
    if (!submit.dataset.defaultText) submit.dataset.defaultText = submit.textContent;

    form.addEventListener('submit', async (e) => {
      e.preventDefault();

      const files = fileInput ? Array.from(fileInput.files || []) : [];
      if (files.length === 0) {
        form.submit();
        return;
      }

      for (const file of files) {
        const limit = file.type.startsWith('video/') ? 100 * 1024 * 1024 : 10 * 1024 * 1024;
        if (file.size > limit) {
          alert(`Archivo muy pesado: ${file.name}`);
          return;
        }
      }

      try {
        submit.disabled = true;
        submit.textContent = 'Subiendo archivos...';
        setStatus(statusEl, 'Iniciando subida...', 'warning');

        hiddenInput.value = JSON.stringify(await uploadFiles(files, statusEl));
        setStatus(statusEl, 'Listo. Creando ticket...', 'success');
        form.submit();
      } catch (err) {
        console.error(err);
        setStatus(statusEl, 'Error', 'error');
        submit.disabled = false;
        submit.textContent = submit.dataset.defaultText;
      }
    });
  }

  function bindModalOpeners() {
    const modalId = 'modalNuevoTicketNavbar';
    const modal = document.getElementById(modalId);
    const form = modal?.querySelector('[data-ticket-create-form]');

    document.querySelectorAll('.js-open-ticket-modal').forEach((link) => {
      link.addEventListener('click', (e) => {
        if (!window.IntranetModal || !modal || !form) return;
        e.preventDefault();
        resetForm(form);
        window.IntranetModal.open(modalId);
      });
    });

    modal?.addEventListener('transitionend', () => {
      if (form && !modal.classList.contains('is-open')) resetForm(form);
    });
  }

  function init() {
    document.querySelectorAll('[data-ticket-create-form]').forEach((form) => {
      bindCounter(form);
      bindFiles(form);
      bindSubmit(form);
    });
    bindModalOpeners();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

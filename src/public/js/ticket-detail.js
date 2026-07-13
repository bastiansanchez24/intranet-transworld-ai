(function () {
  const MAX_CHARS = 2000;

  function bindCharCounter(root, textareaId, counterId) {
    const textarea = root.querySelector(`#${textareaId}`);
    const counter = root.querySelector(`#${counterId}`);
    if (!textarea || !counter || textarea.dataset.counterBound === 'true') return;
    textarea.dataset.counterBound = 'true';

    const refresh = () => {
      const currentLength = textarea.value.length;
      counter.textContent = `${currentLength} / ${MAX_CHARS} caracteres`;
      counter.classList.toggle('limit-reached', currentLength >= MAX_CHARS);
    };

    textarea.addEventListener('input', refresh);
    refresh();
  }

  function setUploadStatus(statusEl, text, statusClass) {
    if (!statusEl) return;
    statusEl.className = statusClass ? `ticket-upload-status ${statusClass}` : 'ticket-upload-status';
    statusEl.textContent = text;
  }

  function setupLocalUpload(root, formId, inputFilesId, hiddenDataId, statusId, btnSubmitId) {
    const form = root.querySelector(`#${formId}`);
    const inputFiles = root.querySelector(`#${inputFilesId}`);
    const hiddenInput = root.querySelector(`#${hiddenDataId}`);
    const statusEl = root.querySelector(`#${statusId}`);
    const btnSubmit = root.querySelector(`#${btnSubmitId}`);
    if (!form || !inputFiles || form.dataset.uploadBound === 'true') return;
    form.dataset.uploadBound = 'true';

    form.addEventListener('submit', async (e) => {
      const files = Array.from(inputFiles.files || []);
      if (files.length === 0) return;

      e.preventDefault();
      if (btnSubmit) {
        btnSubmit.disabled = true;
        btnSubmit.textContent = 'Subiendo archivos...';
      }
      setUploadStatus(statusEl, `Preparando subida (${files.length} archivo/s)...`, 'ticket-status-text');

      try {
        const uploadedList = [];
        for (let i = 0; i < files.length; i += 1) {
          const file = files[i];
          setUploadStatus(statusEl, `Subiendo archivo ${i + 1} de ${files.length}: ${file.name}...`, 'ticket-status-text');

          const formData = new FormData();
          formData.append('file', file);

          let dbType = 'doc';
          if (file.type.startsWith('video/')) dbType = 'video';
          else if (file.type.startsWith('image/')) dbType = 'image';
          else if (file.type === 'application/pdf') dbType = 'pdf';

          const resUp = await fetch('/sistemas/tickets/upload', { method: 'POST', body: formData });
          if (!resUp.ok) throw new Error('Fallo subida');
          const data = await resUp.json();

          uploadedList.push({ url: data.secure_url, nombre: file.name, tipo: dbType });
        }

        hiddenInput.value = JSON.stringify(uploadedList);
        setUploadStatus(statusEl, 'Subida lista. Guardando...', 'ticket-status-text--success');
        form.submit();
      } catch (err) {
        console.error(err);
        setUploadStatus(statusEl, 'Error', 'ticket-status-text--error');
        if (btnSubmit) {
          btnSubmit.disabled = false;
          btnSubmit.textContent = 'Intentar de nuevo';
        }
      }
    });
  }

  async function takeTicket(button) {
    const ticketId = button.dataset.takeTicket;
    if (!ticketId || button.textContent.includes('tomado exitosamente')) return;

    button.disabled = true;
    button.textContent = 'Asignando...';

    try {
      const res = await fetch(`/sistemas/tickets/${ticketId}/tomar`, { method: 'POST' });
      const data = await res.json();

      if (data.success) {
        button.classList.add('is-assigned');
        button.textContent = 'Ticket tomado exitosamente.';
        setTimeout(() => {
          button.textContent = `Ticket tomado por ${data.assigned_to || data.asignado_a}`;
          button.disabled = false;
        }, 2500);
      } else {
        alert(`Error: ${data.error}`);
        button.disabled = false;
        button.textContent = 'Tomar Ticket';
      }
    } catch (err) {
      console.error(err);
      button.disabled = false;
      button.textContent = 'Tomar Ticket';
    }
  }

  function init(root = document) {
    bindCharCounter(root, 'mensajeAdmin', 'charCountAdmin');
    bindCharCounter(root, 'mensajeUser', 'charCountUser');
    setupLocalUpload(root, 'form-upload-admin', 'archivos_admin', 'adjuntos_data_admin', 'upload-status-admin', 'btn-submit-admin');
    setupLocalUpload(root, 'form-upload-user', 'archivos_user', 'adjuntos_data_user', 'upload-status-user', 'btn-submit-user');
  }

  document.addEventListener('click', (e) => {
    const takeButton = e.target.closest('[data-take-ticket]');
    if (takeButton) {
      takeTicket(takeButton);
      return;
    }

    const confirmButton = e.target.closest('[data-confirm-message]');
    if (confirmButton && !confirm(confirmButton.dataset.confirmMessage)) {
      e.preventDefault();
    }
  });

  window.TicketDetail = { init };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => init());
  } else {
    init();
  }
})();

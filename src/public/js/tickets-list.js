(function () {
  const visibleIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M16 8s-3-5.5-8-5.5S0 8s3 5.5 8 5.5S16 8 16 8M1.173 8a13.133 13.133 0 0 1 1.66-2.043C4.12 4.668 5.88 3.5 8 3.5c2.12 0 3.879 1.168 5.168 2.457A13.133 13.133 0 0 1 14.828 8c-.058.087-.122.183-.195.288-.335.48-.83 1.12-1.465 1.755C11.879 11.332 10.119 12.5 8 12.5c-2.12 0-3.879-1.168-5.168-2.457A13.134 13.134 0 0 1 1.172 8z"/><path d="M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5M4.5 8a3.5 3.5 0 1 1 7 0 3.5 3.5 0 0 1-7 0z"/></svg>`;
  const hiddenIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M13.359 11.238C15.06 9.72 16 8 16 8s-3-5.5-8-5.5a7.028 7.028 0 0 0-2.79.588l.77.771A5.944 5.944 0 0 1 8 3.5c2.12 0 3.879 1.168 5.168 2.457A13.134 13.134 0 0 1 14.828 8c-.058.087-.122.183-.195.288-.335.48-.83 1.12-1.465 1.755-.165.165-.337.328-.517.486z"/><path d="M11.297 9.176a3.5 3.5 0 0 0-4.474-4.474l.823.823a2.5 2.5 0 0 1 2.829 2.829zm-2.943 1.299.822.822a3.5 3.5 0 0 1-4.474-4.474l.823.823a2.5 2.5 0 0 0 2.829 2.829z"/><path d="M3.35 5.47c-.18.16-.353.322-.518.487A13.134 13.134 0 0 0 1.172 8l.195.288c.335.48.83 1.12 1.465 1.755C4.121 11.332 5.881 12.5 8 12.5c.716 0 1.39-.133 2.02-.36l.77.772A7.029 7.029 0 0 1 8 13.5C3 13.5 0 8 0 8s.939-1.721 2.641-3.238l.708.709zm10.296 8.884-12-12 .707-.707 12 12-.708.707z"/></svg>`;

  const sortDirection = {};
  let showingClosed = true;

  function sortTable(table, columnIndex) {
    const tbody = table.querySelector('tbody');
    const rows = Array.from(tbody.querySelectorAll('tr.clickable-row'));
    const headers = table.querySelectorAll('th');
    if (rows.length === 0) return;

    sortDirection[columnIndex] = !sortDirection[columnIndex];
    const isAscending = sortDirection[columnIndex];

    headers.forEach((th) => th.classList.remove('th-sort-asc', 'th-sort-desc'));
    headers[columnIndex]?.classList.add(isAscending ? 'th-sort-asc' : 'th-sort-desc');

    rows.sort((rowA, rowB) => {
      const cellA = rowA.children[columnIndex];
      const cellB = rowB.children[columnIndex];
      const valA = cellA.getAttribute('data-sort') || cellA.innerText.trim().toLowerCase();
      const valB = cellB.getAttribute('data-sort') || cellB.innerText.trim().toLowerCase();
      const numA = parseFloat(valA);
      const numB = parseFloat(valB);

      if (!Number.isNaN(numA) && !Number.isNaN(numB)) {
        return isAscending ? numA - numB : numB - numA;
      }
      if (valA < valB) return isAscending ? -1 : 1;
      if (valA > valB) return isAscending ? 1 : -1;
      return 0;
    });

    rows.forEach((row) => tbody.appendChild(row));
  }

  async function openTicketDetail(row, modalBody, modalId) {
    const href = row.getAttribute('data-href');
    if (!href || !modalBody) return;

    modalBody.innerHTML = '<div class="ticket-modal-state">Cargando detalles del ticket...</div>';
    window.IntranetModal?.open(modalId);

    try {
      const res = await fetch(`${href}?modal=true`);
      if (!res.ok) throw new Error('Error al obtener el ticket');
      modalBody.innerHTML = await res.text();
      window.TicketDetail?.init(modalBody);

      modalBody.querySelectorAll('script').forEach((oldScript) => {
        const newScript = document.createElement('script');
        Array.from(oldScript.attributes).forEach((attr) => newScript.setAttribute(attr.name, attr.value));
        newScript.appendChild(document.createTextNode(oldScript.innerHTML));
        oldScript.parentNode.replaceChild(newScript, oldScript);
      });
    } catch (err) {
      console.error(err);
      modalBody.innerHTML = '<div class="ticket-modal-state ticket-modal-state--error">Hubo un error al cargar el ticket.</div>';
    }
  }

  function setClosedVisibility(table, button) {
    table.querySelectorAll('tbody tr.clickable-row').forEach((row) => {
      if (row.getAttribute('data-estado') === 'closed') row.hidden = !showingClosed;
    });

    const icon = button?.querySelector('[data-ticket-closed-icon]');
    const text = button?.querySelector('[data-ticket-closed-text]');
    if (icon) icon.innerHTML = showingClosed ? visibleIcon : hiddenIcon;
    if (text) text.textContent = showingClosed ? 'Ocultar Cerrados' : 'Mostrar Cerrados';
  }

  function init() {
    const table = document.getElementById('ticketsTable');
    if (!table) return;

    const modalId = 'modalVerTicketDetalle';
    const modalBody = document.getElementById('modalVerTicketDetalleBody');
    const toggleClosedButton = document.querySelector('[data-toggle-closed-tickets]');

    table.querySelectorAll('th[data-sort-column]').forEach((th) => {
      th.addEventListener('click', () => sortTable(table, Number(th.dataset.sortColumn)));
    });

    table.querySelectorAll('tr.clickable-row').forEach((row) => {
      row.addEventListener('click', (e) => {
        e.preventDefault();
        openTicketDetail(row, modalBody, modalId);
      });
    });

    toggleClosedButton?.addEventListener('click', () => {
      showingClosed = !showingClosed;
      setClosedVisibility(table, toggleClosedButton);
    });

    if (document.querySelector('[data-ticket-list-admin="true"]')) {
      showingClosed = false;
      setClosedVisibility(table, toggleClosedButton);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

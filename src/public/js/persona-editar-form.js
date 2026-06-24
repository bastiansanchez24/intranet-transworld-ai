(function (global) {
  function initPersonaEditarForm() {
    const form = document.getElementById('formEditarPersona');
    if (!form) {
      return function noop() {};
    }

    const destroyFns = [];

    const eliminarInput = document.getElementById('eliminar_foto');
    const btnRemove = document.getElementById('btn-remove-photo');
    const selectBtn = document.getElementById('btn-select-photo');

    if (typeof global.ProfilePhotoCropper !== 'undefined') {
      const photoCropper = global.ProfilePhotoCropper.init({
        fileInputId: 'foto',
        previewImgId: 'photo-preview-img',
        previewPlaceholderId: 'photo-placeholder',
        selectBtnId: 'btn-select-photo',
        overlayId: 'fotoCropOverlay',
        cropImgId: 'fotoCropImage',
        closeBtnId: 'fotoCropClose',
        cancelBtnId: 'fotoCropCancel',
        saveBtnId: 'fotoCropSave',
        errorElId: 'fotoCropError',
        maxSizeMb: 5,
        outputSize: 400,
        outputFilename: 'foto-perfil.jpg',
        saveLabel: 'Aplicar recorte',
        onCropped: function () {
          eliminarInput.value = '0';
          btnRemove.hidden = false;
          selectBtn.textContent = 'Cambiar foto';
        },
      });

      function onRemovePhoto() {
        if (!confirm('¿Quitar la foto de este colaborador?')) return;
        photoCropper.clearPhoto();
        eliminarInput.value = '1';
        btnRemove.hidden = true;
        selectBtn.textContent = 'Seleccionar foto';
      }

      btnRemove?.addEventListener('click', onRemovePhoto);
      destroyFns.push(function () {
        btnRemove?.removeEventListener('click', onRemovePhoto);
        photoCropper.clearPhoto();
      });
    }

    const emailInput = document.getElementById('email');
    const emailError = document.getElementById('email-error');
    const fechaInput = document.getElementById('fecha_nacimiento');
    const fechaLabel = document.getElementById('fecha_nacimiento_label');
    const telefonoField = form.querySelector('[data-phone-chile]');
    const telefonoLocal = telefonoField?.querySelector('.phone-field__local');
    const telefonoError = document.getElementById('telefono-error');
    const FECHA_REQUERIDA_MSG =
      'La fecha de nacimiento es obligatoria para colaboradores sin correo.';
    const EMAIL_LOCKED_MSG =
      'No puedes quitar el correo de un usuario ya registrado en la intranet.';

    function toggleFieldError(el, message) {
      if (!el) return;
      if (message) {
        el.textContent = message;
        el.classList.add('show');
      } else {
        el.textContent = '';
        el.classList.remove('show');
      }
    }

    function syncFechaRequired() {
      if (!fechaInput || !emailInput) return;
      const obligatoria = global.EmailValidate.isEmpty(emailInput);
      fechaInput.required = obligatoria;
      if (fechaLabel) {
        fechaLabel.textContent = obligatoria
          ? 'Fecha de Nacimiento *'
          : 'Fecha de Nacimiento';
      }
      if (!obligatoria) fechaInput.setCustomValidity('');
    }

    global.EmailValidate.initField(emailInput);
    global.PhoneChile.initField(telefonoField);

    function onEmailInput() {
      let msg = '';
      if (emailInput.dataset.emailLocked === '1' && global.EmailValidate.isEmpty(emailInput)) {
        msg = EMAIL_LOCKED_MSG;
      } else if (!global.EmailValidate.isValid(emailInput)) {
        msg = global.EmailValidate.ERROR_MSG;
      }
      emailInput.setCustomValidity(msg);
      toggleFieldError(emailError, msg);
      syncFechaRequired();
    }

    function onTelefonoInput() {
      const invalid =
        !global.PhoneChile.isFieldEmpty(telefonoField) &&
        !global.PhoneChile.isFieldValid(telefonoField);
      toggleFieldError(telefonoError, invalid ? global.PhoneChile.ERROR_MSG : '');
    }

    function onSubmit(event) {
      let hasError = false;

      if (emailInput?.dataset.emailLocked === '1' && global.EmailValidate.isEmpty(emailInput)) {
        hasError = true;
        toggleFieldError(emailError, EMAIL_LOCKED_MSG);
        emailInput.setCustomValidity(EMAIL_LOCKED_MSG);
        emailInput.reportValidity();
      } else if (!global.EmailValidate.isValid(emailInput)) {
        hasError = true;
        toggleFieldError(emailError, global.EmailValidate.ERROR_MSG);
        emailInput.reportValidity();
      }

      if (
        !global.PhoneChile.isFieldEmpty(telefonoField) &&
        !global.PhoneChile.isFieldValid(telefonoField)
      ) {
        hasError = true;
        toggleFieldError(telefonoError, global.PhoneChile.ERROR_MSG);
        telefonoLocal.reportValidity();
      }

      if (
        global.EmailValidate.isEmpty(emailInput) &&
        !String(fechaInput?.value || '').trim()
      ) {
        hasError = true;
        fechaInput.setCustomValidity(FECHA_REQUERIDA_MSG);
        fechaInput.reportValidity();
      }

      if (hasError) event.preventDefault();
    }

    emailInput?.addEventListener('input', onEmailInput);
    telefonoLocal?.addEventListener('input', onTelefonoInput);
    form.addEventListener('submit', onSubmit);
    syncFechaRequired();

    destroyFns.push(function () {
      emailInput?.removeEventListener('input', onEmailInput);
      telefonoLocal?.removeEventListener('input', onTelefonoInput);
      form.removeEventListener('submit', onSubmit);
    });

    return function destroy() {
      destroyFns.forEach(function (fn) {
        fn();
      });
    };
  }

  global.initPersonaEditarForm = initPersonaEditarForm;
})(window);

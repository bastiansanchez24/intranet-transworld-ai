const CHILE_MOBILE_PATTERN = /^\+56 9 \d{4} \d{4}$/;

const CHILE_MOBILE_ERROR =
  "Ingresa un celular válido con formato 9 1234 5678.";

function isValidChileMobilePhone(phone) {
  return CHILE_MOBILE_PATTERN.test(String(phone || "").trim());
}

function toStoragePhone(phone) {
  const trimmed = String(phone || "").trim();
  if (!trimmed) return null;

  let digits = trimmed.replace(/\D/g, "");
  if (digits.length === 9 && digits.startsWith("9")) {
    digits = `56${digits}`;
  }
  if (digits.length !== 11 || !digits.startsWith("569")) {
    return null;
  }

  return digits;
}

function formatPhoneForDisplay(phone) {
  const trimmed = String(phone || "").trim();
  if (!trimmed) return null;
  if (isValidChileMobilePhone(trimmed)) return trimmed;

  const digits = toStoragePhone(trimmed);
  if (!digits) return trimmed;

  const local = digits.slice(2);
  return `+56 ${local.charAt(0)} ${local.slice(1, 5)} ${local.slice(5)}`;
}

function validateChileMobilePhone(phone, { required = false } = {}) {
  const value = String(phone || "").trim();

  if (!value) {
    if (required) {
      return { valid: false, value: null, storageValue: null, error: CHILE_MOBILE_ERROR };
    }
    return { valid: true, value: null, storageValue: null, error: null };
  }

  const displayValue = formatPhoneForDisplay(value) || value;

  if (!isValidChileMobilePhone(displayValue)) {
    return { valid: false, value: null, storageValue: null, error: CHILE_MOBILE_ERROR };
  }

  return {
    valid: true,
    value: displayValue,
    storageValue: toStoragePhone(displayValue),
    error: null,
  };
}

function toTelHref(phone) {
  const display = formatPhoneForDisplay(phone);
  if (!display || !isValidChileMobilePhone(display)) return null;
  return "tel:" + display.replace(/\s/g, "");
}

module.exports = {
  CHILE_MOBILE_PATTERN,
  CHILE_MOBILE_ERROR,
  isValidChileMobilePhone,
  toStoragePhone,
  formatPhoneForDisplay,
  validateChileMobilePhone,
  toTelHref,
};

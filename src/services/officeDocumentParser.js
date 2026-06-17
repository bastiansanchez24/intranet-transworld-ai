const path = require("path");
const WordExtractor = require("word-extractor");
const XLSX = require("xlsx");

const WORD_EXTENSIONS = new Set([".doc", ".docx"]);
const EXCEL_EXTENSIONS = new Set([".xls", ".xlsx", ".xlsm"]);

const MAX_EXTRACTED_CHARS = parseInt(process.env.CLAUDE_MAX_DOC_CHARS || "120000", 10);

function extensionOf(filename) {
  return path.extname(filename || "").toLowerCase();
}

function getOfficeKind(filename, mimeType = "") {
  const ext = extensionOf(filename);
  if (WORD_EXTENSIONS.has(ext)) return "word";
  if (EXCEL_EXTENSIONS.has(ext)) return "excel";

  const mime = String(mimeType).toLowerCase();
  if (mime.includes("wordprocessingml") || mime === "application/msword") return "word";
  if (mime.includes("spreadsheetml") || mime === "application/vnd.ms-excel") return "excel";

  return null;
}

function isOfficeDocument(filename, mimeType = "") {
  return getOfficeKind(filename, mimeType) !== null;
}

function truncateExtractedText(text, filename) {
  if (text.length <= MAX_EXTRACTED_CHARS) return text;
  return (
    text.slice(0, MAX_EXTRACTED_CHARS) +
    `\n\n[... contenido truncado: "${filename}" supera el límite de ${MAX_EXTRACTED_CHARS.toLocaleString("es-CL")} caracteres procesables ...]`
  );
}

async function extractWordText(buffer) {
  const doc = await new WordExtractor().extract(buffer);
  const parts = [
    doc.getBody()?.trim(),
    doc.getHeaders()?.trim() && `--- Encabezados ---\n${doc.getHeaders().trim()}`,
    doc.getFooters()?.trim() && `--- Pies de página ---\n${doc.getFooters().trim()}`,
  ].filter(Boolean);

  return parts.join("\n\n");
}

function extractExcelText(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sections = [];

  for (const sheetName of workbook.SheetNames) {
    const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName], { blankrows: false });
    if (csv.trim()) {
      sections.push(`### Hoja: ${sheetName}\n\n${csv}`);
    }
  }

  return sections.join("\n\n") || "(Hoja de cálculo sin datos visibles)";
}

async function extractOfficeText(buffer, filename, mimeType = "") {
  const kind = getOfficeKind(filename, mimeType);
  if (!kind) {
    throw new Error(`Formato Office no soportado: ${filename}`);
  }

  let text;
  if (kind === "word") {
    text = await extractWordText(buffer);
  } else {
    text = extractExcelText(buffer);
  }

  if (!text.trim()) {
    throw new Error(`No se pudo extraer texto de "${filename}"`);
  }

  return truncateExtractedText(text, filename);
}

module.exports = {
  WORD_EXTENSIONS,
  EXCEL_EXTENSIONS,
  getOfficeKind,
  isOfficeDocument,
  extractOfficeText,
};

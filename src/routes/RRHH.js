const express = require("express");
const router = express.Router();
const db = require("../db");
const multer = require("multer");
const crypto = require("crypto");
const fileStorage = require("../services/fileStorage");
const userPhotoStorage = require("../services/userPhotoStorage");
const { ROLES, ALL_ROLES } = require("../constants/roles");

function parseRoleFromForm(role) {
  const value = String(role || "").trim();
  return ALL_ROLES.includes(value) ? value : ROLES.USUARIO;
}
const requireRole = require("../middlewares/requireRole");
const { sendMail } = require("../services/mailer");
const { toTitleCase } = require("../utils/formatName");
const {
  validateChileMobilePhone,
  formatPhoneForDisplay,
  toTelHref,
} = require("../utils/phoneChile");
const { validateEmail } = require("../utils/email");
const { mapPersonaForView } = require("../utils/schemaMappers");
const { generateUniqueUsuarioId } = require("../utils/userId");

function redirectPersonalCrearError(res, message) {
  return res.redirect(
    `/RRHH/personal?crearError=${encodeURIComponent(message)}`,
  );
}

function redirectPersonalEditarError(res, id, message) {
  return res.redirect(
    `/RRHH/personal?editar=${encodeURIComponent(id)}&editarError=${encodeURIComponent(message)}`,
  );
}

const storage = multer.memoryStorage();
const upload = multer({ storage });

// Variables globales
let urlOrganigramaActual = null;
let versionCache = Date.now();

// Función Auxiliar
async function getOrganigramaUrl() {
  if (urlOrganigramaActual) return `${urlOrganigramaActual}?v=${versionCache}`;

  try {
    const files = await fileStorage.listFiles("organigrama");
    if (files && files.length > 0) {
      files.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      urlOrganigramaActual = files[0].secure_url;
      return `${urlOrganigramaActual}?v=${versionCache}`;
    }
    return null;
  } catch (err) {
    console.error("Error buscando organigrama:", err);
    return null;
  }
}

function parseFechaNacimiento(fecha) {
  if (!fecha) return null;
  const str =
    typeof fecha === "string"
      ? fecha.slice(0, 10)
      : fecha instanceof Date
        ? fecha.toISOString().slice(0, 10)
        : String(fecha).slice(0, 10);
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return { month: parseInt(m[2], 10) - 1, day: parseInt(m[3], 10) };
}

function pbkdf2Hash(password, saltHex) {
  const salt = Buffer.from(saltHex, "hex");
  return crypto
    .pbkdf2Sync(password, salt, 120000, 32, "sha256")
    .toString("hex");
}

function generarCredencialesTemporales() {
  const passwordTemporal = crypto.randomBytes(4).toString("hex");
  const saltHex = crypto.randomBytes(16).toString("hex");
  const hashHex = pbkdf2Hash(passwordTemporal, saltHex);
  return { passwordTemporal, saltHex, hashHex };
}

function puedeCrearCuentaIntranet(email) {
  return Boolean(email);
}

function enviarClaveTemporal(email, firstName, passwordTemporal) {
  return sendMail({
    to: email,
    subject: "Cuenta creada - Intranet",
    html: `
      <h3>Hola ${firstName},</h3>
      <p>Tu cuenta fue creada en la Intranet Transworld.</p>
      <p>Tu contraseña temporal es: <strong>${passwordTemporal}</strong></p>
      <p>Ingresa con tu correo y esta contraseña. En el primer acceso te pediremos verificar tu correo.</p>
      <p>Por seguridad, se te solicitará cambiarla en tu primer ingreso.</p>
    `,
    text: `Hola ${firstName}, tu contraseña temporal es: ${passwordTemporal}. Ingresa con tu correo y esta contraseña; en el primer acceso te pediremos verificar tu correo.`,
  }).catch((mailErr) =>
    console.error("Error enviando correo:", mailErr.message),
  );
}

async function getAreasTrabajo() {
  const { rows } = await db.query(
    "SELECT id, area_name AS nombre_area FROM work_areas ORDER BY area_name ASC",
  );
  return rows;
}

// ==========================================
// RUTAS PRINCIPALES
// ==========================================

// 1. PÁGINA PRINCIPAL
router.get("/", (req, res) => {
  res.render("RRHH/index", {
    titulo: "Recursos Humanos",
    user: req.session.user,
  });
});

// 2. LISTADO DE PERSONAL
// FIX: Se agregan columnas faltantes: telefono, usuario_intranet
// FIX: Los campos se mapean 1:1 desde la BD sin transformaciones intermedias
router.get("/personal", async (req, res) => {
  const sql = `
    SELECT
      u.id,
      u.first_name,
      u.last_name,
      u.email,
      u.role,
      u.photo,
      u.birth_date,
      u.work_area_id,
      u.phone,
      u.is_intranet_user,
      u.email_confirmed,
      at.area_name AS area
    FROM users u
    LEFT JOIN work_areas at ON at.id = u.work_area_id
    ORDER BY u.last_name ASC NULLS LAST, u.first_name ASC
  `;

  try {
    const { rows: results } = await db.query(sql);
    const mostrarColumnaRol = Boolean(res.locals.isAdministrador);

    const personasFormateadas = results.map((p) => {
      const birthDate = p.birth_date ?? p.fecha_nacimiento;
      const phoneRaw = p.phone ?? p.telefono;
      const partes = parseFechaNacimiento(birthDate);
      const ordenCumple = partes ? partes.month * 100 + partes.day : 9999;
      const fechaCumpleFmt = partes
        ? `${String(partes.day).padStart(2, "0")}-${String(partes.month + 1).padStart(2, "0")}`
        : "-";

      const telefonoHref = toTelHref(phoneRaw);
      const telefonoDisplay = formatPhoneForDisplay(phoneRaw);

      const persona = {
        ...p,
        phone: telefonoDisplay || phoneRaw,
        telefono: telefonoDisplay || phoneRaw,
        ordenCumple,
        fechaCumpleFmt,
        telefonoHref,
      };

      if (!mostrarColumnaRol) {
        delete persona.role;
      }

      return persona;
    });

    // Leer mensajes flash de la querystring
    const successMsg = req.query.ok === "1" ? decodeURIComponent(req.query.msg || "Operación exitosa") : null;
    const crearError = req.query.crearError
      ? decodeURIComponent(req.query.crearError)
      : null;
    const abrirCrearModal =
      req.query.abrirCrear === "1" || Boolean(crearError);
    const editarId = req.query.editar ? String(req.query.editar) : null;
    const editarError = req.query.editarError
      ? decodeURIComponent(req.query.editarError)
      : null;

    let areas = [];
    if (res.locals.isAdministrador) {
      areas = await getAreasTrabajo();
    }

    res.render("RRHH/personal", {
      titulo: "Personal",
      personas: personasFormateadas,
      areas,
      mostrarColumnaRol,
      user: req.session.user,
      success: successMsg,
      error: null,
      crearError,
      abrirCrearModal,
      editarId,
      editarError,
    });
  } catch (err) {
    console.error("Error consultando personas:", err);
    res.status(500).send("Error consultando personas");
  }
});

// --- CRUD Personas ---

router.get("/crear", requireRole.administrador(), (req, res) => {
  res.redirect("/RRHH/personal?abrirCrear=1");
});

// FIX: Se añaden los campos faltantes telefono al INSERT
// FIX: Validación clara con mensajes específicos
router.post("/crear", requireRole.administrador(), async (req, res) => {
  const {
    first_name,
    last_name,
    email,
    area_trabajo_id,
    fecha_nacimiento,
    telefono,
  } = req.body;

  try {
    const emailRaw =
      email && typeof email === "string" ? email.trim() : "";
    const emailCheck = emailRaw
      ? validateEmail(emailRaw)
      : { valid: true, value: null };
    const emailClean = emailCheck.value;
    const areaId = (area_trabajo_id && String(area_trabajo_id).trim()) ? Number(area_trabajo_id) : null;
    const telefonoCheck = (telefono && typeof telefono === 'string' && telefono.trim()) ? validateChileMobilePhone(telefono) : { valid: true, value: null, storageValue: null };
    const telefonoVal = telefonoCheck.storageValue;

    const firstName = (first_name && typeof first_name === 'string') ? toTitleCase(first_name.trim()) : '';
    const lastName = (last_name && typeof last_name === 'string') ? toTitleCase(last_name.trim()) : '';
    const fechaVal =
      fecha_nacimiento && String(fecha_nacimiento).trim()
        ? fecha_nacimiento
        : null;

    if (!firstName || !lastName || !areaId) {
      return redirectPersonalCrearError(
        res,
        "Completa los campos obligatorios: Nombre, Apellido y Área de Trabajo.",
      );
    }

    if (!emailClean && !fechaVal) {
      return redirectPersonalCrearError(
        res,
        "La fecha de nacimiento es obligatoria para colaboradores sin correo.",
      );
    }

    if (!emailCheck.valid) {
      return redirectPersonalCrearError(res, emailCheck.error);
    }

    if (!telefonoCheck.valid) {
      return redirectPersonalCrearError(res, telefonoCheck.error);
    }

    if (emailClean) {
      const { rows: existingUser } = await db.query(
        "SELECT id FROM users WHERE email = $1 LIMIT 1",
        [emailClean],
      );
      if (existingUser.length > 0) {
        return redirectPersonalCrearError(
          res,
          "El correo ya existe en el sistema.",
        );
      }
    }

    const crearCuentaIntranet = puedeCrearCuentaIntranet(emailClean);
    const userId = await generateUniqueUsuarioId(db);
    let successMsg = "Colaborador+agregado+correctamente";

    if (crearCuentaIntranet) {
      const { passwordTemporal, saltHex, hashHex } =
        generarCredencialesTemporales();

      await db.query(
        `INSERT INTO users
          (id, first_name, last_name, email, password_hash, password_salt, role, email_confirmed, must_change_password, work_area_id, birth_date, phone, is_intranet_user, home_tutorial_seen)
        VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, TRUE, $8, $9, $10, TRUE, FALSE)`,
        [
          userId,
          firstName,
          lastName,
          emailClean,
          hashHex,
          saltHex,
          ROLES.DESHABILITADO,
          areaId,
          fechaVal,
          telefonoVal,
        ],
      );

      await enviarClaveTemporal(emailClean, firstName, passwordTemporal);
      successMsg =
        "Usuario+creado+correctamente.+Se+envió+la+clave+temporal+al+correo.";
    } else {
      await db.query(
        `INSERT INTO users
          (id, first_name, last_name, email, role, email_confirmed, must_change_password, work_area_id, birth_date, phone, is_intranet_user)
        VALUES ($1, $2, $3, $4, $5, FALSE, FALSE, $6, $7, $8, FALSE)`,
        [
          userId,
          firstName,
          lastName,
          emailClean,
          ROLES.DESHABILITADO,
          areaId,
          fechaVal,
          telefonoVal,
        ],
      );
    }

    res.redirect(`/RRHH/personal?ok=1&msg=${successMsg}`);
  } catch (err) {
    if (err && err.code === "23505") {
      return redirectPersonalCrearError(
        res,
        "El correo ya existe en el sistema.",
      );
    }
    console.error("Error creando usuario:", err);
    return redirectPersonalCrearError(
      res,
      `Error al crear el usuario: ${err.message}`,
    );
  }
});

router.get("/editar/:id", requireRole.administrador(), async (req, res) => {
  const { id } = req.params;
  try {
    const [userResult, areas] = await Promise.all([
      db.query("SELECT * FROM users WHERE id = $1", [id]),
      getAreasTrabajo(),
    ]);
    const { rows } = userResult;

    if (rows.length === 0) return res.status(404).send("Usuario no encontrado");

    const persona = mapPersonaForView({
      ...rows[0],
      telefono: formatPhoneForDisplay(rows[0].phone ?? rows[0].telefono) || rows[0].phone || rows[0].telefono,
    });

    if (req.query.partial === "1") {
      return res.render("RRHH/partials/persona_editar_modal", {
        layout: false,
        persona,
        areas,
      });
    }

    return res.redirect(`/RRHH/personal?editar=${encodeURIComponent(id)}`);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error cargando formulario de edición");
  }
});

router.post(
  "/editar/:id",
  requireRole.administrador(),
  upload.single("foto"),
  async (req, res) => {
    const { id } = req.params;
    const {
      first_name,
      last_name,
      role,
      area_trabajo_id,
      fecha_nacimiento,
      telefono,
      email,
      eliminar_foto,
    } = req.body;

    try {
      const areaId = (area_trabajo_id && String(area_trabajo_id).trim()) ? Number(area_trabajo_id) : null;
      const telefonoCheck = (telefono && typeof telefono === 'string' && telefono.trim()) ? validateChileMobilePhone(telefono) : { valid: true, value: null, storageValue: null };
      const telefonoVal = telefonoCheck.storageValue;
      const firstName = (first_name && typeof first_name === 'string') ? toTitleCase(first_name.trim()) : '';
      const lastName = (last_name && typeof last_name === 'string') ? toTitleCase(last_name.trim()) : '';
      const emailRaw =
        email && typeof email === "string" ? email.trim() : "";
      const emailCheck = emailRaw
        ? validateEmail(emailRaw)
        : { valid: true, value: null };
      const emailClean = emailCheck.value;
      const fechaVal =
        fecha_nacimiento && String(fecha_nacimiento).trim()
          ? fecha_nacimiento
          : null;

      if (!firstName || !lastName || !areaId) {
        return redirectPersonalEditarError(
          res,
          id,
          "Completa los campos obligatorios: Nombre, Apellido y Área.",
        );
      }

      if (!emailClean && !fechaVal) {
        return redirectPersonalEditarError(
          res,
          id,
          "La fecha de nacimiento es obligatoria para colaboradores sin correo.",
        );
      }

      if (!emailCheck.valid) {
        return redirectPersonalEditarError(res, id, emailCheck.error);
      }

      if (!telefonoCheck.valid) {
        return redirectPersonalEditarError(res, id, telefonoCheck.error);
      }

      if (emailClean) {
        const { rows: emailConflict } = await db.query(
          "SELECT id FROM users WHERE email = $1 AND id <> $2 LIMIT 1",
          [emailClean, id],
        );
        if (emailConflict.length > 0) {
          return redirectPersonalEditarError(
            res,
            id,
            "El correo ya está registrado por otro usuario.",
          );
        }
      }

      const { rows: prev } = await db.query(
        "SELECT photo AS foto, password_hash, email_confirmed, role, email FROM users WHERE id = $1",
        [id],
      );
      const prevUser = prev[0] || {};
      const prevEmail = prevUser.email ? String(prevUser.email).trim() : "";
      if (prevEmail && !emailClean) {
        return redirectPersonalEditarError(
          res,
          id,
          "No puedes quitar el correo de un usuario ya registrado en la intranet.",
        );
      }
      const previousUrl = prevUser.foto || null;
      const teniaPassword = Boolean(prevUser.password_hash);
      const correoVerificado = Boolean(prevUser.email_confirmed);
      const roleToSave = correoVerificado
        ? parseRoleFromForm(role)
        : ROLES.DESHABILITADO;
      const crearCuentaIntranet =
        !teniaPassword && puedeCrearCuentaIntranet(emailClean);
      const shouldRemovePhoto =
        eliminar_foto === "1" || eliminar_foto === "true";

      let fotoValue;
      if (req.file) {
        fotoValue = await userPhotoStorage.saveUserPhotoReplacing(
          id,
          req.file.buffer,
          previousUrl,
        );
      } else if (shouldRemovePhoto) {
        await userPhotoStorage.removeUserPhoto(id, previousUrl);
        fotoValue = null;
      }

      const setClauses = [
        "first_name=$1",
        "last_name=$2",
        "role=$3",
        "work_area_id=$4",
        "birth_date=$5",
        "phone=$6",
        "email=$7",
      ];
      const values = [
        firstName,
        lastName,
        roleToSave,
        areaId,
        fechaVal,
        telefonoVal,
        emailClean,
      ];

      if (fotoValue !== undefined) {
        setClauses.push(`photo=$${values.length + 1}`);
        values.push(fotoValue);
      }

      let successMsg = "Usuario+actualizado+correctamente";
      let passwordTemporalNueva = null;
      if (crearCuentaIntranet) {
        const credenciales = generarCredencialesTemporales();
        passwordTemporalNueva = credenciales.passwordTemporal;
        setClauses.push(
          `password_hash=$${values.length + 1}`,
          `password_salt=$${values.length + 2}`,
          "email_confirmed=FALSE",
          "must_change_password=TRUE",
          "is_intranet_user=TRUE",
          "confirm_token=NULL",
          "confirm_expires=NULL",
        );
        values.push(credenciales.hashHex, credenciales.saltHex);
        successMsg =
          "Usuario+actualizado.+Se+envió+la+clave+temporal+al+correo.";
      }

      values.push(id);
      await db.query(
        `UPDATE users SET ${setClauses.join(", ")} WHERE id=$${values.length}`,
        values,
      );

      if (
        req.session.user &&
        String(req.session.user.id) === String(id) &&
        fotoValue !== undefined
      ) {
        req.session.user.foto = fotoValue;
        req.session.user.photo = fotoValue;
      }

      if (passwordTemporalNueva) {
        await enviarClaveTemporal(emailClean, firstName, passwordTemporalNueva);
      }

      res.redirect(`/RRHH/personal?ok=1&msg=${successMsg}`);
    } catch (err) {
      if (err && err.code === "23505") {
        return redirectPersonalEditarError(
          res,
          id,
          "El correo ya está registrado por otro usuario.",
        );
      }
      console.error(err);
      return redirectPersonalEditarError(res, id, "Error actualizando usuario.");
    }
  },
);

router.post("/eliminar/:id", requireRole.administrador(), async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await db.query("SELECT photo AS foto FROM users WHERE id = $1", [
      id,
    ]);
    if (rows.length > 0) {
      await userPhotoStorage.removeUserPhoto(id, rows[0].foto);
    }

    await db.query("DELETE FROM users WHERE id = $1", [id]);
    res.redirect("/RRHH/personal?ok=1&msg=Usuario+eliminado+correctamente");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error eliminando usuario");
  }
});

// ==========================================
// RUTAS DE ORGANIGRAMA
// ==========================================

router.get("/organigrama", async (req, res) => {
  const organigramaUrl = await getOrganigramaUrl();
  res.render("RRHH/organigrama", {
    titulo: "Organigrama",
    organigramaUrl,
    user: req.session.user,
  });
});

router.post(
  "/organigrama/subir",
  requireRole.administrador(),
  upload.single("organigrama"),
  async (req, res) => {
    if (!req.file) return res.status(400).send("No se subió archivo.");

    try {
      await fileStorage.deleteFolder("organigrama");

      const result = await fileStorage.saveFile(
        req.file.buffer,
        "organigrama",
        req.file.originalname,
      );

      urlOrganigramaActual = result.secure_url;
      versionCache = Date.now();

      if (req.session.user && req.session.user.id) {
        await db.query(
          "INSERT INTO change_log (user_id, action, section, link_path) VALUES ($1, $2, $3, $4)",
          [
            req.session.user.id,
            "actualizó",
            "Organigrama",
            "/RRHH/organigrama",
          ],
        );
      }

      res.redirect("/RRHH/organigrama");
    } catch (err) {
      console.error("Error en subida de organigrama:", err);
      res.status(500).send("Error subiendo archivo.");
    }
  },
);

router.post(
  "/organigrama/eliminar",
  requireRole.administrador(),
  async (req, res) => {
    try {
      await fileStorage.deleteFolder("organigrama");
      urlOrganigramaActual = null;
      res.redirect("/RRHH/organigrama");
    } catch (e) {
      console.error("Error eliminando:", e);
      res.status(500).send("Error al eliminar.");
    }
  },
);

module.exports = router;

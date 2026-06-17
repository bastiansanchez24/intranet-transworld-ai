const express = require("express");
const crypto = require("crypto");
const multer = require("multer");
const router = express.Router();
const pool = require("../db");
const { sendMail } = require("../services/mailer");
const { toTitleCase } = require("../utils/formatName");
const { isPasswordStrongEnough } = require("../utils/passwordStrength");
const { validateChileMobilePhone } = require("../utils/phoneChile");
const userPhotoStorage = require("../services/userPhotoStorage");
const {
  ROLES,
  normalizeRole,
  isDeshabilitado,
  canLogin,
} = require("../constants/roles");
const linkedinService = require("../services/linkedinService");
const { generateUniqueUsuarioId } = require("../utils/userId");

function getBaseUrl(req) {
  return process.env.APP_BASE_URL || `${req.protocol}://${req.get("host")}`;
}

function pbkdf2Hash(password, saltHex) {
  const salt = Buffer.from(saltHex, "hex");
  const derived = crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256");
  return derived.toString("hex");
}

function safeEqualHex(a, b) {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function safeEqualString(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

const OTP_EXPIRES_MS = 15 * 60 * 1000;

function generateEmailVerificationCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function normalizeVerificationCode(raw) {
  return String(raw || "")
    .replace(/\D/g, "")
    .slice(0, 6);
}

async function sendVerificationCodeEmail(email, firstName, code) {
  const minutes = Math.round(OTP_EXPIRES_MS / 60000);
  await sendMail({
    to: email,
    subject: "Código de verificación - Intranet Transworld",
    text: `Hola ${firstName},\n\nTu código de verificación es: ${code}\n\nIngrésalo en la intranet para activar tu cuenta. El código expira en ${minutes} minutos.\n`,
    html: `<div style="font-family: sans-serif; max-width: 520px;">
      <p>Hola <strong>${firstName}</strong>,</p>
      <p>Usa este código para verificar tu correo en la intranet:</p>
      <p style="font-size: 2rem; letter-spacing: 0.35em; font-weight: 800; color: #003a70; margin: 24px 0;">${code}</p>
      <p style="color: #555;">Válido por ${minutes} minutos. Si no solicitaste este registro, ignora este mensaje.</p>
    </div>`,
  });
}

async function issueVerificationCode(userId, firstName, email) {
  const code = generateEmailVerificationCode();
  const expires = new Date(Date.now() + OTP_EXPIRES_MS);
  await pool.query(
    "UPDATE users SET confirm_token = $1, confirm_expires = $2 WHERE id = $3",
    [code, expires, userId],
  );
  await sendVerificationCodeEmail(email, firstName, code);
  return code;
}

const ALLOWED_LOGIN_DOMAINS = new Set([
  "transworld.cl",
  "gmail.com",
  "hotmail.com",
  "hotmail.cl",
  "yahoo.com",
  "yahoo.cl",
  "icloud.com",
  "outlook.com",
  "outlook.cl",
]);

const TRANSWORLD_EMAIL_DOMAIN = "transworld.cl";

const EXTERNAL_DOMAIN_PENDING_MSG =
  "Su correo pertenece a un dominio que no es de Transworld, espere para que un administrador le de acceso";

const AUTH_VIEW_TITLES = {
  login: "Iniciar sesión",
  register: "Registro",
  forgot: "Recuperar contraseña",
  verify: "Verificar correo",
  reset: "Crear nueva contraseña",
};

function renderAuthPage(res, view, options = {}) {
  const payload = {
    view,
    titulo: options.titulo || AUTH_VIEW_TITLES[view] || AUTH_VIEW_TITLES.login,
    error: options.error ?? null,
    info: options.info ?? null,
    email: options.email ?? null,
    awaitingAdmin: options.awaitingAdmin ?? false,
    externalDomainMessage: options.externalDomainMessage ?? null,
    formData: options.formData ?? null,
    layout: false,
  };
  const status = options.status || 200;
  if (status === 200) return res.render("login", payload);
  return res.status(status).render("login", payload);
}

function isTransworldEmail(email) {
  if (!email || !email.includes("@")) return false;
  return email.split("@")[1] === TRANSWORLD_EMAIL_DOMAIN;
}

function isExternalDomainEmail(email) {
  return Boolean(email) && !isTransworldEmail(email);
}

function needsAdminAuthorization(user) {
  return (
    isExternalDomainEmail(user.email) &&
    user.email_confirmed &&
    isDeshabilitado(user.role)
  );
}

async function notifyTIAdminsNewUser(firstName, lastName, email, isTransworld) {
  // Solo administradores que pertenecen al área de trabajo TI.
  const { rows } = await pool.query(
    `SELECT u.email
     FROM users u
     JOIN area_trabajo at ON at.id = u.area_trabajo_id
     WHERE u.role IN ($1, $2)
       AND at.nombre_area ILIKE 'TI'
       AND u.email IS NOT NULL AND TRIM(u.email) <> ''`,
    [ROLES.ADMINISTRADOR, "admin"],
  );
  const adminEmails = [
    ...new Set(rows.map((r) => String(r.email).trim().toLowerCase()).filter(Boolean)),
  ];

  if (!adminEmails.length && process.env.ADMIN_NOTIFY_EMAIL) {
    adminEmails.push(String(process.env.ADMIN_NOTIFY_EMAIL).trim().toLowerCase());
  }
  if (!adminEmails.length) {
    console.warn(
      "[Registro] No hay administradores de TI con correo para notificar el nuevo registro.",
    );
    return;
  }

  const pendingText = isTransworld
    ? `El usuario tiene rol "${ROLES.USUARIO}" y está pendiente de asignación de área de trabajo en RRHH.`
    : `El correo es de un dominio externo: el usuario quedará deshabilitado hasta que un administrador lo autorice y le asigne área de trabajo.`;

  const subject = "Nuevo usuario registrado en la Intranet";
  const text = `Se registró un nuevo usuario en la intranet:

Nombre: ${firstName} ${lastName}
Correo: ${email}

${pendingText}`;

  const html = `<div style="font-family: sans-serif; max-width: 520px;">
    <p>Se registró un nuevo usuario en la intranet:</p>
    <p><strong>${firstName} ${lastName}</strong><br>${email}</p>
    <p>${pendingText}</p>
  </div>`;

  const [primary, ...rest] = adminEmails;
  await sendMail({
    to: primary,
    bcc: rest.length ? rest : undefined,
    subject,
    text,
    html,
  }).catch((err) => {
    console.error("Error notificando a administradores de TI:", err);
  });
}

function stripEmailLocalPart(usernameOrEmail) {
  const raw = String(usernameOrEmail || "").trim().toLowerCase();
  if (!raw) return "";
  const atIdx = raw.indexOf("@");
  return atIdx === -1 ? raw : raw.slice(0, atIdx);
}

function normalizeCorporateEmail(usernameOrEmail, selectedDomain = null) {
  const raw = String(usernameOrEmail || "")
    .trim()
    .toLowerCase();
  if (!raw) return null;
  if (raw.includes("@")) {
    const parts = raw.split("@");
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    if (!ALLOWED_LOGIN_DOMAINS.has(parts[1])) return null;
    return `${parts[0]}@${parts[1]}`;
  }
  const localPart = stripEmailLocalPart(raw);
  if (!localPart) return null;
  const domain = String(selectedDomain || "")
    .trim()
    .toLowerCase();
  if (!ALLOWED_LOGIN_DOMAINS.has(domain)) return null;
  return `${localPart}@${domain}`;
}

const uploadProfilePhoto = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype || !file.mimetype.startsWith("image/")) {
      return cb(new Error("Formato de imagen no permitido."));
    }
    cb(null, true);
  },
});

// ==========================================
// LOGIN
// ==========================================
router.get("/login", (req, res) => {
  if (req.session && req.session.user) return res.redirect("/");

  const info =
    req.query.confirmed === "1"
      ? "Correo verificado correctamente. Ya puedes iniciar sesión."
      : req.query.pending === "1"
        ? "Debes verificar tu correo con el código de 6 dígitos antes de ingresar."
        : req.query.exists === "1"
          ? "Ese correo ya está registrado. Inicia sesión."
          : req.query.reset === "1"
            ? "Se ha enviado una nueva contraseña a tu correo."
            : req.query.changed === "1"
              ? "Contraseña actualizada correctamente. Ingresa con tu correo y nueva contraseña."
              : null;

  renderAuthPage(res, "login", { info });
});

router.post("/login", async (req, res) => {
  const { username, password, domain } = req.body;
  const validUser = process.env.AUTH_USER;
  const validPass = process.env.AUTH_PASS;

  if (username === validUser && password === validPass) {
    req.session.user = {
      id: 0,
      username: validUser,
      role: ROLES.ADMINISTRADOR,
      email: null,
      foto: null,
    };
    return res.redirect("/");
  }

  try {
    const email = normalizeCorporateEmail(username, domain);
    if (!email) {
      return renderAuthPage(res, "login", {
        status: 400,
        error: "Debes ingresar un usuario corporativo válido.",
      });
    }

    const { rows } = await pool.query(
      `SELECT id, first_name, last_name, email, role, email_confirmed,
              password_hash, password_salt, foto, must_change_password,
              confirm_token, confirm_expires
       FROM users WHERE email = $1 LIMIT 1`,
      [email],
    );

    if (!rows.length) {
      return renderAuthPage(res, "login", {
        status: 401,
        error: "Usuario no registrado en la intranet",
      });
    }

    const u = rows[0];

    if (!u.password_hash || !u.password_salt) {
      return renderAuthPage(res, "login", {
        status: 401,
        error: "Usuario o contraseña incorrectos",
      });
    }

    const computed = pbkdf2Hash(password, u.password_salt);
    if (!safeEqualHex(computed, u.password_hash)) {
      return renderAuthPage(res, "login", {
        status: 401,
        error: "Usuario o contraseña incorrectos",
      });
    }

    if (!u.email_confirmed) {
      const codeExpired =
        !u.confirm_expires || new Date(u.confirm_expires) < new Date();
      let codeJustSent = false;
      if (!u.confirm_token || codeExpired) {
        await issueVerificationCode(u.id, u.first_name, email);
        codeJustSent = true;
      }
      req.session.pendingEmailVerification = email;
      return res.redirect(
        codeJustSent ? "/verify-email?sent=1" : "/verify-email",
      );
    }

    if (!canLogin(u.role)) {
      let errorMsg = "Tu cuenta no tiene permiso para ingresar. Contacta a un administrador.";
      if (needsAdminAuthorization(u)) {
        errorMsg = EXTERNAL_DOMAIN_PENDING_MSG;
      } else if (isDeshabilitado(u.role)) {
        errorMsg =
          "Usuario deshabilitado, póngase en contacto con el administrador";
      }
      return renderAuthPage(res, "login", {
        status: 403,
        error: errorMsg,
      });
    }

    delete req.session.pendingPasswordReset;

    req.session.user = {
      id: u.id,
      username: u.email,
      email: u.email,
      role: normalizeRole(u.role),
      nombre: u.first_name + (u.last_name ? " " + u.last_name : ""),
      foto: u.foto || null,
      must_change_password: u.must_change_password,
    };

    if (u.must_change_password) {
      return res.redirect("/reset-password");
    }

    const redirectUrl = req.session.returnTo || "/";
    delete req.session.returnTo;
    return res.redirect(redirectUrl);
  } catch (err) {
    console.error("Login error:", err);
    // FIX 1: se agrega info: null para que la vista no rompa
    return renderAuthPage(res, "login", {
      status: 500,
      error: "Error interno del servidor",
    });
  }
});

// ==========================================
// REGISTRO
// ==========================================
router.get("/register", (req, res) => {
  if (req.session && req.session.user) return res.redirect("/");
  renderAuthPage(res, "register");
});

router.post(
  "/register",
  uploadProfilePhoto.single("foto_file"),
  async (req, res) => {
    // Para repoblar el formulario si hay un error (sin contraseñas ni foto).
    const formData = {
      first_name: req.body.first_name || "",
      last_name: req.body.last_name || "",
      username: stripEmailLocalPart(req.body.username),
      domain: String(req.body.domain || "").trim().toLowerCase(),
      telefono: req.body.telefono || "",
      fecha_nacimiento: req.body.fecha_nacimiento || "",
    };

    try {
      const firstName = toTitleCase(req.body.first_name);
      const lastName = toTitleCase(req.body.last_name);

      const usernameInput = String(
        req.body.username || req.body.email || "",
      ).trim();
      const selectedDomain = String(req.body.domain || "")
        .trim()
        .toLowerCase();
      const email = normalizeCorporateEmail(usernameInput, selectedDomain);
      const password = String(req.body.password || "");
      const password2 = String(req.body.password2 || "");
      const fechaNacimiento =
        String(req.body.fecha_nacimiento || "").trim() || null;
      const telefonoCheck = validateChileMobilePhone(req.body.telefono, {
        required: true,
      });
      const telefono = telefonoCheck.storageValue;
      const hasPhotoFile = Boolean(req.file && req.file.buffer);

      if (
        !firstName ||
        !lastName ||
        !email ||
        !password ||
        !password2 ||
        !fechaNacimiento ||
        !telefono
      ) {
        return renderAuthPage(res, "register", {
          status: 400,
          error: "Todos los campos son obligatorios, incluyendo teléfono.",
          formData,
        });
      }

      if (!telefonoCheck.valid) {
        return renderAuthPage(res, "register", {
          status: 400,
          error: telefonoCheck.error,
          formData,
        });
      }

      if (!email) {
        return renderAuthPage(res, "register", {
          status: 400,
          error:
            "Dominio no permitido. Usa uno de los dominios permitidos.",
          formData,
        });
      }

      if (!isPasswordStrongEnough(password)) {
        return renderAuthPage(res, "register", {
          status: 400,
          error:
            "La contraseña es muy débil. Debe tener al menos 8 caracteres e incluir mayúsculas, minúsculas, números y símbolos.",
          formData,
        });
      }

      if (password !== password2) {
        return renderAuthPage(res, "register", {
          status: 400,
          error: "Las contraseñas no coinciden.",
          formData,
        });
      }

      const { rows: exists } = await pool.query(
        "SELECT id FROM users WHERE email = $1 LIMIT 1",
        [email],
      );
      if (exists.length) {
        return res.redirect("/login?exists=1");
      }

      const generatedUserId = await generateUniqueUsuarioId(pool);

      const saltHex = crypto.randomBytes(16).toString("hex");
      const hashHex = pbkdf2Hash(password, saltHex);
      const verificationCode = generateEmailVerificationCode();
      const expires = new Date(Date.now() + OTP_EXPIRES_MS);

      const isTransworld = isTransworldEmail(email);
      const roleOnRegister = isTransworld
        ? ROLES.USUARIO
        : ROLES.DESHABILITADO;

      await pool.query(
        `INSERT INTO users
        (id, first_name, last_name, email, password_hash, password_salt, role, email_confirmed, confirm_token, confirm_expires, foto, must_change_password, area_trabajo_id, fecha_nacimiento, telefono, usuario_intranet)
       VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, $8, $9, NULL, FALSE, NULL, $10, $11, TRUE)`,
        [
          generatedUserId,
          firstName,
          lastName,
          email,
          hashHex,
          saltHex,
          roleOnRegister,
          verificationCode,
          expires,
          fechaNacimiento,
          telefono,
        ],
      );

      if (hasPhotoFile) {
        try {
          const foto = await userPhotoStorage.saveUserPhoto(
            generatedUserId,
            req.file.buffer,
          );
          await pool.query("UPDATE users SET foto = $1 WHERE id = $2", [
            foto,
            generatedUserId,
          ]);
        } catch (photoErr) {
          console.error("Error guardando foto de registro:", photoErr);
          await pool.query("DELETE FROM users WHERE id = $1", [generatedUserId]);
          return renderAuthPage(res, "register", {
            status: 500,
            error:
              "No se pudo guardar la foto de perfil. Intenta de nuevo con otra imagen o continúa sin foto.",
            formData,
          });
        }
      }

      await sendVerificationCodeEmail(email, firstName, verificationCode).catch(
        (err) => {
          console.error("Error enviando código de verificación:", err);
        },
      );

      await notifyTIAdminsNewUser(firstName, lastName, email, isTransworld);

      req.session.pendingEmailVerification = email;
      return res.redirect("/verify-email");
    } catch (err) {
      if (err && err.code === "23505") {
        return res.redirect("/login?exists=1");
      }
      console.error("Register error:", err);
      return renderAuthPage(res, "register", {
        status: 500,
        error: "Error interno en el servidor al procesar el registro.",
        formData,
      });
    }
  },
);

// ==========================================
// VERIFICACIÓN DE CORREO (CÓDIGO 6 DÍGITOS)
// ==========================================
router.get("/verify-email", async (req, res) => {
  const sessionEmail = req.session.pendingEmailVerification || null;
  const queryEmail = normalizeCorporateEmail(req.query.email);
  const email = sessionEmail || queryEmail;

  if (!email) {
    return res.redirect("/register");
  }

  if (!sessionEmail && queryEmail) {
    req.session.pendingEmailVerification = queryEmail;
  }

  let info = null;
  if (req.query.sent === "1") {
    info = "Te enviamos un nuevo código a tu correo.";
  }

  try {
    const { rows } = await pool.query(
      "SELECT email_confirmed, role FROM users WHERE email = $1 LIMIT 1",
      [email],
    );
    if (rows.length && rows[0].email_confirmed) {
      delete req.session.pendingEmailVerification;
      if (
        needsAdminAuthorization({ email, email_confirmed: true, role: rows[0].role })
      ) {
        return renderAuthPage(res, "verify", {
          email,
          awaitingAdmin: true,
          externalDomainMessage: EXTERNAL_DOMAIN_PENDING_MSG,
        });
      }
      return res.redirect("/login?confirmed=1");
    }
  } catch (err) {
    console.error("Verify-email GET error:", err);
  }

  return renderAuthPage(res, "verify", {
    email,
    info,
  });
});

router.post("/verify-email", async (req, res) => {
  const email =
    req.session.pendingEmailVerification ||
    normalizeCorporateEmail(req.body.email);
  const code = normalizeVerificationCode(req.body.code);

  if (!email) {
    return res.redirect("/register");
  }

  if (code.length !== 6) {
    return renderAuthPage(res, "verify", {
      status: 400,
      email,
      error: "El código debe tener 6 dígitos.",
    });
  }

  try {
    const { rows } = await pool.query(
      `SELECT id, first_name, email, email_confirmed, confirm_token, confirm_expires, role, area_trabajo_id, must_change_password
       FROM users WHERE email = $1 LIMIT 1`,
      [email],
    );

    if (!rows.length) {
      return renderAuthPage(res, "verify", {
        status: 400,
        email,
        error: "No encontramos una cuenta con ese correo.",
      });
    }

    const u = rows[0];

    if (u.email_confirmed) {
      delete req.session.pendingEmailVerification;
      if (needsAdminAuthorization(u)) {
        return renderAuthPage(res, "verify", {
          email,
          awaitingAdmin: true,
          externalDomainMessage: EXTERNAL_DOMAIN_PENDING_MSG,
        });
      }
      return res.redirect("/login?confirmed=1");
    }

    if (!u.confirm_token || !u.confirm_expires) {
      return renderAuthPage(res, "verify", {
        status: 400,
        email,
        error: "No hay un código activo. Solicita uno nuevo.",
      });
    }

    if (new Date(u.confirm_expires) < new Date()) {
      return renderAuthPage(res, "verify", {
        status: 400,
        email,
        error: "El código expiró. Usa «Reenviar código» para obtener uno nuevo.",
      });
    }

    if (!safeEqualString(code, u.confirm_token)) {
      return renderAuthPage(res, "verify", {
        status: 400,
        email,
        error: "Código incorrecto. Revisa tu correo e inténtalo de nuevo.",
      });
    }

    // Si el administrador creó al usuario desde la intranet ya validó el correo
    // y le asignó un área de trabajo, por lo que se le permite ingresar aunque
    // su correo sea de un dominio externo.
    const createdByAdmin = u.area_trabajo_id != null;
    const roleOnVerify =
      isExternalDomainEmail(u.email) && !createdByAdmin
        ? ROLES.DESHABILITADO
        : ROLES.USUARIO;

    await pool.query(
      `UPDATE users
       SET email_confirmed = TRUE,
           confirm_token = NULL,
           confirm_expires = NULL,
           role = $2,
           usuario_intranet = $3
       WHERE id = $1`,
      [u.id, roleOnVerify, roleOnVerify === ROLES.USUARIO],
    );

    delete req.session.pendingEmailVerification;

    if (isExternalDomainEmail(u.email) && !createdByAdmin) {
      return renderAuthPage(res, "verify", {
        email,
        awaitingAdmin: true,
        externalDomainMessage: EXTERNAL_DOMAIN_PENDING_MSG,
      });
    }

    // Flujo fluido: si debe cambiar la contraseña temporal, avanza directo
    // a la vista de crear nueva contraseña sin pasar por el login.
    if (u.must_change_password) {
      req.session.pendingPasswordReset = u.id;
      return res.redirect("/reset-password?confirmed=1");
    }

    return res.redirect("/login?confirmed=1");
  } catch (err) {
    console.error("Verify-email POST error:", err);
    return renderAuthPage(res, "verify", {
      status: 500,
      email,
      error: "Error interno al verificar el código.",
    });
  }
});

router.post("/verify-email/resend", async (req, res) => {
  const email =
    req.session.pendingEmailVerification ||
    normalizeCorporateEmail(req.body.email);

  if (!email) {
    return res.redirect("/register");
  }

  try {
    const { rows } = await pool.query(
      "SELECT id, first_name, email, email_confirmed, role FROM users WHERE email = $1 LIMIT 1",
      [email],
    );

    if (!rows.length) {
      return res.redirect("/register");
    }

    const u = rows[0];

    if (u.email_confirmed) {
      delete req.session.pendingEmailVerification;
      if (needsAdminAuthorization(u)) {
        return renderAuthPage(res, "verify", {
          email,
          awaitingAdmin: true,
          externalDomainMessage: EXTERNAL_DOMAIN_PENDING_MSG,
        });
      }
      return res.redirect("/login?confirmed=1");
    }

    await issueVerificationCode(u.id, u.first_name, email);
    req.session.pendingEmailVerification = email;
    return res.redirect("/verify-email?sent=1");
  } catch (err) {
    console.error("Verify-email resend error:", err);
    return renderAuthPage(res, "verify", {
      status: 500,
      email,
      error: "No pudimos reenviar el código. Intenta más tarde.",
    });
  }
});

router.get("/confirm", (_req, res) => {
  return res.redirect("/verify-email");
});

// ==========================================
// RECUPERAR CONTRASEÑA
// ==========================================
router.get("/forgot-password", (req, res) => {
  renderAuthPage(res, "forgot");
});

router.post("/forgot-password", async (req, res) => {
  const { email } = req.body;

  try {
    const cleanEmail = String(email || "")
      .trim()
      .toLowerCase();

    const { rows } = await pool.query(
      "SELECT id, first_name FROM users WHERE email = $1",
      [cleanEmail],
    );

    if (!rows.length) return res.redirect("/login?reset=1");

    const user = rows[0];

    const tempPassword = crypto.randomBytes(4).toString("hex");
    const newSalt = crypto.randomBytes(16).toString("hex");
    const newHash = pbkdf2Hash(tempPassword, newSalt);

    await pool.query(
      `UPDATE users 
       SET password_hash = $1, 
           password_salt = $2, 
           must_change_password = TRUE 
       WHERE id = $3`,
      [newHash, newSalt, user.id],
    );

    await sendMail({
      to: cleanEmail,
      subject: "Recuperación de contraseña - Intranet Transworld",
      text: `Hola ${user.first_name},\n\nSe ha solicitado restablecer tu contraseña.\n\nTu nueva contraseña temporal es: ${tempPassword}\n\nPor favor inicia sesión con ella. El sistema te pedirá cambiarla inmediatamente.\n`,
    });

    res.redirect("/login?reset=1");
  } catch (err) {
    console.error("Error en Forgot Password:", err);
    renderAuthPage(res, "forgot", {
      status: 500,
      error: "Error interno al procesar la solicitud.",
    });
  }
});

// ==========================================
// RESTABLECER CONTRASEÑA
// ==========================================
router.get("/reset-password", (req, res) => {
  // Flujo fluido tras verificar el correo: aún no hay sesión iniciada.
  if (!req.session.user && req.session.pendingPasswordReset) {
    return renderAuthPage(res, "reset", {
      info:
        req.query.confirmed === "1"
          ? "Correo verificado correctamente. Ahora crea tu nueva contraseña."
          : null,
    });
  }

  if (!req.session.user) return res.redirect("/login");
  if (!req.session.user.must_change_password) return res.redirect("/");

  renderAuthPage(res, "reset");
});

router.post("/reset-password", async (req, res) => {
  const sessionUser = req.session.user || null;
  const pendingResetId = req.session.pendingPasswordReset || null;
  const userId = sessionUser ? sessionUser.id : pendingResetId;

  if (!userId) return res.redirect("/login");

  const { new_password, confirm_password } = req.body;

  if (new_password !== confirm_password) {
    return renderAuthPage(res, "reset", {
      status: 400,
      error: "Las contraseñas no coinciden.",
    });
  }
  if (new_password.length < 6) {
    return renderAuthPage(res, "reset", {
      status: 400,
      error: "La contraseña debe tener al menos 6 caracteres.",
    });
  }

  try {
    const newSalt = crypto.randomBytes(16).toString("hex");
    const newHash = pbkdf2Hash(new_password, newSalt);

    await pool.query(
      "UPDATE users SET password_hash = $1, password_salt = $2, must_change_password = FALSE WHERE id = $3",
      [newHash, newSalt, userId],
    );

    if (!sessionUser) {
      // Venía del flujo de verificación: ahora debe ingresar con su
      // correo y la nueva contraseña.
      delete req.session.pendingPasswordReset;
      return res.redirect("/login?changed=1");
    }

    req.session.user.must_change_password = false;

    res.redirect("/?changed=1");
  } catch (err) {
    console.error(err);
    return renderAuthPage(res, "reset", {
      status: 500,
      error: "Error al actualizar la contraseña.",
    });
  }
});

// ==========================================
// CAMBIAR CONTRASEÑA
// ==========================================
router.get("/change-password", (req, res) => {
  if (!req.session || !req.session.user) return res.redirect("/login");
  res.render("change_password", { titulo: "Cambiar contraseña", error: null });
});

router.post("/change-password", async (req, res) => {
  if (!req.session || !req.session.user) return res.redirect("/login");

  const { old_password, new_password, confirm_password } = req.body;
  const userId = req.session.user.id;

  try {
    if (new_password !== confirm_password)
      return res.render("change_password", {
        titulo: "Cambiar contraseña",
        error: "Las nuevas contraseñas no coinciden.",
      });
    if (new_password.length < 6)
      return res.render("change_password", {
        titulo: "Cambiar contraseña",
        error: "Mínimo 6 caracteres.",
      });

    const { rows } = await pool.query(
      "SELECT password_hash, password_salt FROM users WHERE id = $1",
      [userId],
    );
    if (!rows.length) return res.redirect("/login");

    const u = rows[0];
    const computed = pbkdf2Hash(old_password, u.password_salt);
    if (!safeEqualHex(computed, u.password_hash)) {
      return res.render("change_password", {
        titulo: "Cambiar contraseña",
        error: "La contraseña actual es incorrecta.",
      });
    }

    const newSalt = crypto.randomBytes(16).toString("hex");
    const newHash = pbkdf2Hash(new_password, newSalt);

    await pool.query(
      "UPDATE users SET password_hash = $1, password_salt = $2 WHERE id = $3",
      [newHash, newSalt, userId],
    );

    res.redirect("/login?changed=1");
  } catch (err) {
    console.error("Change password error:", err);
    res.status(500).render("change_password", {
      titulo: "Cambiar contraseña",
      error: "Error interno.",
    });
  }
});

// ==========================================
// LOGOUT
// ==========================================
router.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

// ==========================================
// LINKEDIN
// ==========================================
router.get("/auth/linkedin/login", (req, res) => {
  res.redirect(linkedinService.getAuthorizationUrl());
});

router.get("/auth/linkedin/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.send("Error: No se recibió código de LinkedIn");

  try {
    await linkedinService.exchangeCodeForToken(code);
    res.send(`
      <div style="font-family: sans-serif; text-align: center; margin-top: 50px;">
        <h1 style="color: #28a745;">¡Conexión Exitosa!</h1>
        <p>Token guardado. Ya puedes cerrar esta ventana.</p>
        <a href="/">Ir al Inicio</a>
      </div>
    `);
  } catch (err) {
    res.send("Error conectando con LinkedIn: " + err.message);
  }
});

// ==========================================
// VER MIS CURSOS REALIZADOS
// ==========================================
router.get("/perfil/cursos", async (req, res) => {
  const user = req.session.user;
  if (!user) return res.redirect("/login");

  try {
    const sqlCursos = `
      SELECT cu.curso_id, c.titulo, cu.nota, cu.intentos, cu.fecha_completado, cu.estado
      FROM capacitaciones_usuarios cu
      JOIN cursos c ON cu.curso_id = c.id
      WHERE cu.usuario_id = $1 AND cu.estado = 'Evaluado'
      ORDER BY cu.fecha_completado DESC
    `;

    const sqlPuntaje = `
      SELECT COALESCE(SUM(nota), 0) AS puntaje_total 
      FROM capacitaciones_usuarios 
      WHERE usuario_id = $1 AND estado = 'Evaluado'
    `;

    const sqlTotalCursos = `SELECT COUNT(*) AS total FROM cursos WHERE activo = true`;

    const [resultCursos, resultPuntaje, resultTotal] = await Promise.all([
      pool.query(sqlCursos, [user.id]),
      pool.query(sqlPuntaje, [user.id]),
      pool.query(sqlTotalCursos),
    ]);

    const cursosRealizados = resultCursos.rows;
    const puntajeTotal = resultPuntaje.rows[0].puntaje_total;
    const totalCursosActivos = parseInt(resultTotal.rows[0].total) || 0;

    const totalCompletados = cursosRealizados.length;
    const porcentajeAvance =
      totalCursosActivos > 0
        ? Math.round((totalCompletados / totalCursosActivos) * 100)
        : 0;

    res.render("ver-cursos", {
      titulo: "Mis Cursos Realizados | Transworld",
      user: user,
      cursos: cursosRealizados,
      puntajeTotal: puntajeTotal,
      totalCursosActivos: totalCursosActivos,
      porcentajeAvance: porcentajeAvance,
    });
  } catch (err) {
    console.error("Error al obtener cursos del usuario:", err);
    res.status(500).send("Error interno del servidor al cargar los cursos.");
  }
});

module.exports = router;

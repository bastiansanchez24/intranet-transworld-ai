const express = require("express");
const router = express.Router();
const db = require("../db");
const multer = require("multer");
const fileStorage = require("../services/fileStorage");
const userPhotoStorage = require("../services/userPhotoStorage");
const { getIndicadores } = require("../services/usdService");
const { getWeather } = require("../services/weatherService");
const linkedinService = require("../services/linkedinService");
const requireRole = require("../middlewares/requireRole");
const { isAdministrador, ROLES, normalizeRole } = require("../constants/roles");
const { toTitleCase } = require("../utils/formatName");
const {
  toTelHref,
  formatPhoneForDisplay,
  validateChileMobilePhone,
} = require("../utils/phoneChile");
const { sendMail } = require("../services/mailer");
const {
  NOTICIA_VIEW_COLUMNS,
  APPLICATION_VIEW_COLUMNS,
  MATERIAL_VIEW_COLUMNS,
  courseStatusToDb,
  courseStatusFromDb,
} = require("../utils/schemaMappers");

const storage = multer.memoryStorage();
const upload = multer({ storage });

// ==========================================
// SISTEMA DE CACHÉ
// ==========================================
const COURSE_LIST_BASE = `
  SELECT c.id, c.title AS titulo, c.subsection AS subseccion, sd.image_url AS imagen_url
  FROM courses c
  LEFT JOIN subsection_details sd ON c.subsection = sd.name
`;

function buildProgresoMap(rows) {
  const progresoMap = {};
  rows.forEach((p) => {
    progresoMap[p.curso_id] = {
      curso_id: p.curso_id,
      segundos_vistos: p.segundos_vistos,
      estado: courseStatusFromDb(p.estado_db ?? p.estado),
    };
  });
  return progresoMap;
}

function mapCursoRow(curso) {
  return {
    ...curso,
    titulo: curso.title ?? curso.titulo,
    descripcion: curso.description ?? curso.descripcion,
    subseccion: curso.subsection ?? curso.subseccion,
    tiempo_requerido_segundos:
      curso.required_watch_seconds ?? curso.tiempo_requerido_segundos,
  };
}

function mapPreguntaRow(pregunta) {
  return {
    ...pregunta,
    enunciado: pregunta.question_text ?? pregunta.enunciado,
    orden: pregunta.sort_order ?? pregunta.orden,
    alternativas: (pregunta.alternativas || []).map((alt) => ({
      id: alt.id,
      texto: alt.text ?? alt.texto,
    })),
  };
}
let cachedIndicadores = {
  dolar: { valor: null, tendencia: "igual" },
  euro: { valor: null, tendencia: "igual" },
  uf: { valor: null, tendencia: "igual" },
};
let cachedClima = { temp: "--", icon: "⏳", desc: "Cargando...", sunset: null, manana: null };
let cachedLinkedin = [];
let cachedEventosPool = [];
let cachedEventosCarouselAt = 0;

function shuffleArray(items) {
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

async function updateDataBackground() {
  try {
    const nuevosIndicadores = await getIndicadores();
    if (nuevosIndicadores) {
      const calcularTendencia = (ind) => {
        if (!ind || !ind.valor || !ind.valorAyer) return "igual";
        if (ind.valor > ind.valorAyer) return "alcista";
        if (ind.valor < ind.valorAyer) return "bajista";
        return "igual";
      };
      cachedIndicadores = {
        dolar: {
          ...nuevosIndicadores.dolar,
          tendencia: calcularTendencia(nuevosIndicadores.dolar),
        },
        euro: {
          ...nuevosIndicadores.euro,
          tendencia: calcularTendencia(nuevosIndicadores.euro),
        },
        uf: {
          ...nuevosIndicadores.uf,
          tendencia: calcularTendencia(nuevosIndicadores.uf),
        },
      };
    }
  } catch (err) {
    console.error("[FINANZAS] Error:", err.message);
  }

  try {
    const climaData = await getWeather();
    if (climaData) cachedClima = climaData;
  } catch (err) {
    console.error("[CLIMA] Error:", err.message);
  }

  try {
    const posts = await linkedinService.getCompanyPosts();
    if (posts && posts.length > 0) {
      cachedLinkedin = posts;
    }
  } catch (err) {
    console.error("[LINKEDIN] Error actualizando feed:", err.message);
  }
}

if (process.env.LINKEDIN_CLIENT_ID) {
  console.log(
    "[LINKEDIN] OAuth callback:",
    linkedinService.getRedirectUri(),
  );
}

updateDataBackground();
setInterval(updateDataBackground, 15 * 60 * 1000);

function mapNoticiaHomeRow(n) {
  return {
    id: n.id,
    type: "noticia",
    title: n.title ?? n.titulo,
    subtitle: n.subtitle ?? n.subtitulo,
    image: n.image ?? n.imagen,
    link: `/noticias/${n.id}`,
    fecha: (n.created_at ?? n.fecha_creacion)
      ? new Date(n.created_at ?? n.fecha_creacion)
      : new Date(),
    featured: Boolean(n.featured ?? n.destacada),
  };
}

async function fetchNoticiasHome() {
  let noticiaDestacada = null;

  try {
    const { rows } = await db.query(
      `SELECT id, title, image, subtitle, created_at, featured
       FROM news_articles
       WHERE featured = true
       ORDER BY created_at DESC
       LIMIT 1`,
    );
    if (rows[0]) {
      noticiaDestacada = mapNoticiaHomeRow(rows[0]);
    }
  } catch (err) {
    console.warn(
      "[HOME] Columna destacada no disponible en noticias;",
      err.message,
    );
  }

  let noticiasLista = [];
  try {
    const sql = noticiaDestacada
      ? `SELECT id, title, image, subtitle, created_at
         FROM news_articles
         WHERE id != $1
         ORDER BY created_at DESC
         LIMIT 8`
      : `SELECT id, title, image, subtitle, created_at
         FROM news_articles
         ORDER BY created_at DESC
         LIMIT 8`;
    const params = noticiaDestacada ? [noticiaDestacada.id] : [];
    const { rows } = await db.query(sql, params);
    noticiasLista = rows.map((n) => mapNoticiaHomeRow(n));
  } catch (err) {
    console.error("[HOME] Error cargando lista de noticias:", err.message);
  }

  const mixedFeed = noticiaDestacada
    ? [noticiaDestacada, ...noticiasLista]
    : noticiasLista;

  return { noticiaDestacada, noticiasLista, mixedFeed };
}

async function fetchEventosCarousel() {
  const cacheMs = 15 * 60 * 1000;
  if (Date.now() - cachedEventosCarouselAt < cacheMs) {
    return shuffleArray(cachedEventosPool).slice(0, 30);
  }

  try {
    const { rows: eventos } = await db.query(
      `SELECT name, slug
       FROM events
       ORDER BY created_at DESC
       LIMIT 10`,
    );

    const galerias = await Promise.all(
      eventos.map(async (evento) => {
        try {
          const archivos = await fileStorage.listFiles(`eventos/${evento.slug}`);
          return archivos
            .filter((item) => item.resource_type === "image")
            .map((item) => ({
              image: item.url,
              name: evento.name,
              slug: evento.slug,
              created_at: item.created_at,
            }));
        } catch (err) {
          console.warn(
            `[HOME] No se pudo leer galería de ${evento.slug}:`,
            err.message,
          );
          return [];
        }
      }),
    );

    cachedEventosPool = galerias
      .flat()
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    cachedEventosCarouselAt = Date.now();

    return shuffleArray(cachedEventosPool).slice(0, 30);
  } catch (err) {
    console.error("[HOME] Error cargando galería de eventos:", err.message);
    return shuffleArray(cachedEventosPool).slice(0, 30);
  }
}

// ==========================================
// RUTA: HOME
// ==========================================
router.get("/", async (req, res) => {
  if (!req.session.user) return res.redirect("/login");

  try {
    const dataFinanciera = cachedIndicadores;
    const dataClima = cachedClima;
    const dataLinkedin = cachedLinkedin;

    const hoy = new Date();
    const mes = hoy.getMonth() + 1;
    const diaHoy = hoy.getDate();
    const mesNombreRaw = new Intl.DateTimeFormat("es-CL", {
      month: "long",
    }).format(hoy);
    const mesNombre =
      mesNombreRaw.charAt(0).toUpperCase() + mesNombreRaw.slice(1);

    // FIX: LEFT JOIN en vez de INNER JOIN para no romper si area_trabajo_id es NULL
    const sqlMes = `
      SELECT
        TRIM(CONCAT(u.first_name, ' ', COALESCE(u.last_name, ''))) AS nombre,
        COALESCE(at.area_name, 'Sin área') AS area,
        u.photo,
        EXTRACT(DAY FROM u.birth_date) AS dia
      FROM users u
      LEFT JOIN work_areas at ON at.id = u.work_area_id
      WHERE u.birth_date IS NOT NULL
        AND EXTRACT(MONTH FROM u.birth_date) = $1
      ORDER BY dia ASC, nombre ASC
    `;
    const sqlEventosPortada = `SELECT name, slug, image FROM events WHERE image IS NOT NULL AND image != '' ORDER BY created_at DESC LIMIT 8`;

    const emptyNoticiasHome = {
      noticiaDestacada: null,
      noticiasLista: [],
      mixedFeed: [],
    };

    // FIX: .catch(() => []) en cada query para que un fallo aislado no rompa todo el home
    const [resultsMes, eventosRows, noticiasHome, eventosPortadas] =
      await Promise.all([
        db
          .query(sqlMes, [mes])
          .then((r) => r.rows)
          .catch(() => []),
        fetchEventosCarousel().catch(() => []),
        fetchNoticiasHome().catch(() => emptyNoticiasHome),
        db
          .query(sqlEventosPortada)
          .then((r) => r.rows)
          .catch(() => []),
      ]);

    const { noticiaDestacada, noticiasLista, mixedFeed } = noticiasHome;

    // ==========================================
    // LÓGICA DEL PLATO DEL DÍA
    // ==========================================
    const d = new Date();
    let diaActual = d.getDay();
    if (diaActual === 0 || diaActual === 6) diaActual = 1;

    // FIX: .catch para que si la tabla platos no existe no rompa el home
    const { rows: platosRows } = await db
      .query(
        "SELECT day_number, dish_name FROM lunch_menu ORDER BY day_number ASC",
      )
      .catch(() => ({ rows: [] }));

    const platoHoy = platosRows.find((p) => p.day_number === diaActual);
    const platoDelDia = platoHoy ? platoHoy.dish_name : "No definido";

    const diaManana = diaActual < 5 ? diaActual + 1 : null;
    const platoMananaRow = diaManana
      ? platosRows.find((p) => p.day_number === diaManana)
      : null;
    const platoManana = diaManana
      ? (platoMananaRow ? platoMananaRow.dish_name : "No definido")
      : null;

    res.render("home", {
      titulo: "Home | Intranet Transworld Chile",
      finanzas: dataFinanciera,
      clima: dataClima,
      mesNombre,
      diaHoy,
      cumpleaniosMes: resultsMes,
      eventosCarousel: eventosRows,
      eventosPortadas,
      mixedCarousel: mixedFeed,
      noticiaDestacada,
      noticiasLista,
      linkedinFeed: dataLinkedin,
      platoDelDia,
      platoManana,
      menuSemanal: platosRows,
      user: req.session.user,
      showHomeTutorial:
        req.session.user &&
        req.session.user.id > 0 &&
        req.session.user.show_home_tutorial === true,
    });
  } catch (err) {
    console.error("Error en Home:", err);
    res.status(500).send("Error cargando el inicio");
  }
});

// ==========================================
// TUTORIAL DE BIENVENIDA (PRIMER INICIO)
// ==========================================
router.post("/home/tutorial-visto", async (req, res) => {
  if (!req.session.user || !req.session.user.id) {
    return res.status(401).json({ ok: false });
  }

  const userId = req.session.user.id;
  if (userId <= 0) {
    req.session.user.show_home_tutorial = false;
    req.session.user.home_tutorial_seen = true;
    return res.json({ ok: true });
  }

  try {
    await db.query(
      `UPDATE users
       SET home_tutorial_seen = TRUE,
           last_login_at = COALESCE(last_login_at, NOW())
       WHERE id = $1`,
      [userId],
    );
    req.session.user.show_home_tutorial = false;
    req.session.user.home_tutorial_seen = true;
    return res.json({ ok: true });
  } catch (err) {
    if (err.code === "42703") {
      try {
        await db.query(
          "UPDATE users SET home_tutorial_seen = TRUE WHERE id = $1",
          [userId],
        );
      } catch (_) {
        /* columna aún no migrada */
      }
      req.session.user.show_home_tutorial = false;
      req.session.user.home_tutorial_seen = true;
      return res.json({ ok: true });
    }
    console.error("[HOME] Error marcando tutorial visto:", err.message);
    return res.status(500).json({ ok: false });
  }
});

// ==========================================
// GUARDAR MENÚ SEMANAL
// ==========================================
router.post("/platos/editar", async (req, res) => {
  if (!req.session.user || !isAdministrador(req.session.user.role))
    return res.status(403).send("No autorizado");

  const { plato_1, plato_2, plato_3, plato_4, plato_5 } = req.body;
  try {
    await db.query("UPDATE lunch_menu SET dish_name = $1 WHERE day_number = 1", [
      plato_1,
    ]);
    await db.query("UPDATE lunch_menu SET dish_name = $1 WHERE day_number = 2", [
      plato_2,
    ]);
    await db.query("UPDATE lunch_menu SET dish_name = $1 WHERE day_number = 3", [
      plato_3,
    ]);
    await db.query("UPDATE lunch_menu SET dish_name = $1 WHERE day_number = 4", [
      plato_4,
    ]);
    await db.query("UPDATE lunch_menu SET dish_name = $1 WHERE day_number = 5", [
      plato_5,
    ]);

    res.redirect("/?ok=MenuActualizado");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error actualizando el menú");
  }
});

// ==========================================
// RUTAS DE PERFIL
// ==========================================
router.get("/perfil", async (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  const id = req.session.user.id;
  const { rows } = await db.query(
    `SELECT u.*, at.area_name AS area
     FROM users u
     LEFT JOIN work_areas at ON at.id = u.work_area_id
     WHERE u.id = $1`,
    [id],
  );
  if (rows.length === 0) return res.redirect("/");
  const raw = rows[0];
  res.render("perfil", {
    titulo: "Mi Perfil",
    error: req.query.error || null,
    usuario: {
      ...raw,
      photo: raw.photo ?? raw.foto,
      role: normalizeRole(raw.role),
      birth_date_input: raw.birth_date
        ? new Date(raw.birth_date).toISOString().slice(0, 10)
        : "",
      phone: formatPhoneForDisplay(raw.phone) || raw.phone,
      telefonoHref: toTelHref(raw.phone),
    },
  });
});

router.post("/perfil", async (req, res) => {
  if (!req.session.user) return res.redirect("/login");

  const userId = req.session.user.id;
  const firstName = toTitleCase(req.body.first_name);
  const lastName = toTitleCase(req.body.last_name);
  const fechaNacimiento =
    String(req.body.birth_date || req.body.fecha_nacimiento || "").trim() || null;
  const telefonoCheck = validateChileMobilePhone(req.body.phone || req.body.telefono, {
    required: true,
  });

  if (!firstName || !lastName || !fechaNacimiento) {
    return res.redirect(
      `/perfil?error=${encodeURIComponent("Completa nombre, apellido y fecha de nacimiento.")}`,
    );
  }

  if (!telefonoCheck.valid) {
    return res.redirect(
      `/perfil?error=${encodeURIComponent(telefonoCheck.error)}`,
    );
  }

  try {
    await db.query(
      `UPDATE users
       SET first_name = $1,
           last_name = $2,
           birth_date = $3,
           phone = $4
       WHERE id = $5`,
      [
        firstName,
        lastName,
        fechaNacimiento,
        telefonoCheck.storageValue,
        userId,
      ],
    );

    req.session.user.first_name = firstName;
    req.session.user.last_name = lastName;
    req.session.user.telefono = telefonoCheck.storageValue;
    req.session.user.fecha_nacimiento = fechaNacimiento;

    res.redirect("/perfil?ok=Perfil+actualizado");
  } catch (err) {
    console.error("Error actualizando perfil:", err);
    res.redirect(
      `/perfil?error=${encodeURIComponent("No se pudo actualizar el perfil. Intenta nuevamente.")}`,
    );
  }
});

router.post("/perfil/foto", upload.single("foto_perfil"), async (req, res) => {
  if (!req.session.user || !req.file) return res.redirect("/perfil");
  try {
    const userId = req.session.user.id;
    const { rows } = await db.query("SELECT photo AS foto FROM users WHERE id = $1", [
      userId,
    ]);
    const previousUrl = rows[0]?.foto || null;
    const fotoUrl = await userPhotoStorage.saveUserPhotoReplacing(
      userId,
      req.file.buffer,
      previousUrl,
    );
    await db.query("UPDATE users SET photo = $1 WHERE id = $2", [
      fotoUrl,
      userId,
    ]);
    req.session.user.foto = fotoUrl;
    req.session.user.photo = fotoUrl;
    res.redirect("/perfil");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error");
  }
});

router.post("/perfil/foto/eliminar", async (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  try {
    const userId = req.session.user.id;
    const { rows } = await db.query("SELECT photo AS foto FROM users WHERE id = $1", [
      userId,
    ]);
    const previousUrl = rows[0]?.foto || null;
    await userPhotoStorage.removeUserPhoto(userId, previousUrl);
    await db.query("UPDATE users SET photo = NULL WHERE id = $1", [userId]);
    req.session.user.foto = null;
    req.session.user.photo = null;
    res.redirect("/perfil");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error");
  }
});

// ==========================================
// RUTA: CURSOS Y CAPACITACIONES
// ==========================================
router.get("/cursos", async (req, res) => {
  if (!req.session.user) return res.redirect("/login");

  try {
    res.render("cursos/index", {
      titulo: "Cursos | Transworld",
      user: req.session.user,
      active: "inicio",
    });
  } catch (err) {
    console.error("Error al cargar la página de cursos:", err);
    res.status(500).send("Error cargando los cursos");
  }
});

// ==========================================
// RUTA: EQUIPAMIENTO ACTIVO
// ==========================================
router.get("/cursos/equipamiento-activo", async (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  try {
    const { rows: progreso } = await db.query(
      "SELECT course_id AS curso_id, status AS estado_db, seconds_watched AS segundos_vistos FROM user_course_progress WHERE user_id = $1",
      [req.session.user.id],
    );
    const progresoMap = buildProgresoMap(progreso);

    const { rows: cursosRows } = await db.query(
      `${COURSE_LIST_BASE} WHERE c.section ILIKE '%Equipamiento%' AND c.is_active = true ORDER BY c.subsection ASC, c.title ASC`,
    );
    const cursosAgrupados = {};
    cursosRows.forEach((curso) => {
      const sub = curso.subseccion || "Otros";
      if (!cursosAgrupados[sub]) cursosAgrupados[sub] = [];
      cursosAgrupados[sub].push(curso);
    });

    const { rows: materiales } = await db.query(
      `SELECT ${MATERIAL_VIEW_COLUMNS} FROM study_materials WHERE section = 'Equipamiento Activo' ORDER BY created_at DESC`,
    );

    res.render("cursos/equipamiento-activo", {
      titulo: "Equipamiento Activo | Transworld",
      pageTitle: "Equipamiento activo",
      user: req.session.user,
      active: "equipamiento",
      progresoUsuario: progresoMap,
      cursosAgrupados,
      materiales,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error");
  }
});

// ==========================================
// RUTA: FIBRA ÓPTICA
// ==========================================
router.get("/cursos/fibra-optica", async (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  try {
    const { rows: progreso } = await db.query(
      "SELECT course_id AS curso_id, status AS estado_db, seconds_watched AS segundos_vistos FROM user_course_progress WHERE user_id = $1",
      [req.session.user.id],
    );
    const progresoMap = buildProgresoMap(progreso);

    const { rows: cursosRows } = await db.query(
      `${COURSE_LIST_BASE} WHERE c.section ILIKE '%Fibra%' AND c.is_active = true ORDER BY c.subsection ASC, c.title ASC`,
    );
    const cursosAgrupados = {};
    cursosRows.forEach((curso) => {
      const sub = curso.subseccion || "Otros";
      if (!cursosAgrupados[sub]) cursosAgrupados[sub] = [];
      cursosAgrupados[sub].push(curso);
    });

    const { rows: materiales } = await db.query(
      `SELECT ${MATERIAL_VIEW_COLUMNS} FROM study_materials WHERE section = 'Fibra Óptica' ORDER BY created_at DESC`,
    );

    res.render("cursos/fibra-optica", {
      titulo: "Fibra Óptica | Transworld",
      pageTitle: "Fibra Óptica",
      user: req.session.user,
      active: "fibra",
      progresoUsuario: progresoMap,
      cursosAgrupados,
      materiales,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error");
  }
});

// ==========================================
// RUTA: INFRAESTRUCTURA
// ==========================================
router.get("/cursos/infraestructura", async (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  try {
    const { rows: progreso } = await db.query(
      "SELECT course_id AS curso_id, status AS estado_db, seconds_watched AS segundos_vistos FROM user_course_progress WHERE user_id = $1",
      [req.session.user.id],
    );
    const progresoMap = buildProgresoMap(progreso);

    const { rows: cursosRows } = await db.query(
      `${COURSE_LIST_BASE} WHERE c.section ILIKE '%Infraestructura%' AND c.is_active = true ORDER BY c.subsection ASC, c.title ASC`,
    );
    const cursosAgrupados = {};
    cursosRows.forEach((curso) => {
      const sub = curso.subseccion || "Otros";
      if (!cursosAgrupados[sub]) cursosAgrupados[sub] = [];
      cursosAgrupados[sub].push(curso);
    });

    const { rows: materiales } = await db.query(
      `SELECT ${MATERIAL_VIEW_COLUMNS} FROM study_materials WHERE section = 'Infraestructura' ORDER BY created_at DESC`,
    );

    res.render("cursos/infraestructura", {
      titulo: "Infraestructura | Transworld",
      pageTitle: "Infraestructura",
      user: req.session.user,
      active: "infraestructura",
      progresoUsuario: progresoMap,
      cursosAgrupados,
      materiales,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error");
  }
});

// ==========================================
// RUTA: SAFETY MACHINE
// ==========================================
router.get("/cursos/safety-machine", async (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  try {
    const { rows: progreso } = await db.query(
      "SELECT course_id AS curso_id, status AS estado_db, seconds_watched AS segundos_vistos FROM user_course_progress WHERE user_id = $1",
      [req.session.user.id],
    );
    const progresoMap = buildProgresoMap(progreso);

    const { rows: cursosRows } = await db.query(
      `${COURSE_LIST_BASE} WHERE c.section ILIKE '%Seguridad%' AND c.is_active = true ORDER BY c.subsection ASC, c.title ASC`,
    );
    const cursosAgrupados = {};
    cursosRows.forEach((curso) => {
      const sub = curso.subseccion || "Otros";
      if (!cursosAgrupados[sub]) cursosAgrupados[sub] = [];
      cursosAgrupados[sub].push(curso);
    });

    const { rows: materiales } = await db.query(
      `SELECT ${MATERIAL_VIEW_COLUMNS} FROM study_materials WHERE section = 'Safety Machine' ORDER BY created_at DESC`,
    );

    res.render("cursos/safety-machine", {
      titulo: "Safety Machine | Transworld",
      pageTitle: "Safety Machine",
      user: req.session.user,
      active: "safety-machine",
      progresoUsuario: progresoMap,
      cursosAgrupados,
      materiales,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error");
  }
});

// ==========================================
// CRUD: MATERIAL DE ESTUDIO
// ==========================================

router.post(
  "/cursos/material/nuevo",
  requireRole.administrador(),
  upload.single("archivo"),
  async (req, res) => {
    const { nombre, seccion, return_url } = req.body;
    try {
      if (!req.file) return res.status(400).send("Debe adjuntar un archivo");

      const result = await fileStorage.saveFile(
        req.file.buffer,
        "material_estudio",
        req.file.originalname,
      );

      await db.query(
        "INSERT INTO study_materials (section, name, file_url, public_id, resource_type) VALUES ($1, $2, $3, $4, $5)",
        [
          seccion,
          nombre,
          result.secure_url,
          result.public_id,
          result.resource_type || "file",
        ],
      );
      res.redirect(return_url || "/cursos");
    } catch (err) {
      console.error("Error subiendo material:", err);
      res.status(500).send("Error interno");
    }
  },
);

router.post(
  "/cursos/material/editar/:id",
  requireRole.administrador(),
  upload.single("archivo"),
  async (req, res) => {
    const { id } = req.params;
    const { nombre, return_url } = req.body;
    try {
      if (req.file) {
        const { rows } = await db.query(
          "SELECT public_id FROM study_materials WHERE id = $1",
          [id],
        );
        if (rows.length > 0 && rows[0].public_id) {
          await fileStorage.deleteFile(rows[0].public_id);
        }

        const result = await fileStorage.saveFile(
          req.file.buffer,
          "material_estudio",
          req.file.originalname,
        );

        await db.query(
          "UPDATE study_materials SET name = $1, file_url = $2, public_id = $3, resource_type = $4 WHERE id = $5",
          [nombre, result.secure_url, result.public_id, "file", id],
        );
      } else {
        await db.query(
          "UPDATE study_materials SET name = $1 WHERE id = $2",
          [nombre, id],
        );
      }
      res.redirect(return_url || "/cursos");
    } catch (err) {
      console.error("Error editando material:", err);
      res.status(500).send("Error interno");
    }
  },
);

router.post(
  "/cursos/material/eliminar/:id",
  requireRole.administrador(),
  async (req, res) => {
    const { id } = req.params;
    const { return_url } = req.body;
    try {
      const { rows } = await db.query(
        "SELECT public_id FROM study_materials WHERE id = $1",
        [id],
      );
      if (rows.length > 0 && rows[0].public_id) {
        await fileStorage.deleteFile(rows[0].public_id);
      }
      await db.query("DELETE FROM study_materials WHERE id = $1", [id]);
      res.redirect(return_url || "/cursos");
    } catch (err) {
      console.error("Error eliminando material:", err);
      res.status(500).send("Error interno");
    }
  },
);

// ==========================================
// EDITAR SUBSECCIÓN Y SUBIR IMAGEN
// ==========================================
router.post(
  "/cursos/editar-subseccion",
  requireRole.administrador(),
  upload.single("imagen"),
  async (req, res) => {
    const { old_name, new_name, current_url, return_url } = req.body;
    const nombre_final = new_name || old_name;

    try {
      if (new_name && new_name !== old_name) {
        await db.query(
          "UPDATE courses SET subsection = $1 WHERE subsection = $2",
          [new_name, old_name],
        );
        await db.query(
          "UPDATE subsection_details SET name = $1 WHERE name = $2",
          [new_name, old_name],
        );
      }

      let imageUrl = current_url;
      if (req.file) {
        if (current_url && current_url.includes("/uploads/")) {
          try {
            const publicId = current_url.replace(/^\/uploads\//, "");
            await fileStorage.deleteFile(publicId);
          } catch (err) {
            console.error("Error al intentar borrar imagen antigua:", err);
          }
        }

        const result = await fileStorage.saveFile(
          req.file.buffer,
          "subsecciones_cursos",
          req.file.originalname,
        );
        imageUrl = result.secure_url;
      }

      await db.query(
        `INSERT INTO subsection_details (name, image_url) 
         VALUES ($1, $2)
         ON CONFLICT (name) 
         DO UPDATE SET image_url = EXCLUDED.image_url`,
        [nombre_final, imageUrl],
      );

      res.redirect(return_url || "/cursos");
    } catch (err) {
      console.error("Error editando subsección:", err);
      res.status(500).send("Error editando la subsección.");
    }
  },
);

// ==========================================
// RUTA: REPRODUCTOR DE CURSOS
// ==========================================
router.get("/cursos/reproductor/:id", async (req, res) => {
  if (!req.session.user) return res.redirect("/login");

  try {
    const cursoId = req.params.id;
    const usuarioId = req.session.user.id;

    const { rows: cursoRows } = await db.query(
      "SELECT * FROM courses WHERE id = $1",
      [cursoId],
    );
    if (cursoRows.length === 0)
      return res.status(404).send("Curso no encontrado");
    const cursoDb = mapCursoRow(cursoRows[0]);

    const { rows: progresoRows } = await db.query(
      "SELECT seconds_watched AS segundos_vistos FROM user_course_progress WHERE user_id = $1 AND course_id = $2",
      [usuarioId, cursoId],
    );
    const progresoGuardado =
      progresoRows.length > 0 ? progresoRows[0].segundos_vistos : 0;

    res.render("cursos/reproductor", {
      titulo: `${cursoDb.titulo} | Transworld`,
      pageTitle: "Reproductor de Curso",
      user: req.session.user,
      active: "equipamiento",
      curso: {
        id: cursoDb.id,
        titulo: cursoDb.titulo,
        descripcion: cursoDb.descripcion,
        youtubeId: cursoDb.video_url,
        tiempoRequerido: cursoDb.tiempo_requerido_segundos,
      },
      progresoGuardado,
    });
  } catch (err) {
    console.error("Error cargando reproductor:", err);
    res.status(500).send("Error interno del servidor");
  }
});

// ==========================================
// API: GUARDAR PROGRESO AUTOMÁTICAMENTE
// ==========================================
router.post("/cursos/api/progreso", async (req, res) => {
  if (!req.session.user)
    return res.status(401).json({ error: "No autorizado" });

  const { curso_id, segundos_vistos } = req.body;
  const usuario_id = req.session.user.id;

  try {
    const sql = `
      INSERT INTO user_course_progress (user_id, course_id, seconds_watched, status) 
      VALUES ($1, $2, $3, 'in_progress') 
      ON CONFLICT (user_id, course_id) 
      DO UPDATE SET 
        seconds_watched = GREATEST(user_course_progress.seconds_watched, EXCLUDED.seconds_watched),
        status = CASE WHEN user_course_progress.status = 'evaluated' THEN 'evaluated' ELSE 'in_progress' END
    `;
    await db.query(sql, [usuario_id, curso_id, segundos_vistos]);
    res.json({ success: true });
  } catch (err) {
    console.error("Error guardando progreso:", err);
    res.status(500).json({ error: "Error interno" });
  }
});

// ==========================================
// RUTA: MOSTRAR EVALUACIÓN
// ==========================================
router.get("/cursos/evaluacion/:id", async (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  const cursoId = req.params.id;
  const usuarioId = req.session.user.id;

  try {
    const { rows: cursoRows } = await db.query(
      "SELECT * FROM courses WHERE id = $1",
      [cursoId],
    );
    if (cursoRows.length === 0)
      return res.status(404).send("Curso no encontrado");

    const { rows: userProg } = await db.query(
      "SELECT status AS estado_db, score AS nota, attempts AS intentos FROM user_course_progress WHERE user_id = $1 AND course_id = $2",
      [usuarioId, cursoId],
    );
    const progreso = userProg.length > 0 ? userProg[0] : null;

    const yaEvaluado = progreso && courseStatusFromDb(progreso.estado_db) === "Evaluado";
    const notaGuardada = progreso ? progreso.nota : null;
    const intentosTotales = progreso ? progreso.intentos || 0 : 0;

    const { rows: preguntasRows } = await db.query(
      "SELECT id, question_text AS enunciado, sort_order AS orden FROM questions WHERE course_id = $1 ORDER BY sort_order ASC",
      [cursoId],
    );

    for (let p of preguntasRows) {
      const { rows: altRows } = await db.query(
        "SELECT id, text AS texto FROM question_options WHERE question_id = $1 ORDER BY id ASC",
        [p.id],
      );
      p.alternativas = altRows;
    }

    let correctasIds = [];
    if (yaEvaluado && notaGuardada >= 80) {
      const { rows: correctas } = await db.query(
        `SELECT a.id AS alternativa_id 
         FROM question_options a 
         JOIN questions p ON a.question_id = p.id 
         WHERE p.course_id = $1 AND a.is_correct = true`,
        [cursoId],
      );
      correctasIds = correctas.map((c) => c.alternativa_id);
    }

    res.render("cursos/evaluacion", {
      titulo: `Evaluación: ${mapCursoRow(cursoRows[0]).titulo} | Transworld`,
      pageTitle: "Evaluación de Curso",
      user: req.session.user,
      active: "equipamiento",
      curso: mapCursoRow(cursoRows[0]),
      preguntas: preguntasRows.map(mapPreguntaRow),
      yaEvaluado,
      notaGuardada,
      intentosTotales,
      correctasIds,
    });
  } catch (err) {
    console.error("Error cargando evaluación:", err);
    res.status(500).send("Error interno");
  }
});

// ==========================================
// RUTA: PROCESAR EVALUACIÓN
// ==========================================
router.post("/cursos/api/evaluacion/:id", async (req, res) => {
  if (!req.session.user)
    return res.status(401).json({ error: "No autorizado" });
  const cursoId = req.params.id;
  const usuarioId = req.session.user.id;
  const respuestasUsuario = req.body;

  try {
    const { rows: correctas } = await db.query(
      `SELECT a.question_id AS pregunta_id, a.id AS alternativa_id 
       FROM question_options a 
       JOIN questions p ON a.question_id = p.id 
       WHERE p.course_id = $1 AND a.is_correct = true`,
      [cursoId],
    );

    let buenas = 0;
    let total = correctas.length;
    let mapeoCorrectas = {};

    correctas.forEach((c) => {
      mapeoCorrectas[c.pregunta_id] = c.alternativa_id;
      if (respuestasUsuario[`preg_${c.pregunta_id}`] == c.alternativa_id) {
        buenas++;
      }
    });

    const porcentaje = Math.round((buenas / total) * 100);
    const mostrarFeedback = porcentaje >= 80;

    await db.query(
      `UPDATE user_course_progress 
       SET attempts = COALESCE(attempts, 0) + 1, 
           score = GREATEST(COALESCE(score, 0), $1), 
           status = 'evaluated', 
           seconds_watched = 0, 
           completed_at = COALESCE(completed_at, NOW())
       WHERE user_id = $2 AND course_id = $3`,
      [porcentaje, usuarioId, cursoId],
    );

    res.json({
      success: true,
      porcentaje,
      mostrarFeedback,
      respuestasCorrectas: mostrarFeedback ? mapeoCorrectas : null,
    });
  } catch (err) {
    console.error("Error procesando examen:", err);
    res.status(500).json({ error: "Error interno" });
  }
});

// ==========================================
// RUTA: REINTENTAR CURSO
// ==========================================
router.post("/cursos/api/reintentar/:id", async (req, res) => {
  if (!req.session.user)
    return res.status(401).json({ error: "No autorizado" });

  try {
    await db.query(
      `UPDATE user_course_progress 
       SET seconds_watched = 0, status = 'in_progress' 
       WHERE user_id = $1 AND course_id = $2`,
      [req.session.user.id, req.params.id],
    );
    res.json({ success: true });
  } catch (err) {
    console.error("Error reiniciando curso:", err);
    res.status(500).json({ error: "Error interno" });
  }
});

// ==========================================
// RUTA: DASHBOARD KPI DE CURSOS
// ==========================================
router.get("/kpi-cursos", async (req, res) => {
  try {
    const queryRanking = `
      SELECT 
        u.id AS usuario_id,
        u.first_name || ' ' || COALESCE(u.last_name, '') AS nombre_usuario,
        SUM(cu.score) AS puntaje_total,
        COUNT(cu.course_id) AS cursos_completados
      FROM user_course_progress cu
      JOIN users u ON cu.user_id = u.id
      WHERE cu.status = 'evaluated'
      GROUP BY u.id, u.first_name, u.last_name
      ORDER BY puntaje_total DESC, cursos_completados DESC
    `;
    const { rows: todosLosRanking } = await db.query(queryRanking);
    const top10Ranking = todosLosRanking.slice(0, 10);

    const queryCursos = `SELECT id, title AS titulo, section AS seccion, subsection AS subseccion FROM courses WHERE is_active = true`;
    const { rows: cursos } = await db.query(queryCursos);

    const kpiPorCursoPromises = cursos.map(async (curso) => {
      const queryNotasCurso = `
        SELECT 
          u.first_name || ' ' || COALESCE(u.last_name, '') AS nombre_usuario,
          cu.score AS nota
        FROM user_course_progress cu
        JOIN users u ON cu.user_id = u.id
        WHERE cu.course_id = $1 AND cu.score IS NOT NULL AND cu.score > 0
        ORDER BY cu.score DESC
        LIMIT 10
      `;
      const { rows: notasCurso } = await db.query(queryNotasCurso, [curso.id]);

      if (notasCurso.length > 0) {
        return {
          curso_titulo: curso.titulo,
          seccion: curso.seccion,
          subseccion: curso.subseccion,
          top10: notasCurso,
        };
      }
      return null;
    });

    const resultadosBrutos = await Promise.all(kpiPorCursoPromises);
    const kpiPorCurso = resultadosBrutos.filter((kpi) => kpi !== null);

    res.render("kpi-cursos", {
      titulo: "KPI Cursos | Transworld",
      pageTitle: "Dashboard de Capacitaciones",
      user: req.session.user,
      active: "inicio",
      todosLosRanking,
      top10Ranking,
      kpiPorCurso,
    });
  } catch (err) {
    console.error("Error cargando Dashboard KPI Cursos:", err);
    res.status(500).send("Error interno cargando los indicadores.");
  }
});

// ==========================================
// APLICACIONES
// ==========================================
router.get("/apps", requireRole.intranetActivo(), async (req, res) => {
    try {
      const { rows } = await db.query(
        "SELECT * FROM applications ORDER BY created_at DESC",
      );
      res.render("ver-apps", {
        titulo: "Aplicaciones | Transworld",
        apps: rows.map((app) => ({
          ...app,
          nombre: app.name ?? app.nombre,
          descripcion: app.description ?? app.descripcion,
          fecha_creacion: app.created_at ?? app.fecha_creacion,
          ultima_actualizacion: app.updated_at ?? app.ultima_actualizacion,
          cambios: app.changelog ?? app.cambios,
          notificado: app.notified ?? app.notificado,
        })),
        user: req.session.user,
        ok: req.query.ok,
      });
    } catch (err) {
      console.error("Error al cargar aplicaciones:", err);
      res.status(500).send("Error interno del servidor.");
    }
  },
);

const uploadFileLocally = async (buffer, folder, fileName) => {
  return fileStorage.saveFile(buffer, folder, fileName);
};

const appUploads = upload.fields([
  { name: "qr_apk", maxCount: 1 },
  { name: "qr_ios", maxCount: 1 },
]);

router.post(
  "/apps/nueva",
  requireRole.administrador(),
  appUploads,
  async (req, res) => {
    const { nombre, descripcion, url_pc, url_apk } = req.body;
    let qr_apk_url = null;
    let qr_ios_url = null;

    try {
      if (req.files && req.files["qr_apk"]) {
        const result = await uploadFileLocally(
          req.files["qr_apk"][0].buffer,
          "apps_qr",
          req.files["qr_apk"][0].originalname,
        );
        qr_apk_url = result.secure_url;
      }
      if (req.files && req.files["qr_ios"]) {
        const result = await uploadFileLocally(
          req.files["qr_ios"][0].buffer,
          "apps_qr",
          req.files["qr_ios"][0].originalname,
        );
        qr_ios_url = result.secure_url;
      }

      await db.query(
        `INSERT INTO applications (name, description, url_pc, url_apk, qr_apk, qr_ios) 
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          nombre,
          descripcion,
          url_pc || null,
          url_apk || null,
          qr_apk_url,
          qr_ios_url,
        ],
      );

      res.redirect("/apps?ok=Aplicación+registrada+correctamente");
    } catch (err) {
      console.error("Error al guardar aplicación:", err);
      res.status(500).send("Error al guardar en la base de datos.");
    }
  },
);

router.post(
  "/apps/editar/:id",
  requireRole.administrador(),
  appUploads,
  async (req, res) => {
    const { id } = req.params;
    const { nombre, descripcion, url_pc, url_apk } = req.body;

    try {
      let updateQuery = `UPDATE applications SET name = $1, description = $2, url_pc = $3, url_apk = $4, updated_at = NOW(), notified = false`;
      let queryParams = [nombre, descripcion, url_pc || null, url_apk || null];
      let paramIndex = 5;

      if (req.files && req.files["qr_apk"]) {
        const result = await uploadFileLocally(
          req.files["qr_apk"][0].buffer,
          "apps_qr",
          req.files["qr_apk"][0].originalname,
        );
        updateQuery += `, qr_apk = $${paramIndex}`;
        queryParams.push(result.secure_url);
        paramIndex++;
      }
      if (req.files && req.files["qr_ios"]) {
        const result = await uploadFileLocally(
          req.files["qr_ios"][0].buffer,
          "apps_qr",
          req.files["qr_ios"][0].originalname,
        );
        updateQuery += `, qr_ios = $${paramIndex}`;
        queryParams.push(result.secure_url);
        paramIndex++;
      }

      updateQuery += ` WHERE id = $${paramIndex}`;
      queryParams.push(id);

      await db.query(updateQuery, queryParams);
      res.redirect("/apps?ok=Aplicación+actualizada+correctamente");
    } catch (err) {
      console.error("Error al editar aplicación:", err);
      res.status(500).send("Error al actualizar la base de datos.");
    }
  },
);

router.post(
  "/apps/eliminar/:id",
  requireRole.administrador(),
  async (req, res) => {
    const { id } = req.params;
    try {
      await db.query("DELETE FROM applications WHERE id = $1", [id]);
      res.redirect("/apps?ok=Aplicación+eliminada+con+éxito");
    } catch (err) {
      console.error("Error al eliminar aplicación:", err);
      res.status(500).send("Error al eliminar la aplicación.");
    }
  },
);

// ==========================================
// LINKEDIN
// ==========================================
router.get("/auth/linkedin/renovar", (req, res) => {
  res.redirect(linkedinService.getAuthorizationUrl(req));
});

// ==========================================
// NOTIFICACIÓN DE APP
// ==========================================
router.post("/apps/notificar/:id", requireRole.administrador(), async (req, res) => {
  const { id } = req.params;
  const { cambios_texto } = req.body;

  try {
    const { rows: appRows } = await db.query(
      "UPDATE applications SET changelog = $1, notified = true WHERE id = $2 RETURNING name AS nombre",
      [cambios_texto, id],
    );

    if (appRows.length === 0) return res.status(404).send("App no encontrada");
    const nombreApp = appRows[0].nombre;

    const { rows: usuarios } = await db.query(
      `SELECT email FROM users
       WHERE role IN ($1, $2) AND email IS NOT NULL AND TRIM(email) <> ''`,
      [ROLES.USUARIO, ROLES.ADMINISTRADOR],
    );
    const listaCorreos = usuarios.map((u) => u.email);

    if (listaCorreos.length > 0) {
      const htmlCorreo = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden;">
          <div style="background-color: #003a70; padding: 20px; text-align: center;">
            <h2 style="color: white; margin: 0;">Actualización de Aplicación</h2>
          </div>
          <div style="padding: 25px; background-color: #ffffff;">
            <h3 style="color: #003a70; margin-top: 0;">${nombreApp}</h3>
            <p style="color: #64748b; font-size: 0.9rem; margin-bottom: 20px;">Se han realizado cambios importantes en esta herramienta:</p>
            <div style="background-color: #f1f5f9; padding: 15px; border-left: 4px solid #003a70; color: #334155; font-size: 15px; line-height: 1.6;">
              ${cambios_texto.replace(/\n/g, "<br>")}
            </div>
            <div style="text-align: center; margin-top: 35px; margin-bottom: 10px;">
              <a href="${process.env.APP_BASE_URL || "http://localhost:3000"}/apps" 
                 style="display: inline-block; background-color: #ffffff; color: #003a70; border: 3px solid #003a70; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px;">
                Ir a Descargas
              </a>
            </div>
          </div>
        </div>
      `;

      await sendMail({
        to: process.env.MAIL_FROM || "noreply@transworld.cl",
        bcc: listaCorreos,
        subject: `Actualización: ${nombreApp}`,
        html: htmlCorreo,
      });
    }

    res.redirect("/apps?ok=Notificación+enviada+con+éxito");
  } catch (err) {
    console.error("Error al notificar app:", err);
    res.status(500).send("Error al enviar la notificación.");
  }
});

module.exports = router;

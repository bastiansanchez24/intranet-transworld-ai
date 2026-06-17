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
const { toTelHref, formatPhoneForDisplay } = require("../utils/phoneChile");
const { sendMail } = require("../services/mailer");

const storage = multer.memoryStorage();
const upload = multer({ storage });

// ==========================================
// SISTEMA DE CACHÉ
// ==========================================
let cachedIndicadores = {
  dolar: { valor: null, tendencia: "igual" },
  euro: { valor: null, tendencia: "igual" },
  uf: { valor: null, tendencia: "igual" },
};
let cachedClima = { temp: "--", icon: "⏳", desc: "Cargando...", sunset: null, manana: null };
let cachedLinkedin = [];

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

updateDataBackground();
setInterval(updateDataBackground, 15 * 60 * 1000);

function mapNoticiaHomeRow(n) {
  return {
    id: n.id,
    type: "noticia",
    titulo: n.titulo,
    subtitulo: n.subtitulo,
    imagen: n.imagen,
    link: `/noticias/${n.id}`,
    fecha: n.fecha_creacion ? new Date(n.fecha_creacion) : new Date(),
    destacada: Boolean(n.destacada),
  };
}

async function fetchNoticiasHome() {
  let noticiaDestacada = null;

  try {
    const { rows } = await db.query(
      `SELECT id, titulo, imagen, subtitulo, fecha_creacion, destacada
       FROM noticias
       WHERE destacada = true
       ORDER BY fecha_creacion DESC
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
      ? `SELECT id, titulo, imagen, subtitulo, fecha_creacion
         FROM noticias
         WHERE id != $1
         ORDER BY fecha_creacion DESC
         LIMIT 8`
      : `SELECT id, titulo, imagen, subtitulo, fecha_creacion
         FROM noticias
         ORDER BY fecha_creacion DESC
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
        COALESCE(at.nombre_area, 'Sin área') AS area,
        u.foto,
        EXTRACT(DAY FROM u.fecha_nacimiento) AS dia
      FROM users u
      LEFT JOIN area_trabajo at ON at.id = u.area_trabajo_id
      WHERE u.fecha_nacimiento IS NOT NULL
        AND EXTRACT(MONTH FROM u.fecha_nacimiento) = $1
      ORDER BY dia ASC, nombre ASC
    `;
    const sqlEventos = `SELECT ef.url as imagen, e.nombre FROM eventos_fotos ef JOIN eventos e ON ef.evento_id = e.id ORDER BY RANDOM() LIMIT 30`;
    const sqlEventosPortada = `SELECT nombre, slug, imagen FROM eventos WHERE imagen IS NOT NULL AND imagen != '' ORDER BY fecha_creacion DESC LIMIT 8`;

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
        db
          .query(sqlEventos)
          .then((r) => r.rows)
          .catch(() => []),
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
        "SELECT dia_numero, nombre_plato FROM platos ORDER BY dia_numero ASC",
      )
      .catch(() => ({ rows: [] }));

    const platoHoy = platosRows.find((p) => p.dia_numero === diaActual);
    const platoDelDia = platoHoy ? platoHoy.nombre_plato : "No definido";

    const diaManana = diaActual < 5 ? diaActual + 1 : null;
    const platoMananaRow = diaManana
      ? platosRows.find((p) => p.dia_numero === diaManana)
      : null;
    const platoManana = diaManana
      ? (platoMananaRow ? platoMananaRow.nombre_plato : "No definido")
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
    });
  } catch (err) {
    console.error("Error en Home:", err);
    res.status(500).send("Error cargando el inicio");
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
    await db.query("UPDATE platos SET nombre_plato = $1 WHERE dia_numero = 1", [
      plato_1,
    ]);
    await db.query("UPDATE platos SET nombre_plato = $1 WHERE dia_numero = 2", [
      plato_2,
    ]);
    await db.query("UPDATE platos SET nombre_plato = $1 WHERE dia_numero = 3", [
      plato_3,
    ]);
    await db.query("UPDATE platos SET nombre_plato = $1 WHERE dia_numero = 4", [
      plato_4,
    ]);
    await db.query("UPDATE platos SET nombre_plato = $1 WHERE dia_numero = 5", [
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
    `SELECT u.*, at.nombre_area AS area
     FROM users u
     LEFT JOIN area_trabajo at ON at.id = u.area_trabajo_id
     WHERE u.id = $1`,
    [id],
  );
  if (rows.length === 0) return res.redirect("/");
  const raw = rows[0];
  res.render("perfil", {
    titulo: "Mi Perfil",
    usuario: {
      ...raw,
      role: normalizeRole(raw.role),
      telefono: formatPhoneForDisplay(raw.telefono) || raw.telefono,
      telefonoHref: toTelHref(raw.telefono),
    },
  });
});

router.post("/perfil/foto", upload.single("foto_perfil"), async (req, res) => {
  if (!req.session.user || !req.file) return res.redirect("/perfil");
  try {
    const userId = req.session.user.id;
    const { rows } = await db.query("SELECT foto FROM users WHERE id = $1", [
      userId,
    ]);
    const previousUrl = rows[0]?.foto || null;
    const fotoUrl = await userPhotoStorage.saveUserPhotoReplacing(
      userId,
      req.file.buffer,
      previousUrl,
    );
    await db.query("UPDATE users SET foto = $1 WHERE id = $2", [
      fotoUrl,
      userId,
    ]);
    req.session.user.foto = fotoUrl;
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
    const { rows } = await db.query("SELECT foto FROM users WHERE id = $1", [
      userId,
    ]);
    const previousUrl = rows[0]?.foto || null;
    await userPhotoStorage.removeUserPhoto(userId, previousUrl);
    await db.query("UPDATE users SET foto = NULL WHERE id = $1", [userId]);
    req.session.user.foto = null;
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
      "SELECT curso_id, estado, segundos_vistos FROM capacitaciones_usuarios WHERE usuario_id = $1",
      [req.session.user.id],
    );
    const progresoMap = {};
    progreso.forEach((p) => {
      progresoMap[p.curso_id] = p;
    });

    const { rows: cursosRows } = await db.query(
      "SELECT c.id, c.titulo, c.subseccion, sd.imagen_url FROM cursos c LEFT JOIN subsecciones_detalles sd ON c.subseccion = sd.nombre WHERE c.seccion ILIKE '%Equipamiento%' AND c.activo = true ORDER BY c.subseccion ASC, c.titulo ASC",
    );
    const cursosAgrupados = {};
    cursosRows.forEach((curso) => {
      const sub = curso.subseccion || "Otros";
      if (!cursosAgrupados[sub]) cursosAgrupados[sub] = [];
      cursosAgrupados[sub].push(curso);
    });

    const { rows: materiales } = await db.query(
      "SELECT * FROM material_estudio WHERE seccion = 'Equipamiento Activo' ORDER BY fecha_creacion DESC",
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
      "SELECT curso_id, estado, segundos_vistos FROM capacitaciones_usuarios WHERE usuario_id = $1",
      [req.session.user.id],
    );
    const progresoMap = {};
    progreso.forEach((p) => {
      progresoMap[p.curso_id] = p;
    });

    const { rows: cursosRows } = await db.query(
      "SELECT c.id, c.titulo, c.subseccion, sd.imagen_url FROM cursos c LEFT JOIN subsecciones_detalles sd ON c.subseccion = sd.nombre WHERE c.seccion ILIKE '%Fibra%' AND c.activo = true ORDER BY c.subseccion ASC, c.titulo ASC",
    );
    const cursosAgrupados = {};
    cursosRows.forEach((curso) => {
      const sub = curso.subseccion || "Otros";
      if (!cursosAgrupados[sub]) cursosAgrupados[sub] = [];
      cursosAgrupados[sub].push(curso);
    });

    const { rows: materiales } = await db.query(
      "SELECT * FROM material_estudio WHERE seccion = 'Fibra Óptica' ORDER BY fecha_creacion DESC",
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
      "SELECT curso_id, estado, segundos_vistos FROM capacitaciones_usuarios WHERE usuario_id = $1",
      [req.session.user.id],
    );
    const progresoMap = {};
    progreso.forEach((p) => {
      progresoMap[p.curso_id] = p;
    });

    const { rows: cursosRows } = await db.query(
      "SELECT c.id, c.titulo, c.subseccion, sd.imagen_url FROM cursos c LEFT JOIN subsecciones_detalles sd ON c.subseccion = sd.nombre WHERE c.seccion ILIKE '%Infraestructura%' AND c.activo = true ORDER BY c.subseccion ASC, c.titulo ASC",
    );
    const cursosAgrupados = {};
    cursosRows.forEach((curso) => {
      const sub = curso.subseccion || "Otros";
      if (!cursosAgrupados[sub]) cursosAgrupados[sub] = [];
      cursosAgrupados[sub].push(curso);
    });

    const { rows: materiales } = await db.query(
      "SELECT * FROM material_estudio WHERE seccion = 'Infraestructura' ORDER BY fecha_creacion DESC",
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
      "SELECT curso_id, estado, segundos_vistos FROM capacitaciones_usuarios WHERE usuario_id = $1",
      [req.session.user.id],
    );
    const progresoMap = {};
    progreso.forEach((p) => {
      progresoMap[p.curso_id] = p;
    });

    const { rows: cursosRows } = await db.query(
      "SELECT c.id, c.titulo, c.subseccion, sd.imagen_url FROM cursos c LEFT JOIN subsecciones_detalles sd ON c.subseccion = sd.nombre WHERE c.seccion ILIKE '%Seguridad%' AND c.activo = true ORDER BY c.subseccion ASC, c.titulo ASC",
    );
    const cursosAgrupados = {};
    cursosRows.forEach((curso) => {
      const sub = curso.subseccion || "Otros";
      if (!cursosAgrupados[sub]) cursosAgrupados[sub] = [];
      cursosAgrupados[sub].push(curso);
    });

    const { rows: materiales } = await db.query(
      "SELECT * FROM material_estudio WHERE seccion = 'Safety Machine' ORDER BY fecha_creacion DESC",
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
        "INSERT INTO material_estudio (seccion, nombre, archivo_url, public_id, tipo_recurso) VALUES ($1, $2, $3, $4, $5)",
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
          "SELECT public_id FROM material_estudio WHERE id = $1",
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
          "UPDATE material_estudio SET nombre = $1, archivo_url = $2, public_id = $3, tipo_recurso = $4 WHERE id = $5",
          [nombre, result.secure_url, result.public_id, "file", id],
        );
      } else {
        await db.query(
          "UPDATE material_estudio SET nombre = $1 WHERE id = $2",
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
        "SELECT public_id FROM material_estudio WHERE id = $1",
        [id],
      );
      if (rows.length > 0 && rows[0].public_id) {
        await fileStorage.deleteFile(rows[0].public_id);
      }
      await db.query("DELETE FROM material_estudio WHERE id = $1", [id]);
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
          "UPDATE cursos SET subseccion = $1 WHERE subseccion = $2",
          [new_name, old_name],
        );
        await db.query(
          "UPDATE subsecciones_detalles SET nombre = $1 WHERE nombre = $2",
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
        `INSERT INTO subsecciones_detalles (nombre, imagen_url) 
         VALUES ($1, $2)
         ON CONFLICT (nombre) 
         DO UPDATE SET imagen_url = EXCLUDED.imagen_url`,
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
      "SELECT * FROM cursos WHERE id = $1",
      [cursoId],
    );
    if (cursoRows.length === 0)
      return res.status(404).send("Curso no encontrado");
    const cursoDb = cursoRows[0];

    const { rows: progresoRows } = await db.query(
      "SELECT segundos_vistos FROM capacitaciones_usuarios WHERE usuario_id = $1 AND curso_id = $2",
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
      INSERT INTO capacitaciones_usuarios (usuario_id, curso_id, segundos_vistos, estado) 
      VALUES ($1, $2, $3, 'En curso') 
      ON CONFLICT (usuario_id, curso_id) 
      DO UPDATE SET 
        segundos_vistos = GREATEST(capacitaciones_usuarios.segundos_vistos, EXCLUDED.segundos_vistos),
        estado = CASE WHEN capacitaciones_usuarios.estado = 'Evaluado' THEN 'Evaluado' ELSE 'En curso' END
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
      "SELECT * FROM cursos WHERE id = $1",
      [cursoId],
    );
    if (cursoRows.length === 0)
      return res.status(404).send("Curso no encontrado");

    const { rows: userProg } = await db.query(
      "SELECT estado, nota, intentos FROM capacitaciones_usuarios WHERE usuario_id = $1 AND curso_id = $2",
      [usuarioId, cursoId],
    );
    const progreso = userProg.length > 0 ? userProg[0] : null;

    const yaEvaluado = progreso && progreso.estado === "Evaluado";
    const notaGuardada = progreso ? progreso.nota : null;
    const intentosTotales = progreso ? progreso.intentos || 0 : 0;

    const { rows: preguntasRows } = await db.query(
      "SELECT * FROM preguntas WHERE curso_id = $1 ORDER BY orden ASC",
      [cursoId],
    );

    for (let p of preguntasRows) {
      const { rows: altRows } = await db.query(
        "SELECT id, texto FROM alternativas WHERE pregunta_id = $1 ORDER BY id ASC",
        [p.id],
      );
      p.alternativas = altRows;
    }

    let correctasIds = [];
    if (yaEvaluado && notaGuardada >= 80) {
      const { rows: correctas } = await db.query(
        `SELECT a.id AS alternativa_id 
         FROM alternativas a 
         JOIN preguntas p ON a.pregunta_id = p.id 
         WHERE p.curso_id = $1 AND a.es_correcta = true`,
        [cursoId],
      );
      correctasIds = correctas.map((c) => c.alternativa_id);
    }

    res.render("cursos/evaluacion", {
      titulo: `Evaluación: ${cursoRows[0].titulo} | Transworld`,
      pageTitle: "Evaluación de Curso",
      user: req.session.user,
      active: "equipamiento",
      curso: cursoRows[0],
      preguntas: preguntasRows,
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
      `SELECT a.pregunta_id, a.id AS alternativa_id 
       FROM alternativas a 
       JOIN preguntas p ON a.pregunta_id = p.id 
       WHERE p.curso_id = $1 AND a.es_correcta = true`,
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
      `UPDATE capacitaciones_usuarios 
       SET intentos = COALESCE(intentos, 0) + 1, 
           nota = GREATEST(COALESCE(nota, 0), $1), 
           estado = 'Evaluado', 
           segundos_vistos = 0, 
           fecha_completado = COALESCE(fecha_completado, NOW())
       WHERE usuario_id = $2 AND curso_id = $3`,
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
      `UPDATE capacitaciones_usuarios 
       SET segundos_vistos = 0, estado = 'En curso' 
       WHERE usuario_id = $1 AND curso_id = $2`,
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
        SUM(cu.nota) AS puntaje_total,
        COUNT(cu.curso_id) AS cursos_completados
      FROM capacitaciones_usuarios cu
      JOIN users u ON cu.usuario_id = u.id
      WHERE cu.estado = 'Evaluado'
      GROUP BY u.id, u.first_name, u.last_name
      ORDER BY puntaje_total DESC, cursos_completados DESC
    `;
    const { rows: todosLosRanking } = await db.query(queryRanking);
    const top10Ranking = todosLosRanking.slice(0, 10);

    const queryCursos = `SELECT id, titulo, seccion, subseccion FROM cursos WHERE activo = true`;
    const { rows: cursos } = await db.query(queryCursos);

    const kpiPorCursoPromises = cursos.map(async (curso) => {
      const queryNotasCurso = `
        SELECT 
          u.first_name || ' ' || COALESCE(u.last_name, '') AS nombre_usuario,
          cu.nota
        FROM capacitaciones_usuarios cu
        JOIN users u ON cu.usuario_id = u.id
        WHERE cu.curso_id = $1 AND cu.nota IS NOT NULL AND cu.nota > 0
        ORDER BY cu.nota DESC
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
        "SELECT * FROM aplicaciones ORDER BY fecha_creacion DESC",
      );
      res.render("ver-apps", {
        titulo: "Aplicaciones | Transworld",
        apps: rows,
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
        `INSERT INTO aplicaciones (nombre, descripcion, url_pc, url_apk, qr_apk, qr_ios) 
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
      let updateQuery = `UPDATE aplicaciones SET nombre = $1, descripcion = $2, url_pc = $3, url_apk = $4, ultima_actualizacion = NOW(), notificado = false`;
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
      await db.query("DELETE FROM aplicaciones WHERE id = $1", [id]);
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
  const urlLogin = linkedinService.getAuthorizationUrl();
  res.redirect(urlLogin);
});

router.get("/auth/linkedin/callback", async (req, res) => {
  const code = req.query.code;
  if (code) {
    try {
      await linkedinService.exchangeCodeForToken(code);
      res.send(
        "Token de LinkedIn renovado y guardado en la BD con éxito. Ya puede volver a la Intranet.",
      );
    } catch (error) {
      res.status(500).send("Error al canjear el código. Revise la consola.");
    }
  } else {
    res.send("No se recibió ningún código de LinkedIn.");
  }
});

// ==========================================
// NOTIFICACIÓN DE APP
// ==========================================
router.post("/apps/notificar/:id", requireRole.administrador(), async (req, res) => {
  const { id } = req.params;
  const { cambios_texto } = req.body;

  try {
    const { rows: appRows } = await db.query(
      "UPDATE aplicaciones SET cambios = $1, notificado = true WHERE id = $2 RETURNING nombre",
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

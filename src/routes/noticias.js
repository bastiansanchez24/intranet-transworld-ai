const express = require('express');
const router = express.Router();
const db = require('../db'); 
const fileStorage = require('../services/fileStorage');
const requireRole = require('../middlewares/requireRole');
const { isAdministrador } = require('../constants/roles');
const multer = require('multer');
const { sendMail } = require('../services/mailer');
const { NOTICIA_VIEW_COLUMNS } = require('../utils/schemaMappers');

const storage = multer.memoryStorage();
const upload = multer({ storage });

const ROLES_CREAR = ['admin'];
const ROLES_ELIMINAR = ['admin']; 

async function setNoticiaDestacada(noticiaId, destacada) {
  const isDestacada =
    destacada === true ||
    destacada === "1" ||
    destacada === "true" ||
    destacada === "on";
  if (isDestacada) {
    await db.query("UPDATE news_articles SET featured = false WHERE id != $1", [
      noticiaId,
    ]);
    await db.query("UPDATE news_articles SET featured = true WHERE id = $1", [
      noticiaId,
    ]);
  } else {
    await db.query("UPDATE news_articles SET featured = false WHERE id = $1", [
      noticiaId,
    ]);
  }
}

function createSlug(text) {
  return text.toString().toLowerCase().trim()
    .replace(/\s+/g, '-')           
    .replace(/[^\w\-]+/g, '')       
    .replace(/\-\-+/g, '-')         
    + '-' + Date.now().toString().slice(-4); 
}

function buildNoticiaEmailHtml(noticia) {
  const baseUrl = process.env.APP_BASE_URL || 'https://intranet.transworld.cl';

  // Los archivos se guardan con rutas relativas (/content/...). En un correo
  // deben ser absolutas para que el cliente de correo las pueda cargar.
  const toAbsolute = (url) => {
    if (!url) return '';
    if (/^https?:\/\//i.test(url)) return url;
    return `${baseUrl}${url.startsWith('/') ? '' : '/'}${url}`;
  };

  let adjuntosCorreo = [];
  try {
    if (noticia.attachments) {
      adjuntosCorreo =
        typeof noticia.attachments === 'string'
          ? JSON.parse(noticia.attachments)
          : noticia.attachments;
    }
  } catch (e) {}

  const imagenesCorreo = adjuntosCorreo.filter(
    (a) => a.tipo === 'image' || (a.resource_type === 'image' && a.tipo !== 'video' && a.tipo !== 'document'),
  );

  const documentosCorreo = adjuntosCorreo.filter(
    (a) => a.tipo === 'document' || (a.resource_type === 'raw' && a.tipo !== 'image' && a.tipo !== 'video'),
  );

  const galeriaHtml =
    imagenesCorreo.length > 0
      ? `<tr><td style="padding: 0 32px 8px 32px;">
           <p style="color:#003a70; font-weight:700; font-size:14px; text-transform:uppercase; letter-spacing:0.5px; margin:24px 0 12px 0;">Imágenes adjuntas</p>
           <div style="text-align: left; font-size:0;">
             ${imagenesCorreo
               .map(
                 (img) =>
                   `<a href="${toAbsolute(img.url)}" target="_blank" style="display:inline-block; margin:0 8px 8px 0; vertical-align: top;"><img src="${toAbsolute(img.url)}" alt="${img.nombre || 'Imagen'}" width="72" style="width:72px; height:72px; object-fit:cover; border-radius:8px; border:1px solid #e2e8f0; display:block;"></a>`,
               )
               .join('')}
           </div>
         </td></tr>`
      : '';

  const documentosHtml =
    documentosCorreo.length > 0
      ? `<tr><td style="padding: 0 32px 8px 32px;">
           <p style="color:#003a70; font-weight:700; font-size:14px; text-transform:uppercase; letter-spacing:0.5px; margin:24px 0 12px 0;">Documentos adjuntos</p>
           ${documentosCorreo
             .map(
               (doc) =>
                 `<a href="${toAbsolute(doc.url)}" target="_blank" style="display:block; margin:0 0 8px 0; padding:12px 16px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; text-decoration:none; color:#003a70; font-weight:600; font-size:14px;">${doc.nombre || 'Documento'}</a>`,
             )
             .join('')}
         </td></tr>`
      : '';

  const subtituloHtml = noticia.subtitle
    ? `<tr><td style="padding: 0 32px;">
         <p style="color:#475569; font-size:17px; font-weight:500; line-height:1.5; margin:0 0 4px 0;">${noticia.subtitle}</p>
       </td></tr>`
    : '';

  return `
    <div style="background-color:#eef2f7; padding:32px 16px; font-family: Arial, Helvetica, sans-serif;">
      <table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px; width:100%; margin:0 auto; background-color:#ffffff; border-radius:12px; overflow:hidden; box-shadow:0 4px 16px rgba(0,58,112,0.08);">
        <!-- Encabezado -->
        <tr>
          <td style="background-color:#003a70; padding:28px 32px;">
            <p style="color:#9cc3ee; font-size:12px; font-weight:700; letter-spacing:1.5px; text-transform:uppercase; margin:0 0 6px 0;">Intranet Transworld</p>
            <h1 style="color:#ffffff; font-size:20px; font-weight:800; margin:0;">Nueva noticia publicada</h1>
          </td>
        </tr>

        <!-- Título -->
        <tr>
          <td style="padding: 32px 32px 0 32px;">
            <h2 style="color:#003a70; font-size:25px; font-weight:800; line-height:1.25; margin:0 0 10px 0;">${noticia.title}</h2>
          </td>
        </tr>
        ${subtituloHtml}

        <!-- Separador -->
        <tr><td style="padding: 20px 32px 0 32px;"><div style="border-top:1px solid #e2e8f0; height:1px; line-height:1px; font-size:1px;">&nbsp;</div></td></tr>

        <!-- Contenido -->
        <tr>
          <td style="padding: 20px 32px 8px 32px; color:#334155; font-size:15px; line-height:1.7;">
            ${noticia.content}
          </td>
        </tr>

        ${galeriaHtml}
        ${documentosHtml}

        <!-- CTA -->
        <tr>
          <td style="padding: 28px 32px 36px 32px;" align="center">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="border-radius:8px; background-color:#003a70;">
                  <a href="${baseUrl}/noticias/${noticia.id}" target="_blank"
                     style="display:inline-block; padding:14px 36px; color:#ffffff; font-size:16px; font-weight:700; text-decoration:none; border-radius:8px;">
                    Leer en la Intranet →
                  </a>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Pie -->
        <tr>
          <td style="background-color:#f8fafc; padding:18px 32px; border-top:1px solid #e2e8f0;" align="center">
            <p style="color:#94a3b8; font-size:12px; line-height:1.5; margin:0;">Este es un mensaje automático de la Intranet Transworld. Por favor, no respondas a este correo.</p>
          </td>
        </tr>
      </table>
    </div>
  `;
}

async function listarUsuariosConCorreo() {
  const { rows } = await db.query(`
    SELECT
      u.id,
      u.first_name,
      u.last_name,
      u.email,
      at.area_name AS area
    FROM users u
    LEFT JOIN work_areas at ON at.id = u.work_area_id
    WHERE u.email IS NOT NULL AND TRIM(u.email) <> ''
    ORDER BY u.last_name ASC NULLS LAST, u.first_name ASC
  `);
  return rows;
}

async function obtenerCorreosDestinatarios({ enviarTodos, userIds }) {
  if (enviarTodos) {
    const { rows } = await db.query(
      "SELECT email FROM users WHERE email IS NOT NULL AND TRIM(email) <> ''",
    );
    return rows.map((u) => u.email);
  }

  const ids = (Array.isArray(userIds) ? userIds : [userIds])
    .map((id) => parseInt(id, 10))
    .filter((id) => Number.isInteger(id) && id > 0);

  if (ids.length === 0) {
    return [];
  }

  const { rows } = await db.query(
    `SELECT email FROM users
     WHERE id = ANY($1::int[])
       AND email IS NOT NULL AND TRIM(email) <> ''`,
    [ids],
  );
  return rows.map((u) => u.email);
}

async function enviarCorreoNoticia(noticia, opciones = {}) {
  const listaCorreos = await obtenerCorreosDestinatarios(opciones);

  if (listaCorreos.length === 0) {
    return { enviados: 0 };
  }

  await sendMail({
    to: process.env.MAIL_FROM || 'noreply@transworld.cl',
    bcc: listaCorreos,
    subject: `Nueva Noticia: ${noticia.title}`,
    html: buildNoticiaEmailHtml(noticia),
  });

  console.log(`Notificación de noticia enviada a ${listaCorreos.length} trabajador(es).`);
  return { enviados: listaCorreos.length };
}

// ==========================================
// 1. LISTADO DE NOTICIAS
// ==========================================
router.get('/', async (req, res) => {
  try {
    const { rows } = await db.query(`SELECT ${NOTICIA_VIEW_COLUMNS} FROM news_articles ORDER BY created_at DESC`);
    res.render('noticias/index', { 
      titulo: 'Noticias', 
      noticias: rows,
      user: req.session.user,
      ok: req.query.ok || null
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error cargando noticias');
  }
});

// ==========================================
// 2. FORMULARIO DE CREACIÓN NOTICIA
// ==========================================
// La creación ahora se realiza mediante un modal en /noticias (index).
router.get('/crear', requireRole(...ROLES_CREAR), (req, res) => {
  res.redirect('/noticias');
});

// ==========================================
// 4. ENDPOINT PARA SUBIR IMÁGENES/ADJUNTOS
// ==========================================
router.post('/upload', requireRole(...ROLES_CREAR), multer({ storage: multer.memoryStorage() }).single('archivo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No se subió archivo' });
    }

    const result = await fileStorage.saveFile(
      req.file.buffer,
      'noticias_adjuntos',
      req.file.originalname
    );

    res.json({
      url: result.secure_url,
      secure_url: result.secure_url,
      public_id: result.public_id,
      resource_type: result.resource_type,
      nombre: result.fileName
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al subir archivo' });
  }
});

// ==========================================
// 5. ANTIGUA RUTA DE FIRMA (compatibilidad)
// ==========================================
router.get('/signature', requireRole(...ROLES_CREAR), async (req, res) => {
  try {
    // Ya no se necesita firma para almacenamiento local
    res.json({
      timestamp: Math.round(Date.now() / 1000),
      folder: 'noticias_adjuntos'
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error generando firma' });
  }
});

// ==========================================
// 5. GUARDAR NOTICIA
// ==========================================
router.post('/crear', requireRole(...ROLES_CREAR), async (req, res) => {
  const { titulo, subtitulo, contenido, imagen_portada, adjuntos_data } = req.body;
  
  if (!titulo || !contenido) {
    return res.status(400).send('Faltan campos obligatorios');
  }

  const slug = createSlug(titulo);
  const autor = req.session.user ? (req.session.user.username || req.session.user.email) : 'Anónimo';

  try {
    const sql = `
      INSERT INTO news_articles (title, subtitle, slug, content, image, attachments, author, created_at) 
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW()) 
      RETURNING id
    `;
    
    const values = [
      titulo, 
      subtitulo || '', 
      slug, 
      contenido, 
      imagen_portada || null, 
      adjuntos_data || '[]',
      autor
    ];

    const result = await db.query(sql, values);
    const noticiaId = result.rows[0].id;

    if (req.session.user) {
      await db.query(
        'INSERT INTO change_log (user_id, action, section, link_path) VALUES ($1, $2, $3, $4)',
        [req.session.user.id, 'publicó una nueva noticia', 'Noticias', `/noticias/${noticiaId}`]
      );
    }

    res.redirect(`/noticias/${noticiaId}?publicada=1`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error guardando la noticia');
  }
});

// ==========================================
// 6. ELIMINAR NOTICIA
// ==========================================
router.post('/eliminar/:id', requireRole(...ROLES_ELIMINAR), async (req, res) => {
  const { id } = req.params;

  try {
    await db.query('DELETE FROM news_articles WHERE id = $1', [id]);

    if (req.session.user) {
      await db.query(
        'INSERT INTO change_log (user_id, action, section, link_path) VALUES ($1, $2, $3, $4)',
        [req.session.user.id, 'eliminó una noticia', 'Noticias', '/noticias']
      );
    }

    res.redirect('/noticias?ok=Noticia eliminada');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error eliminando la noticia');
  }
});

// ==========================================
// MARCAR / QUITAR NOTICIA DESTACADA
// ==========================================
router.post('/destacar/:id', requireRole(...ROLES_CREAR), async (req, res) => {
  const { id } = req.params;
  const quitar = req.body.quitar === '1';

  try {
    const { rows } = await db.query(`SELECT id, title FROM news_articles WHERE id = $1`, [id]);

    if (rows.length === 0) {
      return res.status(404).send('Noticia no encontrada');
    }

    try {
      await setNoticiaDestacada(id, !quitar);
    } catch (destErr) {
      console.warn(
        '[NOTICIAS] Columna destacada no disponible; ejecuta migrations/002_noticias_destacada.sql',
        destErr.message,
      );
      return res.redirect(`/noticias/${id}?error=destacada_no_disponible`);
    }

    if (req.session.user) {
      await db.query(
        'INSERT INTO change_log (user_id, action, section, link_path) VALUES ($1, $2, $3, $4)',
        [
          req.session.user.id,
          quitar ? 'quitó noticia destacada del inicio' : 'marcó una noticia como destacada',
          'Noticias',
          `/noticias/${id}`,
        ],
      );
    }

    res.redirect(`/noticias/${id}?ok=${quitar ? 'destacada_quitada' : 'destacada_marcada'}`);
  } catch (err) {
    console.error('Error al actualizar noticia destacada:', err);
    res.redirect(`/noticias/${id}?error=destacada_fallida`);
  }
});

// ==========================================
// ENVIAR AVISO POR CORREO (MANUAL)
// ==========================================
router.post('/enviar-correo/:id', requireRole(...ROLES_CREAR), async (req, res) => {
  const { id } = req.params;
  const enviarTodos =
    req.body.enviar_todos === '1' ||
    req.body.enviar_todos === 'true' ||
    req.body.enviar_todos === 'on';
  const userIds = req.body.usuarios;

  try {
    const { rows } = await db.query(`SELECT ${NOTICIA_VIEW_COLUMNS} FROM news_articles WHERE id = $1`, [id]);

    if (rows.length === 0) {
      return res.status(404).send('Noticia no encontrada');
    }

    if (!enviarTodos && (!userIds || (Array.isArray(userIds) && userIds.length === 0))) {
      return res.redirect(`/noticias/${id}?error=sin_seleccion`);
    }

    const resultado = await enviarCorreoNoticia(rows[0], { enviarTodos, userIds });

    if (req.session.user) {
      await db.query(
        'INSERT INTO change_log (user_id, action, section, link_path) VALUES ($1, $2, $3, $4)',
        [
          req.session.user.id,
          'envió aviso por correo de una noticia',
          'Noticias',
          `/noticias/${id}`,
        ],
      );
    }

    if (resultado.enviados === 0) {
      return res.redirect(`/noticias/${id}?error=sin_destinatarios`);
    }

    res.redirect(`/noticias/${id}?ok=correo_enviado&destinatarios=${resultado.enviados}`);
  } catch (err) {
    console.error('Error al enviar correos de notificación de noticia:', err);
    res.redirect(`/noticias/${id}?error=correo_fallido`);
  }
});

// ==========================================
// 7. VER DETALLE
// ==========================================
router.get('/:id_or_slug', async (req, res) => {
  const param = req.params.id_or_slug;
  let sql = '';
  let values = [];

  if (/^\d+$/.test(param)) {
    sql = `SELECT ${NOTICIA_VIEW_COLUMNS} FROM news_articles WHERE id = $1`;
    values = [parseInt(param)];
  } else {
    sql = `SELECT ${NOTICIA_VIEW_COLUMNS} FROM news_articles WHERE slug = $1`;
    values = [param];
  }

  try {
    const { rows } = await db.query(sql, values);
    
    if (rows.length === 0) {
      return res.status(404).render('404', { titulo: 'Noticia no encontrada', user: req.session.user });
    }

    let usuariosCorreo = [];
    if (isAdministrador(req.session.user?.role)) {
      usuariosCorreo = await listarUsuariosConCorreo();
    }

    res.render('noticias/detalle', { 
      titulo: rows[0].title, 
      noticia: rows[0],
      user: req.session.user,
      usuariosCorreo,
      publicada: req.query.publicada === '1',
      editar: req.query.editar === '1',
      ok: req.query.ok || null,
      error: req.query.error || null,
      destinatarios: req.query.destinatarios || null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error cargando la noticia');
  }
});

// ==========================================
// FORMULARIO DE EDICIÓN (redirige al detalle con modal)
// ==========================================
router.get('/editar/:id', requireRole(...ROLES_CREAR), (req, res) => {
  res.redirect(`/noticias/${req.params.id}?editar=1`);
});

// ==========================================
// GUARDAR CAMBIOS DE EDICIÓN
// ==========================================
router.post('/editar/:id', requireRole(...ROLES_CREAR), async (req, res) => {
  const { id } = req.params;
  const { titulo, subtitulo, contenido, imagen_portada, adjuntos_data } = req.body;
  
  if (!titulo || !contenido) {
    return res.status(400).send('Faltan campos obligatorios');
  }

  try {
    const sql = `
      UPDATE news_articles 
      SET title = $1, subtitle = $2, content = $3, image = $4, attachments = $5
      WHERE id = $6
    `;
    
    const values = [
      titulo, 
      subtitulo || '', 
      contenido, 
      imagen_portada || null, 
      adjuntos_data || '[]',
      id
    ];

    await db.query(sql, values);

    if (req.session.user) {
      await db.query(
        'INSERT INTO change_log (user_id, action, section, link_path) VALUES ($1, $2, $3, $4)',
        [req.session.user.id, 'editó una noticia', 'Noticias', `/noticias/${id}`]
      );
    }

    res.redirect(`/noticias/${id}`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error actualizando la noticia');
  }
});

module.exports = router;
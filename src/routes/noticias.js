const express = require('express');
const router = express.Router();
const db = require('../db'); 
const fileStorage = require('../services/fileStorage');
const requireRole = require('../middlewares/requireRole');
const multer = require('multer');
const { sendMail } = require('../services/mailer');

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
    await db.query("UPDATE noticias SET destacada = false WHERE id != $1", [
      noticiaId,
    ]);
    await db.query("UPDATE noticias SET destacada = true WHERE id = $1", [
      noticiaId,
    ]);
  } else {
    await db.query("UPDATE noticias SET destacada = false WHERE id = $1", [
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
  let adjuntosCorreo = [];
  try {
    if (noticia.adjuntos) {
      adjuntosCorreo =
        typeof noticia.adjuntos === 'string'
          ? JSON.parse(noticia.adjuntos)
          : noticia.adjuntos;
    }
  } catch (e) {}

  const imagenesCorreo = adjuntosCorreo.filter(
    (a) => a.tipo === 'image' || (a.resource_type === 'image' && a.tipo !== 'video'),
  );

  const imagenPortadaHtml = noticia.imagen
    ? `<img src="${noticia.imagen}" alt="Portada" style="width:100%; max-height:380px; object-fit:cover; display:block; margin-bottom:0;">`
    : '';

  const galeriaHtml =
    imagenesCorreo.length > 0
      ? `<div style="margin: 20px 0 10px 0;">
           <p style="color:#003a70; font-weight:700; font-size:15px; margin:0 0 10px 0;">Imágenes adjuntas</p>
           <div style="text-align: left;">
             ${imagenesCorreo
               .map(
                 (img) =>
                   `<a href="${img.url}" target="_blank" style="display:inline-block; margin: 4px; vertical-align: top;"><img src="${img.url}" alt="${img.nombre || 'Imagen'}" style="width: 60px; height: auto; border-radius:6px; border:1px solid #e2e8f0; display:block;"></a>`,
               )
               .join('')}
           </div>
         </div>`
      : '';

  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden;">
      <div style="background-color: #003a70; padding: 20px; text-align: center;">
        <h2 style="color: white; margin: 0;">Nueva Noticia en Transworld</h2>
      </div>
      ${imagenPortadaHtml}
      <div style="padding: 25px; background-color: #ffffff;">
        <h3 style="color: #003a70; margin-top: 0; font-size: 22px;">${noticia.titulo}</h3>
        ${noticia.subtitulo ? `<p style="color: #475569; font-size: 16px; font-weight: bold;">${noticia.subtitulo}</p>` : ''}
        <div style="color: #334155; font-size: 15px; line-height: 1.6; margin-bottom: 20px;">
          ${noticia.contenido}
        </div>
        ${galeriaHtml}
        <div style="text-align: center; margin-top: 30px; margin-bottom: 10px;">
          <a href="${process.env.APP_BASE_URL || 'http://localhost:3000'}/noticias/${noticia.id}"
             style="display: inline-block; background-color: #ffffff; color: #003a70; border: 3px solid #003a70; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px;">
            Leer en la Intranet
          </a>
        </div>
      </div>
      <div style="background-color: #f8fafc; padding: 15px; text-align: center; border-top: 1px solid #e0e0e0;">
        <p style="color: #94a3b8; font-size: 12px; margin: 0;">Este es un mensaje de la Intranet Transworld, por favor no respondas a este correo.</p>
      </div>
    </div>
  `;
}

async function enviarCorreoNoticia(noticia) {
  const { rows: usuarios } = await db.query(
    "SELECT email FROM users WHERE email IS NOT NULL AND email != ''",
  );
  const listaCorreos = usuarios.map((u) => u.email);

  if (listaCorreos.length === 0) {
    return { enviados: 0 };
  }

  await sendMail({
    to: process.env.MAIL_FROM || 'noreply@transworld.cl',
    bcc: listaCorreos,
    subject: `Nueva Noticia: ${noticia.titulo}`,
    html: buildNoticiaEmailHtml(noticia),
  });

  console.log(`Notificación de noticia enviada a ${listaCorreos.length} trabajadores.`);
  return { enviados: listaCorreos.length };
}

// ==========================================
// 1. LISTADO DE NOTICIAS
// ==========================================
router.get('/', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM noticias ORDER BY fecha_creacion DESC');
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
router.get('/crear', requireRole(...ROLES_CREAR), (req, res) => {
  res.render('noticias/crear', { 
    titulo: 'Publicar Noticia',
    user: req.session.user 
  });
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
      INSERT INTO noticias (titulo, subtitulo, slug, contenido, imagen, adjuntos, autor, fecha_creacion) 
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
        'INSERT INTO historial_cambios (usuario_id, accion, seccion, enlace) VALUES ($1, $2, $3, $4)',
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
    await db.query('DELETE FROM noticias WHERE id = $1', [id]);

    if (req.session.user) {
      await db.query(
        'INSERT INTO historial_cambios (usuario_id, accion, seccion, enlace) VALUES ($1, $2, $3, $4)',
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
    const { rows } = await db.query('SELECT id, titulo FROM noticias WHERE id = $1', [id]);

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
        'INSERT INTO historial_cambios (usuario_id, accion, seccion, enlace) VALUES ($1, $2, $3, $4)',
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

  try {
    const { rows } = await db.query('SELECT * FROM noticias WHERE id = $1', [id]);

    if (rows.length === 0) {
      return res.status(404).send('Noticia no encontrada');
    }

    const resultado = await enviarCorreoNoticia(rows[0]);

    if (req.session.user) {
      await db.query(
        'INSERT INTO historial_cambios (usuario_id, accion, seccion, enlace) VALUES ($1, $2, $3, $4)',
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
    sql = 'SELECT * FROM noticias WHERE id = $1';
    values = [parseInt(param)];
  } else {
    sql = 'SELECT * FROM noticias WHERE slug = $1';
    values = [param];
  }

  try {
    const { rows } = await db.query(sql, values);
    
    if (rows.length === 0) {
      return res.status(404).render('404', { titulo: 'Noticia no encontrada', user: req.session.user });
    }

    res.render('noticias/detalle', { 
      titulo: rows[0].titulo, 
      noticia: rows[0],
      user: req.session.user,
      publicada: req.query.publicada === '1',
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
// FORMULARIO DE EDICIÓN
// ==========================================
router.get('/editar/:id', requireRole(...ROLES_CREAR), async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await db.query('SELECT * FROM noticias WHERE id = $1', [id]);
    
    if (rows.length === 0) {
      return res.status(404).send('Noticia no encontrada');
    }

    res.render('noticias/editar-noticia', { 
      titulo: 'Editar Noticia',
      noticia: rows[0],
      user: req.session.user 
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error cargando la vista de edición');
  }
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
      UPDATE noticias 
      SET titulo = $1, subtitulo = $2, contenido = $3, imagen = $4, adjuntos = $5
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
        'INSERT INTO historial_cambios (usuario_id, accion, seccion, enlace) VALUES ($1, $2, $3, $4)',
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
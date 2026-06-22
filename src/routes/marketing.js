const express = require('express');
const multer = require('multer');
const db = require('../db');
const fileStorage = require('../services/fileStorage');
const requireRole = require('../middlewares/requireRole');
const { EVENTO_VIEW_COLUMNS } = require('../utils/schemaMappers');

const router = express.Router();
const WRITE_ROLES = ['admin'];

const storage = multer.memoryStorage();
const upload = multer({ storage });

function createSlug(text) {
  return text.toString().toLowerCase().trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w\-]+/g, '')
    .replace(/\-\-+/g, '-');
}

// Normaliza imágenes enviadas desde el front
function parseDirectUploadedImages(body) {
  if (!body) return [];
  let candidate = body.images || body.uploadedImages || body.fotos || body.photos;
  if (typeof candidate === 'string') {
    try { candidate = JSON.parse(candidate); } catch (e) { candidate = null; }
  }
  if (candidate && !Array.isArray(candidate) && typeof candidate === 'object') {
    candidate = [candidate];
  }
  if (!Array.isArray(candidate)) return [];

  return candidate
    .map((img) => {
      const secure_url = img.secure_url || img.url || img.secureUrl;
      const public_id = img.public_id || img.publicId;
      const resource_type = img.resource_type || 'image'; 
      return { secure_url, public_id, resource_type };
    })
    .filter((img) => img.secure_url && img.public_id);
}

// ==========================================
// RUTAS
// ==========================================

router.get('/', (req, res) => res.redirect('/marketing/eventos'));

router.get('/eventos', async (req, res) => {
  try {
    const { rows } = await db.query(`SELECT ${EVENTO_VIEW_COLUMNS} FROM events ORDER BY created_at DESC`);
    res.render('marketing/eventos', { titulo: 'Galería de Eventos | Intranet Transworld Chile', eventos: rows });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error cargando eventos');
  }
});

router.get('/eventos/nuevo', requireRole(...WRITE_ROLES), (req, res) => {
  res.render('marketing/eventos_nuevo', { titulo: 'Crear Nuevo Evento', error: null });
});

router.post('/eventos/nuevo', requireRole(...WRITE_ROLES), async (req, res) => {
  const { nombre, descripcion } = req.body;
  const slug = createSlug(nombre);

  try {
    await db.query('INSERT INTO events (name, slug, description) VALUES ($1, $2, $3)',
      [nombre, slug, descripcion]);
    res.redirect('/marketing/eventos');
  } catch (err) {
    const errorMsg = err.code === '23505' ? 'Ya existe un evento con ese nombre.' : 'Error al crear.';
    res.render('marketing/eventos_nuevo', { titulo: 'Crear Nuevo Evento', error: errorMsg });
  }
});

// GET DETALLE
router.get('/eventos/:slug', async (req, res) => {
  const { slug } = req.params;
  try {
    const { rows } = await db.query(`SELECT ${EVENTO_VIEW_COLUMNS} FROM events WHERE slug = $1`, [slug]);
    if (rows.length === 0) return res.status(404).send('Evento no encontrado');

    const folder = `eventos/${slug}/`;

    // Obtener imágenes y videos locales
    const imagenes = await fileStorage.listFiles(folder);
    let todos = imagenes.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    res.render('marketing/evento_detalle', {
      titulo: rows[0].name,
      evento: rows[0],
      imagenes: todos
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error al cargar detalle');
  }
});


// SIGNATURE - Endpoint para obtener datos de subida
router.get('/eventos/:slug/fotos/signature', requireRole(...WRITE_ROLES), async (req, res) => {
  const { slug } = req.params;
  try {
    // Ya no se necesita firma para almacenamiento local
    res.json({
      timestamp: Math.round(Date.now() / 1000),
      folder: `eventos/${slug}`
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error generando datos' });
  }
});

// ENDPOINT PARA SUBIR ARCHIVOS
router.post('/eventos/:slug/fotos/upload', requireRole(...WRITE_ROLES), multer({ storage: multer.memoryStorage() }).single('archivo'), async (req, res) => {
  const { slug } = req.params;
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No se subió archivo' });
    }

    const folder = `eventos/${slug}`;
    const result = await fileStorage.saveFile(
      req.file.buffer,
      folder,
      req.file.originalname
    );

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al subir archivo' });
  }
});

// SUBIR - Compatibilidad con uploads directos
router.post('/eventos/:slug/fotos', requireRole(...WRITE_ROLES), upload.none(), async (req, res) => {
  const { slug } = req.params;
  const directFiles = parseDirectUploadedImages(req.body);

  if (directFiles.length > 0) {
    try {
      const firstImage = directFiles.find(f => (f.resource_type === 'image' || !f.resource_type));
      if (firstImage) {
        await db.query(
          `UPDATE events SET image = $1 WHERE slug = $2 AND (image IS NULL OR image = '')`,
          [firstImage.secure_url, slug]
        );
      }

      if (req.session.user && req.session.user.id) {
        await db.query(
          'INSERT INTO change_log (user_id, action, section, link_path) VALUES ($1, $2, $3, $4)',
          [req.session.user.id, 'subió contenido multimedia', 'Galería de Eventos', `/marketing/eventos/${slug}`]
        );
      }
      return res.redirect(`/marketing/eventos/${slug}`);
    } catch (err) {
      console.error(err);
      return res.status(500).send('Error registrando multimedia');
    }
  }

  res.redirect(`/marketing/eventos/${slug}`);
});

// DEFINIR PORTADA
router.post('/eventos/:slug/portada', requireRole(...WRITE_ROLES), async (req, res) => {
  const { slug } = req.params;
  const { url_imagen } = req.body;
  try {
    await db.query('UPDATE events SET image = $1 WHERE slug = $2', [url_imagen, slug]);
    res.redirect(`/marketing/eventos/${slug}`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error al definir portada');
  }
});

// ELIMINAR FOTO O VIDEO
router.post('/eventos/:slug/fotos/eliminar', requireRole(...WRITE_ROLES), async (req, res) => {
  const { public_id, resource_type } = req.body; 
  const { slug } = req.params;
  
  try {
    await fileStorage.deleteFile(public_id);

    const { rows } = await db.query('SELECT image FROM events WHERE slug = $1', [slug]);
    if (rows.length > 0 && rows[0].image && rows[0].image.includes(public_id)) {
        await db.query('UPDATE events SET image = NULL WHERE slug = $1', [slug]);
    }
    res.redirect(`/marketing/eventos/${slug}`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error eliminando archivo');
  }
});

// ELIMINAR EVENTO COMPLETO
router.post('/eventos/:slug/eliminar', requireRole(...WRITE_ROLES), async (req, res) => {
  const { slug } = req.params;
  try {
    await fileStorage.deleteFolder(`eventos/${slug}`);
    
    await db.query('DELETE FROM events WHERE slug = $1', [slug]);
    res.redirect('/marketing/eventos');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error eliminando evento');
  }
});

// RUTAS EDITAR
router.get('/eventos/:slug/editar', requireRole(...WRITE_ROLES), async (req, res) => {
  const { slug } = req.params;
  try {
    const { rows } = await db.query(`SELECT ${EVENTO_VIEW_COLUMNS} FROM events WHERE slug = $1`, [slug]);
    if (rows.length === 0) return res.status(404).send('Evento no encontrado');
    res.render('marketing/eventos_editar', { titulo: 'Editar Evento', evento: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error al cargar formulario de edición');
  }
});

router.post('/eventos/:slug/editar', requireRole(...WRITE_ROLES), async (req, res) => {
  const { slug } = req.params;
  const { nombre, descripcion } = req.body;
  try {
    await db.query('UPDATE events SET name = $1, description = $2 WHERE slug = $3', [nombre, descripcion, slug]);
    if (req.session.user && req.session.user.id) {
      await db.query('INSERT INTO change_log (user_id, action, section, link_path) VALUES ($1, $2, $3, $4)',
        [req.session.user.id, 'editó información del evento', 'Galería de Eventos', `/marketing/eventos/${slug}`]);
    }
    res.redirect(`/marketing/eventos/${slug}?ok=Evento actualizado correctamente`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error al actualizar el evento');
  }
});

module.exports = router;

const express = require('express');
const path = require('path');
const router = express.Router();
const db = require('../db');
const multer = require('multer');
const fileStorage = require('../services/fileStorage');
const requireRole = require('../middlewares/requireRole');
const { isAdministrador } = require('../constants/roles');

function getFileExtension(url, nombre) {
  const source = url || nombre || '';
  const clean = String(source).split('?')[0].split('#')[0];
  const ext = path.extname(clean).replace('.', '').toLowerCase();
  if (ext) return ext;
  const match = clean.match(/\.([a-zA-Z0-9]+)$/);
  return match ? match[1].toLowerCase() : '';
}

function mapDocumentoRow(row) {
  return {
    id: row.id,
    url: row.url,
    name: row.name,
    public_id: row.public_id,
    format: getFileExtension(row.url, row.name),
  };
}

const storage = multer.memoryStorage();
const upload = multer({ storage });

// === 1. DEFINICIÓN DE ÁREAS ===
const AREAS = [
  { slug: 'logistica', name: 'Logística' },
  { slug: 'contabilidad', name: 'Contabilidad' },
  { slug: 'ti', name: 'TI' },
  { slug: 'marketing', name: 'Marketing' },
  { slug: 'comercial', name: 'Comercial' }
];

// === 2. HELPER DE PERMISOS ===
function getPermissions(user) {
  const admin = user ? isAdministrador(user.role) : false;
  return {
    can_upload: admin,
    can_edit: admin,
    can_delete: admin,
  };
}

// ==========================================
// 3. VISTAS PRINCIPALES
// ==========================================
router.get('/', (req, res) => res.render('procesos/index', { titulo: 'Procesos y Documentos', user: req.session.user }));

router.get('/procedimientos', async (req, res) => {
  try {
    const areasConConteo = await Promise.all(AREAS.map(async (area) => {
      const result = await db.query('SELECT COUNT(*) FROM documents WHERE type = $1', [`procedimiento_${area.slug}`]);
      return { ...area, cantidad: parseInt(result.rows[0].count) || 0 };
    }));

    res.render('procesos/menu_carpetas', { 
      titulo: 'Procedimientos',
      seccionBase: 'procedimientos',
      areas: areasConConteo,
      user: req.session.user 
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error cargando carpetas');
  }
});

router.get('/protocolos', async (req, res) => {
  try {
    const areasConConteo = await Promise.all(AREAS.map(async (area) => {
      const result = await db.query('SELECT COUNT(*) FROM documents WHERE type = $1', [`protocolo_${area.slug}`]);
      return { ...area, cantidad: parseInt(result.rows[0].count) || 0 };
    }));

    res.render('procesos/menu_carpetas', { 
      titulo: 'Protocolos',
      seccionBase: 'protocolos',
      areas: areasConConteo,
      user: req.session.user 
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error cargando carpetas');
  }
});

router.get('/reglamento', async (req, res) => {
  try {
    const { rows } = await db.query("SELECT * FROM documents WHERE type = 'reglamento' ORDER BY created_at DESC");
    
    const archivos = rows.map(mapDocumentoRow);
    
    const permisos = getPermissions(req.session.user);

    res.render('procesos/vista_archivos', {
      titulo: 'Reglamento Interno',
      tituloSeccion: 'Reglamento Interno',
      tituloArea: 'General',
      seccionBase: 'reglamento',
      slugArea: 'general',
      archivos,
      user: req.session.user,
      permisos: permisos, 
      can: { reglamento_write: permisos.can_upload }
    });
  } catch (err) { console.error(err); res.status(500).send('Error'); }
});
// ==========================================
// RUTA: BUSCADOR GLOBAL
// ==========================================
router.get('/api/buscar', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'No autorizado' });

  try {
      const query = req.query.q || '';
      if (query.length < 1) return res.json([]);

      const searchParam = `%${query}%`;
      
      const docsQuery = `
          SELECT name, url, type
          FROM documents 
          WHERE name ILIKE $1 
          ORDER BY created_at DESC 
          LIMIT 10
      `;
      const otrosQuery = `
          SELECT name, url, 'otros' AS type 
          FROM other_documents 
          WHERE name ILIKE $1 
          ORDER BY created_at DESC 
          LIMIT 5
      `;

      const [docsRes, otrosRes] = await Promise.all([
          db.query(docsQuery, [searchParam]),
          db.query(otrosQuery, [searchParam])
      ]);

      const resultados = [...docsRes.rows, ...otrosRes.rows];
      res.json(resultados);

  } catch (err) {
      console.error('Error en buscador global:', err);
      res.status(500).json({ error: 'Error en el servidor' });
  }
});
// ==========================================
// 4. VISTA DE ARCHIVOS
// ==========================================
router.get('/:seccion/:area', async (req, res) => {
  const { seccion, area } = req.params;
  
  const mapSeccion = { 'procedimientos': 'procedimiento', 'protocolos': 'protocolo' };
  if (!mapSeccion[seccion]) return res.redirect('/procesos');

  const areaObj = AREAS.find(a => a.slug === area);
  if (!areaObj) return res.redirect(`/procesos/${seccion}`);

  const tipoDB = `${mapSeccion[seccion]}_${area}`;

  try {
    const { rows } = await db.query('SELECT * FROM documents WHERE type = $1 ORDER BY created_at DESC', [tipoDB]);
    
    const archivos = rows.map(mapDocumentoRow);

    const permisos = getPermissions(req.session.user);

    const tituloSeccionCapitalizado = seccion.charAt(0).toUpperCase() + seccion.slice(1);

    res.render('procesos/vista_archivos', {
      titulo: `${tituloSeccionCapitalizado}: ${areaObj.name}`,
      tituloSeccion: tituloSeccionCapitalizado,
      tituloArea: areaObj.name,
      seccionBase: seccion,
      slugArea: area,
      archivos,
      user: req.session.user,
      permisos: permisos, 
      can: { [seccion + '_write']: permisos.can_upload }
    });

  } catch (err) {
    console.error(err);
    res.status(500).send('Error cargando documentos');
  }
});

// ==========================================
// 5. ENDPOINT PARA SUBIR ARCHIVO
// ==========================================
router.post('/:seccion/:area/upload', requireRole.administrador(), upload.single('archivo'), async (req, res) => {
  const { seccion, area } = req.params;

  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No se subió archivo' });
    }

    if (!fileStorage.validateFileSize(req.file.buffer, 20)) {
      return res.status(400).json({ error: 'El archivo excede el límite de 20 MB' });
    }

    const folder = `documentos/${seccion}/${area}`;
    const result = await fileStorage.saveFile(
      req.file.buffer,
      folder,
      req.file.originalname
    );

    res.json({
      secure_url: result.secure_url,
      public_id: result.public_id,
      url: result.url,
      fileName: result.fileName,
    });
  } catch (err) {
    console.error('[Procesos] Error subida SharePoint:', err);
    res.status(500).json({
      error: err.message || 'Error al subir archivo a SharePoint',
    });
  }
});

// ANTIGUA RUTA DE FIRMA (compatibilidad)
router.get('/:seccion/:area/signature', requireRole.administrador(), async (req, res) => {
  const { seccion, area } = req.params;

  try {
    // Ya no se necesita firma para almacenamiento local
    res.json({ 
      timestamp: Math.round(Date.now() / 1000),
      folder: `documentos/${seccion}/${area}`
    });
  } catch (err) { 
    res.status(500).json({ error: 'Error firma' }); 
  }
});

// ==========================================
// 6. SUBIR ARCHIVO (compatibilidad)
// ==========================================
router.post('/:seccion/:area/subir', requireRole.administrador(), async (req, res) => {
  const { seccion, area } = req.params;
  const { nombre_archivo, secure_url, public_id } = req.body;

  try {
    if (!secure_url || !public_id) {
      return res.status(400).json({ error: 'Faltan datos del archivo subido' });
    }
    if (seccion === 'otros') {
        await db.query(
            'INSERT INTO other_documents (name, url, public_id) VALUES ($1, $2, $3)',
            [nombre_archivo || 'Documento', secure_url, public_id]
        );
    } else {
        const mapSeccion = { 'procedimientos': 'procedimiento', 'protocolos': 'protocolo', 'reglamento': 'reglamento' };
        let tipoDB = (seccion === 'reglamento') ? 'reglamento' : `${mapSeccion[seccion]}_${area}`; 
        
        await db.query(
          'INSERT INTO documents (name, type, url, public_id, user_id) VALUES ($1, $2, $3, $4, $5)',
          [nombre_archivo || 'Documento', tipoDB, secure_url, public_id, req.session.user.id]
        );
    }

    const areaObj = AREAS.find(a => a.slug === area);
    const nombreArea = areaObj ? areaObj.name : (area === 'general' ? '' : area);
    const nombreSeccion = seccion.charAt(0).toUpperCase() + seccion.slice(1);
    const textoHistorial = nombreArea ? `${nombreSeccion} sección ${nombreArea}` : `${nombreSeccion}`;

    let urlHistorial = `/procesos/${seccion}/${area}`;
    if(seccion === 'reglamento') urlHistorial = '/procesos/reglamento';
    if(seccion === 'otros') urlHistorial = '/procesos/otros';

    await db.query(
      'INSERT INTO change_log (user_id, action, section, link_path) VALUES ($1, $2, $3, $4)',
      [req.session.user.id, `subió un documento`, textoHistorial, urlHistorial]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('[Procesos] Error guardando documento:', err);
    res.status(500).json({ error: err.message || 'Error al guardar en la base de datos' });
  }
});

// ==========================================
// 7. EDITAR NOMBRE
// ==========================================
router.post('/documento/editar', requireRole.administrador(), async (req, res) => {
  const { id, nuevo_nombre, return_to, seccion_base } = req.body;
  try {
    const tabla = seccion_base === 'otros' ? 'other_documents' : 'documents';
    await db.query(`UPDATE ${tabla} SET name = $1 WHERE id = $2`, [nuevo_nombre, id]);
    res.redirect(`${return_to}?ok=Editado`);
  } catch (err) { res.redirect(return_to); }
});

// ==========================================
// 8. ELIMINAR 
// ==========================================
router.post('/eliminar', requireRole.administrador(), async (req, res) => {
  const { public_id, db_id, return_to, seccion_base } = req.body;
  try {
    if (public_id) await fileStorage.deleteFile(public_id);
    
    const tabla = seccion_base === 'otros' ? 'other_documents' : 'documents';
    if (db_id) await db.query(`DELETE FROM ${tabla} WHERE id = $1`, [db_id]);
    
    await db.query(
      'INSERT INTO change_log (user_id, action, section, link_path) VALUES ($1, $2, $3, $4)',
      [req.session.user.id, `eliminó un documento`, seccion_base || 'Procesos', return_to || '/procesos']
    );

    res.redirect(return_to);
  } catch (err) { res.status(500).send('Error eliminando'); }
});

// ==========================================
// 9. RUTA UNIFICADA: OTROS DOCUMENTOS
// ==========================================
router.get('/otros', async (req, res) => {
  try {
    const { rows } = await db.query("SELECT * FROM other_documents ORDER BY created_at DESC");
    
    const archivos = rows.map(mapDocumentoRow);
    
    const permisos = getPermissions(req.session.user);

    res.render('procesos/vista_archivos', {
      titulo: 'Otros Documentos',
      tituloSeccion: 'Otros Documentos',
      tituloArea: 'General',
      seccionBase: 'otros',
      slugArea: 'general',
      archivos,
      user: req.session.user,
      permisos: permisos, 
      can: { otros_write: permisos.can_upload }
    });
  } catch (err) { console.error(err); res.status(500).send('Error'); }
});

router.post('/otros/subir', requireRole.administrador(), upload.single('archivo'), async (req, res) => {
    try {
        const { nombre_archivo } = req.body;
          const result = await fileStorage.saveFile(req.file.buffer, 'intranet_otros_docs', req.file.originalname);

          await db.query(
            'INSERT INTO other_documents (name, url, public_id) VALUES ($1, $2, $3)',
            [nombre_archivo, result.secure_url, result.public_id]
          );
        res.redirect('/procesos/otros');
    } catch (err) {
        console.error(err);
        res.status(500).send('Error subiendo archivo');
    }
});

router.post('/otros/editar', requireRole.administrador(), async (req, res) => {
    const { id, nuevo_nombre } = req.body;
    try {
        await db.query('UPDATE other_documents SET name = $1 WHERE id = $2', [nuevo_nombre, id]);
        res.redirect('/procesos/otros?ok=Editado');
    } catch (err) {
        console.error(err);
        res.redirect('/procesos/otros');
    }
});

router.post('/otros/eliminar', requireRole.administrador(), async (req, res) => {
    try {
      const { id, public_id } = req.body;
      if (public_id) await fileStorage.deleteFile(public_id);
      await db.query('DELETE FROM other_documents WHERE id = $1', [id]);
      res.redirect('/procesos/otros');
    } catch (err) {
      console.error(err);
      res.status(500).send('Error eliminando archivo');
    }
});
module.exports = router;
const express = require('express');
const crypto = require('crypto');
const db = require('../db');

const router = express.Router();

function generarUUID() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

async function obtenerEvento(eventoId) {
  const { rows } = await db.query(
    "SELECT id, name AS nombre, COALESCE(fecha, '') AS fecha FROM events WHERE id = $1 OR slug = $1 LIMIT 1",
    [eventoId]
  );
  return rows && rows[0] ? rows[0] : null;
}

router.get('/evento/:id', async (req, res) => {
  const eventoId = req.params.id;
  if (!eventoId) return res.status(400).json({ error: 'ID de evento requerido' });

  try {
    const evento = await obtenerEvento(eventoId);
    if (!evento) {
      return res.status(404).json({ error: 'Evento no encontrado' });
    }

    return res.json({ nombre: evento.nombre, fecha: evento.fecha });
  } catch (err) {
    console.error('[Registro API] Error al cargar evento:', err.message);
    return res.status(500).json({ error: 'Error interno al cargar evento' });
  }
});

router.post('/evento/:id/registrar', async (req, res) => {
  const eventoId = req.params.id;
  const { nombre_completo, empresa, cargo, telefono, email, acreditado } = req.body || {};

  if (!eventoId) return res.status(400).json({ error: 'ID de evento requerido' });
  if (!nombre_completo || !empresa || !cargo || !telefono || !email) {
    return res.status(400).json({ error: 'Todos los campos son obligatorios' });
  }

  const emailNormalizado = String(email).trim().toLowerCase();

  try {
    const evento = await obtenerEvento(eventoId);
    if (!evento) {
      return res.status(404).json({ error: 'Evento no encontrado' });
    }

    const eventoPk = evento.id;
    const { rows: duplicados } = await db.query(
      'SELECT full_name AS nombre_completo FROM event_registrants WHERE event_id = $1 AND LOWER(email) = $2 LIMIT 1',
      [eventoPk, emailNormalizado]
    );

    if (duplicados.length > 0) {
      return res.status(409).json({
        error: `El correo ${emailNormalizado} ya se encuentra registrado para este evento bajo el nombre de ${duplicados[0].nombre_completo}.`
      });
    }

    const nuevoId = generarUUID();
    await db.query(
      `INSERT INTO event_registrants
       (id, full_name, company, job_title, phone, email, event_id, accredited)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [nuevoId, nombre_completo, empresa, cargo, telefono, emailNormalizado, eventoPk, acreditado || false]
    );

    return res.json({ id: nuevoId });
  } catch (err) {
    console.error('[Registro API] Error al registrar usuario:', err.message);
    return res.status(500).json({ error: 'Error interno al registrar usuario' });
  }
});

module.exports = router;

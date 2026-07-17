/**
 * Endpoint propio del formulario de registro.
 * Usa BREVO_API_KEY del .env. Remitente fijo de registro (no MAIL_FROM de tickets).
 */
const BREVO_API_KEY = (process.env.BREVO_API_KEY || process.env.SMTP_PASS || '').trim();
const MAIL_FROM = 'contacto@transworld.cl';
const MAIL_SENDER_NAME = 'Equipo de Transworld';

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Normaliza fecha a { y, m, d } desde ISO (YYYY-MM-DD) o DD-MM-YYYY / DD/MM/YYYY */
function parseFechaParts(fechaRaw, fechaDisplay) {
  const candidates = [fechaRaw, fechaDisplay].map((v) => String(v || '').trim()).filter(Boolean);

  for (const value of candidates) {
    const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) {
      return { y: iso[1], m: iso[2], d: iso[3] };
    }
    const dmy = value.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
    if (dmy) {
      return {
        y: dmy[3],
        m: dmy[2].padStart(2, '0'),
        d: dmy[1].padStart(2, '0'),
      };
    }
  }
  return null;
}

function buildCalendarLinks({ titulo, fechaRaw, fechaDisplay, lugar, direccion, descripcion }) {
  const parts = parseFechaParts(fechaRaw, fechaDisplay);
  if (!parts) return { google: '', outlook: '' };

  const { y, m, d } = parts;
  // Evento de día completo (Chile)
  const startDay = `${y}${m}${d}`;
  const endDate = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d) + 1));
  const endDay = [
    endDate.getUTCFullYear(),
    String(endDate.getUTCMonth() + 1).padStart(2, '0'),
    String(endDate.getUTCDate()).padStart(2, '0'),
  ].join('');

  const location = [lugar, direccion].filter(Boolean).join(', ');
  const details = descripcion || '';

  const google = new URL('https://calendar.google.com/calendar/render');
  google.searchParams.set('action', 'TEMPLATE');
  google.searchParams.set('text', titulo);
  google.searchParams.set('dates', `${startDay}/${endDay}`);
  if (location) google.searchParams.set('location', location);
  if (details) google.searchParams.set('details', details);

  const outlook = new URL('https://outlook.live.com/calendar/0/deeplink/compose');
  outlook.searchParams.set('path', '/calendar/action/compose');
  outlook.searchParams.set('rru', 'addevent');
  outlook.searchParams.set('subject', titulo);
  outlook.searchParams.set('startdt', `${y}-${m}-${d}T09:00:00`);
  outlook.searchParams.set('enddt', `${y}-${m}-${d}T18:00:00`);
  outlook.searchParams.set('allday', 'true');
  if (location) outlook.searchParams.set('location', location);
  if (details) outlook.searchParams.set('body', details);

  return { google: google.toString(), outlook: outlook.toString() };
}

async function enviarQrHandler(req, res) {
  try {
    const {
      email,
      nombre,
      eventoNombre,
      eventoFecha,
      eventoFechaRaw,
      eventoLugar,
      eventoDireccion,
      registroId,
    } = req.body || {};

    const to = String(email || '').trim().toLowerCase();
    const id = String(registroId || '').trim();
    const nombreClean = String(nombre || '').trim();

    if (!to || !to.includes('@')) {
      return res.status(400).json({ ok: false, error: 'Email inválido' });
    }
    if (!BREVO_API_KEY) {
      console.error('[registro] Falta BREVO_API_KEY en las variables de entorno');
      return res.status(500).json({ ok: false, error: 'Servicio de correo no configurado' });
    }
    if (!id || !nombreClean) {
      return res.status(400).json({ ok: false, error: 'Datos incompletos' });
    }

    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&format=jpeg&data=${encodeURIComponent(id)}`;
    const evento = String(eventoNombre || 'Transworld Connect').trim();
    const fecha = String(eventoFecha || '').trim();
    const lugar = String(eventoLugar || '').trim();
    const direccion = String(eventoDireccion || '').trim();

    const partes = [`Tu registro ha finalizado exitosamente para asistir a ${evento}`];
    if (fecha) partes.push(` a realizarse el ${fecha}`);
    if (lugar) partes.push(` en ${lugar}`);
    if (direccion) partes.push(`${lugar ? ',' : ''} ubicado en ${direccion}`);
    partes.push('.');
    const cuerpoRegistro = partes.join('');

    const bold = (value) => `<strong>${escapeHtml(value)}</strong>`;
    const partesHtml = [
      `Tu registro ha finalizado exitosamente para asistir a ${bold(evento)}`,
    ];
    if (fecha) partesHtml.push(` a realizarse el ${bold(fecha)}`);
    if (lugar) partesHtml.push(` en ${bold(lugar)}`);
    if (direccion) {
      partesHtml.push(`${lugar ? ',' : ''} ubicado en ${bold(direccion)}`);
    }
    partesHtml.push('.');
    const cuerpoRegistroHtml = partesHtml.join('');

    const calendarDesc = [
      cuerpoRegistro,
      '',
      'Presenta tu código QR en la entrada.',
      'Consultas: contacto@transworld.cl',
    ].join('\n');

    const { google: googleCalUrl, outlook: outlookCalUrl } = buildCalendarLinks({
      titulo: evento,
      fechaRaw: eventoFechaRaw,
      fechaDisplay: fecha,
      lugar,
      direccion,
      descripcion: calendarDesc,
    });

    const calendarButtons =
      googleCalUrl || outlookCalUrl
        ? `
    <p style="margin:28px 0 10px;font-size:15px;color:#333333;font-weight:bold;">Agéndalo a tu calendario</p>
    <p style="margin:0 0 8px;">
      ${
        googleCalUrl
          ? `<a href="${googleCalUrl}" style="display:inline-block;margin:0 8px 8px 0;padding:10px 16px;background:#ffffff;border:1px solid #c5c5c5;border-radius:6px;color:#1a73e8;text-decoration:none;font-size:14px;font-weight:bold;">Google Calendar</a>`
          : ''
      }
      ${
        outlookCalUrl
          ? `<a href="${outlookCalUrl}" style="display:inline-block;margin:0 8px 8px 0;padding:10px 16px;background:#ffffff;border:1px solid #c5c5c5;border-radius:6px;color:#0078d4;text-decoration:none;font-size:14px;font-weight:bold;">Outlook</a>`
          : ''
      }
    </p>`
        : '';

    const html = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#d9d9d9;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:32px 20px;">
    <div style="background:#ececec;border-radius:12px;padding:32px 28px;color:#222222;line-height:1.55;">
      <p style="margin:0 0 18px;font-size:16px;">Hola <strong>${escapeHtml(nombreClean)}</strong>.</p>

      <p style="margin:0 0 24px;font-size:15px;color:#333333;">
        ${cuerpoRegistroHtml}
      </p>

      <div style="background:#ffffff;border:1px solid #cfcfcf;border-radius:12px;padding:22px;text-align:center;margin:0 0 24px;">
        <img src="${qrUrl}" alt="Código QR de acceso" width="220" height="220" style="display:block;margin:0 auto;border-radius:8px;background:#ffffff;">
        <p style="margin:14px 0 0;font-size:13px;color:#666666;">Presenta este código QR en la entrada del evento.</p>
      </div>

      <p style="margin:0 0 6px;font-size:15px;color:#333333;">
        Consultas a<br>
        <a href="mailto:contacto@transworld.cl" style="color:#1a5fb4;text-decoration:none;font-weight:bold;">contacto@transworld.cl</a>
      </p>

      ${calendarButtons}

      <p style="margin:28px 0 0;font-size:15px;color:#333333;">
        Saludos cordiales.<br>
        <strong>Marketing</strong><br>
        Transworld
      </p>
    </div>
  </div>
</body>
</html>`;

    const text = [
      `Hola ${nombreClean}.`,
      '',
      cuerpoRegistro,
      '',
      `Código QR: ${qrUrl}`,
      '',
      'Consultas a contacto@transworld.cl',
      '',
      googleCalUrl ? `Google Calendar: ${googleCalUrl}` : '',
      outlookCalUrl ? `Outlook: ${outlookCalUrl}` : '',
      '',
      'Saludos cordiales.',
      'Marketing',
      'Transworld',
    ]
      .filter((line) => line !== '')
      .join('\n');

    const brevoRes = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'api-key': BREVO_API_KEY,
      },
      body: JSON.stringify({
        sender: { name: MAIL_SENDER_NAME, email: MAIL_FROM },
        to: [{ email: to }],
        subject: `Registro confirmado · ${evento}`,
        htmlContent: html,
        textContent: text,
      }),
    });

    if (!brevoRes.ok) {
      const body = await brevoRes.json().catch(() => ({}));
      console.error('[registro] Brevo error:', brevoRes.status, body);
      return res.status(502).json({ ok: false, error: 'No se pudo enviar el correo' });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('[registro] Error enviando QR:', err);
    return res.status(500).json({ ok: false, error: 'No se pudo enviar el correo' });
  }
}

module.exports = { enviarQrHandler };

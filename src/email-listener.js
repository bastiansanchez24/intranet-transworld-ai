// email-listener.js
//
// Escucha el buzón IMAP del correo de soporte
// y crea un ticket nuevo en la tabla `support_tickets` por cada correo entrante.

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const db = require('./db');

async function main() {
  const client = new ImapFlow({
    host: process.env.IMAP_HOST || 'outlook.office365.com',
    port: process.env.IMAP_PORT ? Number(process.env.IMAP_PORT) : 993,
    secure: true,
    auth: {
      user: process.env.IMAP_USER,
      pass: process.env.IMAP_PASS 
    }
  });

  console.log('Conectando a IMAP...');
  await client.connect();
  console.log('Conectado a IMAP.');

  await client.mailboxOpen('INBOX');
  console.log('INBOX abierto. Esperando nuevos correos...');

  client.on('exists', async () => {
    try {
      const seq = client.mailbox.exists; // último mensaje
      const message = await client.fetchOne(seq, { source: true });

      const parsed = await simpleParser(message.source);

      const from = parsed.from && parsed.from.value && parsed.from.value[0];
      const requester_email = from ? from.address : null;
      const requester_name = from ? (from.name || from.address) : null;

      const title = (parsed.subject || '(sin asunto)').substring(0, 255);
      const description =
        parsed.text || parsed.html || '(sin contenido en el correo)';

      const category = 'Otro';
      const priority = 'medium';
      const status = 'open';

      if (!requester_email) {
        console.log(
          'Correo recibido sin remitente válido, no se crea ticket.'
        );
        return;
      }

      const { rows } = await db.query(
        `
        INSERT INTO support_tickets (
          title,
          description,
          category,
          priority,
          status,
          requester_name,
          requester_email
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id
      `,
        [
          title,
          description,
          category,
          priority,
          status,
          requester_name,
          requester_email
        ],
      );

      console.log(
        `Ticket creado desde email. ID: ${rows[0].id}, remitente: ${requester_email}`
      );
    } catch (err) {
      console.error('Error procesando nuevo correo:', err);
    }
  });

  client.on('error', (err) => {
    console.error('Error en cliente IMAP:', err);
  });
}

main().catch((err) => {
  console.error('Error iniciando email-listener:', err);
});

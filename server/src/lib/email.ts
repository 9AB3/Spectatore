import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const MODE = process.env.EMAIL_MODE || 'stub';
const OUTBOX = process.env.EMAIL_OUTBOX || './outbox_emails';

// Default sender (SendGrid requires this to be a verified sender/domain)
const DEFAULT_FROM = (process.env.EMAIL_FROM || 'noreply@spectatore.com').trim();

export async function sendEmail(
  to: string,
  subject: string,
  text: string,
  opts?: { from?: string },
) {
  if (MODE !== 'real') {
    // ===== STUB MODE (local dev) =====
    if (!fs.existsSync(OUTBOX)) fs.mkdirSync(OUTBOX, { recursive: true });
    const file = path.join(
      OUTBOX,
      `${Date.now()}-${subject.replace(/\W+/g, '_')}.txt`,
    );
    const from = (opts?.from || DEFAULT_FROM).trim();
    const content = `To: ${to}\nFrom: ${from}\nSubject: ${subject}\n\n${text}\n`;
    await fs.promises.writeFile(file, content, 'utf8');
    console.log(`[email-stub] Wrote email to ${file}`);
    return;
  }

  // ===== REAL EMAIL MODE (production) =====
  const sg = await import('@sendgrid/mail');
  sg.default.setApiKey(process.env.SENDGRID_API_KEY!);

  const from = (opts?.from || DEFAULT_FROM).trim();

  await sg.default.send({
    to,
    from,
    subject,
    text,
  });
}

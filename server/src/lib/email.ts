import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config();

const OUTBOX = process.env.EMAIL_OUTBOX || './outbox_emails';

export async function sendEmail(to: string, subject: string, text: string) {
  if (!fs.existsSync(OUTBOX)) fs.mkdirSync(OUTBOX, { recursive: true });
  const file = path.join(OUTBOX, `${Date.now()}-${subject.replace(/\W+/g, '_')}.txt`);
  const content = `To: ${to}\nSubject: ${subject}\n\n${text}\n`;
  await fs.promises.writeFile(file, content, 'utf8');
  console.log(`[email-stub] Wrote email to ${file}`);
}

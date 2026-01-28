import { sendSms } from "../dist/lib/sms.js";

const to = process.env.SUPER_ADMIN_SMS_TO;
if (!to) throw new Error("Missing SUPER_ADMIN_SMS_TO");

await sendSms(to, "✅ Spectatore test SMS (Twilio direct)");
console.log("sent");

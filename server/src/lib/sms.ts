import twilio from "twilio";

const sid = process.env.TWILIO_ACCOUNT_SID || "";
const token = process.env.TWILIO_AUTH_TOKEN || "";
const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID || "";

const client = sid && token ? twilio(sid, token) : null;

export async function sendSms(to: string, body: string) {
  if (process.env.SMS_ALERTS_ENABLED !== "1") return;
  if (!client) throw new Error("Twilio not configured (SID/TOKEN missing)");
  if (!messagingServiceSid) throw new Error("Twilio Messaging Service SID missing");

  await client.messages.create({
    to,
    messagingServiceSid,
    body,
  });
}

import express from 'express';
import Stripe from 'stripe';
import { pool } from '../lib/pg.js';
import { authMiddleware } from '../lib/auth.js';

const router = express.Router();

function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY || '';
  if (!key) throw new Error('STRIPE_SECRET_KEY missing');
  return new Stripe(key, {
    // Keep explicit to avoid surprises across Stripe SDK versions
    apiVersion: (process.env.STRIPE_API_VERSION as any) || '2023-10-16',
  });
}

function clientBaseUrl(): string {
  const u = (process.env.CLIENT_BASE_URL || 'http://localhost:5173').trim();
  return u.replace(/\/$/, '');
}

async function ensureCustomer(stripe: Stripe, userId: number): Promise<{ customerId: string; email?: string | null }>{
  const r = await pool.query(`SELECT id, email, name, stripe_customer_id FROM users WHERE id=$1`, [userId]);
  const u = r.rows?.[0];
  if (!u?.id) throw new Error('user not found');
  if (u.stripe_customer_id) return { customerId: u.stripe_customer_id, email: u.email };

  const customer = await stripe.customers.create({
    email: u.email || undefined,
    name: u.name || undefined,
    metadata: { user_id: String(u.id) },
  });

  await pool.query(`UPDATE users SET stripe_customer_id=$1 WHERE id=$2`, [customer.id, u.id]);
  return { customerId: customer.id, email: u.email };
}

function priceForInterval(interval: 'month' | 'year'): string {
  const priceId = interval === 'year' ? process.env.STRIPE_PRICE_YEARLY : process.env.STRIPE_PRICE_MONTHLY;
  if (!priceId) throw new Error('Stripe price id missing for interval: ' + interval);
  return priceId;
}

function isEnforced(): boolean {
  return String(process.env.STRIPE_ENFORCE_SUBSCRIPTION || '0') === '1';
}

// Returns billing state for the logged in user.
router.get('/status', authMiddleware, async (req: any, res) => {
  try {
    const r = await pool.query(
      `SELECT
         id,
         email,
         is_admin,
         billing_exempt,
         stripe_customer_id,
         stripe_subscription_id,
         subscription_status,
         subscription_price_id,
         subscription_interval,
         current_period_end,
         cancel_at_period_end
       FROM users
       WHERE id=$1`,
      [req.user_id],
    );
    const u = r.rows?.[0];
    if (!u?.id) return res.status(404).json({ ok: false, error: 'user not found' });
    // Backfill current_period_end from Stripe if missing but we have a subscription id.
    // This prevents the UI showing a blank renew date in local/dev if webhooks arrived before the period end was set.
    if (!u.current_period_end && u.stripe_subscription_id && process.env.STRIPE_SECRET_KEY) {
      try {
        const stripe = getStripe();
        const sub = await stripe.subscriptions.retrieve(String(u.stripe_subscription_id));
        const price = sub.items?.data?.[0]?.price;
        const interval = (price?.recurring?.interval || null) as any;
        const periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000) : null;

        if (periodEnd) {
          await pool.query(
            `UPDATE users
                SET subscription_status = $2,
                    subscription_price_id = $3,
                    subscription_interval = $4,
                    current_period_end = $5,
                    cancel_at_period_end = $6
              WHERE id = $1`,
            [
              u.id,
              String(sub.status || ''),
              price?.id || null,
              interval,
              periodEnd,
              !!sub.cancel_at_period_end,
            ],
          );
          // reflect for this response too
          u.subscription_status = String(sub.status || '');
          u.subscription_price_id = price?.id || null;
          u.subscription_interval = interval;
          u.current_period_end = periodEnd;
          u.cancel_at_period_end = !!sub.cancel_at_period_end;
        }
      } catch {
        // ignore backfill errors; webhook remains source of truth
      }
    }


    
// Detect scheduled subscription changes (e.g. yearly -> monthly downgrade schedule)
// so the UI can show "Upcoming changes" after a refresh.
let scheduled_change: any = null;
if (u.stripe_subscription_id && process.env.STRIPE_SECRET_KEY) {
  try {
    const stripe = getStripe();
    const sub = await stripe.subscriptions.retrieve(String(u.stripe_subscription_id));
    const nowSec = Math.floor(Date.now() / 1000);

    const scheduleId: string | null = (sub as any).schedule ?? null;
    if (scheduleId) {
      // Expand phase prices so we can read their recurring interval
      const sched: any = await stripe.subscriptionSchedules.retrieve(String(scheduleId), {
        expand: ['phases.items.price'],
      } as any);

      const phases: any[] = Array.isArray(sched?.phases) ? sched.phases : [];
      const currentPhase = phases.find((p) => {
        const s = Number(p?.start_date || 0);
        const e = p?.end_date ? Number(p.end_date) : null;
        return s <= nowSec && (!e || nowSec < e);
      });
      const nextPhase = phases
        .filter((p) => Number(p?.start_date || 0) > nowSec)
        .sort((a, b) => Number(a.start_date || 0) - Number(b.start_date || 0))[0];

      const curPrice: any = currentPhase?.items?.[0]?.price;
      const nextPrice: any = nextPhase?.items?.[0]?.price;

      const curInterval =
        (curPrice?.recurring?.interval || u.subscription_interval || null) as 'month' | 'year' | null;
      const nextInterval = (nextPrice?.recurring?.interval || null) as 'month' | 'year' | null;

      if (nextPhase && curInterval && nextInterval && nextInterval !== curInterval) {
        scheduled_change = {
          type: 'plan_change',
          current_interval: curInterval,
          target_interval: nextInterval,
          effective_at: new Date(Number(nextPhase.start_date) * 1000).toISOString(),
          schedule_id: String(sched?.id || scheduleId),
          source: 'stripe_schedule',
        };
      }
    }

    // If there's no plan change scheduled but the subscription is set to cancel at period end,
    // surface that as an upcoming change too.
    if (!scheduled_change && (u.cancel_at_period_end || sub.cancel_at_period_end) && u.current_period_end) {
      scheduled_change = {
        type: 'cancel',
        current_interval: (u.subscription_interval || null),
        target_interval: null,
        effective_at: new Date(u.current_period_end).toISOString(),
        schedule_id: null,
        source: 'subscription_cancel_at_period_end',
      };
    }
  } catch {
    // ignore schedule lookup errors; webhook remains source of truth
  }
}

// Server-side determination of allow/deny
    const now = Date.now();
    const cpe = u.current_period_end ? new Date(u.current_period_end).getTime() : 0;
    const activeStatus = ['active', 'trialing'].includes(String(u.subscription_status || '').toLowerCase());
    const withinPaidWindow = !!cpe && cpe > now;
    const devBypassEnabled = String(process.env.STRIPE_DEV_BYPASS || '0') === '1';
    const allowEmails = (process.env.STRIPE_DEV_BYPASS_EMAILS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const email = String(u.email || '').toLowerCase();
    const devBypass = devBypassEnabled && !!email && allowEmails.includes(email);

    const allowed = !!u.billing_exempt || !!u.is_admin || devBypass || activeStatus || withinPaidWindow;

    return res.json({
      ok: true,
      enforced: isEnforced(),
      allowed,
      is_admin: !!u.is_admin,
      billing_exempt: !!u.billing_exempt,
      dev_bypass: devBypass,
      subscription_status: u.subscription_status,
      subscription_interval: u.subscription_interval,
      current_period_end: u.current_period_end,
      cancel_at_period_end: u.cancel_at_period_end,
      scheduled_change,
    });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'status failed' });
  }
});

// Creates a Stripe Checkout session.
router.post('/create-checkout-session', authMiddleware, async (req: any, res) => {
  try {
    const stripe = getStripe();
    const interval: 'month' | 'year' = (req.body?.interval === 'year' ? 'year' : 'month');
    const priceId = priceForInterval(interval);

    const { customerId } = await ensureCustomer(stripe, req.user_id);
    const successUrl = `${clientBaseUrl()}/subscribe?result=success&session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${clientBaseUrl()}/subscribe?result=cancel`;

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      allow_promotion_codes: true,
      client_reference_id: String(req.user_id),
      metadata: { user_id: String(req.user_id), interval },
    });

    return res.json({ ok: true, url: session.url });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'checkout failed' });
  }
});

// Creates a Stripe Billing Portal session.
router.post('/create-portal-session', authMiddleware, async (req: any, res) => {
  try {
    const stripe = getStripe();
    const { customerId } = await ensureCustomer(stripe, req.user_id);
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${clientBaseUrl()}/Settings`,
    });
    return res.json({ ok: true, url: session.url });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'portal failed' });
  }
});

// Change plan (monthly/yearly).
//
// For YEARLY -> MONTHLY we schedule the change at the end of the current
// billing period using a Stripe Subscription Schedule, so the user is not
// charged again immediately for a shorter interval.
router.post('/change-plan', authMiddleware, async (req: any, res) => {
  try {
    const intervalRaw = (req.body?.interval ?? '').toString().toLowerCase();
    const targetInterval = intervalRaw === 'month' || intervalRaw === 'monthly'
      ? 'month'
      : intervalRaw === 'year' || intervalRaw === 'yearly'
        ? 'year'
        : null;

    if (!targetInterval) {
      return res.status(400).json({ error: 'invalid interval' });
    }

    const userId = req.user_id;
    const stripe = getStripe();
    const { customerId } = await ensureCustomer(stripe, userId);

    // Load user billing state
    const { rows } = await pool.query(
      `SELECT stripe_subscription_id, subscription_price_id, subscription_interval
       FROM users
       WHERE id=$1`,
      [userId]
    );
    const userRow = rows[0];

    let subscriptionId: string | null = userRow?.stripe_subscription_id ?? null;
    if (!subscriptionId) {
      const subs = await stripe.subscriptions.list({ customer: customerId, status: 'active', limit: 1 });
      subscriptionId = subs.data[0]?.id ?? null;
    }
    if (!subscriptionId) {
      return res.status(400).json({ error: 'no active subscription' });
    }

    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    const item = sub.items.data[0];
    const currentPriceId = item?.price?.id;
    const currentInterval = item?.price?.recurring?.interval as ('month' | 'year' | undefined);

    const targetPriceId = targetInterval === 'month'
      ? process.env.STRIPE_PRICE_MONTHLY
      : process.env.STRIPE_PRICE_YEARLY;

    if (!targetPriceId) {
      return res.status(500).json({ error: 'missing target price env' });
    }

    if (!currentPriceId || !currentInterval) {
      return res.status(500).json({ error: 'unable to read current subscription price' });
    }

    if (currentPriceId === targetPriceId) {
      return res.json({ ok: true, message: 'already on that plan' });
    }

    // Downgrade (year -> month): schedule change at period end.
    if (currentInterval === 'year' && targetInterval === 'month') {
      const cps = (sub as any).current_period_start as number | undefined;
      const cpe = (sub as any).current_period_end as number | undefined;
      if (!cps || !cpe) {
        return res.status(500).json({ error: 'missing current period dates' });
      }

      let scheduleId: string | null = (sub as any).schedule ?? null;
      if (!scheduleId) {
        const schedule = await stripe.subscriptionSchedules.create({ from_subscription: sub.id });
        scheduleId = schedule.id;
      }

      await stripe.subscriptionSchedules.update(scheduleId, {
        end_behavior: 'release',
        phases: [
          {
            start_date: cps,
            end_date: cpe,
            items: [{ price: currentPriceId, quantity: item.quantity ?? 1 }],
          },
          {
            start_date: cpe,
            items: [{ price: targetPriceId, quantity: item.quantity ?? 1 }],
          },
        ],
      });

      return res.json({
        ok: true,
        scheduled: true,
        effective_at: new Date(cpe * 1000).toISOString(),
      });
    }

    // Upgrade (month -> year): send the user through Stripe Billing Portal
    // confirmation flow, which will show the charge/proration and collect
    // payment immediately (including SCA) before returning to the app.
    if (currentInterval === 'month' && targetInterval === 'year') {
      const session = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: `${clientBaseUrl()}/subscriptions`,
        flow_data: {
          type: 'subscription_update_confirm',
          subscription_update_confirm: {
            subscription: sub.id,
            items: [{ id: item.id, price: targetPriceId, quantity: item.quantity ?? 1 }],
          },
        },
      } as any);

      return res.json({
        ok: true,
        redirect: true,
        url: session.url,
        message: 'Continue to Stripe to confirm the upgrade and complete payment.',
      });
    }

    // Other changes (e.g. price swap within same interval): apply immediately.
    await stripe.subscriptions.update(sub.id, {
      items: [{ id: item.id, price: targetPriceId }],
      proration_behavior: 'none',
    });

    return res.json({ ok: true, scheduled: false, charged_now: false, message: 'Plan updated.' });
  } catch (e: any) {
    console.error('[billing] change-plan failed', e);
    return res.status(500).json({ error: e?.message || 'change-plan failed' });
  }
});

export async function handleStripeWebhook(rawBody: Buffer, sig: string | string[] | undefined) {
  const stripe = getStripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET || '';
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET missing');
  const signature = Array.isArray(sig) ? sig[0] : sig;
  if (!signature) throw new Error('Missing stripe-signature header');

  const event = stripe.webhooks.constructEvent(rawBody, signature, secret);

  // Idempotency: store processed events
  await pool.query(
    `CREATE TABLE IF NOT EXISTS stripe_webhook_events (
        id TEXT PRIMARY KEY,
        type TEXT,
        created_at TIMESTAMPTZ DEFAULT now()
      )`,
  );
  const already = await pool.query(`SELECT 1 FROM stripe_webhook_events WHERE id=$1`, [event.id]);
  if (already.rowCount) return { ok: true, skipped: true };
  await pool.query(`INSERT INTO stripe_webhook_events(id, type) VALUES ($1,$2)`, [event.id, String((event as any).type || '')]);

  const upsertUserFromSubscription = async (sub: Stripe.Subscription) => {
    const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
    if (!customerId) return;
    const price = sub.items?.data?.[0]?.price;
    const interval = (price?.recurring?.interval || null) as any;
    const periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000) : null;

    await pool.query(
      `UPDATE users
          SET stripe_customer_id = COALESCE(stripe_customer_id, $1),
              stripe_subscription_id = $2,
              subscription_status = $3,
              subscription_price_id = $4,
              subscription_interval = $5,
              current_period_end = $6,
              cancel_at_period_end = $7
        WHERE stripe_customer_id = $1`,
      [
        customerId,
        sub.id,
        String(sub.status || ''),
        price?.id || null,
        interval,
        periodEnd,
        !!sub.cancel_at_period_end,
      ],
    );
  };

  const upsertUserFromInvoiceLike = async (obj: any) => {
    // Some Stripe flows (and some webhook configurations) may deliver invoice-related
    // events before (or instead of) a useful checkout.session.completed payload.
    // We can always map an invoice -> subscription -> user, so use invoices as a
    // reliable fallback to keep the app from "hanging" waiting for status updates.
    // Object can be either an Invoice (invoice.* events) OR an InvoicePayment
    // (invoice_payment.* events). Normalize to an invoice first.
    let invoice: Stripe.Invoice | null = null;

    if (obj?.object === 'invoice') {
      invoice = obj as Stripe.Invoice;
    } else if (obj?.object === 'invoice_payment' && obj?.invoice) {
      try {
        invoice = await stripe.invoices.retrieve(String(obj.invoice));
      } catch {
        invoice = null;
      }
    }

    const subId = invoice?.subscription ? String(invoice.subscription) : null;
    if (!subId) return;
    const sub = await stripe.subscriptions.retrieve(subId);
    await upsertUserFromSubscription(sub);
  };

  const eventType = String((event as any).type || '');

  switch (eventType) {
    case 'checkout.session.completed': {
      const s = event.data.object as Stripe.Checkout.Session;
      // Stripe may not expand subscription; fetch it when present.
      if (s.subscription) {
        const sub = await stripe.subscriptions.retrieve(String(s.subscription));
        await upsertUserFromSubscription(sub);
      } else {
        // Defensive: if subscription is missing, try to locate the most recent active
        // subscription for the customer and upsert from it.
        const custId = s.customer ? String(s.customer) : null;
        if (custId) {
          const subs = await stripe.subscriptions.list({ customer: custId, status: 'all', limit: 1 });
          const maybe = subs.data?.[0];
          if (maybe) await upsertUserFromSubscription(maybe);
        }
      }
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      await upsertUserFromSubscription(sub);
      break;
    }
    case 'invoice.payment_failed': {
      // Mark the user's subscription status as 'past_due' if we can map it.
      const inv = event.data.object as Stripe.Invoice;
      const subId = inv.subscription ? String(inv.subscription) : null;
      if (subId) {
        await pool.query(
          `UPDATE users SET subscription_status='past_due' WHERE stripe_subscription_id=$1`,
          [subId],
        );
      }
      break;
    }

    // Live mode often emits invoice/invoice_payment events; treat them as a reliable
    // signal to refresh the user's subscription state.
    case 'invoice.paid':
    case 'invoice.payment_succeeded':
    // Newer event naming seen in Workbench/Event Destinations (snapshot payload)
    case 'invoice_payment.paid':
    case 'invoice_payment.succeeded': {
      const obj: any = event.data.object as any;
      await upsertUserFromInvoiceLike(obj);
      break;
    }
    default:
      break;
  }

  return { ok: true };
}

export default router;

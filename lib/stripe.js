'use strict';
/**
 * Stripe Integration — CLAUDE.md §3 (Subscriptions)
 *
 * خطط التسعير:
 *   starter:    $29/شهر — 5 مستخدمين
 *   pro:        $79/شهر — 20 مستخدم
 *   enterprise: $199/شهر — غير محدود
 *
 * CLAUDE.md §4 — BLOCKING: أي تعديل على الأسعار يحتاج موافقة يدوية.
 */
let _stripe = null;

function getStripe() {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY غير موجود في .env');
    _stripe = require('stripe')(key);
  }
  return _stripe;
}

function isConfigured() {
  return !!(process.env.STRIPE_SECRET_KEY);
}

// Price IDs — يجب إنشاؤها في Stripe Dashboard وإضافتها لـ .env
const PRICE_IDS = {
  starter:    process.env.STRIPE_PRICE_STARTER    || null,
  pro:        process.env.STRIPE_PRICE_PRO        || null,
  enterprise: process.env.STRIPE_PRICE_ENTERPRISE || null,
};

/**
 * Create or retrieve a Stripe customer for a tenant.
 */
async function ensureStripeCustomer(tenant) {
  const stripe = getStripe();
  if (tenant.stripeCustomerId) return tenant.stripeCustomerId;

  const customer = await stripe.customers.create({
    email:    tenant.email,
    name:     tenant.name,
    metadata: { tenantId: tenant.tenantId },
  });
  return customer.id;
}

/**
 * Create a Stripe Checkout session for plan upgrade.
 * Redirects user to Stripe-hosted checkout page.
 */
async function createCheckoutSession({ tenantId, plan, email, name, successUrl, cancelUrl }) {
  const stripe   = getStripe();
  const priceId  = PRICE_IDS[plan];

  if (!priceId) throw new Error(`STRIPE_PRICE_${plan.toUpperCase()} غير محدد في .env`);

  const session = await stripe.checkout.sessions.create({
    mode:                'subscription',
    payment_method_types: ['card'],
    customer_email:      email,
    line_items:          [{ price: priceId, quantity: 1 }],
    success_url:         successUrl || `${process.env.APP_URL || 'http://localhost:3000'}/subscription/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url:          cancelUrl  || `${process.env.APP_URL || 'http://localhost:3000'}/subscription/cancel`,
    metadata:            { tenantId, plan },
    subscription_data:   { metadata: { tenantId, plan } },
    allow_promotion_codes: true,
  });

  return { url: session.url, sessionId: session.id };
}

/**
 * Handle Stripe webhook events.
 * Call from POST /api/stripe/webhook
 */
async function handleWebhook(rawBody, signature) {
  const stripe = getStripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET غير محدد في .env');

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, secret);
  } catch (e) {
    throw new Error(`Webhook signature invalid: ${e.message}`);
  }

  return event;
}

/**
 * Cancel a subscription at period end.
 */
async function cancelSubscription(stripeSubscriptionId) {
  const stripe = getStripe();
  return stripe.subscriptions.update(stripeSubscriptionId, { cancel_at_period_end: true });
}

/**
 * Get subscription details from Stripe.
 */
async function getSubscriptionDetails(stripeSubscriptionId) {
  const stripe = getStripe();
  return stripe.subscriptions.retrieve(stripeSubscriptionId);
}

module.exports = {
  isConfigured,
  createCheckoutSession,
  handleWebhook,
  cancelSubscription,
  getSubscriptionDetails,
  PRICE_IDS,
};

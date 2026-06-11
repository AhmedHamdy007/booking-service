const express = require("express");

const config = require("../config");
const stripe = require("../utils/stripe");
const { publish } = require("../events/publisher");
const {
  BOOKING_CONFIRMED,
  BOOKING_BALANCE_PAYMENT_FAILED,
  BOOKING_DEPOSIT_EXPIRED,
  BOOKING_DEPOSIT_PAID,
  BOOKING_PAYMENT_FAILED,
  PAYMENT_CAPTURED,
  PAYMENT_FAILED,
  STYLIST_BOOKING_CONFIRMED,
} = require("../events/eventTypes");
const {
  findBookingByPaymentIntentId,
  findBookingByDepositPaymentIntentId,
  findBookingByBalancePaymentIntentId,
  findBookingPaymentById,
  insertBookingStatusHistory,
  markBookingPaymentFailed,
  markBookingPaymentRefunded,
  markBookingPaymentSucceeded,
  markBookingPayoutFailed,
  markBookingPayoutPaid,
  updateBookingById,
} = require("../repositories/bookingRepository");
const { createPayoutEvent } = require("../repositories/payoutEventRepository");
const {
  createProcessedWebhookEvent,
  findProcessedWebhookEvent,
} = require("../repositories/webhookEventRepository");
const {
  BOOKING_STATUS,
  DEPOSIT_STATUS,
  BALANCE_STATUS,
  assertCanTransition,
  canTransition,
  normalizeBookingStatus,
} = require("../utils/bookingTransitions");
const {
  deauthorizeConnectAccount,
  updateConnectAccountStatus,
} = require("../services/shopClient");

const router = express.Router();

function toIsoString(value) {
  if (!value) return new Date().toISOString();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function bookingConfirmedPayload(booking) {
  return {
    bookingId: booking.id,
    userId: booking.customerUserId,
    shopId: booking.shopId,
    stylistId: booking.stylistUserId,
    serviceId: booking.serviceId,
    scheduledAt: toIsoString(booking.scheduledStart),
    createdAt: toIsoString(booking.createdAt),
  };
}

function paymentFailedPayload(booking) {
  return {
    bookingId: booking.id,
    userId: booking.customerUserId,
    shopId: booking.shopId,
    stylistId: booking.stylistUserId,
    serviceId: booking.serviceId,
    failedAt: new Date().toISOString(),
  };
}

function depositPaidPayload(booking) {
  return {
    bookingId: booking.id,
    userId: booking.customerUserId,
    customerId: booking.customerUserId,
    shopId: booking.shopId,
    stylistId: booking.stylistUserId,
    serviceId: booking.serviceId,
    depositAmount: booking.depositAmount,
    depositPaidAt: toIsoString(booking.depositPaidAt || new Date()),
  };
}

async function publishEvent(req, routingKey, payload) {
  try {
    await publish(routingKey, payload);
  } catch (error) {
    req.logger?.error("Failed to publish webhook-triggered event", {
      request_id: req.id,
      routing_key: routingKey,
      booking_id: payload?.bookingId,
      error: error.message,
    });
  }
}

async function sendBookingConfirmationEmail(req, booking) {
  await publishEvent(req, BOOKING_CONFIRMED, bookingConfirmedPayload(booking));
}

async function sendStylistNotification(req, booking) {
  await publishEvent(req, STYLIST_BOOKING_CONFIRMED, {
    ...bookingConfirmedPayload(booking),
    userId: booking.stylistUserId,
  });
}

async function sendPaymentFailedEmail(req, booking) {
  await publishEvent(req, BOOKING_PAYMENT_FAILED, paymentFailedPayload(booking));
}

async function notifyAdminOfDeauthorization(req, accountId) {
  req.logger?.error("Stripe Connect account deauthorized; admin review required", {
    request_id: req.id,
    stripe_account_id: accountId,
  });
}

function paymentIntentAmount(intent) {
  return Number.parseInt(String(intent.amount_received || intent.amount || 0), 10);
}

function paymentIntentApplicationFee(intent) {
  return Number.parseInt(
    String(intent.application_fee_amount || intent.metadata?.platformFee || 0),
    10
  );
}

function paymentIntentStylistPayout(intent, booking) {
  const metadataPayout = Number.parseInt(String(intent?.metadata?.stylistPayout || ""), 10);
  if (Number.isInteger(metadataPayout) && metadataPayout >= 0) return metadataPayout;

  const amount = paymentIntentAmount(intent);
  const platformFee = paymentIntentApplicationFee(intent);
  return amount > 0 ? Math.max(amount - platformFee, 0) : booking.depositStylistPayout || 0;
}

function isDepositStripeObject(value) {
  const metadata = value?.metadata || {};
  return metadata.type === "deposit";
}

function isBalanceStripeObject(value) {
  return value?.metadata?.type === "balance";
}

function paymentIntentTransferId(intent) {
  const charge = intent?.latest_charge && typeof intent.latest_charge === "object"
    ? intent.latest_charge
    : null;
  return charge?.transfer || null;
}

async function loadVerifiedBookingForIntent(req, intent) {
  const bookingId = intent.metadata?.bookingId;
  const customerId = intent.metadata?.customerId;
  if (!bookingId) {
    req.logger?.warn("Stripe payment intent missing bookingId metadata", {
      request_id: req.id,
      payment_intent_id: intent.id,
    });
    return null;
  }

  const booking = await findBookingPaymentById(bookingId);
  if (!booking) {
    req.logger?.warn("Stripe payment intent references unknown booking", {
      request_id: req.id,
      booking_id: bookingId,
      payment_intent_id: intent.id,
    });
    return null;
  }

  const storedIntentId = isBalanceStripeObject(intent)
    ? (booking.balancePaymentIntentId || booking.paymentIntentId)
    : booking.paymentIntentId;

  if (storedIntentId !== intent.id) {
    req.logger?.warn("Stripe payment intent mismatch blocked", {
      request_id: req.id,
      booking_id: booking.id,
      stored_payment_intent_id: storedIntentId,
      webhook_payment_intent_id: intent.id,
    });
    return null;
  }

  if (customerId && String(booking.customerUserId) !== String(customerId)) {
    req.logger?.warn("Stripe payment intent customer mismatch blocked", {
      request_id: req.id,
      booking_id: booking.id,
      booking_customer_id: booking.customerUserId,
      webhook_customer_id: customerId,
    });
    return null;
  }

  return booking;
}

async function loadVerifiedBookingForDepositIntent(req, intent) {
  const bookingId = intent.metadata?.bookingId;
  const customerId = intent.metadata?.customerId;
  if (!bookingId) {
    req.logger?.warn("Stripe deposit payment intent missing bookingId metadata", {
      request_id: req.id,
      payment_intent_id: intent.id,
    });
    return null;
  }

  const booking = await findBookingPaymentById(bookingId);
  if (!booking) {
    req.logger?.warn("Stripe deposit payment intent references unknown booking", {
      request_id: req.id,
      booking_id: bookingId,
      payment_intent_id: intent.id,
    });
    return null;
  }

  if (booking.depositPaymentIntentId && booking.depositPaymentIntentId !== intent.id) {
    req.logger?.warn("Stripe deposit payment intent mismatch blocked", {
      request_id: req.id,
      booking_id: booking.id,
      stored_deposit_payment_intent_id: booking.depositPaymentIntentId,
      webhook_payment_intent_id: intent.id,
    });
    return null;
  }

  if (customerId && String(booking.customerUserId) !== String(customerId)) {
    req.logger?.warn("Stripe deposit payment intent customer mismatch blocked", {
      request_id: req.id,
      booking_id: booking.id,
      booking_customer_id: booking.customerUserId,
      webhook_customer_id: customerId,
    });
    return null;
  }

  return booking;
}

async function handlePaymentSucceeded(req, event) {
  const intent = event.data.object;
  const booking = await loadVerifiedBookingForIntent(req, intent);
  if (!booking) return;

  const amountPaid = paymentIntentAmount(intent);
  const platformFee = paymentIntentApplicationFee(intent);
  const stylistPayout = Math.max(amountPaid - platformFee, 0);
  const beforeStatus = booking.status;

  if (!isBalanceStripeObject(intent)) {
    req.logger?.warn("Ignoring non-balance payment_intent.succeeded for booking payment handler", {
      request_id: req.id,
      event_id: event.id,
      booking_id: booking.id,
      payment_intent_id: intent.id,
    });
    return;
  }

  assertCanTransition(booking.status, BOOKING_STATUS.COMPLETED);
  const updated = await updateBookingById(booking.id, {
    payment_status: "captured",
    status: BOOKING_STATUS.COMPLETED,
    balance_status: BALANCE_STATUS.PAID,
    balance_payment_intent_id: intent.id,
    balance_platform_fee: platformFee,
    balance_stylist_payout: stylistPayout,
    balance_paid_at: new Date(),
    amount_paid: amountPaid,
    paid_at: new Date(),
    captured_at: new Date(),
  });

  if (!updated) {
    req.logger?.warn("Payment succeeded webhook did not update booking", {
      request_id: req.id,
      booking_id: booking.id,
      payment_intent_id: intent.id,
    });
    return;
  }

  if (beforeStatus !== "completed") {
    await insertBookingStatusHistory({
      bookingId: updated.id,
      fromStatus: beforeStatus || null,
      toStatus: BOOKING_STATUS.COMPLETED,
      changedByUserId: booking.customerUserId,
      changedByRole: "webhook",
      source: "webhook",
      reason: "Payment captured",
    });
  }

  req.logger?.info("Webhook updated booking payment to captured", {
    request_id: req.id,
    event_id: event.id,
    booking_id: updated.id,
    payment_intent_id: intent.id,
    balance_amount: amountPaid,
    platform_fee: platformFee,
    stylist_payout: stylistPayout,
  });

  await publishEvent(req, PAYMENT_CAPTURED, {
    bookingId: updated.id,
    userId: updated.customerUserId,
    customerId: updated.customerUserId,
    stylistId: updated.stylistUserId,
    shopId: updated.shopId,
    amount: amountPaid,
  });
}

async function handleAmountCapturableUpdated(req, event) {
  const intent = event.data.object;
  const booking = await loadVerifiedBookingForIntent(req, intent);
  if (!booking) return;

  if (!isBalanceStripeObject(intent)) return;
  const toStatus = normalizeBookingStatus(booking.status) === BOOKING_STATUS.BALANCE_PENDING
    ? BOOKING_STATUS.BALANCE_PENDING
    : assertCanTransition(booking.status, BOOKING_STATUS.BALANCE_PENDING);
  const updated = await updateBookingById(booking.id, {
    payment_status: "authorized",
    status: toStatus,
    balance_status: BALANCE_STATUS.PENDING,
    balance_payment_intent_id: intent.id,
    balance_platform_fee: paymentIntentApplicationFee(intent),
    balance_stylist_payout: paymentIntentStylistPayout(intent, booking),
    authorized_at: new Date(),
  });

  await insertBookingStatusHistory({
    bookingId: booking.id,
    fromStatus: booking.status || null,
    toStatus,
    changedByUserId: "webhook",
    changedByRole: "webhook",
    source: "webhook",
    reason: "Balance payment authorization succeeded",
  });
}

async function handlePaymentFailed(req, event) {
  const intent = event.data.object;
  const booking = await loadVerifiedBookingForIntent(req, intent);
  if (!booking) return;

  if (!isBalanceStripeObject(intent)) return;

  const currentStatus = normalizeBookingStatus(booking.status);
  const toStatus = BOOKING_STATUS.DEPOSIT_PAID;
  if (currentStatus !== BOOKING_STATUS.DEPOSIT_PAID && !canTransition(currentStatus, toStatus)) {
    req.logger?.warn("Balance payment failure ignored for invalid booking transition", {
      request_id: req.id,
      event_id: event.id,
      booking_id: booking.id,
      from_status: booking.status,
      to_status: toStatus,
      payment_intent_id: intent.id,
    });
    return;
  }

  const updated = await updateBookingById(booking.id, {
    status: toStatus,
    balance_status: BALANCE_STATUS.FAILED,
    balance_payment_intent_id: intent.id,
    payment_status: "failed",
  });

  req.logger?.info("Webhook updated booking payment to failed", {
    request_id: req.id,
    event_id: event.id,
    booking_id: booking.id,
    payment_intent_id: intent.id,
  });

  if (updated) {
    if (currentStatus !== BOOKING_STATUS.DEPOSIT_PAID) {
      await insertBookingStatusHistory({
        bookingId: updated.id,
        fromStatus: booking.status || null,
        toStatus,
        changedByUserId: "webhook",
        changedByRole: "webhook",
        source: "webhook",
        reason: "Balance payment failed; retry allowed",
      });
    }
    await publishEvent(req, BOOKING_BALANCE_PAYMENT_FAILED, {
      bookingId: updated.id,
      userId: updated.customerUserId,
      customerId: updated.customerUserId,
      stylistId: updated.stylistUserId,
      shopId: updated.shopId,
    });
  }
}

async function handleDepositAmountCapturableUpdated(req, event) {
  const intent = event.data.object;
  const booking = await loadVerifiedBookingForDepositIntent(req, intent);
  if (!booking || !booking.depositRequired) return;

  const captured = await captureDepositIntentIfNeeded(intent, booking);
  if (captured?.status !== "succeeded") {
    await updateBookingById(booking.id, {
      deposit_status: DEPOSIT_STATUS.PENDING,
      deposit_payment_intent_id: intent.id,
      deposit_platform_fee: paymentIntentApplicationFee(intent),
      deposit_stylist_payout: Math.max(paymentIntentAmount(intent) - paymentIntentApplicationFee(intent), 0),
    });
    return;
  }

  await markDepositPaidFromStripe({
    req,
    booking,
    intent: captured,
    reason: "Stripe deposit authorization captured",
  });
}

async function handleDepositPaymentSucceeded(req, event) {
  const intent = event.data.object;
  const booking = await loadVerifiedBookingForDepositIntent(req, intent);
  if (!booking || !booking.depositRequired) return;

  await markDepositPaidFromStripe({
    req,
    booking,
    intent,
    reason: "Stripe deposit payment succeeded",
  });
}

async function handleDepositPaymentFailed(req, event) {
  const intent = event.data.object;
  const booking = await loadVerifiedBookingForDepositIntent(req, intent);
  if (!booking || !booking.depositRequired) return;

  assertCanTransition(booking.status, BOOKING_STATUS.DEPOSIT_FAILED);
  const updated = await updateBookingById(booking.id, {
    status: BOOKING_STATUS.DEPOSIT_FAILED,
    deposit_status: DEPOSIT_STATUS.FAILED,
    deposit_payment_intent_id: intent.id,
  });

  await insertBookingStatusHistory({
    bookingId: booking.id,
    fromStatus: booking.status || null,
    toStatus: BOOKING_STATUS.DEPOSIT_FAILED,
    changedByUserId: "webhook",
    changedByRole: "webhook",
    source: "webhook",
    reason: "Stripe deposit payment failed",
  });

  await sendPaymentFailedEmail(req, updated);
}

async function handlePaymentCanceled(req, event) {
  const intent = event.data.object;
  const booking = await loadVerifiedBookingForIntent(req, intent);
  if (!booking) return;

  await updateBookingById(booking.id, {
    payment_status: "refunded",
  });

  req.logger?.info("Webhook marked booking authorization released", {
    request_id: req.id,
    event_id: event.id,
    booking_id: booking.id,
    payment_intent_id: intent.id,
  });
}

/**
 * Resolve the payment intent id from a Stripe Checkout Session object.
 *
 * @param {object} session - Stripe Checkout Session.
 * @returns {string|null} Stripe PaymentIntent id.
 */
function checkoutSessionPaymentIntentId(session) {
  if (!session?.payment_intent) return null;
  return typeof session.payment_intent === "string"
    ? session.payment_intent
    : session.payment_intent.id || null;
}

/**
 * Read a non-negative integer from Stripe metadata.
 *
 * @param {object} source - Stripe object with metadata.
 * @param {string} key - Metadata key.
 * @param {number} fallback - Fallback integer.
 * @returns {number} Parsed integer.
 */
function metadataInteger(source, key, fallback = 0) {
  const value = Number.parseInt(String(source?.metadata?.[key] ?? ""), 10);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

/**
 * Resolve the deposit platform fee from Checkout Session metadata.
 *
 * @param {object} session - Stripe Checkout Session.
 * @param {object} booking - Booking row.
 * @returns {number} Platform fee in sen.
 */
function checkoutSessionPlatformFee(session, booking) {
  return metadataInteger(session, "platformFee", booking.depositPlatformFee || 0);
}

/**
 * Resolve the deposit stylist payout from Checkout Session metadata.
 *
 * @param {object} session - Stripe Checkout Session.
 * @param {object} booking - Booking row.
 * @returns {number} Stylist payout in sen.
 */
function checkoutSessionStylistPayout(session, booking) {
  return metadataInteger(session, "stylistPayout", booking.depositStylistPayout || 0);
}

async function retrieveDepositPaymentIntent(session) {
  const intentId = checkoutSessionPaymentIntentId(session);
  if (!intentId) return null;
  return stripe.paymentIntents.retrieve(intentId, {
    expand: ["latest_charge"],
  });
}

async function captureDepositIntentIfNeeded(intent, booking) {
  if (!intent) return null;
  if (intent.status !== "requires_capture") return intent;

  await stripe.paymentIntents.capture(
    intent.id,
    {},
    { idempotencyKey: `capture-deposit-${booking.id}` }
  );

  return stripe.paymentIntents.retrieve(intent.id, {
    expand: ["latest_charge"],
  });
}

async function markDepositPaidFromStripe({ req, booking, session = null, intent = null, reason }) {
  if (booking.depositPaid && normalizeBookingStatus(booking.status) === BOOKING_STATUS.DEPOSIT_PAID && booking.depositStatus === DEPOSIT_STATUS.PAID) {
    req.logger?.info("Deposit payment already applied", {
      request_id: req.id,
      booking_id: booking.id,
      checkout_session_id: session?.id,
      payment_intent_id: intent?.id,
    });
    return booking;
  }

  assertCanTransition(booking.status, BOOKING_STATUS.DEPOSIT_PAID);
  const updated = await updateBookingById(booking.id, {
    status: BOOKING_STATUS.DEPOSIT_PAID,
    deposit_paid: true,
    deposit_paid_at: new Date(),
    deposit_status: DEPOSIT_STATUS.PAID,
    deposit_stripe_session_id: session?.id || booking.depositStripeSessionId,
    deposit_payment_intent_id: intent?.id || checkoutSessionPaymentIntentId(session) || booking.depositPaymentIntentId,
    deposit_platform_fee: session
      ? checkoutSessionPlatformFee(session, booking)
      : intent
      ? paymentIntentApplicationFee(intent) || booking.depositPlatformFee
      : booking.depositPlatformFee,
    deposit_stylist_payout: session
      ? checkoutSessionStylistPayout(session, booking)
      : intent
      ? paymentIntentStylistPayout(intent, booking)
      : booking.depositStylistPayout,
    deposit_transfer_id: paymentIntentTransferId(intent) || booking.depositTransferId,
  });

  await insertBookingStatusHistory({
    bookingId: booking.id,
    fromStatus: booking.status || null,
    toStatus: BOOKING_STATUS.DEPOSIT_PAID,
    changedByUserId: "webhook",
    changedByRole: "webhook",
    source: "webhook",
    reason,
  });

  await publishEvent(req, BOOKING_DEPOSIT_PAID, depositPaidPayload(updated));
  return updated;
}

/**
 * Load and verify the booking referenced by Stripe Checkout Session metadata.
 *
 * @param {object} req - Express request, used for request logging.
 * @param {object} session - Stripe Checkout Session.
 * @returns {Promise<object|null>} Matching booking, or null when invalid.
 */
async function loadVerifiedBookingForCheckoutSession(req, session) {
  const bookingId = session.metadata?.bookingId;
  const customerId = session.metadata?.customerId;
  if (!bookingId) {
    req.logger?.warn("Stripe checkout session missing bookingId metadata", {
      request_id: req.id,
      checkout_session_id: session.id,
    });
    return null;
  }

  const booking = await findBookingPaymentById(bookingId);
  if (!booking) {
    req.logger?.warn("Stripe checkout session references unknown booking", {
      request_id: req.id,
      booking_id: bookingId,
      checkout_session_id: session.id,
    });
    return null;
  }

  if (booking.depositStripeSessionId && booking.depositStripeSessionId !== session.id) {
    req.logger?.warn("Stripe checkout session mismatch blocked", {
      request_id: req.id,
      booking_id: booking.id,
      stored_checkout_session_id: booking.depositStripeSessionId,
      webhook_checkout_session_id: session.id,
    });
    return null;
  }

  if (customerId && String(booking.customerUserId) !== String(customerId)) {
    req.logger?.warn("Stripe checkout session customer mismatch blocked", {
      request_id: req.id,
      booking_id: booking.id,
      booking_customer_id: booking.customerUserId,
      webhook_customer_id: customerId,
    });
    return null;
  }

  return booking;
}

/**
 * Confirm a booking only after Stripe reports the deposit Checkout Session completed.
 *
 * @param {object} req - Express request.
 * @param {object} event - Verified Stripe webhook event.
 * @returns {Promise<void>}
 */
async function handleCheckoutSessionCompleted(req, event) {
  const session = event.data.object;
  if (!isDepositStripeObject(session)) return;

  const booking = await loadVerifiedBookingForCheckoutSession(req, session);
  if (!booking || !booking.depositRequired) return;

  let intent = await retrieveDepositPaymentIntent(session);
  intent = await captureDepositIntentIfNeeded(intent, booking);

  if (session.payment_status !== "paid" && intent?.status !== "succeeded") {
    req.logger?.warn("Completed Stripe deposit checkout is not paid yet", {
      request_id: req.id,
      event_id: event.id,
      checkout_session_id: session.id,
      payment_status: session.payment_status,
      payment_intent_status: intent?.status,
    });
    await updateBookingById(booking.id, {
      deposit_status: DEPOSIT_STATUS.PENDING,
      deposit_stripe_session_id: session.id,
      deposit_payment_intent_id: intent?.id || checkoutSessionPaymentIntentId(session),
      deposit_platform_fee: checkoutSessionPlatformFee(session, booking),
      deposit_stylist_payout: checkoutSessionStylistPayout(session, booking),
    });
    return;
  }

  await markDepositPaidFromStripe({
    req,
    booking,
    session,
    intent,
    reason: "Stripe deposit checkout completed",
  });
}

/**
 * Mark an unpaid deposit booking as failed after its Stripe Checkout Session expires.
 *
 * @param {object} req - Express request.
 * @param {object} event - Verified Stripe webhook event.
 * @returns {Promise<void>}
 */
async function handleCheckoutSessionExpired(req, event) {
  const session = event.data.object;
  if (!isDepositStripeObject(session)) return;
  const booking = await loadVerifiedBookingForCheckoutSession(req, session);
  if (!booking || booking.depositPaid || !booking.depositRequired) return;

  assertCanTransition(booking.status, BOOKING_STATUS.DEPOSIT_EXPIRED);
  const updated = await updateBookingById(booking.id, {
    status: BOOKING_STATUS.DEPOSIT_EXPIRED,
    deposit_status: DEPOSIT_STATUS.EXPIRED,
    deposit_stripe_session_id: session.id,
    deposit_payment_intent_id: checkoutSessionPaymentIntentId(session),
    deposit_platform_fee: checkoutSessionPlatformFee(session, booking),
    deposit_stylist_payout: checkoutSessionStylistPayout(session, booking),
  });

  await insertBookingStatusHistory({
    bookingId: booking.id,
    fromStatus: booking.status || null,
    toStatus: BOOKING_STATUS.DEPOSIT_EXPIRED,
    changedByUserId: "webhook",
    changedByRole: "webhook",
    source: "webhook",
    reason: "Stripe deposit checkout expired",
  });

  req.logger?.info("Deposit checkout session expired", {
    request_id: req.id,
    event_id: event.id,
    booking_id: updated.id,
    checkout_session_id: session.id,
  });

  await publishEvent(req, BOOKING_DEPOSIT_EXPIRED, {
    bookingId: updated.id,
    userId: updated.customerUserId,
    customerId: updated.customerUserId,
    stylistId: updated.stylistUserId,
    shopId: updated.shopId,
    serviceId: updated.serviceId,
  });
}

async function handleChargeRefunded(req, event) {
  const charge = event.data.object;
  let bookingId = charge.metadata?.bookingId;
  if (!bookingId && charge.payment_intent) {
    const booking = await findBookingByPaymentIntentId(charge.payment_intent);
    bookingId = booking?.id;
  }
  if (!bookingId) return;

  const refundId = charge.refunds?.data?.[0]?.id || null;
  await markBookingPaymentRefunded({ bookingId, refundId });
  req.logger?.info("Webhook updated booking payment to refunded", {
    request_id: req.id,
    event_id: event.id,
    booking_id: bookingId,
    refund_id: refundId,
  });
}

async function handleDepositChargeRefunded(req, event) {
  const charge = event.data.object;
  let booking = null;
  const bookingId = charge.metadata?.bookingId;
  if (bookingId) {
    booking = await findBookingPaymentById(bookingId);
  }
  if (!booking && charge.payment_intent) {
    booking = await findBookingByDepositPaymentIntentId(charge.payment_intent);
  }
  if (!booking || !booking.depositRequired) return;

  await updateBookingById(booking.id, {
    deposit_status: "REFUNDED",
  });

  req.logger?.info("Webhook updated booking deposit to refunded", {
    request_id: req.id,
    event_id: event.id,
    booking_id: booking.id,
    payment_intent_id: charge.payment_intent,
  });
}

async function handleAccountUpdated(req, event) {
  const account = event.data.object;
  const payoutsEnabled = Boolean(account.payouts_enabled);
  const chargesEnabled = Boolean(account.charges_enabled);
  const upstream = await updateConnectAccountStatus({
    stripeAccountId: account.id,
    payoutsEnabled,
    chargesEnabled,
    stripeOnboardingDone: payoutsEnabled && chargesEnabled,
    requestId: req.id,
  });

  req.logger?.info("Webhook updated Stripe Connect account status", {
    request_id: req.id,
    event_id: event.id,
    stripe_account_id: account.id,
    payouts_enabled: payoutsEnabled,
    charges_enabled: chargesEnabled,
    shop_service_status: upstream.status,
  });
}

async function handleAccountDeauthorized(req, event) {
  const account = event.data.object;
  const accountId = account.account || account.id;
  if (!accountId) return;

  const upstream = await deauthorizeConnectAccount({
    stripeAccountId: accountId,
    requestId: req.id,
  });

  req.logger?.warn("Webhook cleared deauthorized Stripe Connect account", {
    request_id: req.id,
    event_id: event.id,
    stripe_account_id: accountId,
    shop_service_status: upstream.status,
  });
  await notifyAdminOfDeauthorization(req, accountId);
}

async function logPayoutEvent(bookingId, stylistId, eventType, amount, stripeEventId, metadata = null) {
  await createPayoutEvent({
    bookingId,
    stylistId: stylistId || "unknown",
    eventType,
    amount,
    stripeEventId,
    metadata,
  });
}

/**
 * Process a verified Stripe webhook event after the HTTP response is acknowledged.
 *
 * @param {object} req - Express request with logger and request id.
 * @param {object} event - Verified Stripe event.
 * @returns {Promise<void>}
 */
async function processStripeWebhookEvent(req, event) {
  const alreadyProcessed = await findProcessedWebhookEvent(event.id);
  if (alreadyProcessed) {
    req.logger?.info("Stripe webhook skipped because it was already processed", {
      request_id: req.id,
      event_id: event.id,
      event_type: event.type,
    });
    return;
  }

  const claimedEvent = await createProcessedWebhookEvent({
    eventId: event.id,
    eventType: event.type,
    processedAt: new Date(),
  });
  if (!claimedEvent) {
    req.logger?.info("Stripe webhook skipped because another worker claimed it", {
      request_id: req.id,
      event_id: event.id,
      event_type: event.type,
    });
    return;
  }

  switch (event.type) {
    case "checkout.session.completed":
      await handleCheckoutSessionCompleted(req, event);
      break;

    case "checkout.session.expired":
      await handleCheckoutSessionExpired(req, event);
      break;

    case "payment_intent.amount_capturable_updated":
      if (isDepositStripeObject(event.data.object)) {
        await handleDepositAmountCapturableUpdated(req, event);
      } else {
        await handleAmountCapturableUpdated(req, event);
      }
      break;

    case "payment_intent.succeeded":
      if (isDepositStripeObject(event.data.object)) {
        await handleDepositPaymentSucceeded(req, event);
      } else {
        await handlePaymentSucceeded(req, event);
      }
      break;

    case "payment_intent.canceled":
      await handlePaymentCanceled(req, event);
      break;

    case "payment_intent.payment_failed":
      if (isDepositStripeObject(event.data.object)) {
        await handleDepositPaymentFailed(req, event);
      } else {
        await handlePaymentFailed(req, event);
      }
      break;

    case "charge.refunded":
      if (isDepositStripeObject(event.data.object)) {
        await handleDepositChargeRefunded(req, event);
      } else {
        await handleChargeRefunded(req, event);
      }
      break;

    case "account.updated":
      await handleAccountUpdated(req, event);
      break;

    case "account.application.deauthorized":
      await handleAccountDeauthorized(req, event);
      break;

    case "transfer.created": {
      const transfer = event.data.object;
      const bookingId = transfer.metadata?.bookingId;
      if (bookingId) {
        await logPayoutEvent(
          bookingId,
          transfer.metadata?.stylistId,
          "transfer_created",
          transfer.amount,
          event.id,
          { transferId: transfer.id }
        );
      }
      break;
    }

    case "transfer.paid": {
      const transfer = event.data.object;
      const bookingId = transfer.metadata?.bookingId;
      if (bookingId) {
        await markBookingPayoutPaid({ bookingId });
        await logPayoutEvent(
          bookingId,
          transfer.metadata?.stylistId,
          "payout_completed",
          transfer.amount,
          event.id,
          { transferId: transfer.id }
        );
      }
      break;
    }

    case "transfer.failed": {
      const transfer = event.data.object;
      const bookingId = transfer.metadata?.bookingId;
      if (bookingId) {
        await markBookingPayoutFailed({ bookingId });
        await logPayoutEvent(
          bookingId,
          transfer.metadata?.stylistId,
          "payout_failed",
          transfer.amount,
          event.id,
          { transferId: transfer.id }
        );
      }
      break;
    }

    default:
      req.logger?.info("Unhandled Stripe webhook event type", {
        request_id: req.id,
        event_id: event.id,
        event_type: event.type,
      });
      break;
  }

}

router.post(
  "/webhooks/stripe",
  express.raw({ type: "application/json", limit: "1mb" }),
  async (req, res) => {
    if (!stripe || !config.stripeWebhookSecret) {
      req.logger?.error("Stripe webhook is not configured", { request_id: req.id });
      return res.status(500).send("Stripe webhook is not configured");
    }

    const signature = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(req.body, signature, config.stripeWebhookSecret);
    } catch (error) {
      req.logger?.warn("Webhook signature failed", {
        request_id: req.id,
        error: error.message,
      });
      return res.status(400).send(`Webhook Error: ${error.message}`);
    }

    req.logger?.info("Stripe webhook received", {
      request_id: req.id,
      event_id: event.id,
      event_type: event.type,
    });

    setImmediate(() => {
      processStripeWebhookEvent(req, event).catch((error) => {
        req.logger?.error("Stripe webhook handler error", {
          request_id: req.id,
          event_id: event?.id,
          event_type: event?.type,
          error: error.message,
        });
      });
    });

    return res.status(200).json({ received: true });
  }
);

module.exports = router;

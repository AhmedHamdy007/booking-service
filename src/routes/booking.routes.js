const express = require("express");
const crypto = require("crypto");
const config = require("../config");
const { healthCheck } = require("../db/pool");
const { requireAuth, requireRole } = require("../middleware/auth");
const { customerOnly } = require("../middleware/customerOnly");
const {
  ValidationError,
  validateDateOnly,
  validateListLimit,
  validateRequiredIdentifier,
  normalizeCancelPayload,
  normalizeCreateBookingPayload,
  normalizeReschedulePayload,
  normalizeStatusUpdatePayload,
} = require("../utils/validation");
const stripe = require("../utils/stripe");
const { amountInMinorUnit } = require("../utils/money");
const {
  BOOKING_STATUS,
  DEPOSIT_STATUS,
  BALANCE_STATUS,
  assertCanTransition,
  canTransition,
  isBlockingStatus,
  normalizeBookingStatus,
} = require("../utils/bookingTransitions");
const {
  createBooking,
  findBookingById,
  findBookingPaymentById,
  findStripeCustomerIdForCustomer,
  listBookingsByIds,
  listBookingsByCustomer,
  listBookingsByStylist,
  listBookingsByShop,
  findOverlappingBooking,
  updateBookingById,
  insertBookingStatusHistory,
  listBookingStatusHistory,
  listBlockingBookingsForStylistOnDate,
} = require("../repositories/bookingRepository");
const {
  getShopBookingContext,
  getShopSummary,
  getStylistConnectAccount,
} = require("../services/shopClient");
const { publish } = require("../events/publisher");
const {
  BOOKING_ACCEPTED,
  BOOKING_CANCELLED,
  BOOKING_CANCELLED_FORFEITED,
  BOOKING_CANCELLED_REFUNDED,
  BOOKING_COMPLETED,
  BOOKING_DEPOSIT_PAID,
  BOOKING_DISPUTED,
  BOOKING_REJECTED,
} = require("../events/eventTypes");

const router = express.Router();

const DEFAULT_SLOT_INTERVAL_MINUTES = 30;
const DEFAULT_OPEN_HOUR = 9;
const DEFAULT_CLOSE_HOUR = 19;
const CANCELLATION_REFUND_WINDOW_MS = 7 * 60 * 60 * 1000;

function sameId(a, b) {
  if (a === undefined || a === null || b === undefined || b === null) return false;
  return String(a) === String(b);
}

function errorResponse(res, status, message, requestId) {
  return res.status(status).json({
    success: false,
    error: message,
    message,
    request_id: requestId,
  });
}

function requireStripePayoutClient(res, requestId) {
  if (!stripe) {
    errorResponse(res, 503, "Payouts are not configured", requestId);
    return null;
  }
  return stripe;
}

function withMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

/**
 * Calculate a 10% deposit in Stripe's smallest currency unit.
 *
 * @param {number|string} price - Service price in MYR.
 * @returns {number} Deposit amount in sen.
 */
function calculateDepositAmount(price) {
  const total = amountInMinorUnit(price);
  return Math.floor(total * 0.1);
}

/**
 * Convert a deposit amount from MYR to Stripe's smallest currency unit.
 *
 * @param {object} booking - Booking row with a depositAmount field.
 * @returns {number} Deposit amount in sen.
 */
function depositAmountInMinorUnit(booking) {
  const amount = Number.parseInt(String(booking?.depositAmount || 0), 10);
  return Number.isInteger(amount) ? amount : 0;
}

function bookingTransferGroup(bookingId) {
  return `booking_${bookingId}`;
}

function cancellationDeadlineFor(scheduledStart) {
  return new Date(new Date(scheduledStart).getTime() - CANCELLATION_REFUND_WINDOW_MS);
}

function isDepositRefundableAtCreation(scheduledStart) {
  return cancellationDeadlineFor(scheduledStart).getTime() >= Date.now();
}

/**
 * Return the configured Stripe client or write a safe 503 response.
 *
 * @param {object} res - Express response.
 * @param {string} requestId - Request correlation id.
 * @returns {object|null} Stripe client.
 */
function requireStripeCheckoutClient(res, requestId) {
  if (!stripe) {
    errorResponse(res, 503, "Deposit payments are not configured", requestId);
    return null;
  }
  return stripe;
}

/**
 * Build frontend redirect URLs for Stripe Checkout completion/cancellation.
 *
 * @param {string} bookingId - Booking id.
 * @returns {{successUrl: string, cancelUrl: string}} Checkout redirect URLs.
 */
function buildDepositCheckoutUrls(bookingId) {
  const success = new URL(`/bookings/${encodeURIComponent(bookingId)}`, config.clientUrl);
  success.searchParams.set("payment", "success");

  const cancel = new URL(`/bookings/${encodeURIComponent(bookingId)}`, config.clientUrl);
  cancel.searchParams.set("payment", "cancelled");

  return {
    successUrl: success.toString(),
    cancelUrl: cancel.toString(),
  };
}

/**
 * Fetch a still-open Stripe Checkout Session so repeated clicks reuse it.
 *
 * @param {object} client - Stripe client.
 * @param {object} booking - Booking row.
 * @returns {Promise<object|null>} Reusable Checkout Session, if one exists.
 */
async function retrieveReusableDepositSession(client, booking) {
  if (!booking?.depositStripeSessionId) return null;

  try {
    const session = await client.checkout.sessions.retrieve(booking.depositStripeSessionId, {
      expand: ["payment_intent.latest_charge"],
    });
    if (
      session?.status === "open" &&
      session?.url &&
      session.metadata?.type === "deposit"
    ) {
      return session;
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Convert configured platform fee percent to a decimal fraction.
 *
 * @returns {number} Platform fee fraction, e.g. 0.1 for 10%.
 */
function stripePlatformFeeFraction() {
  const percent = Number(config.stripePlatformFeePercent);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new Error("STRIPE_PLATFORM_FEE_PERCENT must be a number between 0 and 100");
  }
  return percent / 100;
}

/**
 * Calculate deposit, platform fee, and stylist payout in sen.
 *
 * @param {object} booking - Booking row with a deposit amount.
 * @returns {{amount: number, platformFee: number, stylistPayout: number}} Connect split amounts.
 */
function depositConnectAmounts(booking) {
  const amount = depositAmountInMinorUnit(booking);
  if (!Number.isInteger(amount) || amount <= 0) {
    const error = new Error("Booking deposit amount must be a positive value");
    error.status = 400;
    throw error;
  }

  const platformFee = Math.floor(amount * stripePlatformFeeFraction());
  return {
    amount,
    platformFee,
    stylistPayout: Math.max(amount - platformFee, 0),
  };
}

/**
 * Reuse or create the Stripe customer used for the deposit Checkout Session.
 *
 * @param {object} client - Stripe client.
 * @param {object} booking - Booking row.
 * @param {object} user - Authenticated customer.
 * @returns {Promise<string>} Stripe customer id.
 */
async function resolveDepositStripeCustomerId(client, booking, user) {
  const existingCustomerId =
    booking.stripeCustomerId || (await findStripeCustomerIdForCustomer(user.id));

  if (existingCustomerId) return existingCustomerId;

  const customer = await client.customers.create(
    {
      email: user.email || undefined,
      name: user.name || undefined,
      metadata: {
        customerId: user.id,
      },
    },
    { idempotencyKey: `stripe-customer-${user.id}` }
  );

  return customer.id;
}

/**
 * Load and validate the stylist's Stripe Connect destination account.
 *
 * @param {object} params - Lookup params.
 * @param {string} params.stylistUserId - Stylist user id.
 * @param {string} params.requestId - Request correlation id.
 * @returns {Promise<object>} Connected account profile.
 */
async function requireReadyDepositConnectAccount({ stylistUserId, requestId }) {
  const upstream = await getStylistConnectAccount({ stylistUserId, requestId });
  if (upstream.status !== 200) {
    const error = new Error("Stylist payment account not ready");
    error.status = 400;
    throw error;
  }

  const account = upstream.body?.data;
  if (!account?.stripeAccountId || account.chargesEnabled !== true) {
    const error = new Error("Stylist payment account not ready");
    error.status = 400;
    throw error;
  }

  return account;
}

/**
 * Create a Stripe-hosted Checkout Session for a booking deposit.
 *
 * @param {object} params - Checkout creation params.
 * @param {object} params.client - Stripe client.
 * @param {object} params.booking - Booking row.
 * @param {object} params.enrichedBooking - Booking enriched with stylist/shop context.
 * @param {object} params.user - Authenticated customer.
 * @param {string} params.requestId - Request correlation id.
 * @returns {Promise<object>} Stripe Checkout Session.
 */
async function createDepositCheckoutSession({ client, booking, enrichedBooking, user, requestId }) {
  const { amount, platformFee, stylistPayout } = depositConnectAmounts(booking);
  const [stylistAccount, stripeCustomerId] = await Promise.all([
    requireReadyDepositConnectAccount({
      stylistUserId: booking.stylistUserId,
      requestId,
    }),
    resolveDepositStripeCustomerId(client, booking, user),
  ]);
  const stylistName = enrichedBooking?.stylistName || enrichedBooking?.stylist?.displayName || "your stylist";
  const serviceName = booking.serviceName || enrichedBooking?.serviceOffering?.name || "Appointment";
  const { successUrl, cancelUrl } = buildDepositCheckoutUrls(booking.id);

  const session = await client.checkout.sessions.create(
    {
      mode: "payment",
      payment_method_types: ["card"],
      customer: stripeCustomerId,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: booking.currency || "myr",
            unit_amount: amount,
            product_data: {
              name: `Deposit - ${serviceName} with ${stylistName}`,
              description: "10% booking deposit",
            },
          },
        },
      ],
      payment_intent_data: {
        capture_method: "manual",
        application_fee_amount: platformFee,
        transfer_data: {
          destination: stylistAccount.stripeAccountId,
        },
        transfer_group: bookingTransferGroup(booking.id),
        metadata: {
          bookingId: String(booking.id),
          customerId: String(booking.customerUserId),
          stylistId: String(booking.stylistUserId),
          type: "deposit",
          paymentKind: "deposit",
          totalAmount: String(booking.amountTotal),
          depositAmount: String(amount),
          platformFee: String(platformFee),
          stylistPayout: String(stylistPayout),
        },
      },
      metadata: {
        bookingId: String(booking.id),
        customerId: String(booking.customerUserId),
        stylistId: String(booking.stylistUserId),
        type: "deposit",
        totalAmount: String(booking.amountTotal || 0),
        depositAmount: String(amount),
        platformFee: String(platformFee),
        stylistPayout: String(stylistPayout),
      },
      success_url: successUrl,
      cancel_url: cancelUrl,
    },
    {
      idempotencyKey: `deposit_session_${booking.id}`,
    }
  );

  return {
    session,
    stripeCustomerId,
    depositPlatformFee: platformFee,
    depositStylistPayout: stylistPayout,
  };
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
 * Retrieve the Stripe Checkout Session stored on the booking.
 *
 * @param {object} client - Stripe client.
 * @param {object} booking - Booking row.
 * @returns {Promise<object|null>} Stripe Checkout Session if one exists.
 */
async function retrieveStoredDepositSession(client, booking) {
  if (!booking?.depositStripeSessionId) return null;
  return client.checkout.sessions.retrieve(booking.depositStripeSessionId, {
    expand: ["payment_intent.latest_charge"],
  });
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
 * Return the expanded PaymentIntent from a Checkout Session.
 *
 * @param {object} session - Stripe Checkout Session.
 * @returns {object|null} Expanded PaymentIntent, if present.
 */
function checkoutSessionPaymentIntent(session) {
  return session?.payment_intent && typeof session.payment_intent === "object"
    ? session.payment_intent
    : null;
}

/**
 * Resolve a destination transfer id from an expanded Stripe PaymentIntent.
 *
 * @param {object|null} intent - Stripe PaymentIntent.
 * @returns {string|null} Stripe transfer id.
 */
function paymentIntentTransferId(intent) {
  const charge = intent?.latest_charge && typeof intent.latest_charge === "object"
    ? intent.latest_charge
    : null;
  return charge?.transfer || null;
}

/**
 * Capture the manual deposit authorization when Stripe Checkout has completed.
 *
 * @param {object} client - Stripe client.
 * @param {object} session - Stripe Checkout Session.
 * @param {object} booking - Booking row.
 * @returns {Promise<object|null>} Captured or current PaymentIntent.
 */
async function captureDepositIntentIfNeeded(client, session, booking) {
  const intentId = checkoutSessionPaymentIntentId(session);
  if (!intentId) return null;

  let intent = checkoutSessionPaymentIntent(session);
  if (!intent || typeof intent.latest_charge === "string") {
    intent = await client.paymentIntents.retrieve(intentId, {
      expand: ["latest_charge"],
    });
  }

  if (intent?.status === "requires_capture") {
    await client.paymentIntents.capture(
      intent.id,
      {},
      { idempotencyKey: `capture-deposit-${booking.id}` }
    );
    return client.paymentIntents.retrieve(intent.id, {
      expand: ["latest_charge"],
    });
  }

  return intent;
}

/**
 * Resolve the destination transfer id from an expanded Checkout Session.
 *
 * @param {object} session - Stripe Checkout Session.
 * @returns {string|null} Stripe transfer id.
 */
function checkoutSessionTransferId(session) {
  const intent = checkoutSessionPaymentIntent(session);
  const charge = intent?.latest_charge && typeof intent.latest_charge === "object"
    ? intent.latest_charge
    : null;
  return charge?.transfer || null;
}

/**
 * Resolve the deposit platform fee from Stripe session/payment data.
 *
 * @param {object} session - Stripe Checkout Session.
 * @param {object} booking - Booking row.
 * @returns {number} Platform fee in sen.
 */
function checkoutSessionPlatformFee(session, booking) {
  const intent = checkoutSessionPaymentIntent(session);
  const fromIntent = Number.parseInt(String(intent?.application_fee_amount ?? ""), 10);
  if (Number.isInteger(fromIntent) && fromIntent >= 0) return fromIntent;
  return metadataInteger(session, "platformFee", booking.depositPlatformFee || 0);
}

/**
 * Resolve the deposit stylist payout from Stripe session metadata.
 *
 * @param {object} session - Stripe Checkout Session.
 * @param {object} booking - Booking row.
 * @returns {number} Stylist payout in sen.
 */
function checkoutSessionStylistPayout(session, booking) {
  return metadataInteger(session, "stylistPayout", booking.depositStylistPayout || 0);
}

/**
 * Build the event payload emitted after a deposit is verified as paid.
 *
 * @param {object} booking - Updated booking row.
 * @returns {object} Event payload.
 */
function bookingDepositPaidPayload(booking) {
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

/**
 * Reconcile a stored Stripe Checkout Session with the booking state.
 *
 * This is a safe local/dev fallback for cases where the webhook is delayed or
 * cannot reach localhost. The client never supplies payment status; the server
 * reads the stored session from Stripe and updates only when Stripe says paid.
 *
 * @param {object} params - Reconciliation params.
 * @param {object} params.req - Express request for logging.
 * @param {object} params.client - Stripe client.
 * @param {object} params.booking - Booking row.
 * @returns {Promise<object>} Updated or unchanged booking.
 */
async function reconcileDepositCheckoutSession({ req, client, booking }) {
  const session = await retrieveStoredDepositSession(client, booking);
  if (!session) return booking;

  if (session.payment_status === "paid") {
    const depositIntent = await captureDepositIntentIfNeeded(client, session, booking);
    if (booking.depositPaid && normalizeBookingStatus(booking.status) === BOOKING_STATUS.DEPOSIT_PAID) return booking;
    assertCanTransition(booking.status, BOOKING_STATUS.DEPOSIT_PAID);

    const updated = await updateBookingById(booking.id, {
      status: BOOKING_STATUS.DEPOSIT_PAID,
      deposit_paid: true,
      deposit_paid_at: new Date(),
      deposit_status: DEPOSIT_STATUS.PAID,
      deposit_stripe_session_id: session.id,
      deposit_payment_intent_id: checkoutSessionPaymentIntentId(session),
      deposit_platform_fee: checkoutSessionPlatformFee(session, booking),
      deposit_stylist_payout: checkoutSessionStylistPayout(session, booking),
      deposit_transfer_id: paymentIntentTransferId(depositIntent) || checkoutSessionTransferId(session),
    });

    await insertBookingStatusHistory({
      bookingId: booking.id,
      fromStatus: booking.status || null,
      toStatus: BOOKING_STATUS.DEPOSIT_PAID,
      changedByUserId: "stripe-sync",
      changedByRole: "system",
      source: "stripe-sync",
      reason: "Stripe deposit checkout reconciled",
    });

    await publishBookingEvent(req, BOOKING_DEPOSIT_PAID, bookingDepositPaidPayload(updated));
    return updated;
  }

  const depositIntent = await captureDepositIntentIfNeeded(client, session, booking);
  if (depositIntent?.status === "succeeded") {
    if (booking.depositPaid && normalizeBookingStatus(booking.status) === BOOKING_STATUS.DEPOSIT_PAID) return booking;
    assertCanTransition(booking.status, BOOKING_STATUS.DEPOSIT_PAID);

    const updated = await updateBookingById(booking.id, {
      status: BOOKING_STATUS.DEPOSIT_PAID,
      deposit_paid: true,
      deposit_paid_at: new Date(),
      deposit_status: DEPOSIT_STATUS.PAID,
      deposit_stripe_session_id: session.id,
      deposit_payment_intent_id: depositIntent.id,
      deposit_platform_fee: checkoutSessionPlatformFee(session, booking),
      deposit_stylist_payout: checkoutSessionStylistPayout(session, booking),
      deposit_transfer_id: paymentIntentTransferId(depositIntent) || checkoutSessionTransferId(session),
    });

    await insertBookingStatusHistory({
      bookingId: booking.id,
      fromStatus: booking.status || null,
      toStatus: BOOKING_STATUS.DEPOSIT_PAID,
      changedByUserId: "stripe-sync",
      changedByRole: "system",
      source: "stripe-sync",
      reason: "Stripe deposit checkout reconciled",
    });

    await publishBookingEvent(req, BOOKING_DEPOSIT_PAID, bookingDepositPaidPayload(updated));
    return updated;
  }

  if (session.status === "expired" && !booking.depositPaid && normalizeBookingStatus(booking.status) !== BOOKING_STATUS.DEPOSIT_EXPIRED) {
    assertCanTransition(booking.status, BOOKING_STATUS.DEPOSIT_EXPIRED);
    const updated = await updateBookingById(booking.id, {
      status: BOOKING_STATUS.DEPOSIT_EXPIRED,
      deposit_status: DEPOSIT_STATUS.EXPIRED,
      deposit_stripe_session_id: session.id,
      deposit_payment_intent_id: checkoutSessionPaymentIntentId(session),
      deposit_platform_fee: checkoutSessionPlatformFee(session, booking),
      deposit_stylist_payout: checkoutSessionStylistPayout(session, booking),
      deposit_transfer_id: checkoutSessionTransferId(session),
    });

    await insertBookingStatusHistory({
      bookingId: booking.id,
      fromStatus: booking.status || null,
      toStatus: BOOKING_STATUS.DEPOSIT_EXPIRED,
      changedByUserId: "stripe-sync",
      changedByRole: "system",
      source: "stripe-sync",
      reason: "Stripe deposit checkout expired",
    });

    return updated;
  }

  return booking;
}

function formatShopAddress(shop) {
  if (!shop) return null;
  return [shop.addressLine1, shop.city, shop.country].filter(Boolean).join(", ") || null;
}

function toIsoString(value) {
  if (!value) return new Date().toISOString();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

async function publishBookingEvent(req, routingKey, payload) {
  try {
    await publish(routingKey, payload);
  } catch (error) {
    req.logger?.error("Failed to publish booking event", {
      request_id: req.id,
      routing_key: routingKey,
      error: error.message,
    });
  }
}

function bookingCancelledPayload(booking, reason) {
  return {
    bookingId: booking.id,
    userId: booking.customerUserId,
    shopId: booking.shopId,
    stylistId: booking.stylistUserId,
    reason: reason || "Booking cancelled",
    cancelledBy: booking.cancelledBy,
    cancelledAt: toIsoString(booking.cancelledAt || new Date()),
  };
}

function bookingAcceptedPayload(booking) {
  return {
    bookingId: booking.id,
    userId: booking.customerUserId,
    shopId: booking.shopId,
    stylistId: booking.stylistUserId,
    acceptedAt: toIsoString(booking.stylistAcceptedAt || new Date()),
  };
}

function bookingRejectedPayload(booking) {
  return {
    bookingId: booking.id,
    userId: booking.customerUserId,
    shopId: booking.shopId,
    stylistId: booking.stylistUserId,
    reason: booking.rejectionReason || "Stylist declined this booking",
    rejectedAt: toIsoString(booking.stylistRejectedAt || new Date()),
  };
}

function bookingCompletedPayload(booking) {
  return {
    bookingId: booking.id,
    userId: booking.customerUserId,
    shopId: booking.shopId,
    stylistId: booking.stylistUserId,
    completedAt: toIsoString(booking.updatedAt || new Date()),
  };
}

function bookingDisputedPayload(booking) {
  return {
    bookingId: booking.id,
    disputeId: booking.disputeId,
    userId: booking.customerUserId,
    shopId: booking.shopId,
    stylistId: booking.stylistUserId,
    reason: booking.disputeReason,
    disputedAt: new Date().toISOString(),
  };
}

function decorateBookingWithContext(booking, contextData) {
  if (!booking || !contextData) return booking;
  const shop = contextData.shop || null;
  const stylist = contextData.stylist || null;
  const serviceOffering = contextData.serviceOffering || null;

  return {
    ...booking,
    shop,
    stylist,
    serviceOffering,
    shopName: shop?.name || null,
    shopAddress: formatShopAddress(shop),
    stylistName: stylist?.displayName || null,
    serviceName: booking.serviceName || serviceOffering?.name || "Appointment",
  };
}

async function enrichBookingForResponse(req, booking) {
  if (!booking || booking.bookingContextType !== "shop") return booking;
  try {
    const context = await getShopBookingContext({
      shopId: booking.shopId,
      stylistUserId: booking.stylistUserId,
      serviceId: booking.serviceId,
      requestId: req.id,
    });
    if (context.status !== 200) return booking;
    return decorateBookingWithContext(booking, context.body?.data);
  } catch {
    return booking;
  }
}

async function enrichBookingsForResponse(req, bookings) {
  return Promise.all(bookings.map((booking) => enrichBookingForResponse(req, booking)));
}

async function ensureOwnerAccess(req, shopId) {
  const upstream = await getShopSummary({ shopId, requestId: req.id });
  if (upstream.status !== 200) return false;
  return sameId(upstream.body?.data?.ownerUserId, req.user.id);
}

async function ensureBookingAccess(req, booking) {
  if (sameId(booking.customerUserId, req.user.id)) return true;
  if (sameId(booking.stylistUserId, req.user.id)) return true;
  if (req.user.role === "owner") {
    return ensureOwnerAccess(req, booking.shopId);
  }
  return false;
}

async function ensureStylistSalonAccess(req, booking) {
  if (req.user.role === "stylist") return sameId(booking.stylistUserId, req.user.id);
  if (req.user.role === "owner") return ensureOwnerAccess(req, booking.shopId);
  return false;
}

async function logStatusTransition({
  booking,
  toStatus,
  user,
  reason = null,
  source = "user",
}) {
  return insertBookingStatusHistory({
    bookingId: booking.id,
    fromStatus: booking.status || null,
    toStatus,
    changedByUserId: user?.id || source,
    changedByRole: user?.role || source,
    source,
    reason,
  });
}

function normalizeReason(value, fallback = null) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function bookingTotalSen(booking) {
  const stored = Number.parseInt(String(booking.amountTotal || booking.servicePriceSen || 0), 10);
  if (Number.isInteger(stored) && stored > 0) return stored;
  const calculated = Math.round(Number(booking.effectivePrice || 0) * 100);
  return Number.isInteger(calculated) && calculated > 0 ? calculated : 0;
}

router.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "booking-service",
    timestamp: new Date().toISOString(),
  });
});

router.get("/ready", async (req, res) => {
  try {
    await healthCheck();
    return res.json({
      ready: true,
      service: "booking-service",
      timestamp: new Date().toISOString(),
    });
  } catch {
    return res.status(503).json({
      ready: false,
      service: "booking-service",
      error: "Database unavailable",
      timestamp: new Date().toISOString(),
      request_id: req.id,
    });
  }
});

router.get("/availability", async (req, res, next) => {
  try {
    const shopId = req.query.shopId;
    const stylistUserId = req.query.stylistUserId;
    const serviceId = req.query.serviceId;
    const date = validateDateOnly("date", req.query.date);

    if (!shopId || !stylistUserId || !serviceId) {
      throw new ValidationError(
        "shopId, stylistUserId, and serviceId are required",
        "availability"
      );
    }

    const context = await getShopBookingContext({
      shopId: String(shopId),
      stylistUserId: String(stylistUserId),
      serviceId: String(serviceId),
      requestId: req.id,
    });

    if (context.status !== 200) {
      return res.status(context.status).json({
        success: false,
        error: context.body?.error || "Booking context not found",
        request_id: req.id,
      });
    }

    const durationMinutes = context.body.data.serviceOffering.durationMinutes;
    const dayStart = new Date(`${date}T${String(DEFAULT_OPEN_HOUR).padStart(2, "0")}:00:00`);
    const dayEnd = new Date(`${date}T${String(DEFAULT_CLOSE_HOUR).padStart(2, "0")}:00:00`);

    const dayBookings = await listBlockingBookingsForStylistOnDate(String(stylistUserId), date);

    const slots = [];
    for (
      let slotStart = new Date(dayStart);
      withMinutes(slotStart, durationMinutes) <= dayEnd;
      slotStart = withMinutes(slotStart, DEFAULT_SLOT_INTERVAL_MINUTES)
    ) {
      const slotEnd = withMinutes(slotStart, durationMinutes);
      const isBlocked = dayBookings.some((booking) => {
        const bookingStart = new Date(booking.scheduledStart);
        const bookingEnd = new Date(booking.scheduledEnd);
        return slotStart < bookingEnd && slotEnd > bookingStart;
      });

      slots.push({
        startsAt: slotStart.toISOString(),
        endsAt: slotEnd.toISOString(),
        available: !isBlocked,
        status: isBlocked ? "unavailable" : "available",
      });
    }

    return res.json({
      success: true,
      data: {
        bookingContextType: context.body.data.bookingContextType,
        serviceOffering: context.body.data.serviceOffering,
        slots,
      },
      request_id: req.id,
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/bookings", requireAuth, customerOnly, async (req, res, next) => {
  try {
    const payload = normalizeCreateBookingPayload(req.body);

    const context = await getShopBookingContext({
      shopId: payload.shopId,
      stylistUserId: payload.stylistUserId,
      serviceId: payload.serviceId,
      requestId: req.id,
    });

    if (context.status !== 200) {
      return res.status(context.status).json({
        success: false,
        error: context.body?.error || "Booking context not found",
        request_id: req.id,
      });
    }

    const serviceOffering = context.body.data.serviceOffering;
    const depositRequired = Boolean(context.body.data.stylist?.depositRequired);
    const amountTotal = amountInMinorUnit(serviceOffering.price);
    const depositAmount = depositRequired
      ? calculateDepositAmount(serviceOffering.price)
      : 0;
    const balanceAmount = Math.max(amountTotal - depositAmount, 0);
    const cancellationDeadline = cancellationDeadlineFor(payload.scheduledStart);
    const depositRefundable = isDepositRefundableAtCreation(payload.scheduledStart);
    const initialStatus = depositRequired ? BOOKING_STATUS.PENDING : BOOKING_STATUS.DEPOSIT_PAID;
    const initialDepositStatus = depositRequired ? DEPOSIT_STATUS.PENDING : DEPOSIT_STATUS.PAID;
    const scheduledEnd = withMinutes(payload.scheduledStart, serviceOffering.durationMinutes);

    const conflict = await findOverlappingBooking({
      stylistUserId: payload.stylistUserId,
      scheduledStart: payload.scheduledStart,
      scheduledEnd,
    });

    if (conflict) {
      return res.status(409).json({
        success: false,
        error: "Selected time overlaps an existing booking",
        request_id: req.id,
      });
    }

    let booking;
    try {
      booking = await createBooking({
        customerUserId: req.user.id,
        createdByUserId: req.user.id,
        shopId: payload.shopId,
        stylistUserId: payload.stylistUserId,
        serviceId: payload.serviceId,
        serviceCatalogKey: serviceOffering.catalogServiceKey,
        serviceName: serviceOffering.name,
        scheduledStart: payload.scheduledStart,
        scheduledEnd,
        effectiveDurationMinutes: serviceOffering.durationMinutes,
        effectivePrice: serviceOffering.price,
        amountTotal,
        status: initialStatus,
        depositRequired,
        depositAmount,
        depositPaid: false,
        depositPaidAt: null,
        depositStatus: initialDepositStatus,
        depositRefundable,
        balanceAmount,
        balanceStatus: BALANCE_STATUS.UNPAID,
        cancellationDeadline,
        notes: payload.notes,
      });

      await insertBookingStatusHistory({
        bookingId: booking.id,
        fromStatus: null,
        toStatus: initialStatus,
        changedByUserId: req.user.id,
        changedByRole: req.user.role,
        source: "user",
        reason: depositRequired
          ? "Booking created pending deposit"
          : "Booking created without required deposit",
      });
    } catch (err) {
      console.error("BOOKING CREATE ERROR:", err);
      return res.status(500).json({
        error: err.message,
        detail: err.detail,
        request_id: req.id,
      });
    }

    return res.status(201).json({
      success: true,
      data: decorateBookingWithContext(booking, context.body?.data),
      request_id: req.id,
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/bookings/me", requireAuth, customerOnly, async (req, res, next) => {
  try {
    const bookings = await listBookingsByCustomer(req.user.id, {
      limit: validateListLimit(req.query.limit),
    });
    const enriched = await enrichBookingsForResponse(req, bookings);
    return res.json({
      success: true,
      count: enriched.length,
      data: enriched,
      request_id: req.id,
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/bookings/stylists/me", requireAuth, requireRole("stylist"), async (req, res, next) => {
  try {
    const bookings = await listBookingsByStylist(req.user.id, {
      limit: validateListLimit(req.query.limit),
    });
    const enriched = await enrichBookingsForResponse(req, bookings);
    return res.json({
      success: true,
      count: enriched.length,
      data: enriched,
      request_id: req.id,
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/bookings/shops/:shopId", requireAuth, requireRole("owner"), async (req, res, next) => {
  try {
    const allowed = await ensureOwnerAccess(req, req.params.shopId);
    if (!allowed) {
      return res.status(403).json({
        success: false,
        error: "You can only view bookings for your own shop",
        request_id: req.id,
      });
    }

    const bookings = await listBookingsByShop(req.params.shopId, {
      limit: validateListLimit(req.query.limit),
    });
    const enriched = await enrichBookingsForResponse(req, bookings);
    return res.json({
      success: true,
      count: enriched.length,
      data: enriched,
      request_id: req.id,
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/bookings/:bookingId/accept", requireAuth, requireRole("stylist", "owner"), async (req, res, next) => {
  try {
    const booking = await findBookingById(req.params.bookingId);
    if (!booking) return errorResponse(res, 404, "Booking not found", req.id);

    const allowed = await ensureStylistSalonAccess(req, booking);
    if (!allowed) return errorResponse(res, 403, "You cannot accept this booking", req.id);

    if (booking.status !== "pending_acceptance") {
      return errorResponse(res, 400, "Only pending bookings can be accepted", req.id);
    }

    const updated = await updateBookingById(booking.id, {
      status: "accepted",
      stylist_accepted_at: new Date(),
    });
    await logStatusTransition({
      booking,
      toStatus: "accepted",
      user: req.user,
      reason: "Stylist accepted booking",
    });
    await publishBookingEvent(req, BOOKING_ACCEPTED, bookingAcceptedPayload(updated));

    return res.json({ success: true, booking: updated, data: updated, request_id: req.id });
  } catch (error) {
    return next(error);
  }
});

router.post("/bookings/:bookingId/reject", requireAuth, requireRole("stylist", "owner"), async (req, res, next) => {
  try {
    const booking = await findBookingById(req.params.bookingId);
    if (!booking) return errorResponse(res, 404, "Booking not found", req.id);

    const allowed = await ensureStylistSalonAccess(req, booking);
    if (!allowed) return errorResponse(res, 403, "You cannot reject this booking", req.id);

    if (booking.status !== "pending_acceptance") {
      return errorResponse(res, 400, "Only pending bookings can be rejected", req.id);
    }

    const reason = normalizeReason(req.body?.reason, "Stylist declined this booking");
    const updated = await updateBookingById(booking.id, {
      status: "rejected",
      stylist_rejected_at: new Date(),
      rejection_reason: reason,
    });
    await logStatusTransition({
      booking,
      toStatus: "rejected",
      user: req.user,
      reason,
    });
    await publishBookingEvent(req, BOOKING_REJECTED, bookingRejectedPayload(updated));

    return res.json({ success: true, booking: updated, data: updated, request_id: req.id });
  } catch (error) {
    return next(error);
  }
});

async function handleBookingCancel(req, res, next) {
  try {
    const payload = normalizeCancelPayload(req.body || {});
    const booking = await findBookingById(req.params.bookingId);
    if (!booking) return errorResponse(res, 404, "Booking not found", req.id);

    const allowed = await ensureBookingAccess(req, booking);
    if (!allowed) return errorResponse(res, 403, "You do not have access to this booking", req.id);

    const status = normalizeBookingStatus(booking.status);
    if ([
      BOOKING_STATUS.COMPLETED,
      BOOKING_STATUS.CANCELLED,
      BOOKING_STATUS.CANCELLED_REFUNDED,
      BOOKING_STATUS.CANCELLED_FORFEITED,
      BOOKING_STATUS.DEPOSIT_EXPIRED,
      BOOKING_STATUS.DEPOSIT_FAILED,
    ].includes(status)) {
      return errorResponse(res, 400, "Booking can no longer be cancelled", req.id);
    }

    const reason = normalizeReason(payload.reason, "Booking cancelled");
    const now = new Date();
    const deadline = booking.cancellationDeadline
      ? new Date(booking.cancellationDeadline)
      : cancellationDeadlineFor(booking.scheduledStart);

    let toStatus = BOOKING_STATUS.CANCELLED;
    let patch = {
      status: toStatus,
      cancelled_at: now,
      cancelled_by: req.user.role,
      cancellation_reason: reason,
    };
    let eventType = BOOKING_CANCELLED;
    let refundId = null;

    if (status === BOOKING_STATUS.DEPOSIT_PAID || status === BOOKING_STATUS.BALANCE_PENDING) {
      if (!booking.depositPaymentIntentId && booking.depositAmount > 0) {
        return errorResponse(res, 409, "Booking deposit payment reference is missing", req.id);
      }

      const refundable = booking.depositRefundable !== false && now.getTime() <= deadline.getTime();
      if (refundable) {
        assertCanTransition(status, BOOKING_STATUS.CANCELLED_REFUNDED);
        toStatus = BOOKING_STATUS.CANCELLED_REFUNDED;
        eventType = BOOKING_CANCELLED_REFUNDED;

        if (booking.depositPaymentIntentId && booking.depositAmount > 0) {
          const client = requireStripePayoutClient(res, req.id);
          if (!client) return;
          const refund = await client.refunds.create(
            {
              payment_intent: booking.depositPaymentIntentId,
              reverse_transfer: true,
              refund_application_fee: true,
              metadata: {
                bookingId: String(booking.id),
                customerId: String(booking.customerUserId),
                type: "deposit_refund",
              },
            },
            { idempotencyKey: `refund_deposit_${booking.id}` }
          );
          refundId = refund.id;
        }

        patch = {
          ...patch,
          status: toStatus,
          deposit_status: DEPOSIT_STATUS.REFUNDED,
          refund_id: refundId || booking.refundId || null,
        };
      } else {
        assertCanTransition(status, BOOKING_STATUS.CANCELLED_FORFEITED);
        toStatus = BOOKING_STATUS.CANCELLED_FORFEITED;
        eventType = BOOKING_CANCELLED_FORFEITED;
        patch = {
          ...patch,
          status: toStatus,
          deposit_status: DEPOSIT_STATUS.FORFEITED,
          deposit_forfeited_at: now,
        };
        req.logger?.info("Booking deposit forfeited on late cancellation", {
          request_id: req.id,
          booking_id: booking.id,
          deposit_payment_intent_id: booking.depositPaymentIntentId,
          forfeited_at: now.toISOString(),
        });
      }
    } else {
      assertCanTransition(status, BOOKING_STATUS.CANCELLED);
    }

    const updated = await updateBookingById(booking.id, patch);
    await logStatusTransition({
      booking,
      toStatus,
      user: req.user,
      reason,
    });
    await publishBookingEvent(req, eventType, bookingCancelledPayload(updated, reason));

    return res.json({ success: true, booking: updated, data: updated, request_id: req.id });
  } catch (error) {
    return next(error);
  }
}

router.post("/bookings/:bookingId/cancel", requireAuth, requireRole("customer", "stylist"), handleBookingCancel);

router.post("/bookings/:bookingId/dispute", requireAuth, customerOnly, async (req, res, next) => {
  try {
    const booking = await findBookingById(req.params.bookingId);
    if (!booking) return errorResponse(res, 404, "Booking not found", req.id);

    if (!sameId(booking.customerUserId, req.user.id)) {
      return errorResponse(res, 403, "You do not have access to this booking", req.id);
    }

    if (booking.status !== "completed" || booking.paymentStatus !== "captured") {
      return errorResponse(res, 400, "Only completed captured bookings can be disputed", req.id);
    }

    const capturedAt = booking.capturedAt ? new Date(booking.capturedAt) : null;
    if (!capturedAt || Number.isNaN(capturedAt.getTime())) {
      return errorResponse(res, 400, "Booking capture timestamp is missing", req.id);
    }

    const disputeDeadline = capturedAt.getTime() + 48 * 60 * 60 * 1000;
    if (Date.now() > disputeDeadline) {
      return errorResponse(res, 400, "Dispute window has closed", req.id);
    }

    const reason = normalizeReason(req.body?.reason);
    if (!reason || reason.length < 20) {
      return errorResponse(res, 400, "Dispute reason must be at least 20 characters", req.id);
    }

    const disputeId = crypto.randomUUID();
    const updated = await updateBookingById(booking.id, {
      status: "disputed",
      dispute_reason: reason,
      dispute_status: "open",
      dispute_id: disputeId,
    });
    await logStatusTransition({
      booking,
      toStatus: "disputed",
      user: req.user,
      reason,
    });
    await publishBookingEvent(req, BOOKING_DISPUTED, bookingDisputedPayload(updated));

    return res.json({ success: true, disputeId, request_id: req.id });
  } catch (error) {
    return next(error);
  }
});

router.get("/internal/bookings/batch", async (req, res, next) => {
  try {
    const ids = String(req.query.ids || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
      .slice(0, 100);

    const bookings = await listBookingsByIds(ids);
    return res.json({
      success: true,
      count: bookings.length,
      data: bookings,
      request_id: req.id,
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/bookings/:bookingId", requireAuth, customerOnly, async (req, res) => {
  const booking = await findBookingById(req.params.bookingId);
  if (!booking) {
    return res.status(404).json({
      success: false,
      error: "Booking not found",
      request_id: req.id,
    });
  }

  const allowed = await ensureBookingAccess(req, booking);
  if (!allowed) {
    return res.status(403).json({
      success: false,
      error: "You do not have access to this booking",
      request_id: req.id,
    });
  }

  const history = await listBookingStatusHistory(booking.id);
  const enriched = await enrichBookingForResponse(req, booking);
  return res.json({
    success: true,
    data: {
      ...enriched,
      statusHistory: history,
    },
    request_id: req.id,
  });
});

router.post("/bookings/:bookingId/checkout", requireAuth, customerOnly, async (req, res, next) => {
  try {
    const client = requireStripeCheckoutClient(res, req.id);
    if (!client) return;

    const bookingId = validateRequiredIdentifier("bookingId", req.params.bookingId, {
      maxLength: 120,
    });
    const booking = await findBookingPaymentById(bookingId);
    if (!booking) return errorResponse(res, 404, "Booking not found", req.id);

    if (!sameId(booking.customerUserId, req.user.id)) {
      return errorResponse(res, 403, "You do not have access to this booking", req.id);
    }

    if (!booking.depositRequired) {
      return errorResponse(res, 400, "Deposit is not required for this booking", req.id);
    }

    const status = normalizeBookingStatus(booking.status);
    if (booking.depositPaid || status === BOOKING_STATUS.DEPOSIT_PAID) {
      return errorResponse(res, 409, "This booking deposit has already been paid", req.id);
    }

    if (![BOOKING_STATUS.PENDING, BOOKING_STATUS.DEPOSIT_PENDING, BOOKING_STATUS.DEPOSIT_EXPIRED, BOOKING_STATUS.DEPOSIT_FAILED].includes(status)) {
      return errorResponse(res, 409, "Deposit checkout is only available while the booking is awaiting deposit", req.id);
    }

    const enriched = await enrichBookingForResponse(req, booking);
    const reusableSession = await retrieveReusableDepositSession(client, booking);
    const checkout = reusableSession
      ? {
          session: reusableSession,
          stripeCustomerId: booking.stripeCustomerId || null,
          ...depositConnectAmounts(booking),
        }
      : await createDepositCheckoutSession({
          client,
          booking,
          enrichedBooking: enriched,
          user: req.user,
          requestId: req.id,
        });
    const { session } = checkout;
    const nextStatus = status === BOOKING_STATUS.DEPOSIT_PENDING
      ? BOOKING_STATUS.DEPOSIT_PENDING
      : assertCanTransition(status, BOOKING_STATUS.DEPOSIT_PENDING);

    const updated = await updateBookingById(booking.id, {
      status: nextStatus,
      stripe_customer_id: checkout.stripeCustomerId || booking.stripeCustomerId || null,
      deposit_stripe_session_id: session.id,
      deposit_payment_intent_id: checkoutSessionPaymentIntentId(session),
      deposit_status: DEPOSIT_STATUS.PENDING,
      deposit_platform_fee: checkout.depositPlatformFee ?? checkout.platformFee ?? booking.depositPlatformFee ?? 0,
      deposit_stylist_payout: checkout.depositStylistPayout ?? checkout.stylistPayout ?? booking.depositStylistPayout ?? 0,
    });

    if (status !== BOOKING_STATUS.DEPOSIT_PENDING) {
      await logStatusTransition({
        booking,
        toStatus: nextStatus,
        user: req.user,
        reason: reusableSession
          ? "Deposit checkout session reused"
          : "Deposit checkout session created",
      });
    }

    return res.json({
      success: true,
      data: {
        checkoutSessionId: session.id,
        url: session.url,
        booking: updated,
      },
      request_id: req.id,
    });
  } catch (error) {
    if (error?.type && String(error.type).startsWith("Stripe")) {
      req.logger?.error("Stripe deposit checkout failed", {
        request_id: req.id,
        booking_id: req.params.bookingId,
        code: error.code,
        type: error.type,
      });
      return res.status(error.statusCode || 502).json({
        success: false,
        error: "Unable to start deposit checkout. Please try again.",
        request_id: req.id,
      });
    }
    return next(error);
  }
});

router.post("/bookings/:bookingId/deposit/sync", requireAuth, customerOnly, async (req, res, next) => {
  try {
    const client = requireStripeCheckoutClient(res, req.id);
    if (!client) return;

    const booking = await findBookingById(req.params.bookingId);
    if (!booking) return errorResponse(res, 404, "Booking not found", req.id);

    if (!sameId(booking.customerUserId, req.user.id)) {
      return errorResponse(res, 403, "You can only sync payment for your own bookings", req.id);
    }

    if (!booking.depositRequired) {
      return errorResponse(res, 400, "Deposit is not required for this booking", req.id);
    }

    if (!booking.depositStripeSessionId) {
      return errorResponse(res, 409, "No deposit checkout session exists for this booking", req.id);
    }

    const updated = await reconcileDepositCheckoutSession({ req, client, booking });
    const enriched = await enrichBookingForResponse(req, updated);
    const history = await listBookingStatusHistory(updated.id);

    return res.json({
      success: true,
      data: {
        ...enriched,
        statusHistory: history,
      },
      request_id: req.id,
    });
  } catch (error) {
    if (error?.type && String(error.type).startsWith("Stripe")) {
      req.logger?.error("Stripe deposit sync failed", {
        request_id: req.id,
        booking_id: req.params.bookingId,
        code: error.code,
        type: error.type,
      });
      return res.status(error.statusCode || 502).json({
        success: false,
        error: "Unable to verify deposit payment. Please try again.",
        request_id: req.id,
      });
    }
    return next(error);
  }
});

router.patch("/bookings/:bookingId/deposit", requireAuth, customerOnly, async (req, res) => {
  return errorResponse(
    res,
    410,
    "Mock deposit payment has been removed. Use POST /api/bookings/:id/checkout.",
    req.id
  );
});

router.post("/bookings/:bookingId/complete", requireAuth, customerOnly, async (req, res, next) => {
  try {
    validateRequiredIdentifier("bookingId", req.params.bookingId, {
      maxLength: 120,
    });
    return errorResponse(
      res,
      410,
      "This endpoint has been replaced. Use POST /api/payments/capture after the customer clicks Pay Now.",
      req.id
    );
  } catch (error) {
    if (error instanceof ValidationError) return next(error);
    return next(error);
  }
});

router.patch("/bookings/:bookingId/cancel", requireAuth, customerOnly, handleBookingCancel);

router.patch("/bookings/:bookingId/reschedule", requireAuth, customerOnly, async (req, res, next) => {
  try {
    const booking = await findBookingById(req.params.bookingId);
    if (!booking) {
      return res.status(404).json({
        success: false,
        error: "Booking not found",
        request_id: req.id,
      });
    }

    const allowed = await ensureBookingAccess(req, booking);
    if (!allowed) {
      return res.status(403).json({
        success: false,
        error: "You do not have access to this booking",
        request_id: req.id,
      });
    }

    if (!["pending_acceptance", "pending_deposit", "confirmed"].includes(booking.status)) {
      return res.status(409).json({
        success: false,
        error: "Booking can no longer be rescheduled",
        request_id: req.id,
      });
    }

    const payload = normalizeReschedulePayload(req.body);
    const newEnd = withMinutes(payload.scheduledStart, booking.effectiveDurationMinutes);
    const conflict = await findOverlappingBooking({
      stylistUserId: booking.stylistUserId,
      scheduledStart: payload.scheduledStart,
      scheduledEnd: newEnd,
      excludeBookingId: booking.id,
    });

    if (conflict) {
      return res.status(409).json({
        success: false,
        error: "Selected time overlaps an existing booking",
        request_id: req.id,
      });
    }

    const updated = await updateBookingById(booking.id, {
      scheduled_start: payload.scheduledStart,
      scheduled_end: newEnd,
    });
    await insertBookingStatusHistory({
      bookingId: booking.id,
      fromStatus: booking.status,
      toStatus: booking.status,
      changedByUserId: req.user.id,
      reason: payload.reason || "Booking rescheduled",
    });

    return res.json({
      success: true,
      data: updated,
      request_id: req.id,
    });
  } catch (error) {
    return next(error);
  }
});

router.patch("/bookings/:bookingId/status", requireAuth, requireRole("owner", "stylist"), async (req, res, next) => {
  try {
    const booking = await findBookingById(req.params.bookingId);
    if (!booking) {
      return res.status(404).json({
        success: false,
        error: "Booking not found",
        request_id: req.id,
      });
    }

    const allowed = await ensureBookingAccess(req, booking);
    if (!allowed || sameId(booking.customerUserId, req.user.id)) {
      return res.status(403).json({
        success: false,
        error: "You cannot update this booking status",
        request_id: req.id,
      });
    }

    const payload = normalizeStatusUpdatePayload(req.body);
    if (["accepted", "rejected", "payment_authorized", "confirmed", "completed", "cancelled", "disputed", "refunded"].includes(payload.status)) {
      return res.status(409).json({
        success: false,
        error: "Use the dedicated booking lifecycle endpoint for this status transition",
        request_id: req.id,
      });
    }

    if (payload.status === "confirmed" && booking.paymentStatus !== "captured") {
      return res.status(409).json({
        success: false,
        error: "Booking cannot be confirmed until payment succeeds",
        request_id: req.id,
      });
    }

    if (!canTransition(booking.status, payload.status)) {
      return res.status(409).json({
        success: false,
        error: `Invalid booking status transition from ${booking.status} to ${payload.status}`,
        request_id: req.id,
      });
    }

    const patch = { status: payload.status };
    if (payload.status === "cancelled") {
      patch.cancellation_reason = payload.reason;
      patch.cancelled_at = new Date();
    }

    const updated = await updateBookingById(booking.id, patch);
    await insertBookingStatusHistory({
      bookingId: booking.id,
      fromStatus: booking.status,
      toStatus: payload.status,
      changedByUserId: req.user.id,
      reason: payload.reason,
    });

    if (payload.status === "cancelled") {
      await publishBookingEvent(
        req,
        BOOKING_CANCELLED,
        bookingCancelledPayload(updated, payload.reason)
      );
    }

    if (payload.status === "completed") {
      await publishBookingEvent(req, BOOKING_COMPLETED, bookingCompletedPayload(updated));
    }

    return res.json({
      success: true,
      data: updated,
      request_id: req.id,
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;

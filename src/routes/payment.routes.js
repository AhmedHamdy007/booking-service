const express = require("express");
const crypto = require("crypto");

const config = require("../config");
const { requireAuth, requireRole } = require("../middleware/auth");
const { customerOnly } = require("../middleware/customerOnly");
const { ValidationError, validateRequiredIdentifier } = require("../utils/validation");
const { amountInMinorUnit } = require("../utils/money");
const {
  BOOKING_STATUS,
  BALANCE_STATUS,
  assertCanTransition,
  normalizeBookingStatus,
} = require("../utils/bookingTransitions");
const stripe = require("../utils/stripe");
const {
  findBookingByDisputeId,
  findBookingPaymentById,
  findStripeCustomerIdForCustomer,
  insertBookingStatusHistory,
  updateBookingById,
} = require("../repositories/bookingRepository");
const { getStylistConnectAccount } = require("../services/shopClient");
const { publish } = require("../events/publisher");
const {
  DISPUTE_RESOLVED,
  PAYMENT_CAPTURED,
} = require("../events/eventTypes");

const router = express.Router();
const CURRENCY = "myr";

function sameId(a, b) {
  if (a === undefined || a === null || b === undefined || b === null) return false;
  return String(a) === String(b);
}

function requireStripeClient(res, requestId) {
  if (!stripe) {
    res.status(503).json({
      message: "Payments are not configured",
      request_id: requestId,
    });
    return null;
  }
  return stripe;
}

async function resolveStripeCustomerId(client, booking, user) {
  const existingCustomerId =
    booking.stripeCustomerId || (await findStripeCustomerIdForCustomer(user.id));

  if (existingCustomerId) return existingCustomerId;

  const customer = await client.customers.create({
    email: user.email || undefined,
    name: user.name || undefined,
    metadata: {
      customerId: user.id,
    },
  }, { idempotencyKey: `stripe-customer-${user.id}` });

  return customer.id;
}

function validateDigitString(name, value, { exactLength = null, minLength = null, maxLength = null } = {}) {
  if (typeof value !== "string") {
    throw new ValidationError(`${name} must be a string`, name);
  }
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new ValidationError(`${name} must contain digits only`, name);
  }
  if (exactLength !== null && normalized.length !== exactLength) {
    throw new ValidationError(`${name} must be exactly ${exactLength} digits`, name);
  }
  if (minLength !== null && normalized.length < minLength) {
    throw new ValidationError(`${name} must be at least ${minLength} digits`, name);
  }
  if (maxLength !== null && normalized.length > maxLength) {
    throw new ValidationError(`${name} must be at most ${maxLength} digits`, name);
  }
  return normalized;
}

function normalizeConnectAccountPayload(body = {}) {
  const accountName = typeof body.accountName === "string" ? body.accountName.trim() : "";
  if (accountName.length < 2 || accountName.length > 255) {
    throw new ValidationError("accountName is required", "accountName");
  }

  const existingStripeAccountId =
    typeof body.existingStripeAccountId === "string" && body.existingStripeAccountId.trim()
      ? body.existingStripeAccountId.trim()
      : null;

  return {
    bankName: typeof body.bankName === "string" ? body.bankName.trim() : "",
    accountNumber: validateDigitString("accountNumber", body.accountNumber, {
      minLength: 10,
      maxLength: 16,
    }),
    accountName,
    icNumber: validateDigitString("icNumber", body.icNumber, { exactLength: 12 }),
    existingStripeAccountId,
    ipAddress:
      typeof body.ipAddress === "string" && body.ipAddress.trim()
        ? body.ipAddress.trim()
        : null,
  };
}

function splitAccountName(accountName) {
  const parts = accountName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    return { firstName: parts[0], lastName: parts[0] };
  }
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" "),
  };
}

function bankAccountFingerprint(accountNumber) {
  return crypto.createHash("sha256").update(accountNumber).digest("hex").slice(0, 16);
}

function isTransfersVerified(account) {
  return (
    account?.capabilities?.transfers === "active" ||
    account?.payouts_enabled === true
  );
}

function platformFeePercent() {
  const percent = Number(config.stripePlatformFeePercent);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new Error("STRIPE_PLATFORM_FEE_PERCENT must be a number between 0 and 100");
  }
  return percent / 100;
}

function bookingTransferGroup(bookingId) {
  return `booking_${bookingId}`;
}

async function publishPaymentEvent(req, routingKey, payload) {
  try {
    await publish(routingKey, payload);
  } catch (error) {
    req.logger?.error("Failed to publish payment event", {
      request_id: req.id,
      routing_key: routingKey,
      error: error.message,
    });
  }
}

async function logStatusTransition({ booking, toStatus, user, reason = null, source = "user" }) {
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

async function markBookingAuthorized({ booking, user, source = "user" }) {
  if (
    booking.balanceStatus === BALANCE_STATUS.PENDING &&
    booking.paymentStatus === "authorized" &&
    normalizeBookingStatus(booking.status) === BOOKING_STATUS.BALANCE_PENDING
  ) {
    return booking;
  }

  const toStatus = normalizeBookingStatus(booking.status) === BOOKING_STATUS.BALANCE_PENDING
    ? BOOKING_STATUS.BALANCE_PENDING
    : assertCanTransition(booking.status, BOOKING_STATUS.BALANCE_PENDING);

  const updated = await updateBookingById(booking.id, {
    payment_status: "authorized",
    status: toStatus,
    balance_status: BALANCE_STATUS.PENDING,
    authorized_at: new Date(),
  });

  if (normalizeBookingStatus(booking.status) !== BOOKING_STATUS.BALANCE_PENDING) {
    await logStatusTransition({
      booking,
      toStatus,
      user,
      source,
      reason: "Balance payment authorization succeeded",
    });
  }

  return updated;
}

function paymentSetupError(message, status = 400, code = null) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

function allowPlatformPaymentFallback() {
  return config.nodeEnv !== "production";
}

function isConnectSetupError(error) {
  return [
    "stylist_payment_account_missing",
    "stylist_payment_account_not_ready",
    "stylist_payment_charges_disabled",
    "payment_account_lookup_failed",
    "payment_account_service_unavailable",
  ].includes(error?.code);
}

function isStripeConnectDestinationError(error) {
  const message = String(error?.message || "").toLowerCase();
  const code = String(error?.code || "").toLowerCase();
  return Boolean(
    error?.type &&
      String(error.type).startsWith("Stripe") &&
      (
        code.includes("account") ||
        message.includes("connected account") ||
        message.includes("destination") ||
        message.includes("transfer_data") ||
        message.includes("application_fee") ||
        message.includes("capabilit") ||
        message.includes("no such account")
      )
  );
}

async function createPlatformFallbackPaymentIntent({ client, params, bookingId, reason, requestId }) {
  const fallbackParams = {
    ...params,
    application_fee_amount: undefined,
    transfer_data: undefined,
    metadata: {
      ...params.metadata,
      connectMode: "platform_fallback",
      connectFallbackReason: String(reason || "connect_unavailable").slice(0, 120),
    },
  };

  return client.paymentIntents.create(fallbackParams, {
    idempotencyKey: `balance_intent_${bookingId}_platform_fallback_${params.amount}_v3`,
  });
}

function bookingTotalAmount(booking) {
  const stored = Number.parseInt(String(booking.amountTotal || 0), 10);
  if (Number.isInteger(stored) && stored > 0) return stored;

  try {
    const amount = amountInMinorUnit(booking.effectivePrice);
    if (Number.isInteger(amount) && amount > 0) return amount;
  } catch {
    // Re-throw below with checkout-specific wording.
  }

  throw paymentSetupError("Booking amount is invalid. Recreate this booking or update the service price before paying.", 400, "invalid_booking_amount");
}

function assertPaymentRetryable(booking) {
  if (booking.balanceStatus === BALANCE_STATUS.PAID || normalizeBookingStatus(booking.status) === BOOKING_STATUS.COMPLETED) {
    const error = new Error("This booking balance has already been paid");
    error.status = 409;
    throw error;
  }

  if (!booking.depositRequired) {
    const status = normalizeBookingStatus(booking.status);
    if (![BOOKING_STATUS.DEPOSIT_PAID, BOOKING_STATUS.BALANCE_PENDING].includes(status)) {
      const error = new Error("Booking is not ready for balance payment");
      error.status = 400;
      throw error;
    }
    return;
  }

  if (normalizeBookingStatus(booking.status) !== BOOKING_STATUS.DEPOSIT_PAID && normalizeBookingStatus(booking.status) !== BOOKING_STATUS.BALANCE_PENDING) {
    const error = new Error("Deposit must be paid before the remaining balance can be charged");
    error.status = 400;
    throw error;
  }

  if (booking.balanceStatus === BALANCE_STATUS.PENDING && booking.balancePaymentIntentId) {
    return;
  }

  if (![BALANCE_STATUS.UNPAID, BALANCE_STATUS.FAILED].includes(booking.balanceStatus || BALANCE_STATUS.UNPAID)) {
    const error = new Error("This booking balance is not awaiting payment");
    error.status = 400;
    throw error;
  }
}

function canRefund(booking) {
  const startsAt = new Date(booking.scheduledStart);
  if (Number.isNaN(startsAt.getTime())) return false;
  const twoHoursFromNow = Date.now() + 2 * 60 * 60 * 1000;
  return startsAt.getTime() > twoHoursFromNow;
}

async function requireReadyStylistConnectAccount({ stylistUserId, requestId }) {
  let upstream;
  try {
    upstream = await getStylistConnectAccount({ stylistUserId, requestId });
  } catch (error) {
    const wrapped = paymentSetupError(
      "Unable to verify the stylist payment account. Please check that shop-service is running and reachable.",
      503,
      "payment_account_lookup_failed"
    );
    wrapped.cause = error;
    throw wrapped;
  }

  if (upstream.status === 404) {
    throw paymentSetupError(
      "Stylist payment account is not set up yet. Ask the stylist to complete Stripe onboarding before customers pay.",
      400,
      "stylist_payment_account_missing"
    );
  }

  if (upstream.status >= 500) {
    throw paymentSetupError(
      "Unable to verify the stylist payment account right now. Please retry after the services are healthy.",
      503,
      "payment_account_service_unavailable"
    );
  }

  if (upstream.status !== 200) {
    throw paymentSetupError("Stylist payment account not ready", 400, "stylist_payment_account_not_ready");
  }

  const account = upstream.body?.data;
  if (!account?.stripeAccountId) {
    throw paymentSetupError(
      "Stylist payment account is not set up yet. Ask the stylist to complete Stripe onboarding before customers pay.",
      400,
      "stylist_payment_account_missing"
    );
  }

  if (account.chargesEnabled !== true) {
    throw paymentSetupError(
      "Stylist payment account cannot accept charges yet. Finish Stripe onboarding and refresh the account status.",
      400,
      "stylist_payment_charges_disabled"
    );
  }

  return account;
}

async function buildCheckoutPaymentIntent({ client, booking, user, stylistId, requestId }) {
  const totalAmount = bookingTotalAmount(booking);
  const depositAmount = Number.parseInt(String(booking.depositAmount || 0), 10) || 0;
  const balanceAmount = Number.parseInt(String(booking.balanceAmount || Math.max(totalAmount - depositAmount, 0)), 10);
  if (!Number.isInteger(balanceAmount) || balanceAmount <= 0) {
    const error = new Error("Booking balance amount must be a positive sen value");
    error.status = 400;
    throw error;
  }

  const platformFee = Math.floor(balanceAmount * platformFeePercent());
  const stylistPayout = Math.max(balanceAmount - platformFee, 0);
  const stripeCustomerId = await resolveStripeCustomerId(client, booking, user);

  let stylistAccount = null;
  let connectMode = "destination_charge";
  try {
    stylistAccount = await requireReadyStylistConnectAccount({
      stylistUserId: stylistId,
      requestId,
    });
  } catch (error) {
    if (!allowPlatformPaymentFallback() || !isConnectSetupError(error)) {
      throw error;
    }
    connectMode = "platform_fallback";
  }

  const paymentIntentParams = {
    amount: balanceAmount,
    currency: CURRENCY,
    customer: stripeCustomerId,
    capture_method: "manual",
    transfer_group: bookingTransferGroup(booking.id),
    metadata: {
      bookingId: String(booking.id),
      customerId: String(user.id),
      stylistId: String(stylistId),
      type: "balance",
      depositAmount: String(depositAmount),
      balanceAmount: String(balanceAmount),
      totalAmount: String(totalAmount),
      platformFee: String(platformFee),
      stylistPayout: String(stylistPayout),
      connectMode,
    },
    automatic_payment_methods: { enabled: true },
  };

  if (connectMode === "destination_charge" && stylistAccount?.stripeAccountId) {
    paymentIntentParams.application_fee_amount = platformFee;
    paymentIntentParams.transfer_data = {
      destination: stylistAccount.stripeAccountId,
    };
  }

  let paymentIntent;
  try {
    paymentIntent = await client.paymentIntents.create(
      paymentIntentParams,
      { idempotencyKey: `balance_intent_${booking.id}_${connectMode}_${user.id}_${balanceAmount}_v3` }
    );
  } catch (error) {
    if (!allowPlatformPaymentFallback() || !isStripeConnectDestinationError(error)) {
      throw error;
    }
    connectMode = "platform_fallback";
    paymentIntent = await createPlatformFallbackPaymentIntent({
      client,
      params: paymentIntentParams,
      bookingId: booking.id,
      reason: error.code || error.message || "stripe_connect_destination_failed",
      requestId,
    });
  }

  await updateBookingById(booking.id, {
    payment_intent_id: paymentIntent.id,
    balance_payment_intent_id: paymentIntent.id,
    stripe_customer_id: stripeCustomerId,
    amount_total: totalAmount,
    balance_amount: balanceAmount,
    balance_platform_fee: platformFee,
    balance_stylist_payout: stylistPayout,
    balance_status: BALANCE_STATUS.UNPAID,
    payment_status: "unpaid",
    currency: CURRENCY,
  });

  return {
    paymentIntent,
    totalAmount: balanceAmount,
    platformFee,
    stylistPayout,
    connectMode,
  };
}
async function retrieveReusablePaymentIntent({ client, booking }) {
  const intentId = booking.balancePaymentIntentId || booking.paymentIntentId;
  if (!intentId) return null;

  const intent = await client.paymentIntents.retrieve(intentId);
  if (
    intent &&
    intent.status !== "canceled" &&
    intent.status !== "succeeded" &&
    Number(intent.amount) === Number(booking.balanceAmount || Math.max(bookingTotalAmount(booking) - (booking.depositAmount || 0), 0)) &&
    String(intent.currency || "").toLowerCase() === CURRENCY
  ) {
    return intent;
  }

  return null;
}

async function handleCreateCheckout(req, res, next) {
  try {
    const client = requireStripeClient(res, req.id);
    if (!client) return;

    const bookingId = validateRequiredIdentifier("bookingId", req.body?.bookingId, {
      maxLength: 120,
    });

    const booking = await findBookingPaymentById(bookingId);
    if (!booking) {
      return res.status(404).json({
        message: "Booking not found",
        request_id: req.id,
      });
    }

    if (!sameId(booking.customerUserId, req.user.id)) {
      return res.status(403).json({
        message: "You do not have access to this booking",
        request_id: req.id,
      });
    }

    assertPaymentRetryable(booking);

    const stylistId = req.body?.stylistId
      ? validateRequiredIdentifier("stylistId", req.body.stylistId, { maxLength: 120 })
      : booking.stylistUserId;
    if (!sameId(stylistId, booking.stylistUserId)) {
      return res.status(409).json({
        message: "Stylist does not match this booking",
        request_id: req.id,
      });
    }

    const existingIntent = await retrieveReusablePaymentIntent({ client, booking });
    const checkout = existingIntent
      ? {
          paymentIntent: existingIntent,
          totalAmount: existingIntent.amount || booking.balanceAmount,
          platformFee: booking.balancePlatformFee,
          stylistPayout: booking.balanceStylistPayout,
          connectMode: existingIntent.metadata?.connectMode || "destination_charge",
        }
      : await buildCheckoutPaymentIntent({
          client,
          booking,
          user: req.user,
          stylistId,
          requestId: req.id,
        });

    return res.status(200).json({
      clientSecret: checkout.paymentIntent.client_secret,
      publishableKey: config.stripePublishableKey,
      amount: checkout.totalAmount,
      platformFee: checkout.platformFee,
      stylistPayout: checkout.stylistPayout,
      currency: CURRENCY,
      paymentMode: checkout.connectMode || "destination_charge",
      setupWarning: checkout.connectMode === "platform_fallback"
        ? "Stripe Connect is not ready for this stylist, so this VM is using a platform-only test payment."
        : undefined,
    });
  } catch (error) {
    if (error instanceof ValidationError) return next(error);
    return next(error);
  }
}

router.post("/internal/connect/stylist-accounts", requireAuth, requireRole("stylist"), async (req, res, next) => {
  try {
    const client = requireStripeClient(res, req.id);
    if (!client) return;

    const payload = normalizeConnectAccountPayload(req.body);
    const { firstName, lastName } = splitAccountName(payload.accountName);
    let accountId = payload.existingStripeAccountId;
    let account = null;

    if (!accountId) {
      account = await client.accounts.create(
        {
          type: "custom",
          country: "MY",
          email: req.user.email || undefined,
          capabilities: {
            transfers: { requested: true },
          },
          business_type: "individual",
          individual: {
            first_name: firstName,
            last_name: lastName,
            id_number: payload.icNumber,
          },
          tos_acceptance: {
            date: Math.floor(Date.now() / 1000),
            ip: payload.ipAddress || req.ip,
          },
          metadata: {
            stylistId: req.user.id,
          },
        },
        { idempotencyKey: `create-account-stylist-${req.user.id}` }
      );
      accountId = account.id;
    }

    await client.accounts.createExternalAccount(
      accountId,
      {
        external_account: {
          object: "bank_account",
          country: "MY",
          currency: CURRENCY,
          account_number: payload.accountNumber,
          account_holder_name: payload.accountName,
          account_holder_type: "individual",
        },
      },
      {
        idempotencyKey: `bank-account-stylist-${req.user.id}-${bankAccountFingerprint(
          payload.accountNumber
        )}`,
      }
    );

    account = await client.accounts.retrieve(accountId);

    return res.status(200).json({
      success: true,
      data: {
        stripeAccountId: accountId,
        isVerified: isTransfersVerified(account),
      },
      request_id: req.id,
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/payments/authorize", requireAuth, customerOnly, handleCreateCheckout);
router.post("/payments/create-checkout", requireAuth, customerOnly, handleCreateCheckout);
router.post("/payments/create-intent", requireAuth, customerOnly, handleCreateCheckout);

router.post("/payments/confirm-authorization", requireAuth, customerOnly, async (req, res, next) => {
  try {
    const client = requireStripeClient(res, req.id);
    if (!client) return;

    const bookingId = validateRequiredIdentifier("bookingId", req.body?.bookingId, {
      maxLength: 120,
    });
    const paymentIntentId = validateRequiredIdentifier("paymentIntentId", req.body?.paymentIntentId, {
      maxLength: 120,
    });

    const booking = await findBookingPaymentById(bookingId);
    if (!booking) {
      return res.status(404).json({
        success: false,
        error: "Booking not found",
        request_id: req.id,
      });
    }

    if (!sameId(booking.customerUserId, req.user.id)) {
      return res.status(403).json({
        success: false,
        error: "You do not have access to this booking",
        request_id: req.id,
      });
    }

    if (!booking.paymentIntentId || booking.paymentIntentId !== paymentIntentId) {
      return res.status(409).json({
        success: false,
        error: "Payment reference does not match this booking",
        request_id: req.id,
      });
    }

    const intent = await client.paymentIntents.retrieve(paymentIntentId);
    if (intent.metadata?.bookingId !== String(booking.id)) {
      return res.status(409).json({
        success: false,
        error: "Payment metadata does not match this booking",
        request_id: req.id,
      });
    }

    if (intent.status !== "requires_capture") {
      return res.status(409).json({
        success: false,
        error: `Payment authorization is ${String(intent.status || "unknown").replace(/_/g, " ")}`,
        request_id: req.id,
      });
    }

    const updated = await markBookingAuthorized({
      booking,
      user: req.user,
      source: "stripe_sync",
    });

    return res.json({
      success: true,
      booking: updated,
      request_id: req.id,
    });
  } catch (error) {
    if (error instanceof ValidationError) return next(error);
    return next(error);
  }
});

router.post("/payments/capture", requireAuth, customerOnly, async (req, res, next) => {
  try {
    const client = requireStripeClient(res, req.id);
    if (!client) return;

    const bookingId = validateRequiredIdentifier("bookingId", req.body?.bookingId, {
      maxLength: 120,
    });
    const booking = await findBookingPaymentById(bookingId);
    if (!booking) {
      return res.status(404).json({
        success: false,
        error: "Booking not found",
        request_id: req.id,
      });
    }

    if (!sameId(booking.customerUserId, req.user.id)) {
      return res.status(403).json({
        success: false,
        error: "You do not have access to this booking",
        request_id: req.id,
      });
    }

    if (normalizeBookingStatus(booking.status) !== BOOKING_STATUS.BALANCE_PENDING) {
      return res.status(400).json({
        success: false,
        error: "Only balance-pending bookings can be captured",
        request_id: req.id,
      });
    }

    if (booking.balanceStatus !== BALANCE_STATUS.PENDING && booking.paymentStatus !== "authorized") {
      return res.status(400).json({
        success: false,
        error: "Booking balance payment is not authorized",
        request_id: req.id,
      });
    }

    const balanceIntentId = booking.balancePaymentIntentId || booking.paymentIntentId;
    if (!balanceIntentId) {
      return res.status(409).json({
        success: false,
        error: "Booking balance payment reference is missing",
        request_id: req.id,
      });
    }

    const intent = await client.paymentIntents.retrieve(balanceIntentId);
    if (intent.status !== "requires_capture") {
      if (["requires_payment_method", "canceled"].includes(intent.status)) {
        const resetStatus = assertCanTransition(booking.status, BOOKING_STATUS.DEPOSIT_PAID);
        await updateBookingById(booking.id, {
          payment_status: "failed",
          status: resetStatus,
          balance_status: BALANCE_STATUS.FAILED,
        });
      }

      return res.status(409).json({
        success: false,
        error: "The remaining balance still needs a valid payment method. Please complete checkout again.",
        action: "complete_checkout",
        booking: {
          id: booking.id,
          status: BOOKING_STATUS.DEPOSIT_PAID,
          balanceStatus: BALANCE_STATUS.FAILED,
        },
        request_id: req.id,
      });
    }

    const captured = await client.paymentIntents.capture(balanceIntentId, {}, {
      idempotencyKey: `capture_balance_${booking.id}`,
    });

    const amountPaid = Number.parseInt(String(captured.amount_received || captured.amount || booking.amountTotal || 0), 10);
    assertCanTransition(booking.status, BOOKING_STATUS.COMPLETED);
    const updated = await updateBookingById(booking.id, {
      payment_status: "captured",
      status: BOOKING_STATUS.COMPLETED,
      balance_status: BALANCE_STATUS.PAID,
      balance_paid_at: new Date(),
      captured_at: new Date(),
      amount_paid: amountPaid,
      paid_at: new Date(),
    });

    await logStatusTransition({
      booking,
      toStatus: BOOKING_STATUS.COMPLETED,
      user: req.user,
      reason: "Customer captured remaining balance",
    });
    await publishPaymentEvent(req, PAYMENT_CAPTURED, {
      bookingId: booking.id,
      userId: booking.customerUserId,
      customerId: booking.customerUserId,
      stylistId: booking.stylistUserId,
      shopId: booking.shopId,
      amount: amountPaid,
    });

    return res.json({ success: true, booking: updated, request_id: req.id });
  } catch (error) {
    return next(error);
  }
});

router.post("/payments/refund", requireAuth, async (req, res, next) => {
  try {
    const client = requireStripeClient(res, req.id);
    if (!client) return;

    if (!["customer", "admin"].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        error: "Customer or admin role required",
        request_id: req.id,
      });
    }

    const bookingId = validateRequiredIdentifier("bookingId", req.body?.bookingId, {
      maxLength: 120,
    });
    const booking = await findBookingPaymentById(bookingId);
    if (!booking) {
      return res.status(404).json({
        success: false,
        error: "Booking not found",
        request_id: req.id,
      });
    }

    if (req.user.role !== "admin" && !sameId(booking.customerUserId, req.user.id)) {
      return res.status(403).json({
        success: false,
        error: "You do not have access to this booking",
        request_id: req.id,
      });
    }

    if (booking.paymentStatus !== "captured") {
      return res.status(400).json({
        success: false,
        error: "Only captured bookings can be refunded",
        request_id: req.id,
      });
    }

    if (!booking.paymentIntentId) {
      return res.status(409).json({
        success: false,
        error: "Booking payment reference is missing",
        request_id: req.id,
      });
    }

    if (!canRefund(booking)) {
      return res.status(400).json({
        success: false,
        error: "Bookings cannot be refunded within 2 hours of the appointment",
        request_id: req.id,
      });
    }

    const refund = await client.refunds.create(
      {
        payment_intent: booking.paymentIntentId,
        reverse_transfer: true,
        refund_application_fee: true,
        metadata: {
          bookingId: String(booking.id),
          customerId: String(booking.customerUserId),
          requestedBy: String(req.user.id),
        },
      },
      { idempotencyKey: `refund-booking-${booking.id}` }
    );

    const updated = await updateBookingById(booking.id, {
      payment_status: "refunded",
      cancelled_at: new Date(),
      refund_id: refund.id,
      status: "cancelled",
      cancellation_reason: "Refund requested",
    });

    await insertBookingStatusHistory({
      bookingId: booking.id,
      fromStatus: booking.status,
      toStatus: "cancelled",
      changedByUserId: req.user.id,
      reason: "Refund requested",
    });

    req.logger?.info("Booking refund created", {
      request_id: req.id,
      booking_id: booking.id,
      refund_id: refund.id,
      payment_intent_id: booking.paymentIntentId,
    });

    return res.json({
      success: true,
      refundId: refund.id,
      data: updated,
      request_id: req.id,
    });
  } catch (error) {
    if (error instanceof ValidationError) return next(error);
    return next(error);
  }
});

router.post("/admin/disputes/:disputeId/resolve", requireAuth, requireRole("admin"), async (req, res, next) => {
  try {
    const client = requireStripeClient(res, req.id);
    if (!client) return;

    const disputeId = validateRequiredIdentifier("disputeId", req.params.disputeId, {
      maxLength: 120,
    });
    const booking = await findBookingByDisputeId(disputeId);
    if (!booking) {
      return res.status(404).json({
        success: false,
        error: "Dispute not found",
        request_id: req.id,
      });
    }

    if (booking.status !== "disputed" || booking.disputeStatus !== "open") {
      return res.status(400).json({
        success: false,
        error: "Only open disputes can be resolved",
        request_id: req.id,
      });
    }

    const resolution = String(req.body?.resolution || "").trim();
    const notes = typeof req.body?.notes === "string" ? req.body.notes.trim() : "";
    if (!["refund", "no_refund"].includes(resolution)) {
      return res.status(400).json({
        success: false,
        error: "resolution must be 'refund' or 'no_refund'",
        request_id: req.id,
      });
    }

    let refund = null;
    let patch;
    let toStatus;
    if (resolution === "refund") {
      if (!booking.paymentIntentId) {
        return res.status(409).json({
          success: false,
          error: "Booking payment reference is missing",
          request_id: req.id,
        });
      }

      refund = await client.refunds.create(
        {
          payment_intent: booking.paymentIntentId,
          reverse_transfer: true,
          refund_application_fee: true,
          metadata: {
            bookingId: String(booking.id),
            disputeId,
            resolvedBy: String(req.user.id),
          },
        },
        { idempotencyKey: `dispute-refund-${disputeId}` }
      );
      patch = {
        payment_status: "refunded",
        status: "refunded",
        refund_id: refund.id,
        dispute_status: "resolved_refund",
      };
      toStatus = "refunded";
    } else {
      patch = {
        status: "completed",
        dispute_status: "resolved_no_refund",
      };
      toStatus = "completed";
    }

    const updated = await updateBookingById(booking.id, patch);
    await logStatusTransition({
      booking,
      toStatus,
      user: req.user,
      reason: notes || `Dispute resolved: ${resolution}`,
    });
    await publishPaymentEvent(req, DISPUTE_RESOLVED, {
      bookingId: booking.id,
      disputeId,
      resolution,
      notes,
      userId: booking.customerUserId,
      customerId: booking.customerUserId,
      stylistId: booking.stylistUserId,
      shopId: booking.shopId,
      refundId: refund?.id || null,
    });

    return res.json({
      success: true,
      booking: updated,
      refundId: refund?.id || null,
      request_id: req.id,
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/payments/status/:bookingId", requireAuth, customerOnly, async (req, res, next) => {
  try {
    const bookingId = validateRequiredIdentifier("bookingId", req.params.bookingId, {
      maxLength: 120,
    });
    const booking = await findBookingPaymentById(bookingId);

    if (!booking) {
      return res.status(404).json({
        message: "Booking not found",
        request_id: req.id,
      });
    }

    if (!sameId(booking.customerUserId, req.user.id)) {
      return res.status(403).json({
        message: "You do not have access to this booking",
        request_id: req.id,
      });
    }

    return res.json({
      paymentStatus: booking.paymentStatus || "unpaid",
      paymentIntentId: booking.paymentIntentId,
      balanceStatus: booking.balanceStatus,
      balancePaymentIntentId: booking.balancePaymentIntentId,
      publishableKey: config.stripePublishableKey,
      amountTotal: booking.amountTotal,
      depositAmount: booking.depositAmount,
      balanceAmount: booking.balanceAmount,
      platformFee: booking.platformFee,
      balancePlatformFee: booking.balancePlatformFee,
      stylistPayout: booking.stylistPayout,
      balanceStylistPayout: booking.balanceStylistPayout,
      currency: booking.currency || CURRENCY,
      amountPaid: booking.amountPaid,
      paidAt: booking.paidAt,
      refundId: booking.refundId,
    });
  } catch (error) {
    if (error instanceof ValidationError) return next(error);
    return next(error);
  }
});

module.exports = router;

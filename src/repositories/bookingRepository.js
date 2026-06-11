const crypto = require("crypto");
const { query } = require("../db/pool");
const {
  ACTIVE_BLOCKING_STATUSES,
  publicBookingStatus,
} = require("../utils/bookingTransitions");

const BOOKING_COLUMNS = [
  "id",
  "booking_context_type",
  "customer_user_id",
  "created_by_user_id",
  "shop_id",
  "stylist_user_id",
  "service_id",
  "service_catalog_key",
  "service_name",
  "scheduled_start",
  "scheduled_end",
  "effective_duration_minutes",
  "effective_price",
  "amount_total",
  "payment_status",
  "payment_intent_id",
  "platform_fee",
  "stylist_payout",
  "currency",
  "stripe_transfer_id",
  "refund_id",
  "amount_paid",
  "paid_at",
  "deposit_required",
  "deposit_amount",
  "deposit_paid",
  "deposit_paid_at",
  "deposit_status",
  "deposit_stripe_session_id",
  "deposit_payment_intent_id",
  "deposit_platform_fee",
  "deposit_stylist_payout",
  "deposit_transfer_id",
  "deposit_refundable",
  "deposit_forfeited_at",
  "balance_amount",
  "balance_status",
  "balance_payment_intent_id",
  "balance_platform_fee",
  "balance_stylist_payout",
  "balance_paid_at",
  "cancellation_deadline",
  "authorized_at",
  "captured_at",
  "cancelled_by",
  "dispute_id",
  "dispute_reason",
  "dispute_status",
  "stylist_accepted_at",
  "stylist_rejected_at",
  "rejection_reason",
  "payout_status",
  "payout_amount",
  "payout_transfer_id",
  "payout_initiated_at",
  "payout_completed_at",
  "stripe_customer_id",
  "authorization_expiry_warning_sent_at",
  "notes",
  "cancellation_reason",
  "cancelled_at",
  "status",
  "created_at",
  "updated_at",
];
const BOOKING_COLUMNS_SQL = BOOKING_COLUMNS.join(", ");

const HISTORY_COLUMNS_SQL = [
  "id",
  "booking_id",
  "from_status",
  "to_status",
  "changed_by_user_id",
  "changed_by_role",
  "source",
  "reason",
  "created_at",
].join(", ");

function rowToBooking(row, { includePaymentSecrets = false } = {}) {
  if (!row) return null;
  const booking = {
    id: row.id,
    bookingContextType: row.booking_context_type,
    customerUserId: row.customer_user_id,
    createdByUserId: row.created_by_user_id,
    shopId: row.shop_id,
    stylistUserId: row.stylist_user_id,
    serviceId: row.service_id,
    serviceCatalogKey: row.service_catalog_key,
    serviceName: row.service_name,
    scheduledStart: row.scheduled_start,
    scheduledEnd: row.scheduled_end,
    effectiveDurationMinutes: row.effective_duration_minutes,
    effectivePrice: Number(row.effective_price),
    servicePriceSen:
      row.amount_total === null || row.amount_total === undefined ? 0 : Number(row.amount_total),
    status: row.status,
    bookingStatus: publicBookingStatus(row.status),
    paymentStatus: row.payment_status || "unpaid",
    paymentIntentId: row.payment_intent_id || null,
    amountTotal:
      row.amount_total === null || row.amount_total === undefined ? 0 : Number(row.amount_total),
    platformFee:
      row.platform_fee === null || row.platform_fee === undefined ? 0 : Number(row.platform_fee),
    stylistPayout:
      row.stylist_payout === null || row.stylist_payout === undefined
        ? 0
        : Number(row.stylist_payout),
    currency: row.currency || "myr",
    stripeTransferId: row.stripe_transfer_id || null,
    refundId: row.refund_id || null,
    amountPaid: row.amount_paid === null || row.amount_paid === undefined ? null : Number(row.amount_paid),
    paidAt: row.paid_at,
    depositRequired: Boolean(row.deposit_required),
    depositAmount:
      row.deposit_amount === null || row.deposit_amount === undefined ? 0 : Number(row.deposit_amount),
    depositPaid: Boolean(row.deposit_paid),
    depositPaidAt: row.deposit_paid_at,
    depositStatus: row.deposit_status || "PENDING",
    depositStripeSessionId: row.deposit_stripe_session_id || null,
    depositPaymentIntentId: row.deposit_payment_intent_id || null,
    depositPlatformFee:
      row.deposit_platform_fee === null || row.deposit_platform_fee === undefined
        ? 0
        : Number(row.deposit_platform_fee),
    depositStylistPayout:
      row.deposit_stylist_payout === null || row.deposit_stylist_payout === undefined
        ? 0
        : Number(row.deposit_stylist_payout),
    depositTransferId: row.deposit_transfer_id || null,
    depositRefundable: row.deposit_refundable === null || row.deposit_refundable === undefined
      ? true
      : Boolean(row.deposit_refundable),
    depositForfeitedAt: row.deposit_forfeited_at,
    balanceAmount:
      row.balance_amount === null || row.balance_amount === undefined ? 0 : Number(row.balance_amount),
    balanceStatus: row.balance_status || "UNPAID",
    balancePaymentIntentId: row.balance_payment_intent_id || null,
    balancePlatformFee:
      row.balance_platform_fee === null || row.balance_platform_fee === undefined
        ? 0
        : Number(row.balance_platform_fee),
    balanceStylistPayout:
      row.balance_stylist_payout === null || row.balance_stylist_payout === undefined
        ? 0
        : Number(row.balance_stylist_payout),
    balancePaidAt: row.balance_paid_at,
    cancellationDeadline: row.cancellation_deadline,
    authorizedAt: row.authorized_at,
    capturedAt: row.captured_at,
    cancelledBy: row.cancelled_by || null,
    disputeId: row.dispute_id || null,
    disputeReason: row.dispute_reason || null,
    disputeStatus: row.dispute_status || null,
    stylistAcceptedAt: row.stylist_accepted_at,
    stylistRejectedAt: row.stylist_rejected_at,
    rejectionReason: row.rejection_reason || null,
    payoutStatus: row.payout_status || "pending",
    payoutAmount:
      row.payout_amount === null || row.payout_amount === undefined
        ? null
        : Number(row.payout_amount),
    payoutTransferId: row.payout_transfer_id || null,
    payoutInitiatedAt: row.payout_initiated_at,
    payoutCompletedAt: row.payout_completed_at,
    notes: row.notes,
    cancellationReason: row.cancellation_reason,
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

  if (includePaymentSecrets) {
    booking.stripeCustomerId = row.stripe_customer_id || null;
  }

  return booking;
}

function rowToHistory(row) {
  if (!row) return null;
  return {
    id: row.id,
    bookingId: row.booking_id,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    changedByUserId: row.changed_by_user_id,
    changedByRole: row.changed_by_role || null,
    source: row.source || "user",
    reason: row.reason,
    createdAt: row.created_at,
  };
}

async function createBooking({
  customerUserId,
  createdByUserId,
  shopId,
  stylistUserId,
  serviceId,
  serviceCatalogKey,
  serviceName,
  scheduledStart,
  scheduledEnd,
  effectiveDurationMinutes,
  effectivePrice,
  amountTotal = 0,
  status = "pending",
  depositRequired = false,
  depositAmount = 0,
  depositPaid = false,
  depositPaidAt = null,
  depositStatus = "PENDING",
  depositRefundable = true,
  balanceAmount = 0,
  balanceStatus = "UNPAID",
  cancellationDeadline = null,
  notes = null,
}) {
  const result = await query(
    `INSERT INTO bookings (
      id,
      booking_context_type,
      customer_user_id,
      created_by_user_id,
      shop_id,
      stylist_user_id,
      service_id,
      service_catalog_key,
      service_name,
      scheduled_start,
      scheduled_end,
      effective_duration_minutes,
      effective_price,
      amount_total,
      deposit_required,
      deposit_amount,
      deposit_paid,
      deposit_paid_at,
      deposit_status,
      deposit_refundable,
      balance_amount,
      balance_status,
      cancellation_deadline,
      currency,
      payment_status,
      status,
      notes
    ) VALUES (
      $1, 'shop', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, 'myr', 'unpaid', $23, $24
    )
    RETURNING *`,
    [
      crypto.randomUUID(),
      customerUserId,
      createdByUserId,
      shopId,
      stylistUserId,
      serviceId,
      serviceCatalogKey,
      serviceName,
      scheduledStart,
      scheduledEnd,
      effectiveDurationMinutes,
      effectivePrice,
      amountTotal,
      Boolean(depositRequired),
      depositAmount,
      Boolean(depositPaid),
      depositPaidAt,
      depositStatus,
      Boolean(depositRefundable),
      balanceAmount,
      balanceStatus,
      cancellationDeadline,
      status,
      notes,
    ]
  );
  return rowToBooking(result.rows[0]);
}

async function findBookingById(id) {
  const result = await query(
    `SELECT ${BOOKING_COLUMNS_SQL} FROM bookings WHERE id = $1 LIMIT 1`,
    [id]
  );
  return rowToBooking(result.rows[0]);
}

async function findBookingPaymentById(id) {
  const result = await query(
    `SELECT ${BOOKING_COLUMNS_SQL} FROM bookings WHERE id = $1 LIMIT 1`,
    [id]
  );
  return rowToBooking(result.rows[0], { includePaymentSecrets: true });
}

async function findBookingByPaymentIntentId(paymentIntentId) {
  const result = await query(
    `SELECT ${BOOKING_COLUMNS_SQL} FROM bookings WHERE payment_intent_id = $1 LIMIT 1`,
    [paymentIntentId]
  );
  return rowToBooking(result.rows[0]);
}

async function findBookingByDepositPaymentIntentId(paymentIntentId) {
  const result = await query(
    `SELECT ${BOOKING_COLUMNS_SQL} FROM bookings WHERE deposit_payment_intent_id = $1 LIMIT 1`,
    [paymentIntentId]
  );
  return rowToBooking(result.rows[0]);
}

async function findBookingByBalancePaymentIntentId(paymentIntentId) {
  const result = await query(
    `SELECT ${BOOKING_COLUMNS_SQL} FROM bookings WHERE balance_payment_intent_id = $1 LIMIT 1`,
    [paymentIntentId]
  );
  return rowToBooking(result.rows[0], { includePaymentSecrets: true });
}

async function findBookingByDisputeId(disputeId) {
  const result = await query(
    `SELECT ${BOOKING_COLUMNS_SQL} FROM bookings WHERE dispute_id = $1 LIMIT 1`,
    [disputeId]
  );
  return rowToBooking(result.rows[0], { includePaymentSecrets: true });
}

async function listBookingsByIds(ids = []) {
  const uniqueIds = [...new Set(ids.filter(Boolean).map(String))];
  if (uniqueIds.length === 0) return [];
  const result = await query(
    `SELECT ${BOOKING_COLUMNS_SQL}
     FROM bookings
     WHERE id = ANY($1::uuid[])`,
    [uniqueIds]
  );
  return result.rows.map(rowToBooking);
}

async function findStripeCustomerIdForCustomer(customerUserId) {
  const result = await query(
    `SELECT stripe_customer_id
     FROM bookings
     WHERE customer_user_id = $1
       AND stripe_customer_id IS NOT NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [customerUserId]
  );
  return result.rows[0]?.stripe_customer_id || null;
}

async function listBookingsByCustomer(customerUserId, { limit = 20 } = {}) {
  const result = await query(
    `SELECT ${BOOKING_COLUMNS_SQL}
     FROM bookings
     WHERE customer_user_id = $1
     ORDER BY scheduled_start DESC
     LIMIT $2`,
    [customerUserId, limit]
  );
  return result.rows.map(rowToBooking);
}

async function listBookingsByStylist(stylistUserId, { limit = 50 } = {}) {
  const result = await query(
    `SELECT ${BOOKING_COLUMNS_SQL}
     FROM bookings
     WHERE stylist_user_id = $1
     ORDER BY scheduled_start DESC
     LIMIT $2`,
    [stylistUserId, limit]
  );
  return result.rows.map(rowToBooking);
}

async function listBookingsByShop(shopId, { limit = 50 } = {}) {
  const result = await query(
    `SELECT ${BOOKING_COLUMNS_SQL}
     FROM bookings
     WHERE shop_id = $1
     ORDER BY scheduled_start DESC
     LIMIT $2`,
    [shopId, limit]
  );
  return result.rows.map(rowToBooking);
}

async function findOverlappingBooking({
  stylistUserId,
  scheduledStart,
  scheduledEnd,
  excludeBookingId = null,
}) {
  const params = [stylistUserId, scheduledStart, scheduledEnd, ACTIVE_BLOCKING_STATUSES];
  let excludeClause = "";

  if (excludeBookingId) {
    params.push(excludeBookingId);
    excludeClause = `AND id <> $${params.length}`;
  }

  const result = await query(
    `SELECT ${BOOKING_COLUMNS_SQL}
     FROM bookings
     WHERE stylist_user_id = $1
       AND scheduled_start < $3
       AND scheduled_end > $2
       AND status = ANY($4)
       ${excludeClause}
     ORDER BY scheduled_start ASC
     LIMIT 1`,
    params
  );
  return rowToBooking(result.rows[0]);
}

async function updateBookingById(id, patch) {
  const fields = [];
  const params = [];

  Object.entries(patch).forEach(([key, value]) => {
    if (value === undefined) return;
    params.push(value);
    fields.push(`${key} = $${params.length}`);
  });

  if (fields.length === 0) return findBookingById(id);

  params.push(id);
  const result = await query(
    `UPDATE bookings
     SET ${fields.join(", ")}, updated_at = NOW()
     WHERE id = $${params.length}
     RETURNING *`,
    params
  );
  return rowToBooking(result.rows[0]);
}

async function markBookingPaymentSucceeded({
  bookingId,
  customerUserId,
  paymentIntentId,
  amountPaid,
  platformFee,
  stylistPayout,
  currency = "myr",
}) {
  const result = await query(
    `UPDATE bookings
     SET payment_status = 'captured',
         payment_intent_id = $3,
         amount_paid = $4,
         amount_total = $4,
         platform_fee = $5,
         stylist_payout = $6,
         currency = $7,
         paid_at = NOW(),
         captured_at = NOW(),
         status = 'completed',
         updated_at = NOW()
     WHERE id = $1
       AND customer_user_id = $2
       AND payment_intent_id = $3
     RETURNING *`,
    [bookingId, customerUserId, paymentIntentId, amountPaid, platformFee, stylistPayout, currency]
  );
  return rowToBooking(result.rows[0]);
}

async function markBookingPaymentFailed({ bookingId, paymentIntentId = null }) {
  const params = [bookingId];
  const paymentIntentClause = paymentIntentId ? "AND payment_intent_id = $2" : "";
  if (paymentIntentId) params.push(paymentIntentId);
  const result = await query(
    `UPDATE bookings
     SET payment_status = 'failed',
         status = 'accepted',
         updated_at = NOW()
     WHERE id = $1
       ${paymentIntentClause}
     RETURNING *`,
    params
  );
  return rowToBooking(result.rows[0]);
}

async function markBookingPaymentRefunded({ bookingId, refundId = null }) {
  const result = await query(
    `UPDATE bookings
     SET payment_status = 'refunded',
         refund_id = COALESCE($2, refund_id),
         cancelled_at = COALESCE(cancelled_at, NOW()),
         status = 'refunded',
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [bookingId, refundId]
  );
  return rowToBooking(result.rows[0]);
}

async function markBookingPayoutProcessing({ bookingId, customerUserId }) {
  const result = await query(
    `UPDATE bookings
     SET payout_status = 'processing',
         payout_initiated_at = NOW(),
         updated_at = NOW()
     WHERE id = $1
       AND customer_user_id = $2
       AND payment_status = 'captured'
       AND payout_status = 'pending'
     RETURNING *`,
    [bookingId, customerUserId]
  );
  return rowToBooking(result.rows[0]);
}

async function markBookingPayoutInitiated({ bookingId, payoutAmount, transferId }) {
  const result = await query(
    `UPDATE bookings
     SET payout_status = 'processing',
         payout_amount = $2,
         payout_transfer_id = $3,
         payout_initiated_at = COALESCE(payout_initiated_at, NOW()),
         status = 'completed',
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [bookingId, payoutAmount, transferId]
  );
  return rowToBooking(result.rows[0]);
}

async function markBookingPayoutPaid({ bookingId }) {
  const result = await query(
    `UPDATE bookings
     SET payout_status = 'paid',
         payout_completed_at = NOW(),
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [bookingId]
  );
  return rowToBooking(result.rows[0]);
}

async function markBookingPayoutFailed({ bookingId }) {
  const result = await query(
    `UPDATE bookings
     SET payout_status = 'failed',
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [bookingId]
  );
  return rowToBooking(result.rows[0]);
}

async function insertBookingStatusHistory({
  bookingId,
  fromStatus = null,
  toStatus,
  changedByUserId,
  changedByRole = null,
  source = "user",
  reason = null,
}) {
  const result = await query(
    `INSERT INTO booking_status_history (
      id, booking_id, from_status, to_status, changed_by_user_id, changed_by_role, source, reason
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING *`,
    [crypto.randomUUID(), bookingId, fromStatus, toStatus, changedByUserId, changedByRole, source, reason]
  );
  return rowToHistory(result.rows[0]);
}

async function listBookingStatusHistory(bookingId) {
  const result = await query(
    `SELECT ${HISTORY_COLUMNS_SQL}
     FROM booking_status_history
     WHERE booking_id = $1
     ORDER BY created_at ASC`,
    [bookingId]
  );
  return result.rows.map(rowToHistory);
}

async function listBlockingBookingsForStylistOnDate(stylistUserId, date) {
  const result = await query(
    `SELECT ${BOOKING_COLUMNS_SQL}
     FROM bookings
     WHERE stylist_user_id = $1
       AND scheduled_start >= $2::date
       AND scheduled_start < ($2::date + interval '1 day')
       AND status = ANY($3)
     ORDER BY scheduled_start ASC`,
    [stylistUserId, date, ACTIVE_BLOCKING_STATUSES]
  );
  return result.rows.map(rowToBooking);
}

async function listAuthorizationsExpiringSoon({ limit = 100 } = {}) {
  const result = await query(
    `SELECT ${BOOKING_COLUMNS_SQL}
     FROM bookings
     WHERE payment_status = 'authorized'
       AND status IN ('payment_authorized', 'confirmed')
       AND authorized_at IS NOT NULL
       AND authorized_at <= NOW() - INTERVAL '6 days'
       AND authorization_expiry_warning_sent_at IS NULL
     ORDER BY authorized_at ASC
     LIMIT $1`,
    [limit]
  );
  return result.rows.map(rowToBooking);
}

async function markAuthorizationExpiryWarningSent(bookingId) {
  const result = await query(
    `UPDATE bookings
     SET authorization_expiry_warning_sent_at = NOW(),
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [bookingId]
  );
  return rowToBooking(result.rows[0]);
}

module.exports = {
  createBooking,
  findBookingById,
  findBookingPaymentById,
  findBookingByPaymentIntentId,
  findBookingByDepositPaymentIntentId,
  findBookingByBalancePaymentIntentId,
  findBookingByDisputeId,
  listBookingsByIds,
  findStripeCustomerIdForCustomer,
  listBookingsByCustomer,
  listBookingsByStylist,
  listBookingsByShop,
  findOverlappingBooking,
  updateBookingById,
  markBookingPaymentSucceeded,
  markBookingPaymentFailed,
  markBookingPaymentRefunded,
  markBookingPayoutProcessing,
  markBookingPayoutInitiated,
  markBookingPayoutPaid,
  markBookingPayoutFailed,
  insertBookingStatusHistory,
  listBookingStatusHistory,
  listBlockingBookingsForStylistOnDate,
  listAuthorizationsExpiringSoon,
  markAuthorizationExpiryWarningSent,
};

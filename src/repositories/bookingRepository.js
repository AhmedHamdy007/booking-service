const crypto = require("crypto");
const { query } = require("../db/pool");
const { ACTIVE_BLOCKING_STATUSES } = require("../utils/bookingTransitions");

function rowToBooking(row) {
  if (!row) return null;
  return {
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
    status: row.status,
    notes: row.notes,
    cancellationReason: row.cancellation_reason,
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToHistory(row) {
  if (!row) return null;
  return {
    id: row.id,
    bookingId: row.booking_id,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    changedByUserId: row.changed_by_user_id,
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
      status,
      notes
    ) VALUES (
      $1, 'shop', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending', $13
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
      notes,
    ]
  );
  return rowToBooking(result.rows[0]);
}

async function findBookingById(id) {
  const result = await query("SELECT * FROM bookings WHERE id = $1 LIMIT 1", [id]);
  return rowToBooking(result.rows[0]);
}

async function listBookingsByCustomer(customerUserId, { limit = 20 } = {}) {
  const result = await query(
    `SELECT *
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
    `SELECT *
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
    `SELECT *
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
    `SELECT *
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

async function insertBookingStatusHistory({
  bookingId,
  fromStatus = null,
  toStatus,
  changedByUserId,
  reason = null,
}) {
  const result = await query(
    `INSERT INTO booking_status_history (
      id, booking_id, from_status, to_status, changed_by_user_id, reason
    ) VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *`,
    [crypto.randomUUID(), bookingId, fromStatus, toStatus, changedByUserId, reason]
  );
  return rowToHistory(result.rows[0]);
}

async function listBookingStatusHistory(bookingId) {
  const result = await query(
    `SELECT *
     FROM booking_status_history
     WHERE booking_id = $1
     ORDER BY created_at ASC`,
    [bookingId]
  );
  return result.rows.map(rowToHistory);
}

async function listBlockingBookingsForStylistOnDate(stylistUserId, date) {
  const result = await query(
    `SELECT *
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

module.exports = {
  createBooking,
  findBookingById,
  listBookingsByCustomer,
  listBookingsByStylist,
  listBookingsByShop,
  findOverlappingBooking,
  updateBookingById,
  insertBookingStatusHistory,
  listBookingStatusHistory,
  listBlockingBookingsForStylistOnDate,
};
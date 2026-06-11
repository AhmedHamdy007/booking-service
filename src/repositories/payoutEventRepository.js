const { query } = require("../db/pool");

function rowToPayoutEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    bookingId: row.booking_id,
    stylistId: row.stylist_id,
    eventType: row.event_type,
    amount: row.amount === null || row.amount === undefined ? null : Number(row.amount),
    stripeEventId: row.stripe_event_id,
    metadata: row.metadata,
    createdAt: row.created_at,
  };
}

async function createPayoutEvent({
  bookingId,
  stylistId,
  eventType,
  amount = null,
  stripeEventId = null,
  metadata = null,
}) {
  const result = await query(
    `INSERT INTO payout_events (
      booking_id, stylist_id, event_type, amount, stripe_event_id, metadata
    ) VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *`,
    [bookingId, stylistId, eventType, amount, stripeEventId, metadata]
  );
  return rowToPayoutEvent(result.rows[0]);
}

module.exports = {
  createPayoutEvent,
};

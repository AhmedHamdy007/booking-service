const crypto = require("crypto");
const { query } = require("../db/pool");

function rowToWebhookEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    eventId: row.event_id,
    eventType: row.event_type,
    processedAt: row.processed_at,
  };
}

async function findProcessedWebhookEvent(eventId) {
  const result = await query(
    "SELECT * FROM processed_webhook_events WHERE event_id = $1 LIMIT 1",
    [eventId]
  );
  return rowToWebhookEvent(result.rows[0]);
}

async function createProcessedWebhookEvent({ eventId, eventType, processedAt = new Date() }) {
  const result = await query(
    `INSERT INTO processed_webhook_events (id, event_id, event_type, processed_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING *`,
    [crypto.randomUUID(), eventId, eventType, processedAt]
  );
  return rowToWebhookEvent(result.rows[0]);
}

module.exports = {
  findProcessedWebhookEvent,
  createProcessedWebhookEvent,
};

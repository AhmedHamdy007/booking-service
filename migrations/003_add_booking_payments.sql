ALTER TABLE bookings
ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'unpaid'
  CHECK (payment_status IN ('unpaid', 'pending', 'paid', 'failed', 'refunded')),
ADD COLUMN IF NOT EXISTS payment_intent_id TEXT,
ADD COLUMN IF NOT EXISTS amount_paid INTEGER,
ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;

CREATE INDEX IF NOT EXISTS idx_bookings_payment_status
ON bookings(payment_status, scheduled_start DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_payment_intent
ON bookings(payment_intent_id)
WHERE payment_intent_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS processed_webhook_events (
  id UUID PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_processed_webhook_events_processed_at
ON processed_webhook_events(processed_at DESC);

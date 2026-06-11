ALTER TABLE bookings
ADD COLUMN IF NOT EXISTS payout_status TEXT NOT NULL DEFAULT 'pending',
ADD COLUMN IF NOT EXISTS payout_amount INTEGER,
ADD COLUMN IF NOT EXISTS payout_transfer_id TEXT,
ADD COLUMN IF NOT EXISTS payout_initiated_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS payout_completed_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'bookings_payout_status_check'
  ) THEN
    ALTER TABLE bookings
    ADD CONSTRAINT bookings_payout_status_check
    CHECK (payout_status IN ('pending', 'processing', 'paid', 'failed'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_bookings_payout_status
ON bookings(payout_status, scheduled_start DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_payout_transfer
ON bookings(payout_transfer_id)
WHERE payout_transfer_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS payout_events (
  id SERIAL PRIMARY KEY,
  booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  stylist_id TEXT NOT NULL,
  event_type VARCHAR(50) NOT NULL,
  amount INTEGER,
  stripe_event_id VARCHAR(255),
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payout_events_booking_id
ON payout_events(booking_id);

CREATE INDEX IF NOT EXISTS idx_payout_events_stripe_event_id
ON payout_events(stripe_event_id);

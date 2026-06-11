ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS deposit_stripe_session_id TEXT,
  ADD COLUMN IF NOT EXISTS deposit_payment_intent_id TEXT;

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_flow_check;
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_payment_status_flow_check;
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_cancelled_by_check;
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_dispute_status_check;

ALTER TABLE bookings
  ADD CONSTRAINT bookings_status_check CHECK (
    status IN (
      'pending_acceptance',
      'pending_deposit',
      'deposit_failed',
      'accepted',
      'rejected',
      'payment_authorized',
      'confirmed',
      'completed',
      'cancelled',
      'disputed',
      'refunded'
    )
  ),
  ADD CONSTRAINT bookings_payment_status_flow_check CHECK (
    payment_status IN (
      'unpaid',
      'authorized',
      'captured',
      'transferred',
      'refunded',
      'failed'
    )
  ),
  ADD CONSTRAINT bookings_cancelled_by_check CHECK (
    cancelled_by IS NULL OR cancelled_by IN ('customer', 'stylist')
  ),
  ADD CONSTRAINT bookings_dispute_status_check CHECK (
    dispute_status IS NULL OR dispute_status IN ('open', 'resolved_refund', 'resolved_no_refund')
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_deposit_stripe_session_id
  ON bookings (deposit_stripe_session_id)
  WHERE deposit_stripe_session_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_deposit_payment_intent_id
  ON bookings (deposit_payment_intent_id)
  WHERE deposit_payment_intent_id IS NOT NULL;

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS balance_amount INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS balance_status TEXT NOT NULL DEFAULT 'UNPAID',
  ADD COLUMN IF NOT EXISTS balance_payment_intent_id TEXT,
  ADD COLUMN IF NOT EXISTS balance_platform_fee INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS balance_stylist_payout INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS balance_paid_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deposit_refundable BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS cancellation_deadline TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deposit_forfeited_at TIMESTAMPTZ;

UPDATE bookings
SET amount_total = COALESCE(NULLIF(amount_total, 0), ROUND(effective_price * 100)::INTEGER, 0)
WHERE amount_total = 0;

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_flow_check;
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_deposit_status_check;
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_deposit_amount_non_negative_check;
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_balance_status_check;
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_balance_amount_non_negative;
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_balance_platform_fee_non_negative;
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_balance_stylist_payout_non_negative;

ALTER TABLE bookings
  ALTER COLUMN deposit_amount TYPE INTEGER
  USING ROUND(deposit_amount * 100)::INTEGER;

UPDATE bookings
SET
  cancellation_deadline = COALESCE(cancellation_deadline, scheduled_start - INTERVAL '7 hours'),
  deposit_refundable = COALESCE(deposit_refundable, (scheduled_start - NOW()) >= INTERVAL '7 hours'),
  balance_amount = GREATEST(amount_total - deposit_amount, 0)
WHERE cancellation_deadline IS NULL
   OR balance_amount = 0;

UPDATE bookings
SET status = CASE
  WHEN status = 'pending_deposit' THEN 'deposit_pending'
  WHEN status = 'deposit_failed' AND deposit_status = 'EXPIRED' THEN 'deposit_expired'
  WHEN status = 'deposit_failed' THEN 'deposit_failed'
  WHEN status IN ('pending_acceptance', 'accepted') THEN 'pending'
  WHEN status IN ('payment_authorized', 'confirmed') AND deposit_paid = TRUE THEN 'deposit_paid'
  WHEN status IN ('payment_authorized', 'confirmed') THEN 'deposit_paid'
  WHEN status = 'refunded' THEN 'cancelled_refunded'
  WHEN status = 'rejected' THEN 'cancelled'
  ELSE status
END;

UPDATE bookings
SET deposit_status = CASE
  WHEN deposit_status = 'REFUNDED' THEN 'REFUNDED'
  WHEN deposit_paid = TRUE THEN 'PAID'
  WHEN status = 'deposit_expired' THEN 'EXPIRED'
  WHEN status = 'deposit_failed' THEN 'FAILED'
  ELSE COALESCE(deposit_status, 'PENDING')
END;

UPDATE bookings
SET balance_status = CASE
  WHEN payment_status = 'captured' OR status = 'completed' THEN 'PAID'
  WHEN payment_status = 'failed' THEN 'FAILED'
  WHEN payment_status = 'authorized' OR status = 'balance_pending' THEN 'PENDING'
  ELSE COALESCE(balance_status, 'UNPAID')
END;

ALTER TABLE bookings
  ALTER COLUMN status SET DEFAULT 'pending',
  ALTER COLUMN deposit_amount SET DEFAULT 0,
  ADD CONSTRAINT bookings_status_check CHECK (
    status IN (
      'pending',
      'deposit_pending',
      'deposit_paid',
      'balance_pending',
      'completed',
      'cancelled',
      'cancelled_refunded',
      'cancelled_forfeited',
      'deposit_expired',
      'deposit_failed'
    )
  ),
  ADD CONSTRAINT bookings_deposit_status_check CHECK (
    deposit_status IN ('PENDING', 'PAID', 'EXPIRED', 'FAILED', 'REFUNDED', 'FORFEITED')
  ),
  ADD CONSTRAINT bookings_balance_status_check CHECK (
    balance_status IN ('UNPAID', 'PENDING', 'PAID', 'FAILED')
  ),
  ADD CONSTRAINT bookings_deposit_amount_non_negative_check CHECK (deposit_amount >= 0),
  ADD CONSTRAINT bookings_balance_amount_non_negative CHECK (balance_amount >= 0),
  ADD CONSTRAINT bookings_balance_platform_fee_non_negative CHECK (balance_platform_fee >= 0),
  ADD CONSTRAINT bookings_balance_stylist_payout_non_negative CHECK (balance_stylist_payout >= 0);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_balance_payment_intent_id
  ON bookings (balance_payment_intent_id)
  WHERE balance_payment_intent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bookings_balance_status
  ON bookings (balance_status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_bookings_cancellation_deadline
  ON bookings (cancellation_deadline)
  WHERE cancellation_deadline IS NOT NULL;

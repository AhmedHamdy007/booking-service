ALTER TABLE bookings ADD COLUMN IF NOT EXISTS status VARCHAR(30) DEFAULT 'pending_acceptance';
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_intent_id VARCHAR(255);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_status VARCHAR(30) DEFAULT 'unpaid';
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS authorized_at TIMESTAMPTZ;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS authorization_expiry_warning_sent_at TIMESTAMPTZ;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS captured_at TIMESTAMPTZ;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS cancelled_by VARCHAR(20);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS dispute_id VARCHAR(255);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS dispute_reason TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS dispute_status VARCHAR(30);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS refund_id VARCHAR(255);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS stylist_accepted_at TIMESTAMPTZ;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS stylist_rejected_at TIMESTAMPTZ;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

ALTER TABLE booking_status_history
ADD COLUMN IF NOT EXISTS changed_by_role VARCHAR(30),
ADD COLUMN IF NOT EXISTS source VARCHAR(30) DEFAULT 'user';

DO $$
DECLARE
  constraint_record RECORD;
BEGIN
  FOR constraint_record IN
    SELECT c.conname
    FROM pg_constraint c
    WHERE c.conrelid = 'bookings'::regclass
      AND c.contype = 'c'
      AND c.conkey && ARRAY(
        SELECT a.attnum
        FROM pg_attribute a
        WHERE a.attrelid = 'bookings'::regclass
          AND a.attname IN ('status', 'payment_status', 'cancelled_by', 'dispute_status')
      )
  LOOP
    EXECUTE format('ALTER TABLE bookings DROP CONSTRAINT %I', constraint_record.conname);
  END LOOP;
END $$;

UPDATE bookings
SET status = CASE status
  WHEN 'pending' THEN 'pending_acceptance'
  WHEN 'checked_in' THEN 'confirmed'
  WHEN 'in_progress' THEN 'confirmed'
  WHEN 'no_show' THEN 'cancelled'
  ELSE status
END;

UPDATE bookings
SET payment_status = CASE payment_status
  WHEN 'pending' THEN 'unpaid'
  WHEN 'paid' THEN 'captured'
  ELSE payment_status
END;

UPDATE bookings
SET status = 'confirmed'
WHERE status = 'payment_authorized'
  AND payment_status = 'captured';

ALTER TABLE bookings
ALTER COLUMN status SET DEFAULT 'pending_acceptance',
ALTER COLUMN payment_status SET DEFAULT 'unpaid',
ADD CONSTRAINT bookings_status_flow_check
  CHECK (status IN (
    'pending_acceptance',
    'accepted',
    'rejected',
    'payment_authorized',
    'confirmed',
    'completed',
    'cancelled',
    'disputed',
    'refunded'
  )),
ADD CONSTRAINT bookings_payment_status_flow_check
  CHECK (payment_status IN (
    'unpaid',
    'authorized',
    'captured',
    'transferred',
    'refunded',
    'failed'
  )),
ADD CONSTRAINT bookings_cancelled_by_check
  CHECK (cancelled_by IS NULL OR cancelled_by IN ('customer', 'stylist')),
ADD CONSTRAINT bookings_dispute_status_check
  CHECK (dispute_status IS NULL OR dispute_status IN ('open', 'resolved_refund', 'resolved_no_refund'));

CREATE INDEX IF NOT EXISTS idx_bookings_dispute_id
ON bookings(dispute_id)
WHERE dispute_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bookings_authorized_at
ON bookings(authorized_at)
WHERE payment_status = 'authorized';

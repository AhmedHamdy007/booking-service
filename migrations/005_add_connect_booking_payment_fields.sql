ALTER TABLE bookings
ADD COLUMN IF NOT EXISTS amount_total INTEGER NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS platform_fee INTEGER NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS stylist_payout INTEGER NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'myr',
ADD COLUMN IF NOT EXISTS stripe_transfer_id TEXT,
ADD COLUMN IF NOT EXISTS refund_id TEXT;

UPDATE bookings
SET payment_status = 'pending'
WHERE payment_status = 'unpaid';

UPDATE bookings
SET amount_total = COALESCE(
  amount_paid,
  NULLIF(amount_total, 0),
  ROUND(effective_price * 100)::INTEGER,
  0
)
WHERE amount_total = 0;

DO $$
DECLARE
  constraint_record RECORD;
BEGIN
  FOR constraint_record IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'bookings'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%payment_status%'
  LOOP
    EXECUTE format('ALTER TABLE bookings DROP CONSTRAINT %I', constraint_record.conname);
  END LOOP;
END $$;

ALTER TABLE bookings
ALTER COLUMN payment_status SET DEFAULT 'pending',
ADD CONSTRAINT bookings_payment_status_check
  CHECK (payment_status IN ('pending', 'paid', 'failed', 'refunded')),
ADD CONSTRAINT bookings_amount_total_non_negative
  CHECK (amount_total >= 0),
ADD CONSTRAINT bookings_platform_fee_non_negative
  CHECK (platform_fee >= 0),
ADD CONSTRAINT bookings_stylist_payout_non_negative
  CHECK (stylist_payout >= 0),
ADD CONSTRAINT bookings_currency_not_blank
  CHECK (length(trim(currency)) > 0);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_stripe_transfer
ON bookings(stripe_transfer_id)
WHERE stripe_transfer_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_refund_id
ON bookings(refund_id)
WHERE refund_id IS NOT NULL;

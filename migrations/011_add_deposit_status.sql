ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS deposit_status TEXT NOT NULL DEFAULT 'PENDING';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'bookings_deposit_status_check'
      AND conrelid = 'bookings'::regclass
  ) THEN
    ALTER TABLE bookings DROP CONSTRAINT bookings_deposit_status_check;
  END IF;
END $$;

ALTER TABLE bookings
  ADD CONSTRAINT bookings_deposit_status_check CHECK (
    deposit_status IN ('PENDING', 'PAID', 'EXPIRED', 'FAILED', 'REFUNDED')
  );

UPDATE bookings
SET deposit_status = CASE
  WHEN deposit_paid = TRUE THEN 'PAID'
  WHEN status = 'deposit_failed' THEN 'FAILED'
  ELSE 'PENDING'
END
WHERE deposit_status IS NULL
   OR deposit_status = 'PENDING';

CREATE INDEX IF NOT EXISTS idx_bookings_deposit_status
  ON bookings (deposit_status, created_at DESC);

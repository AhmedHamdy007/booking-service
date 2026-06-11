ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS deposit_platform_fee INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deposit_stylist_payout INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deposit_transfer_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'bookings_deposit_platform_fee_non_negative'
      AND conrelid = 'bookings'::regclass
  ) THEN
    ALTER TABLE bookings
      ADD CONSTRAINT bookings_deposit_platform_fee_non_negative
      CHECK (deposit_platform_fee >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'bookings_deposit_stylist_payout_non_negative'
      AND conrelid = 'bookings'::regclass
  ) THEN
    ALTER TABLE bookings
      ADD CONSTRAINT bookings_deposit_stylist_payout_non_negative
      CHECK (deposit_stylist_payout >= 0);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_deposit_transfer_id
  ON bookings (deposit_transfer_id)
  WHERE deposit_transfer_id IS NOT NULL;

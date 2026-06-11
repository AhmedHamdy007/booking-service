ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS deposit_required BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS deposit_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deposit_paid BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS deposit_paid_at TIMESTAMPTZ;

DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT con.conname
    FROM pg_constraint con
    INNER JOIN pg_class rel ON rel.oid = con.conrelid
    INNER JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = 'bookings'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE bookings DROP CONSTRAINT IF EXISTS %I', constraint_name);
  END LOOP;
END $$;

ALTER TABLE bookings
  ADD CONSTRAINT bookings_status_check CHECK (
    status IN (
      'pending_acceptance',
      'pending_deposit',
      'accepted',
      'rejected',
      'payment_authorized',
      'confirmed',
      'completed',
      'cancelled',
      'disputed',
      'refunded'
    )
  );

ALTER TABLE bookings
  ADD CONSTRAINT bookings_deposit_amount_non_negative_check CHECK (deposit_amount >= 0);

CREATE INDEX IF NOT EXISTS idx_bookings_customer_pending_deposit
  ON bookings (customer_user_id, created_at DESC)
  WHERE status = 'pending_deposit';

CREATE TABLE IF NOT EXISTS bookings (
  id UUID PRIMARY KEY,
  booking_context_type TEXT NOT NULL CHECK (booking_context_type IN ('shop')),
  customer_user_id TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  stylist_user_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  service_catalog_key TEXT,
  service_name VARCHAR(160) NOT NULL,
  scheduled_start TIMESTAMPTZ NOT NULL,
  scheduled_end TIMESTAMPTZ NOT NULL,
  effective_duration_minutes SMALLINT NOT NULL CHECK (effective_duration_minutes BETWEEN 5 AND 480),
  effective_price NUMERIC(10, 2) NOT NULL CHECK (effective_price >= 0),
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'confirmed', 'checked_in', 'in_progress', 'completed', 'cancelled', 'no_show')
  ),
  notes TEXT,
  cancellation_reason TEXT,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bookings_customer
ON bookings(customer_user_id, scheduled_start DESC);

CREATE INDEX IF NOT EXISTS idx_bookings_shop
ON bookings(shop_id, scheduled_start DESC);

CREATE INDEX IF NOT EXISTS idx_bookings_stylist
ON bookings(stylist_user_id, scheduled_start DESC);

CREATE INDEX IF NOT EXISTS idx_bookings_status
ON bookings(status, scheduled_start DESC);
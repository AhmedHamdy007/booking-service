CREATE INDEX IF NOT EXISTS idx_bookings_customer_created
ON bookings(customer_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_bookings_stylist_status_start
ON bookings(stylist_user_id, status, scheduled_start ASC);

CREATE INDEX IF NOT EXISTS idx_bookings_shop_created
ON bookings(shop_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_bookings_service_id
ON bookings(service_id);

CREATE INDEX IF NOT EXISTS idx_bookings_created_at
ON bookings(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_bookings_payment_status_created
ON bookings(payment_status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_bookings_authorization_warning
ON bookings(authorized_at ASC)
WHERE payment_status = 'authorized'
  AND authorization_expiry_warning_sent_at IS NULL;

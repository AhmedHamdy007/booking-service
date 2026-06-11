const BOOKING_STATUS = Object.freeze({
  PENDING: "pending",
  DEPOSIT_PENDING: "deposit_pending",
  DEPOSIT_PAID: "deposit_paid",
  BALANCE_PENDING: "balance_pending",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
  CANCELLED_REFUNDED: "cancelled_refunded",
  CANCELLED_FORFEITED: "cancelled_forfeited",
  DEPOSIT_EXPIRED: "deposit_expired",
  DEPOSIT_FAILED: "deposit_failed",
});

const PUBLIC_BOOKING_STATUS = Object.freeze(
  Object.fromEntries(
    Object.entries(BOOKING_STATUS).map(([key, value]) => [value, key])
  )
);

const DEPOSIT_STATUS = Object.freeze({
  PENDING: "PENDING",
  PAID: "PAID",
  EXPIRED: "EXPIRED",
  FAILED: "FAILED",
  REFUNDED: "REFUNDED",
  FORFEITED: "FORFEITED",
});

const BALANCE_STATUS = Object.freeze({
  UNPAID: "UNPAID",
  PENDING: "PENDING",
  PAID: "PAID",
  FAILED: "FAILED",
});

const TERMINAL_BOOKING_STATUSES = [
  BOOKING_STATUS.COMPLETED,
  BOOKING_STATUS.CANCELLED,
  BOOKING_STATUS.CANCELLED_REFUNDED,
  BOOKING_STATUS.CANCELLED_FORFEITED,
  BOOKING_STATUS.DEPOSIT_EXPIRED,
  BOOKING_STATUS.DEPOSIT_FAILED,
];

const ACTIVE_BLOCKING_STATUSES = [
  BOOKING_STATUS.PENDING,
  BOOKING_STATUS.DEPOSIT_PENDING,
  BOOKING_STATUS.DEPOSIT_PAID,
  BOOKING_STATUS.BALANCE_PENDING,
];

const ALLOWED_TRANSITIONS = {
  [BOOKING_STATUS.PENDING]: [
    BOOKING_STATUS.DEPOSIT_PENDING,
    BOOKING_STATUS.CANCELLED,
  ],
  [BOOKING_STATUS.DEPOSIT_PENDING]: [
    BOOKING_STATUS.DEPOSIT_PAID,
    BOOKING_STATUS.DEPOSIT_EXPIRED,
    BOOKING_STATUS.DEPOSIT_FAILED,
  ],
  [BOOKING_STATUS.DEPOSIT_PAID]: [
    BOOKING_STATUS.BALANCE_PENDING,
    BOOKING_STATUS.CANCELLED_REFUNDED,
    BOOKING_STATUS.CANCELLED_FORFEITED,
  ],
  [BOOKING_STATUS.BALANCE_PENDING]: [
    BOOKING_STATUS.COMPLETED,
    BOOKING_STATUS.DEPOSIT_PAID,
  ],
  [BOOKING_STATUS.DEPOSIT_EXPIRED]: [BOOKING_STATUS.DEPOSIT_PENDING],
  [BOOKING_STATUS.DEPOSIT_FAILED]: [BOOKING_STATUS.DEPOSIT_PENDING],
  [BOOKING_STATUS.COMPLETED]: [],
  [BOOKING_STATUS.CANCELLED]: [],
  [BOOKING_STATUS.CANCELLED_REFUNDED]: [],
  [BOOKING_STATUS.CANCELLED_FORFEITED]: [],
};

function normalizeBookingStatus(status) {
  const raw = String(status || "").trim();
  const lower = raw.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(PUBLIC_BOOKING_STATUS, lower)) return lower;
  if (Object.prototype.hasOwnProperty.call(BOOKING_STATUS, raw)) return BOOKING_STATUS[raw];
  return lower;
}

function publicBookingStatus(status) {
  return PUBLIC_BOOKING_STATUS[normalizeBookingStatus(status)] || String(status || "").toUpperCase();
}

function canTransition(fromStatus, toStatus) {
  const from = normalizeBookingStatus(fromStatus);
  const to = normalizeBookingStatus(toStatus);
  if (from === to) return true;
  return (ALLOWED_TRANSITIONS[from] || []).includes(to);
}

function assertCanTransition(fromStatus, toStatus) {
  if (canTransition(fromStatus, toStatus)) return normalizeBookingStatus(toStatus);
  const error = new Error(
    `Invalid booking status transition: ${publicBookingStatus(fromStatus)} -> ${publicBookingStatus(toStatus)}`
  );
  error.status = 409;
  throw error;
}

function isBlockingStatus(status) {
  return ACTIVE_BLOCKING_STATUSES.includes(normalizeBookingStatus(status));
}

module.exports = {
  BOOKING_STATUS,
  PUBLIC_BOOKING_STATUS,
  DEPOSIT_STATUS,
  BALANCE_STATUS,
  TERMINAL_BOOKING_STATUSES,
  ACTIVE_BLOCKING_STATUSES,
  ALLOWED_TRANSITIONS,
  normalizeBookingStatus,
  publicBookingStatus,
  canTransition,
  assertCanTransition,
  isBlockingStatus,
};

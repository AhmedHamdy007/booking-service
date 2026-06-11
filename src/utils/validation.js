class ValidationError extends Error {
  constructor(message, field = null) {
    super(message);
    this.name = "ValidationError";
    this.field = field;
  }
}

const {
  BOOKING_STATUS,
  normalizeBookingStatus,
  publicBookingStatus,
} = require("./bookingTransitions");

const BOOKING_STATUSES = [
  ...Object.values(BOOKING_STATUS),
];

function validateOptionalString(name, value, { maxLength = 255 } = {}) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new ValidationError(`${name} must be a string`, name);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new ValidationError(`${name} exceeds max length ${maxLength}`, name);
  }
  return trimmed;
}

function validateRequiredString(name, value, { maxLength = 255 } = {}) {
  const normalized = validateOptionalString(name, value, { maxLength });
  if (!normalized) {
    throw new ValidationError(`${name} is required`, name);
  }
  return normalized;
}

function validateRequiredIdentifier(name, value, { maxLength = 120 } = {}) {
  if (value === undefined || value === null || value === "") {
    throw new ValidationError(`${name} is required`, name);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ValidationError(`${name} must be a valid identifier`, name);
    }
    return String(value);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      throw new ValidationError(`${name} is required`, name);
    }
    if (trimmed.length > maxLength) {
      throw new ValidationError(`${name} exceeds max length ${maxLength}`, name);
    }
    return trimmed;
  }

  throw new ValidationError(`${name} must be a string or number`, name);
}

function validateIsoDate(name, value) {
  const normalized = validateRequiredString(name, value, { maxLength: 40 });
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    throw new ValidationError(`${name} must be a valid ISO date`, name);
  }
  return parsed;
}

function validateDateOnly(name, value) {
  const normalized = validateRequiredString(name, value, { maxLength: 10 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new ValidationError(`${name} must be in YYYY-MM-DD format`, name);
  }
  return normalized;
}

function validateListLimit(rawValue) {
  if (rawValue === undefined) return 20;
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new ValidationError("limit must be an integer between 1 and 100", "limit");
  }
  return parsed;
}

function validateBookingStatus(value) {
  const normalized = normalizeBookingStatus(validateRequiredString("status", value, { maxLength: 40 }));
  if (!BOOKING_STATUSES.includes(normalized)) {
    throw new ValidationError(
      `status must be one of: ${BOOKING_STATUSES.map(publicBookingStatus).join(", ")}`,
      "status"
    );
  }
  return normalized;
}

function normalizeCreateBookingPayload(body) {
  return {
    shopId: validateRequiredIdentifier("shopId", body.shopId, { maxLength: 120 }),
    stylistUserId: validateRequiredIdentifier("stylistUserId", body.stylistUserId, {
      maxLength: 120,
    }),
    serviceId: validateRequiredIdentifier("serviceId", body.serviceId, { maxLength: 120 }),
    scheduledStart: validateIsoDate("scheduledStart", body.scheduledStart),
    notes: validateOptionalString("notes", body.notes, { maxLength: 2000 }),
  };
}

function normalizeReschedulePayload(body) {
  return {
    scheduledStart: validateIsoDate("scheduledStart", body.scheduledStart),
    reason: validateOptionalString("reason", body.reason, { maxLength: 500 }),
  };
}

function normalizeCancelPayload(body) {
  return {
    reason: validateOptionalString("reason", body.reason, { maxLength: 500 }),
  };
}

function normalizeStatusUpdatePayload(body) {
  return {
    status: validateBookingStatus(body.status),
    reason: validateOptionalString("reason", body.reason, { maxLength: 500 }),
  };
}

module.exports = {
  ValidationError,
  BOOKING_STATUSES,
  validateOptionalString,
  validateRequiredString,
  validateRequiredIdentifier,
  validateIsoDate,
  validateDateOnly,
  validateListLimit,
  normalizeCreateBookingPayload,
  normalizeReschedulePayload,
  normalizeCancelPayload,
  normalizeStatusUpdatePayload,
};

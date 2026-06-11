const { ValidationError } = require("../utils/validation");

function errorHandler(err, req, res, next) {
  req.logger?.error("Booking request failed", {
    request_id: req.id,
    method: req.method,
    path: req.path,
    error: err.message,
  });

  if (err instanceof ValidationError) {
    return res.status(400).json({
      success: false,
      error: err.message,
      field: err.field,
      request_id: req.id,
    });
  }

  if (err.type && String(err.type).startsWith("Stripe")) {
    const stripeStatus = Number.isInteger(err.statusCode) && err.statusCode >= 400 && err.statusCode < 600
      ? err.statusCode
      : 502;
    const safeMessage = process.env.NODE_ENV === "production"
      ? "Payment provider request failed"
      : err.message || "Stripe request failed";
    return res.status(stripeStatus).json({
      success: false,
      error: safeMessage,
      code: err.code || undefined,
      request_id: req.id,
    });
  }

  const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600
    ? err.status
    : 500;

  return res.status(status).json({
    success: false,
    error: status === 500 ? "Internal server error" : err.message,
    request_id: req.id,
  });
}

module.exports = errorHandler;

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

  return res.status(500).json({
    success: false,
    error: "Internal server error",
    request_id: req.id,
  });
}

module.exports = errorHandler;
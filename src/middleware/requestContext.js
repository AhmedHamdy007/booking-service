const crypto = require("crypto");

function requestContext(logger) {
  return (req, res, next) => {
    const requestId = req.headers["x-request-id"] || crypto.randomUUID();
    req.id = requestId;
    req.logger = logger;

    const start = Date.now();
    logger.info("Incoming request", {
      request_id: requestId,
      method: req.method,
      path: req.path,
    });

    res.on("finish", () => {
      logger.info("Request completed", {
        request_id: requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration_ms: Date.now() - start,
      });
    });

    next();
  };
}

module.exports = requestContext;

require("express-async-errors");

const express = require("express");
const cors = require("cors");

const config = require("./config");
const {
  createCorsOptions,
  securityHeadersMiddleware,
} = require("../../shared/http/httpSecurity");
const { Logger } = require("./utils/logger");
const requestContext = require("./middleware/requestContext");
const bookingRoutes = require("./routes/booking.routes");
const errorHandler = require("./middleware/errorHandler");

const logger = new Logger("booking-service", config.logLevel);
const app = express();
const corsOptions = createCorsOptions({
  nodeEnv: config.nodeEnv,
  corsAllowedOrigins: config.corsAllowedOrigins,
  allowedMethods: ["GET", "POST", "PATCH"],
});

app.use(securityHeadersMiddleware);
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(requestContext(logger));
app.use(bookingRoutes);

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: `Route not found: ${req.method} ${req.path}`,
    request_id: req.id,
  });
});

app.use(errorHandler);

const server = app.listen(config.port, () => {
  logger.info("Booking service started", {
    port: config.port,
    nodeEnv: config.nodeEnv,
  });
});

function shutdown(signal) {
  logger.info("Shutdown signal received", { signal });
  server.close(() => process.exit(0));
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

module.exports = app;
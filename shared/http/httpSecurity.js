"use strict";

const DEFAULT_DEV_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

function normalizeList(values) {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);
}

function resolveAllowedOrigins({ nodeEnv, corsAllowedOrigins }) {
  const configured = normalizeList(corsAllowedOrigins);
  if (configured.length > 0) return configured;

  if (nodeEnv === "production") {
    return [];
  }

  return DEFAULT_DEV_ORIGINS;
}

function createCorsOptions({
  nodeEnv,
  corsAllowedOrigins,
  allowedMethods,
  allowedHeaders = ["Authorization", "Content-Type", "X-Request-Id", "Accept"],
}) {
  const methods = normalizeList(allowedMethods);
  const headers = normalizeList(allowedHeaders);
  const allowedOrigins = resolveAllowedOrigins({ nodeEnv, corsAllowedOrigins });

  return {
    origin(origin, callback) {
      // Non-browser and same-process calls do not send Origin and should not be blocked.
      if (!origin) {
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(null, false);
    },
    credentials: true,
    methods,
    allowedHeaders: headers,
    optionsSuccessStatus: 204,
    maxAge: nodeEnv === "production" ? 600 : 0,
  };
}

function securityHeadersMiddleware(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-site");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  }
  next();
}

module.exports = {
  createCorsOptions,
  securityHeadersMiddleware,
  resolveAllowedOrigins,
};

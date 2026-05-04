require("dotenv").config();

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function csvEnv(name) {
  const value = process.env[name];
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function intEnv(name) {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} is required`);
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

module.exports = {
  port: intEnv("PORT"),
  nodeEnv: requiredEnv("NODE_ENV"),
  logLevel: requiredEnv("LOG_LEVEL"),
  databaseUrl: requiredEnv("DATABASE_URL"),
  authServiceUrl: requiredEnv("AUTH_SERVICE_URL"),
  shopServiceUrl: requiredEnv("SHOP_SERVICE_URL"),
  jwtPublicKeyPath: requiredEnv("JWT_PUBLIC_KEY_PATH"),
  jwtIssuer: requiredEnv("JWT_ISSUER"),
  jwtAudience: requiredEnv("JWT_AUDIENCE"),
  corsAllowedOrigins: csvEnv("CORS_ALLOWED_ORIGINS"),
};

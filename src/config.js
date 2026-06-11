require("dotenv").config();

const required = [
  "STRIPE_SECRET_KEY",
  "STRIPE_PUBLISHABLE_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PLATFORM_FEE_PERCENT",
  "CLIENT_URL",
];
for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required env variable: ${key}`);
  }
}

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

function stripeKeyMode(value) {
  if (value.startsWith("sk_test_") || value.startsWith("pk_test_")) return "test";
  if (value.startsWith("sk_live_") || value.startsWith("pk_live_")) return "live";
  return null;
}

function requiredStripeKey(name, prefix) {
  const value = requiredEnv(name).trim();
  if (!value.startsWith(prefix)) {
    throw new Error(`${name} must start with ${prefix}`);
  }
  if (/replace_me|changeme|your_/i.test(value)) {
    throw new Error(`${name} must be replaced with a real Stripe key`);
  }
  if (!stripeKeyMode(value)) {
    throw new Error(`${name} must be a Stripe test or live key`);
  }
  return value;
}

const stripeSecretKey = requiredStripeKey("STRIPE_SECRET_KEY", "sk_");
const stripePublishableKey = requiredStripeKey("STRIPE_PUBLISHABLE_KEY", "pk_");
if (stripeKeyMode(stripeSecretKey) !== stripeKeyMode(stripePublishableKey)) {
  throw new Error("STRIPE_SECRET_KEY and STRIPE_PUBLISHABLE_KEY must both be test keys or both be live keys");
}
if (process.env.NODE_ENV === "production" && stripeKeyMode(stripeSecretKey) !== "live") {
  throw new Error("Production payments require live Stripe keys");
}

module.exports = {
  port: intEnv("PORT"),
  nodeEnv: requiredEnv("NODE_ENV"),
  logLevel: requiredEnv("LOG_LEVEL"),
  databaseUrl: requiredEnv("DATABASE_URL"),
  authServiceUrl: requiredEnv("AUTH_SERVICE_URL"),
  shopServiceUrl: requiredEnv("SHOP_SERVICE_URL"),
  stripeSecretKey,
  stripePublishableKey,
  stripeWebhookSecret: requiredEnv("STRIPE_WEBHOOK_SECRET"),
  stripePlatformFeePercent: intEnv("STRIPE_PLATFORM_FEE_PERCENT"),
  clientUrl: requiredEnv("CLIENT_URL").replace(/\/+$/, ""),
  jwtPublicKeyPath: requiredEnv("JWT_PUBLIC_KEY_PATH"),
  jwtIssuer: requiredEnv("JWT_ISSUER"),
  jwtAudience: requiredEnv("JWT_AUDIENCE"),
  corsAllowedOrigins: csvEnv("CORS_ALLOWED_ORIGINS"),
};

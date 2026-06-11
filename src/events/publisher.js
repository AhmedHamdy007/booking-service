const { getChannel } = require("./broker");

const EXCHANGE = "salon.events";
const NOTIFICATION_TIMEOUT_MS = 5000;
const NOTIFICATION_RETRIES = 3;

function log(level, message, meta = {}) {
  const payload = {
    timestamp: new Date().toISOString(),
    service: "event-publisher",
    level,
    message,
    ...meta,
  };
  const output = JSON.stringify(payload);
  if (level === "ERROR") console.error(output);
  else if (level === "WARN") console.warn(output);
  else console.log(output);
}

async function dispatchToNotificationService(routingKey, payload) {
  const baseUrl = process.env.NOTIFICATION_SERVICE_URL;
  if (!baseUrl) return false;

  let lastError;
  for (let attempt = 1; attempt <= NOTIFICATION_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), NOTIFICATION_TIMEOUT_MS);
    try {
      const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/internal/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(process.env.INTERNAL_EVENT_TOKEN
            ? { "x-internal-event-token": process.env.INTERNAL_EVENT_TOKEN }
            : {}),
        },
        body: JSON.stringify({
          type: routingKey,
          payload,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (response.ok) return true;
      lastError = new Error(`notification-service returned ${response.status}`);
      if (response.status < 500 && response.status !== 429) break;
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;
    }

    if (attempt < NOTIFICATION_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 300));
    }
  }

  throw lastError || new Error("notification-service dispatch failed");
}

async function publish(routingKey, payload) {
  if (!process.env.RABBITMQ_URL) {
    dispatchToNotificationService(routingKey, payload)
      .then((dispatched) => {
        if (dispatched) {
          log("INFO", "Dispatched event directly to notification-service", {
            routing_key: routingKey,
          });
        } else {
          log("WARN", "Notification-service fallback is not configured", {
            routing_key: routingKey,
          });
        }
      })
      .catch((error) => {
        log("ERROR", "Failed to dispatch event directly to notification-service", {
          routing_key: routingKey,
          error: error.message,
        });
      });

    log("WARN", "RabbitMQ URL missing; notification fallback is running asynchronously", {
      routing_key: routingKey,
    });
    return;
  }

  const channel = await getChannel();
  await channel.assertExchange(EXCHANGE, "topic", { durable: true });
  const body = Buffer.from(JSON.stringify(payload));
  const accepted = channel.publish(EXCHANGE, routingKey, body, {
    persistent: true,
    contentType: "application/json",
  });

  if (!accepted) {
    await new Promise((resolve) => channel.once("drain", resolve));
  }
}

module.exports = { publish };

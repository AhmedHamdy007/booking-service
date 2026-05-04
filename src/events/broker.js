const amqp = require("amqplib");

const EXCHANGE = "salon.events";
const DLX = "salon.events.dlx";
const DLQ = "salon.dlq";
const MAX_RETRIES = 10;
const RETRY_DELAY_MS = 5000;

let connection = null;
let channel = null;
let connectingPromise = null;
let reconnectTimer = null;
let retries = 0;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(level, message, meta = {}) {
  const payload = {
    timestamp: new Date().toISOString(),
    service: "event-broker",
    level,
    message,
    ...meta,
  };
  const output = JSON.stringify(payload);
  if (level === "ERROR") console.error(output);
  else if (level === "WARN") console.warn(output);
  else console.log(output);
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  channel = null;
  connection = null;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      await connect();
    } catch (error) {
      log("ERROR", "RabbitMQ reconnect failed", { error: error.message });
    }
  }, RETRY_DELAY_MS);
}

async function initializeConnection() {
  const rabbitUrl = process.env.RABBITMQ_URL;
  if (!rabbitUrl) {
    throw new Error("RABBITMQ_URL is required");
  }

  const nextConnection = await amqp.connect(rabbitUrl);
  const nextChannel = await nextConnection.createChannel();

  nextConnection.on("error", (error) => {
    log("ERROR", "RabbitMQ connection error", { error: error.message });
    scheduleReconnect();
  });
  nextConnection.on("close", () => {
    log("WARN", "RabbitMQ connection closed; scheduling reconnect");
    scheduleReconnect();
  });
  nextChannel.on("error", (error) => {
    log("ERROR", "RabbitMQ channel error", { error: error.message });
    scheduleReconnect();
  });
  nextChannel.on("close", () => {
    log("WARN", "RabbitMQ channel closed; scheduling reconnect");
    scheduleReconnect();
  });

  await nextChannel.assertExchange(EXCHANGE, "topic", { durable: true });
  await nextChannel.assertExchange(DLX, "direct", { durable: true });
  await nextChannel.assertQueue(DLQ, { durable: true });
  await nextChannel.bindQueue(DLQ, DLX, "#");

  connection = nextConnection;
  channel = nextChannel;
  retries = 0;

  log("INFO", "RabbitMQ channel initialized", {
    exchange: EXCHANGE,
    dlx: DLX,
    dlq: DLQ,
  });
  log("WARN", "RabbitMQ DLQ is configured; monitor salon.dlq in the management UI");
}

async function connect() {
  if (channel) return channel;
  if (connectingPromise) return connectingPromise;

  connectingPromise = (async () => {
    while (!channel) {
      const attempt = retries + 1;
      log("INFO", "RabbitMQ connection attempt", {
        attempt,
        max_retries: MAX_RETRIES,
      });

      try {
        await initializeConnection();
        return channel;
      } catch (error) {
        retries = attempt;
        log("ERROR", "RabbitMQ connection attempt failed", {
          attempt,
          max_retries: MAX_RETRIES,
          error: error.message,
        });

        if (retries >= MAX_RETRIES) {
          log("ERROR", "RabbitMQ max retries exceeded; exiting process", {
            max_retries: MAX_RETRIES,
          });
          process.exit(1);
        }

        await delay(RETRY_DELAY_MS);
      }
    }

    return channel;
  })();

  try {
    return await connectingPromise;
  } finally {
    connectingPromise = null;
  }
}

async function getChannel() {
  if (!channel) await connect();
  return channel;
}

module.exports = { getChannel };

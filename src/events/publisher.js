const { getChannel } = require("./broker");

const EXCHANGE = "salon.events";

async function publish(routingKey, payload) {
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

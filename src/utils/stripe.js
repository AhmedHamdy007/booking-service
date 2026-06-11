const Stripe = require("stripe");
const config = require("../config");

const stripe = config.stripeSecretKey
  ? new Stripe(config.stripeSecretKey, {
      apiVersion: "2024-06-20",
    })
  : null;

module.exports = stripe;

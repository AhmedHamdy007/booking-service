const { publish } = require("../events/publisher");
const { PAYMENT_AUTHORIZATION_EXPIRING } = require("../events/eventTypes");
const {
  listAuthorizationsExpiringSoon,
  markAuthorizationExpiryWarningSent,
} = require("../repositories/bookingRepository");

const CHECK_INTERVAL_MS = 60 * 60 * 1000;

async function runAuthorizationExpiryWarningCheck(logger) {
  const bookings = await listAuthorizationsExpiringSoon();
  for (const booking of bookings) {
    await publish(PAYMENT_AUTHORIZATION_EXPIRING, {
      bookingId: booking.id,
      userId: booking.customerUserId,
      customerId: booking.customerUserId,
      stylistId: booking.stylistUserId,
      shopId: booking.shopId,
      authorizedAt: booking.authorizedAt,
    });
    await markAuthorizationExpiryWarningSent(booking.id);
  }

  if (bookings.length > 0) {
    logger?.info("Published authorization expiry warnings", {
      count: bookings.length,
    });
  }
}

function startAuthorizationExpiryWarningJob(logger) {
  const run = () =>
    runAuthorizationExpiryWarningCheck(logger).catch((error) => {
      logger?.error("Authorization expiry warning check failed", {
        error: error.message,
      });
    });

  const timer = setInterval(run, CHECK_INTERVAL_MS);
  timer.unref?.();
  run();
  return timer;
}

module.exports = {
  runAuthorizationExpiryWarningCheck,
  startAuthorizationExpiryWarningJob,
};

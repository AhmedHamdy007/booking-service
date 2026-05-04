const config = require("../config");

async function fetchJson(url, { headers = {} } = {}) {
  const response = await fetch(url, {
    method: "GET",
    headers,
  });

  const body = await response.json().catch(() => ({}));
  return {
    status: response.status,
    body,
  };
}

async function getShopSummary({ shopId, requestId }) {
  return fetchJson(`${config.shopServiceUrl}/shops/${shopId}`, {
    headers: {
      "x-request-id": requestId || "",
    },
  });
}

async function getShopBookingContext({ shopId, stylistUserId, serviceId, requestId }) {
  const params = new URLSearchParams({
    shopId,
    stylistUserId,
    serviceId,
  });
  return fetchJson(`${config.shopServiceUrl}/internal/booking-context/shop?${params.toString()}`, {
    headers: {
      "x-request-id": requestId || "",
    },
  });
}

module.exports = {
  getShopSummary,
  getShopBookingContext,
};
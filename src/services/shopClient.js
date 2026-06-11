const config = require("../config");

const INTER_SERVICE_TIMEOUT_MS = 5000;
const MAX_RETRIES = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetry(response) {
  return response.status >= 500 || response.status === 429;
}

async function fetchWithTimeoutAndRetry(url, options = {}) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), INTER_SERVICE_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!shouldRetry(response) || attempt === MAX_RETRIES) {
        return response;
      }
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;
      if (attempt === MAX_RETRIES) throw error;
    }

    await sleep(attempt * 300);
  }

  throw lastError || new Error("Inter-service request failed");
}

async function fetchJson(url, { headers = {} } = {}) {
  const response = await fetchWithTimeoutAndRetry(url, {
    method: "GET",
    headers,
  });

  const body = await response.json().catch(() => ({}));
  return {
    status: response.status,
    body,
  };
}

async function sendJson(url, { method = "POST", headers = {}, body = {} } = {}) {
  const response = await fetchWithTimeoutAndRetry(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });

  const payload = await response.json().catch(() => ({}));
  return {
    status: response.status,
    body: payload,
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

async function getStylistPayoutProfile({ stylistUserId, requestId }) {
  return fetchJson(
    `${config.shopServiceUrl}/internal/stylists/${encodeURIComponent(
      stylistUserId
    )}/payout-profile`,
    {
      headers: {
        "x-request-id": requestId || "",
      },
    }
  );
}

async function getCurrentConnectAccount({ authorization, requestId }) {
  return fetchJson(`${config.shopServiceUrl}/internal/connect/account`, {
    headers: {
      authorization: authorization || "",
      "x-request-id": requestId || "",
    },
  });
}

async function saveCurrentConnectAccount({ authorization, requestId, account }) {
  return sendJson(`${config.shopServiceUrl}/internal/connect/account`, {
    method: "PUT",
    headers: {
      authorization: authorization || "",
      "x-request-id": requestId || "",
    },
    body: account,
  });
}

async function getStylistConnectAccount({ stylistUserId, requestId }) {
  return fetchJson(
    `${config.shopServiceUrl}/internal/connect/stylists/${encodeURIComponent(stylistUserId)}`,
    {
      headers: {
        "x-request-id": requestId || "",
      },
    }
  );
}

async function updateConnectAccountStatus({
  stripeAccountId,
  payoutsEnabled,
  chargesEnabled,
  stripeOnboardingDone,
  requestId,
}) {
  return sendJson(
    `${config.shopServiceUrl}/internal/connect/accounts/${encodeURIComponent(
      stripeAccountId
    )}/status`,
    {
      method: "PATCH",
      headers: {
        "x-request-id": requestId || "",
      },
      body: {
        payoutsEnabled,
        chargesEnabled,
        stripeOnboardingDone,
      },
    }
  );
}

async function deauthorizeConnectAccount({ stripeAccountId, requestId }) {
  return sendJson(
    `${config.shopServiceUrl}/internal/connect/accounts/${encodeURIComponent(
      stripeAccountId
    )}/deauthorize`,
    {
      method: "POST",
      headers: {
        "x-request-id": requestId || "",
      },
      body: {},
    }
  );
}

module.exports = {
  deauthorizeConnectAccount,
  getCurrentConnectAccount,
  getShopSummary,
  getShopBookingContext,
  getStylistPayoutProfile,
  getStylistConnectAccount,
  saveCurrentConnectAccount,
  updateConnectAccountStatus,
};

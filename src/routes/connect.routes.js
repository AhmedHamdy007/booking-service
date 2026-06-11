const express = require("express");

const config = require("../config");
const { requireAuth, requireRole } = require("../middleware/auth");
const stripe = require("../utils/stripe");
const {
  getCurrentConnectAccount,
  saveCurrentConnectAccount,
} = require("../services/shopClient");

const router = express.Router();

function errorResponse(res, status, message, requestId) {
  return res.status(status).json({
    success: false,
    error: message,
    message,
    request_id: requestId,
  });
}

function requireStripeClient(res, requestId) {
  if (!stripe) {
    errorResponse(res, 503, "Stripe is not configured", requestId);
    return null;
  }
  return stripe;
}

async function loadConnectAccount(req) {
  const upstream = await getCurrentConnectAccount({
    authorization: req.headers.authorization || "",
    requestId: req.id,
  });
  if (upstream.status !== 200) {
    const message = upstream.body?.error || "Unable to load Stripe Connect account";
    const error = new Error(message);
    error.status = upstream.status;
    throw error;
  }
  return upstream.body?.data || {};
}

async function saveConnectAccount(req, account) {
  const upstream = await saveCurrentConnectAccount({
    authorization: req.headers.authorization || "",
    requestId: req.id,
    account,
  });
  if (upstream.status !== 200) {
    const message = upstream.body?.error || "Unable to save Stripe Connect account";
    const error = new Error(message);
    error.status = upstream.status;
    throw error;
  }
  return upstream.body?.data || {};
}

function accountStatus(account) {
  const payoutsEnabled = Boolean(account.payouts_enabled);
  const chargesEnabled = Boolean(account.charges_enabled);
  return {
    status: payoutsEnabled && chargesEnabled ? "active" : "pending",
    payoutsEnabled,
    chargesEnabled,
    stripeOnboardingDone: payoutsEnabled && chargesEnabled,
    requirements: account.requirements?.currently_due || [],
  };
}

function amountForCurrency(items = [], currency = "myr") {
  const entry = items.find((item) => String(item.currency || "").toLowerCase() === currency);
  return Number.parseInt(String(entry?.amount || 0), 10);
}

function sourceTypeForAmount(items = [], currency = "myr", amount = 0) {
  const entry = items.find((item) => String(item.currency || "").toLowerCase() === currency);
  const sourceTypes = entry?.source_types || {};
  const usable = Object.entries(sourceTypes).find(([, value]) => Number(value) >= amount);
  return usable?.[0] || null;
}

function unixToIso(value) {
  return value ? new Date(Number(value) * 1000).toISOString() : null;
}

async function loadActiveConnectAccount(req, res, client) {
  const existing = await loadConnectAccount(req);
  if (!existing.stripeAccountId || !existing.stripeOnboardingDone) {
    errorResponse(res, 400, "Stripe Connect account is not fully onboarded", req.id);
    return null;
  }

  const account = await client.accounts.retrieve(existing.stripeAccountId);
  const status = accountStatus(account);
  if (!status.payoutsEnabled || !status.chargesEnabled) {
    await saveConnectAccount(req, {
      stripeAccountId: existing.stripeAccountId,
      stripeOnboardingDone: status.stripeOnboardingDone,
      payoutsEnabled: status.payoutsEnabled,
      chargesEnabled: status.chargesEnabled,
    });
    errorResponse(res, 400, "Stripe Connect account is not ready for payouts", req.id);
    return null;
  }

  return { stripeAccountId: existing.stripeAccountId, account };
}

async function buildBalancePayload(client, stripeAccountId) {
  const currency = "myr";
  const [balance, payouts] = await Promise.all([
    client.balance.retrieve({}, { stripeAccount: stripeAccountId }),
    client.payouts.list({ limit: 10 }, { stripeAccount: stripeAccountId }),
  ]);
  const inTransit = payouts.data
    .filter((payout) => ["pending", "in_transit"].includes(String(payout.status)))
    .filter((payout) => String(payout.currency || "").toLowerCase() === currency)
    .reduce((sum, payout) => sum + Number(payout.amount || 0), 0);

  return {
    currency,
    available: amountForCurrency(balance.available, currency),
    pending: amountForCurrency(balance.pending, currency),
    instantAvailable: amountForCurrency(balance.instant_available, currency),
    inTransit,
    recentPayouts: payouts.data.slice(0, 5).map((payout) => ({
      id: payout.id,
      amount: payout.amount,
      currency: payout.currency,
      status: payout.status,
      arrivalDate: unixToIso(payout.arrival_date),
      createdAt: unixToIso(payout.created),
    })),
  };
}

router.post(
  "/connect/onboard",
  requireAuth,
  requireRole("stylist", "owner"),
  async (req, res, next) => {
    try {
      console.log("[connect/onboard] handler reached", {
        requestId: req.id,
        userId: req.user?.id,
        role: req.user?.role,
        contentLength: req.headers["content-length"] || "0",
      });

      const client = requireStripeClient(res, req.id);
      if (!client) return;

      if (!req.user?.id || !req.user?.role || !req.user?.email) {
        return errorResponse(
          res,
          400,
          "Authenticated stylist data is missing. Please sign in again before starting Stripe onboarding.",
          req.id
        );
      }

      const stylist = req.user;
      const existing = await loadConnectAccount(req);
      if (existing.stripeAccountId && existing.stripeOnboardingDone) {
        return errorResponse(
          res,
          400,
          "Already onboarded, use /connect/dashboard-link instead",
          req.id
        );
      }

      let stripeAccountId = existing.stripeAccountId;
      if (!stripeAccountId) {
        const idempotencyKey = `connect-account-${stylist.id}-${Date.now()}`;
        const account = await client.accounts.create(
          {
            country: "MY",
            email: stylist.email || undefined,
            controller: {
              losses: {
                payments: "stripe",
              },
              fees: {
                payer: "account",
              },
              stripe_dashboard: {
                type: "full",
              },
              requirement_collection: "stripe",
            },
            capabilities: {
              card_payments: { requested: true },
              transfers: { requested: true },
            },
            business_type: "individual",
            metadata: {
              stylistId: String(stylist.id),
              platform: "atelier",
            },
          },
          { idempotencyKey }
        );
        stripeAccountId = account.id;
        await saveConnectAccount(req, {
          stripeAccountId,
          stripeOnboardingDone: false,
          payoutsEnabled: false,
          chargesEnabled: false,
        });
      }

      const accountLink = await client.accountLinks.create(
        {
          account: stripeAccountId,
          refresh_url: `${config.clientUrl}/dashboard/connect/retry`,
          return_url: `${config.clientUrl}/dashboard/connect/complete`,
          type: "account_onboarding",
        },
        { idempotencyKey: `connect-onboarding-${req.user.role}-${req.user.id}-${req.id}` }
      );

      return res.json({ url: accountLink.url });
    } catch (error) {
      return next(error);
    }
  }
);

router.get(
  "/connect/balance",
  requireAuth,
  requireRole("stylist", "owner"),
  async (req, res, next) => {
    try {
      const client = requireStripeClient(res, req.id);
      if (!client) return;

      const active = await loadActiveConnectAccount(req, res, client);
      if (!active) return;

      const balance = await buildBalancePayload(client, active.stripeAccountId);
      return res.json({
        ...balance,
        canPayout: balance.available > 0,
      });
    } catch (error) {
      return next(error);
    }
  }
);

router.post(
  "/connect/payout",
  requireAuth,
  requireRole("stylist", "owner"),
  async (req, res, next) => {
    try {
      const client = requireStripeClient(res, req.id);
      if (!client) return;

      const active = await loadActiveConnectAccount(req, res, client);
      if (!active) return;

      const currency = "myr";
      const balance = await client.balance.retrieve({}, { stripeAccount: active.stripeAccountId });
      const available = amountForCurrency(balance.available, currency);
      if (!Number.isInteger(available) || available <= 0) {
        return errorResponse(res, 400, "No available Stripe balance to cash out yet", req.id);
      }

      const sourceType = sourceTypeForAmount(balance.available, currency, available);
      const payout = await client.payouts.create(
        {
          amount: available,
          currency,
          description: "StyleSense stylist cash out",
          metadata: {
            userId: String(req.user.id),
            role: String(req.user.role),
            source: "stylesense_payouts",
          },
          ...(sourceType ? { source_type: sourceType } : {}),
        },
        {
          stripeAccount: active.stripeAccountId,
          idempotencyKey: `cashout-${active.stripeAccountId}-${currency}-${available}-${Math.floor(Date.now() / 60000)}`,
        }
      );

      const nextBalance = await buildBalancePayload(client, active.stripeAccountId);
      return res.json({
        success: true,
        payout: {
          id: payout.id,
          amount: payout.amount,
          currency: payout.currency,
          status: payout.status,
          arrivalDate: unixToIso(payout.arrival_date),
        },
        balance: nextBalance,
        request_id: req.id,
      });
    } catch (error) {
      return next(error);
    }
  }
);

router.get(
  "/connect/status",
  requireAuth,
  requireRole("stylist", "owner"),
  async (req, res, next) => {
    try {
      const client = requireStripeClient(res, req.id);
      if (!client) return;

      const existing = await loadConnectAccount(req);
      if (!existing.stripeAccountId) {
        return res.json({ status: "not_started" });
      }

      const account = await client.accounts.retrieve(existing.stripeAccountId);
      const status = accountStatus(account);
      await saveConnectAccount(req, {
        stripeAccountId: existing.stripeAccountId,
        stripeOnboardingDone: status.stripeOnboardingDone,
        payoutsEnabled: status.payoutsEnabled,
        chargesEnabled: status.chargesEnabled,
      });

      return res.json({
        status: status.status,
        payoutsEnabled: status.payoutsEnabled,
        chargesEnabled: status.chargesEnabled,
        requirements: status.requirements,
      });
    } catch (error) {
      return next(error);
    }
  }
);

router.post(
  "/connect/dashboard-link",
  requireAuth,
  requireRole("stylist", "owner"),
  async (req, res, next) => {
    try {
      const client = requireStripeClient(res, req.id);
      if (!client) return;

      const existing = await loadConnectAccount(req);
      if (!existing.stripeAccountId || !existing.stripeOnboardingDone) {
        return errorResponse(res, 400, "Stripe Connect account is not fully onboarded", req.id);
      }

      const loginLink = await client.accounts.createLoginLink(existing.stripeAccountId, undefined, {
        idempotencyKey: `connect-dashboard-${req.user.role}-${req.user.id}-${req.id}`,
      });

      return res.json({ url: loginLink.url });
    } catch (error) {
      return next(error);
    }
  }
);

module.exports = router;

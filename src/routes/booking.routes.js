const express = require("express");
const { healthCheck } = require("../db/pool");
const { requireAuth, requireRole } = require("../middleware/auth");
const {
  ValidationError,
  validateDateOnly,
  validateListLimit,
  normalizeCreateBookingPayload,
  normalizeReschedulePayload,
  normalizeCancelPayload,
  normalizeStatusUpdatePayload,
} = require("../utils/validation");
const { canTransition, isBlockingStatus } = require("../utils/bookingTransitions");
const {
  createBooking,
  findBookingById,
  listBookingsByCustomer,
  listBookingsByStylist,
  listBookingsByShop,
  findOverlappingBooking,
  updateBookingById,
  insertBookingStatusHistory,
  listBookingStatusHistory,
  listBlockingBookingsForStylistOnDate,
} = require("../repositories/bookingRepository");
const { getShopBookingContext, getShopSummary } = require("../services/shopClient");
const { publish } = require("../events/publisher");
const {
  BOOKING_CONFIRMED,
  BOOKING_CANCELLED,
  BOOKING_COMPLETED,
} = require("../events/eventTypes");

const router = express.Router();

const DEFAULT_SLOT_INTERVAL_MINUTES = 30;
const DEFAULT_OPEN_HOUR = 9;
const DEFAULT_CLOSE_HOUR = 18;

function sameId(a, b) {
  if (a === undefined || a === null || b === undefined || b === null) return false;
  return String(a) === String(b);
}

function withMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function formatShopAddress(shop) {
  if (!shop) return null;
  return [shop.addressLine1, shop.city, shop.country].filter(Boolean).join(", ") || null;
}

function toIsoString(value) {
  if (!value) return new Date().toISOString();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

async function publishBookingEvent(req, routingKey, payload) {
  if (!process.env.RABBITMQ_URL) {
    req.logger?.warn("RabbitMQ URL missing; skipping event publish", {
      request_id: req.id,
      routing_key: routingKey,
    });
    return;
  }

  try {
    await publish(routingKey, payload);
  } catch (error) {
    req.logger?.error("Failed to publish booking event", {
      request_id: req.id,
      routing_key: routingKey,
      error: error.message,
    });
  }
}

function bookingConfirmedPayload(booking) {
  return {
    bookingId: booking.id,
    userId: booking.customerUserId,
    shopId: booking.shopId,
    stylistId: booking.stylistUserId,
    serviceId: booking.serviceId,
    scheduledAt: toIsoString(booking.scheduledStart),
    createdAt: toIsoString(booking.createdAt),
  };
}

function bookingCancelledPayload(booking, reason) {
  return {
    bookingId: booking.id,
    userId: booking.customerUserId,
    shopId: booking.shopId,
    reason: reason || "Booking cancelled",
    cancelledAt: toIsoString(booking.cancelledAt || new Date()),
  };
}

function bookingCompletedPayload(booking) {
  return {
    bookingId: booking.id,
    userId: booking.customerUserId,
    shopId: booking.shopId,
    stylistId: booking.stylistUserId,
    completedAt: toIsoString(booking.updatedAt || new Date()),
  };
}

function decorateBookingWithContext(booking, contextData) {
  if (!booking || !contextData) return booking;
  const shop = contextData.shop || null;
  const stylist = contextData.stylist || null;
  const serviceOffering = contextData.serviceOffering || null;

  return {
    ...booking,
    shop,
    stylist,
    serviceOffering,
    shopName: shop?.name || null,
    shopAddress: formatShopAddress(shop),
    stylistName: stylist?.displayName || null,
    serviceName: booking.serviceName || serviceOffering?.name || "Appointment",
  };
}

async function enrichBookingForResponse(req, booking) {
  if (!booking || booking.bookingContextType !== "shop") return booking;
  try {
    const context = await getShopBookingContext({
      shopId: booking.shopId,
      stylistUserId: booking.stylistUserId,
      serviceId: booking.serviceId,
      requestId: req.id,
    });
    if (context.status !== 200) return booking;
    return decorateBookingWithContext(booking, context.body?.data);
  } catch {
    return booking;
  }
}

async function enrichBookingsForResponse(req, bookings) {
  return Promise.all(bookings.map((booking) => enrichBookingForResponse(req, booking)));
}

async function ensureOwnerAccess(req, shopId) {
  const upstream = await getShopSummary({ shopId, requestId: req.id });
  if (upstream.status !== 200) return false;
  return sameId(upstream.body?.data?.ownerUserId, req.user.id);
}

async function ensureBookingAccess(req, booking) {
  if (sameId(booking.customerUserId, req.user.id)) return true;
  if (sameId(booking.stylistUserId, req.user.id)) return true;
  if (req.user.role === "owner") {
    return ensureOwnerAccess(req, booking.shopId);
  }
  return false;
}

router.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "booking-service",
    timestamp: new Date().toISOString(),
  });
});

router.get("/ready", async (req, res) => {
  try {
    await healthCheck();
    return res.json({
      ready: true,
      service: "booking-service",
      timestamp: new Date().toISOString(),
    });
  } catch {
    return res.status(503).json({
      ready: false,
      service: "booking-service",
      error: "Database unavailable",
      timestamp: new Date().toISOString(),
      request_id: req.id,
    });
  }
});

router.get("/availability", async (req, res, next) => {
  try {
    const shopId = req.query.shopId;
    const stylistUserId = req.query.stylistUserId;
    const serviceId = req.query.serviceId;
    const date = validateDateOnly("date", req.query.date);

    if (!shopId || !stylistUserId || !serviceId) {
      throw new ValidationError(
        "shopId, stylistUserId, and serviceId are required",
        "availability"
      );
    }

    const context = await getShopBookingContext({
      shopId: String(shopId),
      stylistUserId: String(stylistUserId),
      serviceId: String(serviceId),
      requestId: req.id,
    });

    if (context.status !== 200) {
      return res.status(context.status).json({
        success: false,
        error: context.body?.error || "Booking context not found",
        request_id: req.id,
      });
    }

    const durationMinutes = context.body.data.serviceOffering.durationMinutes;
    const dayStart = new Date(`${date}T${String(DEFAULT_OPEN_HOUR).padStart(2, "0")}:00:00`);
    const dayEnd = new Date(`${date}T${String(DEFAULT_CLOSE_HOUR).padStart(2, "0")}:00:00`);

    const dayBookings = await listBlockingBookingsForStylistOnDate(String(stylistUserId), date);

    const slots = [];
    for (
      let slotStart = new Date(dayStart);
      withMinutes(slotStart, durationMinutes) <= dayEnd;
      slotStart = withMinutes(slotStart, DEFAULT_SLOT_INTERVAL_MINUTES)
    ) {
      const slotEnd = withMinutes(slotStart, durationMinutes);
      const isBlocked = dayBookings.some((booking) => {
        const bookingStart = new Date(booking.scheduledStart);
        const bookingEnd = new Date(booking.scheduledEnd);
        return slotStart < bookingEnd && slotEnd > bookingStart;
      });

      if (!isBlocked) {
        slots.push({
          startsAt: slotStart.toISOString(),
          endsAt: slotEnd.toISOString(),
        });
      }
    }

    return res.json({
      success: true,
      data: {
        bookingContextType: context.body.data.bookingContextType,
        serviceOffering: context.body.data.serviceOffering,
        slots,
      },
      request_id: req.id,
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/bookings", requireAuth, async (req, res, next) => {
  try {
    if (req.user.role === "owner") {
      return res.status(403).json({
        success: false,
        error: "Owner accounts manage shops and cannot create customer bookings",
        request_id: req.id,
      });
    }

    const payload = normalizeCreateBookingPayload(req.body);
    if (req.user.role === "stylist" && sameId(payload.stylistUserId, req.user.id)) {
      return res.status(403).json({
        success: false,
        error: "Stylists cannot book appointments with their own profile",
        request_id: req.id,
      });
    }

    const context = await getShopBookingContext({
      shopId: payload.shopId,
      stylistUserId: payload.stylistUserId,
      serviceId: payload.serviceId,
      requestId: req.id,
    });

    if (context.status !== 200) {
      return res.status(context.status).json({
        success: false,
        error: context.body?.error || "Booking context not found",
        request_id: req.id,
      });
    }

    const serviceOffering = context.body.data.serviceOffering;
    const scheduledEnd = withMinutes(payload.scheduledStart, serviceOffering.durationMinutes);

    const conflict = await findOverlappingBooking({
      stylistUserId: payload.stylistUserId,
      scheduledStart: payload.scheduledStart,
      scheduledEnd,
    });

    if (conflict) {
      return res.status(409).json({
        success: false,
        error: "Selected time overlaps an existing booking",
        request_id: req.id,
      });
    }

    const booking = await createBooking({
      customerUserId: req.user.id,
      createdByUserId: req.user.id,
      shopId: payload.shopId,
      stylistUserId: payload.stylistUserId,
      serviceId: payload.serviceId,
      serviceCatalogKey: serviceOffering.catalogServiceKey,
      serviceName: serviceOffering.name,
      scheduledStart: payload.scheduledStart,
      scheduledEnd,
      effectiveDurationMinutes: serviceOffering.durationMinutes,
      effectivePrice: serviceOffering.price,
      notes: payload.notes,
    });

    await insertBookingStatusHistory({
      bookingId: booking.id,
      fromStatus: null,
      toStatus: "pending",
      changedByUserId: req.user.id,
      reason: "Booking created",
    });

    await publishBookingEvent(req, BOOKING_CONFIRMED, bookingConfirmedPayload(booking));

    return res.status(201).json({
      success: true,
      data: decorateBookingWithContext(booking, context.body?.data),
      request_id: req.id,
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/bookings/me", requireAuth, async (req, res, next) => {
  try {
    const bookings = await listBookingsByCustomer(req.user.id, {
      limit: validateListLimit(req.query.limit),
    });
    const enriched = await enrichBookingsForResponse(req, bookings);
    return res.json({
      success: true,
      count: enriched.length,
      data: enriched,
      request_id: req.id,
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/bookings/stylists/me", requireAuth, requireRole("stylist"), async (req, res, next) => {
  try {
    const bookings = await listBookingsByStylist(req.user.id, {
      limit: validateListLimit(req.query.limit),
    });
    const enriched = await enrichBookingsForResponse(req, bookings);
    return res.json({
      success: true,
      count: enriched.length,
      data: enriched,
      request_id: req.id,
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/bookings/shops/:shopId", requireAuth, requireRole("owner"), async (req, res, next) => {
  try {
    const allowed = await ensureOwnerAccess(req, req.params.shopId);
    if (!allowed) {
      return res.status(403).json({
        success: false,
        error: "You can only view bookings for your own shop",
        request_id: req.id,
      });
    }

    const bookings = await listBookingsByShop(req.params.shopId, {
      limit: validateListLimit(req.query.limit),
    });
    const enriched = await enrichBookingsForResponse(req, bookings);
    return res.json({
      success: true,
      count: enriched.length,
      data: enriched,
      request_id: req.id,
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/bookings/:bookingId", requireAuth, async (req, res) => {
  const booking = await findBookingById(req.params.bookingId);
  if (!booking) {
    return res.status(404).json({
      success: false,
      error: "Booking not found",
      request_id: req.id,
    });
  }

  const allowed = await ensureBookingAccess(req, booking);
  if (!allowed) {
    return res.status(403).json({
      success: false,
      error: "You do not have access to this booking",
      request_id: req.id,
    });
  }

  const history = await listBookingStatusHistory(booking.id);
  const enriched = await enrichBookingForResponse(req, booking);
  return res.json({
    success: true,
    data: {
      ...enriched,
      statusHistory: history,
    },
    request_id: req.id,
  });
});

router.patch("/bookings/:bookingId/cancel", requireAuth, async (req, res, next) => {
  try {
    const booking = await findBookingById(req.params.bookingId);
    if (!booking) {
      return res.status(404).json({
        success: false,
        error: "Booking not found",
        request_id: req.id,
      });
    }

    const allowed = await ensureBookingAccess(req, booking);
    if (!allowed) {
      return res.status(403).json({
        success: false,
        error: "You do not have access to this booking",
        request_id: req.id,
      });
    }

    if (!["pending", "confirmed", "checked_in"].includes(booking.status)) {
      return res.status(409).json({
        success: false,
        error: "Booking can no longer be cancelled",
        request_id: req.id,
      });
    }

    const payload = normalizeCancelPayload(req.body);
    const updated = await updateBookingById(booking.id, {
      status: "cancelled",
      cancellation_reason: payload.reason,
      cancelled_at: new Date(),
    });
    await insertBookingStatusHistory({
      bookingId: booking.id,
      fromStatus: booking.status,
      toStatus: "cancelled",
      changedByUserId: req.user.id,
      reason: payload.reason,
    });

    await publishBookingEvent(req, BOOKING_CANCELLED, bookingCancelledPayload(updated, payload.reason));

    return res.json({
      success: true,
      data: updated,
      request_id: req.id,
    });
  } catch (error) {
    return next(error);
  }
});

router.patch("/bookings/:bookingId/reschedule", requireAuth, async (req, res, next) => {
  try {
    const booking = await findBookingById(req.params.bookingId);
    if (!booking) {
      return res.status(404).json({
        success: false,
        error: "Booking not found",
        request_id: req.id,
      });
    }

    const allowed = await ensureBookingAccess(req, booking);
    if (!allowed) {
      return res.status(403).json({
        success: false,
        error: "You do not have access to this booking",
        request_id: req.id,
      });
    }

    if (!["pending", "confirmed"].includes(booking.status)) {
      return res.status(409).json({
        success: false,
        error: "Booking can no longer be rescheduled",
        request_id: req.id,
      });
    }

    const payload = normalizeReschedulePayload(req.body);
    const newEnd = withMinutes(payload.scheduledStart, booking.effectiveDurationMinutes);
    const conflict = await findOverlappingBooking({
      stylistUserId: booking.stylistUserId,
      scheduledStart: payload.scheduledStart,
      scheduledEnd: newEnd,
      excludeBookingId: booking.id,
    });

    if (conflict) {
      return res.status(409).json({
        success: false,
        error: "Selected time overlaps an existing booking",
        request_id: req.id,
      });
    }

    const updated = await updateBookingById(booking.id, {
      scheduled_start: payload.scheduledStart,
      scheduled_end: newEnd,
    });
    await insertBookingStatusHistory({
      bookingId: booking.id,
      fromStatus: booking.status,
      toStatus: booking.status,
      changedByUserId: req.user.id,
      reason: payload.reason || "Booking rescheduled",
    });

    return res.json({
      success: true,
      data: updated,
      request_id: req.id,
    });
  } catch (error) {
    return next(error);
  }
});

router.patch("/bookings/:bookingId/status", requireAuth, requireRole("owner", "stylist"), async (req, res, next) => {
  try {
    const booking = await findBookingById(req.params.bookingId);
    if (!booking) {
      return res.status(404).json({
        success: false,
        error: "Booking not found",
        request_id: req.id,
      });
    }

    const allowed = await ensureBookingAccess(req, booking);
    if (!allowed || sameId(booking.customerUserId, req.user.id)) {
      return res.status(403).json({
        success: false,
        error: "You cannot update this booking status",
        request_id: req.id,
      });
    }

    const payload = normalizeStatusUpdatePayload(req.body);
    if (!canTransition(booking.status, payload.status)) {
      return res.status(409).json({
        success: false,
        error: `Invalid booking status transition from ${booking.status} to ${payload.status}`,
        request_id: req.id,
      });
    }

    const patch = { status: payload.status };
    if (payload.status === "cancelled") {
      patch.cancellation_reason = payload.reason;
      patch.cancelled_at = new Date();
    }

    const updated = await updateBookingById(booking.id, patch);
    await insertBookingStatusHistory({
      bookingId: booking.id,
      fromStatus: booking.status,
      toStatus: payload.status,
      changedByUserId: req.user.id,
      reason: payload.reason,
    });

    if (payload.status === "cancelled") {
      await publishBookingEvent(
        req,
        BOOKING_CANCELLED,
        bookingCancelledPayload(updated, payload.reason)
      );
    }

    if (payload.status === "completed") {
      await publishBookingEvent(req, BOOKING_COMPLETED, bookingCompletedPayload(updated));
    }

    return res.json({
      success: true,
      data: updated,
      request_id: req.id,
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;

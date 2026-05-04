const ACTIVE_BLOCKING_STATUSES = ["pending", "confirmed", "checked_in", "in_progress"];

const ALLOWED_TRANSITIONS = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["checked_in", "in_progress", "cancelled", "no_show"],
  checked_in: ["in_progress", "cancelled"],
  in_progress: ["completed"],
  completed: [],
  cancelled: [],
  no_show: [],
};

function canTransition(fromStatus, toStatus) {
  return (ALLOWED_TRANSITIONS[fromStatus] || []).includes(toStatus);
}

function isBlockingStatus(status) {
  return ACTIVE_BLOCKING_STATUSES.includes(status);
}

module.exports = {
  ACTIVE_BLOCKING_STATUSES,
  ALLOWED_TRANSITIONS,
  canTransition,
  isBlockingStatus,
};
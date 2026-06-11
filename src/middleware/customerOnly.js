const { ROLES } = require("../shared/constants/roles");

const customerOnly = (req, res, next) => {
  if (!req.user || req.user.role !== ROLES.CUSTOMER) {
    console.warn(
      `[RBAC VIOLATION] userId=${req.user?.id} role=${req.user?.role} ` +
        `attempted customer-only route ${req.method} ${req.originalUrl} ` +
        `at ${new Date().toISOString()}`
    );
    return res.status(403).json({
      success: false,
      error: "Access denied: this feature is available to customers only.",
      request_id: req.id,
    });
  }
  return next();
};

module.exports = { customerOnly };

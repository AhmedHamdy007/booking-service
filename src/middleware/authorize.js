function logRbacViolation(req, allowedRoles) {
  console.warn(
    `[RBAC VIOLATION] userId=${req.user?.id} role=${req.user?.role} ` +
      `attempted ${req.method} ${req.originalUrl} allowed=${allowedRoles.join(",")} ` +
      `at ${new Date().toISOString()}`
  );
}

const authorize = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      logRbacViolation(req, allowedRoles);
      return res.status(403).json({
        success: false,
        error: "Access denied: insufficient role.",
        request_id: req.id,
      });
    }
    return next();
  };
};

module.exports = { authorize };

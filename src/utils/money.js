function amountInMinorUnit(price) {
  const normalized = String(price).trim();
  const match = normalized.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) {
    throw new Error("Service price must be a non-negative amount with up to 2 decimals");
  }

  const ringgit = Number.parseInt(match[1], 10);
  const sen = Number.parseInt((match[2] || "").padEnd(2, "0"), 10) || 0;
  return ringgit * 100 + sen;
}

module.exports = { amountInMinorUnit };

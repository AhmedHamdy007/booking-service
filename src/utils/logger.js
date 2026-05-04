class Logger {
  constructor(service, level = "INFO") {
    this.service = service;
    this.level = level;
  }

  info(message, meta = {}) {
    this.#log("INFO", message, meta);
  }

  warn(message, meta = {}) {
    this.#log("WARN", message, meta);
  }

  error(message, meta = {}) {
    this.#log("ERROR", message, meta);
  }

  #log(level, message, meta) {
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        service: this.service,
        level,
        message,
        ...meta,
      })
    );
  }
}

module.exports = { Logger };

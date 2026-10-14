/** Next sets PORT to the listening port before loading the server modules. */
export function sessionCookieName(): string {
  const override = process.env.DEZFIL_SESSION_COOKIE;
  if (override !== undefined) {
    if (!override || /[^!#$%&'*+\-.^_`|~0-9A-Za-z]/.test(override)) {
      throw new Error("DEZFIL_SESSION_COOKIE must be a non-empty cookie-name token (ASCII letters, digits or !#$%&'*+-.^_`|~).");
    }
    return override;
  }
  const port = process.env.PORT || "3000";
  return port === "3000" ? "dezfil_session" : `dezfil_session_${port}`;
}

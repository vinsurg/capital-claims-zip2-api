module.exports = async (req, res) => {
  try {
    const raw = process.env.DATABASE_URL || "";
    let parsed = {};
    try {
      const u = new URL(raw);
      parsed = {
        protocol: u.protocol,
        host: u.host,
        hostname: u.hostname,
        port: u.port,
        pathname: u.pathname,
        has_password: u.password ? true : false
      };
    } catch (e) {
      parsed = { parse_error: String(e && e.message || e) };
    }
    // Mask password in the echo
    const masked = raw.replace(/:(.+)@/, ":*****@");
    res.status(200).json({
      ok: true,
      DATABASE_URL_seen: masked,
      parsed
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
};

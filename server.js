require("dotenv").config();
const path = require("path");
const fs = require("fs/promises");
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const nodemailer = require("nodemailer");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, "data");

app.set("trust proxy", 1);
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["https://fonts.gstatic.com"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        upgradeInsecureRequests: null,
      },
    },
  })
);
app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "public")));

// Email is optional: without SMTP settings, messages are only saved to data/messages.jsonl
const mailer =
  process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS
    ? nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT) || 465,
        secure: (Number(process.env.SMTP_PORT) || 465) === 465,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      })
    : null;

const contactLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5, // 5 messages per IP every 15 minutes
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Too many messages. Please try again later." },
});

const clean = (v, max) => String(v ?? "").replace(/\r?\n/g, " ").trim().slice(0, max);

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.post("/api/contact", contactLimiter, async (req, res) => {
  const body = req.body || {};

  // Honeypot: real visitors never fill this hidden field
  if (body.website) return res.json({ ok: true });

  const name = clean(body.name, 80);
  const email = clean(body.email, 120);
  const subject = clean(body.subject, 120) || "Website project enquiry";
  const message = String(body.message ?? "").trim().slice(0, 3000);

  if (!name || !email || !message) {
    return res.status(400).json({ ok: false, error: "Please fill in your name, email and message." });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: "Please enter a valid email address." });
  }

  const entry = { time: new Date().toISOString(), name, email, subject, message };

  try {
    // Always keep a local copy so nothing is lost if email fails
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.appendFile(path.join(DATA_DIR, "messages.jsonl"), JSON.stringify(entry) + "\n");

    const text = `Name: ${name}\nEmail: ${email}\n\n${message}`;
    if (process.env.RESEND_API_KEY) {
      // HTTPS email API (works on hosts that block SMTP ports, like Render free)
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: process.env.MAIL_FROM || "CodeNest Website <onboarding@resend.dev>",
          to: [process.env.MAIL_TO],
          reply_to: email,
          subject: `[Portfolio] ${subject}`,
          text,
        }),
      });
      if (!r.ok) throw new Error(`Resend ${r.status}: ${await r.text()}`);
    } else if (mailer) {
      await mailer.sendMail({
        from: `"Portfolio Website" <${process.env.SMTP_USER}>`,
        to: process.env.MAIL_TO || process.env.SMTP_USER,
        replyTo: `"${name.replace(/"/g, "")}" <${email}>`,
        subject: `[Portfolio] ${subject}`,
        text,
      });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("Contact error:", err.message);
    res.status(500).json({ ok: false, error: "Could not send your message. Please try again later." });
  }
});

app.use((_req, res) => res.status(404).sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => console.log(`Portfolio running at http://localhost:${PORT}`));

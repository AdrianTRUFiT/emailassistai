// ================================================
// EmailAssistAI — Jamaica We Rise (Final Build)
// ================================================

// --- GLOBAL TLS OVERRIDE (needed for Gmail SMTP on Windows) ---
process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = 0;

import "dotenv/config";
import express from "express";
import cors from "cors";
import nodemailer from "nodemailer";
import imaps from "imap-simple";
import { simpleParser } from "mailparser";
import fs from "fs-extra";
import OpenAI from "openai";

// -----------------------------
// 0. BASIC SETUP
// -----------------------------
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;

const {
  OPENAI_API_KEY,
  CAMPAIGN_NAME,
  CAMPAIGN_DOMAIN,
  DASHBOARD_URL,
  ESCALATION_EMAIL,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_SECURE,
  IMAP_HOST,
  IMAP_PORT,
  SMTP_USER,
  SMTP_PASS,
  IMAP_USER,
  IMAP_PASS,
  ALIAS_DONATE,
  ALIAS_SUPPORT,
  ALIAS_INFO,
  REGISTRY_PATH,
  IMAP_POLL_INTERVAL_MS,
  ENABLE_IMAP: ENABLE_IMAP_ENV
} = process.env;

// ---------------------------------------------
// FIX: Correctly declare ENABLE_IMAP flag
// ---------------------------------------------
const ENABLE_IMAP =
  (ENABLE_IMAP_ENV || "false").toString().toLowerCase() === "true";
// ---------------------------------------------

const campaignName = CAMPAIGN_NAME || "Jamaica We Rise";
const dashboardUrl =
  DASHBOARD_URL || "https://jamaica-we-rise.vercel.app/iascendai-auth.html";

const openai =
  OPENAI_API_KEY &&
  new OpenAI({
    apiKey: OPENAI_API_KEY,
  });

// -----------------------------
// 1. REGISTRY (DONOR "CRM")
// -----------------------------
const registryPath = REGISTRY_PATH || "./registry/donors_verified.json";

async function loadRegistry() {
  try {
    await fs.ensureFile(registryPath);
    const text = await fs.readFile(registryPath, "utf8");
    if (!text.trim()) {
      await fs.writeFile(registryPath, "[]", "utf8");
      return [];
    }
    return JSON.parse(text);
  } catch (err) {
    console.error("Error loading registry, resetting to []:", err);
    await fs.writeFile(registryPath, "[]", "utf8");
    return [];
  }
}

async function saveRegistry(reg) {
  try {
    await fs.writeFile(registryPath, JSON.stringify(reg, null, 2), "utf8");
  } catch (err) {
    console.error("Error saving registry:", err);
  }
}

async function upsertDonor({
  email,
  name,
  amount,
  currency,
  soulmark,
  sessionId,
}) {
  const registry = await loadRegistry();
  const now = new Date().toISOString();

  let donor = registry.find((d) => d.email.toLowerCase() === email.toLowerCase());
  if (!donor) {
    donor = {
      email,
      name: name || "",
      donations: [],
      createdAt: now,
      lastContact: now,
    };
    registry.push(donor);
  }

  donor.name = name || donor.name;
  donor.lastContact = now;
  donor.donations.push({
    campaign: campaignName,
    amount,
    currency,
    soulmark,
    sessionId,
    timestamp: now,
  });

  await saveRegistry(registry);
}

// -----------------------------
// 2. SMTP SETUP (SEND EMAIL)
// -----------------------------
const transporter = nodemailer.createTransport({
  host: SMTP_HOST || "smtp.gmail.com",
  port: Number(SMTP_PORT) || 587,
  secure: (SMTP_SECURE || "false").toString() === "true",
  auth: {
    user: SMTP_USER,
    pass: SMTP_PASS,
  },
});

// SMTP verify temporarily disabled for Render upgrade
// transporter.verify((err, success) => {
//   if (err) {
//     console.error("❌ SMTP transport verification failed:", err.message);
//   } else {
//     console.log("✅ SMTP transport ready.");
//   }
// });

// -----------------------------
// 3. DONATION EMAIL (UPDATED)
// -----------------------------
function getPartialSoulmark(fullSoulmark) {
  if (!fullSoulmark || fullSoulmark.length < 10) return fullSoulmark || "N/A";
  return (
    fullSoulmark.slice(0, 6) + "…" + fullSoulmark.slice(fullSoulmark.length - 4)
  );
}

async function sendDonationEmail({ name, email, soulmark, amount, currency }) {
  const fromLabel = `${campaignName} <${ALIAS_SUPPORT || SMTP_USER}>`;
  const partial = getPartialSoulmark(soulmark);

  // 🔐 Universal access gateway (login or create username)
  const accessUrl = "https://fundtrackerai.vercel.app/iascendai-signup.html";

  const html = `
    <p>Thank you for your donation. Your contribution has been verified successfully.</p>

    <p>A unique SoulMark has been created for this transaction.<br>
    For your protection, only a partial version is shown below:</p>

    <p><strong>SoulMark (partial):</strong> ${partial}</p>

    ${
      amount
        ? `<p><strong>Amount:</strong> ${amount} ${currency || "USD"}</p>`
        : ""
    }

    <p>To view your verified donation history and access your SoulMark dashboard, use the secure portal below:</p>

    <p><a href="https://fundtrackerai.vercel.app/iascendai-signup.html?email=${email}">
    <strong>Access Your Dashboard</strong>
    </a></p>


    <p>If you already created your iAscendAi username, simply sign in.<br>
    If not, the portal will guide you to create one so you can access your dashboard.</p>

    <p>${campaignName} × iAscendAi</p>
  `;

  const mail = {
    from: fromLabel,
    to: email,
    subject: "Your Donation Has Been Verified",
    html,
  };

  return transporter.sendMail(mail);
}



// Donation endpoint
app.post("/api/donation-email", async (req, res) => {
  try {
    const { name, email, soulmark, amount, currency, sessionId } = req.body;

    if (!email || !soulmark) {
      return res
        .status(400)
        .json({ error: "email and soulmark are required fields." });
    }

    await sendDonationEmail({ name, email, soulmark, amount, currency });
    await upsertDonor({ email, name, amount, currency, soulmark, sessionId });

    console.log("✅ Donation email sent to", email);
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ Error in /api/donation-email:", err);
    res.status(500).json({ error: "Failed to send donation email." });
  }
});

// -----------------------------
// 4. IMAP SUPPORT POLLING (DISABLED)
// -----------------------------
async function pollSupportInboxOnce() {
  console.warn("IMAP disabled — skipping inbox polling.");
}

// THIS FIXES YOUR ISSUE
function startSupportPolling() {
  if (!ENABLE_IMAP) {
    console.log("ℹ️ IMAP disabled (ENABLE_IMAP=false). Skipping polling.");
    return;
  }

  // If you ever turn IMAP back on in the future:
  const intervalMs = Number(IMAP_POLL_INTERVAL_MS) || 60000;
  console.log(
    `⏱️ EmailAssistAI: support inbox polling every ${intervalMs / 1000}s`,
  );
  pollSupportInboxOnce();
  setInterval(pollSupportInboxOnce, intervalMs);
}

// -----------------------------
// 5. SIMPLE ROUTES
// -----------------------------
app.get("/health", (req, res) => {
  res.json({ ok: true, campaign: campaignName });
});

// -----------------------------
// 6. START SERVER
// -----------------------------
app.listen(PORT, () => {
  console.log(`✅ EmailAssistAI server running on port ${PORT}`);
  startSupportPolling();
});

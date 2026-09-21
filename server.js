/* ============================================================
   TrackBot server.

   Why it exists: the Gemini API key can't live in the browser.
   The browser sends only the customer's text; this server holds
   the key, keeps the conversation state, asks Gemini which move
   to make, and runs that move through the shared engine.

   The browser can't tamper with the flow either: state lives
   here, so a client can't claim to be at "claim_type" and skip
   the steps before it.
   ============================================================ */
require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const path = require("path");
const engine = require("./public/engine.js");
const gemini = require("./gemini.js");

const app = express();
app.use(express.json({ limit: "4kb" }));

// Behind Tailscale Funnel, Render, etc., the real visitor IP arrives in a header.
// Only trust that header when you're actually behind one — otherwise it can be faked.
if (process.env.TRUST_PROXY) app.set("trust proxy", 1);

/* ---- CORS: which websites may call this API from a browser ----
   Needed when the chat page is hosted somewhere else (e.g. GitHub
   Pages) and this server runs on its own. Note: CORS only stops
   other websites. It does NOT stop scripts — rate limits do that. */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map(s => s.trim().replace(/\/$/, "")).filter(Boolean);

app.use("/api", (req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.set({
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin"
    });
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* ---- Rate limits: keep strangers from burning through your API quota ---- */
function rateLimit(maxPerMinute) {
  const hits = new Map();
  setInterval(() => hits.clear(), 60 * 1000).unref();
  return (req, res, next) => {
    const n = (hits.get(req.ip) || 0) + 1;
    hits.set(req.ip, n);
    if (n > maxPerMinute) return res.status(429).json({ error: "Too many messages — give it a minute and try again." });
    next();
  };
}
const CHAT_LIMIT = Number(process.env.RATE_LIMIT_PER_MIN) || 30;

// Serve ONLY the public folder. Serving the project root would expose .env.
app.use(express.static(path.join(__dirname, "public")));

const MAX_TEXT = 500;                 // characters per customer message
const SESSION_TTL = 30 * 60 * 1000;   // drop idle conversations after 30 min
const sessions = new Map();           // id -> { s, transcript: [], touched }

const agentOn = () => Boolean(process.env.GEMINI_API_KEY);

setInterval(() => {
  const now = Date.now();
  for (const [id, rec] of sessions) if (now - rec.touched > SESSION_TTL) sessions.delete(id);
}, 60 * 1000).unref();

function remember(rec, speaker, text) {
  rec.transcript.push(`${speaker}: ${text}`);
  if (rec.transcript.length > 20) rec.transcript.shift();   // keep the prompt small
}

/* ---- Which decision maker is active ---- */
app.get("/api/status", (req, res) => {
  res.json({ agent: agentOn() ? "gemini" : "rules", model: agentOn() ? gemini.MODEL : null });
});

/* ---- Start a conversation ---- */
app.post("/api/session", rateLimit(10), (req, res) => {
  const id = crypto.randomUUID();
  const rec = { s: engine.createSession(), transcript: [], touched: Date.now() };
  sessions.set(id, rec);
  const r = engine.greeting();
  r.messages.forEach(m => remember(rec, "Assistant", m.text));
  res.json({ sessionId: id, ...r });
});

/* ---- One customer turn ---- */
app.post("/api/chat", rateLimit(CHAT_LIMIT), async (req, res) => {
  const rec = sessions.get(req.body?.sessionId);
  if (!rec) return res.status(404).json({ error: "Session expired. Refresh to start over." });

  const text = String(req.body.text || "").trim().slice(0, MAX_TEXT);
  if (!text) return res.status(400).json({ error: "Empty message." });
  rec.touched = Date.now();

  const allowed = engine.allowedActions(rec.s);
  let decision = null;

  // 1. Ask the agent, if one is configured.
  if (agentOn()) {
    try {
      decision = await gemini.chooseAction({
        allowed, ACTIONS: engine.ACTIONS, state: rec.s.state,
        transcript: rec.transcript.join("\n"), text
      });
      decision.by = "gemini";
    } catch (e) {
      console.warn("[gemini] falling back to rules:", e.message);
    }
  }

  // 2. No agent, or it failed: use the rule-based matcher.
  if (!decision) {
    decision = engine.ruleIntent(rec.s, text) || { action: "unclear" };
    decision.by = agentOn() ? "rules (fallback)" : "rules";
  }

  // 3. Guardrail: never execute a move that isn't legal from this step.
  if (!allowed.includes(decision.action)) {
    console.warn(`[guard] rejected "${decision.action}" from state ${rec.s.state}`);
    decision = { action: "unclear", by: decision.by, rejected: decision.action };
  }

  const reply = engine.apply(rec.s, decision.action, decision.args);
  remember(rec, "Customer", text);
  reply.messages.forEach(m => remember(rec, "Assistant", m.text));

  res.json({ ...reply, decision: { action: decision.action, by: decision.by, rejected: decision.rejected } });
});

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`TrackBot running at http://localhost:${port}`);
    console.log(agentOn() ? `Agent: Gemini (${gemini.MODEL})` : "Agent: none — rule-based mode (set GEMINI_API_KEY in .env)");
  });
}

module.exports = app;

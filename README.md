# TrackBot — lost package assistant

A chatbot for **scenario 1: helping a customer track a lost package**, built for the eGain
Analyst I, Solution Success take-home.

The conversation follows a fixed, designed flow. A **Gemini agent** decides which step of
that flow the customer is asking for on each turn — so people can talk the way they
actually talk — but it can only ever choose moves that are drawn on the flowchart.

**Live demo:** https://YOUR-APP.onrender.com — hosted free, so the first visit can take up to
a minute while the server wakes up.

---

## Run it

**Quick look, no setup.** Open `public/index.html` in any browser. The full flow runs
locally, with simple keyword matching deciding each step.

**With the Gemini agent** (needs Node 18+):

```bash
npm install
cp .env.example .env        # then paste your key into .env
npm start                   # → http://localhost:3000
```

Get a free key at [Google AI Studio](https://aistudio.google.com) → *Get API key*. The badge
in the chat header shows which mode you're in. With no key, the server still runs in
rule-based mode.

```bash
npm test                    # 23 tests; no key or network needed
```

---

## Approach

A customer saying "my package is lost" is usually in one of three situations, and only one
of them is actually a lost package. The bot's first job is working out which:

| Tracking says | What's usually going on | What the bot does |
|---|---|---|
| Delivered | It's there — behind a planter, with a neighbor, signed for by a housemate | Asks them to check before opening anything |
| In transit, before the due date | Not lost, just not here yet | Shows the last scan and ETA, offers an arrival alert |
| Past due, no movement | Genuinely lost | Apologizes, goes straight to a claim |

Every path ends in one of three places: the package is found, a claim is opened, or the
customer reaches a person. Typing `agent` works from anywhere.

---

## How the agent works

**Gemini decides. The app speaks.**

Each turn, the server tells Gemini where the conversation is and hands it a short list of
moves — only the ones allowed from that step. For example, after asking *"have you looked
around?"*, the only moves on offer are `already_checked`, `will_look`, `escalate_to_agent`,
and `unclear`. Gemini must pick exactly one (function calling, `mode: "ANY"`).

The app then carries out that move and writes the reply itself. Gemini never writes a
single word the customer sees.

**Why split it this way.** A customer-service bot that lets a model write freely can be
talked into promising refunds or inventing policy. Here, the worst a confused or
manipulated model can do is pick the wrong move from a short list — and even that gets
checked. Meanwhile the customer still gets the benefit: *"nah it's definitely not out
there, asked next door too"* is understood as "already checked," which the keyword
matcher misses.

### Guardrails — each one has a test

| Guardrail | What it prevents |
|---|---|
| Gemini is only offered the current step's moves | Skipping ahead, e.g. straight to a refund |
| The server re-checks the chosen move anyway | A model that ignores its instructions |
| Order numbers from the model are validated and looked up | Hallucinated order numbers |
| All customer-facing text comes from the app | Invented promises or policy |
| Customer text is fenced off as data in the prompt | "Ignore your rules and…" |
| Gemini error or timeout (8s) → keyword matching takes over | A dead chat during an outage |
| Key stays on the server, sent in a header | Key leaking to the browser or logs |
| Server serves only `public/` | `.env` being downloadable |
| Conversation state lives on the server | A client faking which step it's on |

---

## Deploy it (free, from GitHub)

GitHub holds the code. [Render](https://render.com) runs it — the chat page and the Gemini
agent together, at one public URL. Free, no credit card, and it redeploys automatically
every time you push to GitHub.

1. Push this repo to GitHub.
2. Sign in to Render with your GitHub account.
3. **New → Blueprint**, pick this repo. Render reads `render.yaml` and sets everything up.
4. When it asks for `GEMINI_API_KEY`, paste your key. It's stored in Render, never in GitHub.
5. Click **Apply**. In a few minutes you get a URL like `https://trackbot-xxxx.onrender.com`.

Open it and check the badge says **Gemini agent**. Then put the URL at the top of this README.

**About the free tier:** Render puts free servers to sleep after 15 minutes with no visitors.
The next visit wakes it, which takes 30–60 seconds. If someone has the chat open when it
sleeps, their next message quietly starts a fresh conversation instead of showing an error.

---

## Alternative: run the agent on your own machine

You can split this into two pieces:

- **The chat page** — plain files in `public/`, hosted free on GitHub Pages.
- **The agent server** — `server.js`, running on your own machine, holding the key.

The page calls the server over the internet. If the server is ever off, the page notices
within 5 seconds and keeps working in rule-based mode, so a reviewer never sees a broken demo.

**1 · Put the agent server online (Tailscale Funnel).** On the machine that will run it,
with Tailscale installed and signed in:

```bash
npm start                    # agent listening on port 3000
tailscale funnel --bg 3000   # public HTTPS address for it
tailscale funnel status      # shows the address, e.g. https://shawnpc.your-tailnet.ts.net
```

The first time, Tailscale gives you a link to switch Funnel on for your account.

**2 · Tell the page where the server is.** In `public/config.js`:

```js
window.TRACKBOT_API = "https://shawnpc.your-tailnet.ts.net";
```

**3 · Tell the server which website may call it.** In `.env`, then restart:

```
ALLOWED_ORIGINS=https://yourname.github.io
TRUST_PROXY=1
```

Use only the domain, with no path and no trailing slash. `TRUST_PROXY=1` lets rate limits
see each visitor's real address through Funnel.

**4 · Publish the page.** In the repo: *Settings → Pages → Source: GitHub Actions*, then
*Actions → Publish chat page → Run workflow*. It publishes only `public/` — never the server
or key. It only runs when you start it, so it can't fail on every push.

### What protects your key once it's public

| Protection | What it stops |
|---|---|
| Key lives only in `.env` on your machine | Anyone reading it from the page or repo |
| Only your website is allowed (CORS) | Other sites embedding your agent |
| 30 messages / minute per visitor | Scripts burning through your quota |
| 10 new chats / minute per visitor | Session flooding |
| The agent can only pick flowchart moves | Your key being used as a free general chatbot |

CORS only stops other *websites*; a script can ignore it. The rate limits and the narrow
move list are what make the key not worth stealing access to.

**Keep your machine awake** while it's being reviewed — if it sleeps, the page falls back
to rule-based mode.

---

## Conversation design

![Conversation flow](flowchart.svg)

**Yes paths leave the bottom-left of a decision and go left; no paths leave the
bottom-right and go right.** The two error boxes on the right loop back to the start.
The dashed line is the `agent` escape hatch, available at every step.

---

## Error handling

**1 · Not an order number.** Names the expected format and gives an example, instead of
"invalid input."

**2 · Right format, no record.** Treated differently on purpose — the customer typed
something reasonable, so the bot suggests why it might not match rather than implying they
got it wrong.

**3 · Two misses in a row, at any step.** The bot still explains what went wrong, then stops
re-asking and offers a person. Choosing "keep going" returns to the same step.

**4 · The agent itself fails.** Timeouts, API errors, or an illegal move from the model
all fall back to keyword matching or a re-prompt. The customer never sees a crash.

![Error handling](screenshots/02-error-handling.png)

---

## Project layout

```
public/
  index.html     chat interface; talks to the server, or runs the engine locally
  engine.js      the conversation flow — shared by browser and server
  config.js      where the agent server lives, if it's hosted separately
server.js        holds the API key, keeps each conversation's state, runs each turn
gemini.js        builds the Gemini request and reads back the chosen move
test.js          23 tests: every path, every error, every guardrail
render.yaml      one-click deploy to Render
.github/         optional: publishes public/ to GitHub Pages
flowchart.svg    the conversation design
```

**One engine, two decision makers.** `engine.js` is the single copy of the flow. The
browser loads it with keyword matching; the server loads it with Gemini. Whatever decides,
the same code executes the move.

Each turn on the server:
1. Browser sends only the customer's text.
2. Server asks Gemini to pick one of the allowed moves.
3. If Gemini fails, keyword matching picks instead.
4. Server checks the move is legal from this step.
5. Engine carries it out and writes the reply.

---

## Screenshots

These are from rule-based mode. The line under each customer message shows which move was
chosen and by what — in agent mode it reads `· gemini`.

**Tracking says delivered, customer says otherwise → claim**

![Delivered but missing](screenshots/01-delivered-but-missing.png)

**In transit and not yet due → reassure, don't open a claim**

![In transit](screenshots/03-in-transit-not-lost.png)

---

## Try these

| Input | What it shows |
|---|---|
| `EG-58120` | Tracking says delivered — check before claiming |
| `EG-77441` | In transit, not yet due — reassurance |
| `EG-10293` | Past due, no movement — straight to a claim |
| `EG-99999` | Not found (error 2) |
| `asdf` | Not an order number (error 1) |
| `agent` | Reach a person, from any step |
| `my order is eg 58120` | Agent mode pulls the number out of a sentence |
| `nah not out there, asked next door` | Agent mode understands; keyword mode doesn't |

---

## With more time

- Real carrier lookups (USPS/UPS/FedEx) in place of the mock order data.
- Pass the transcript to the human agent on handoff, so the customer never repeats themselves.
- Actually send the arrival alert by email or SMS.
- Log each turn's chosen move and which decision maker chose it — where customers fall
  out of the flow is the roadmap for what to fix next.

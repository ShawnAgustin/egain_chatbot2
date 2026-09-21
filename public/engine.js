/* ============================================================
   TrackBot engine — the conversation flow, shared by the
   browser (rule-based mode) and the server (Gemini agent mode).

   The split that matters:
     - Something DECIDES which action the customer meant.
       That's either Gemini (agent mode) or ruleIntent() below.
     - The engine EXECUTES that action and writes every word
       the customer sees. The model never writes customer copy.

   So the agent can only ever pick one of the moves drawn on
   the flowchart. It can't promise a refund that doesn't exist.
   ============================================================ */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.TrackBotEngine = factory();
})(typeof self !== "undefined" ? self : this, function () {

  /* ---------- Mock data (stands in for a carrier tracking API) ---------- */
  const ORDERS = {
    "EG-58120": { status: "delivered",  on: "Sept 12", where: "left at front door, photo on file" },
    "EG-77441": { status: "in_transit", eta: "Sept 19", where: "regional hub, Reno NV" },
    "EG-10293": { status: "stalled",    due: "Sept 14", where: "last scanned Sept 13 in Memphis TN" }
  };

  /* ---------- Every move the conversation can make ----------
     These double as Gemini's tool definitions: the description is
     exactly what the model reads when deciding which to call.     */
  const ACTIONS = {
    lookup_order: {
      description: "The customer gave an order number to look up.",
      params: { order_id: "The order number exactly as the customer gave it, e.g. EG-58120. Never invent or guess letters or digits." }
    },
    already_checked:   { description: "The customer says they already looked around the delivery spot, with neighbors, or with household members, and the package is not there." },
    will_look:         { description: "The customer wants to go look around the delivery spot before continuing." },
    found_it:          { description: "The customer found the package." },
    still_missing:     { description: "The customer looked again and the package is still missing." },
    notify_on_arrival: { description: "The customer wants an alert when the package is delivered." },
    new_lookup:        { description: "The customer wants to look up a different order." },
    file_claim:        { description: "The customer wants to file a lost-package claim now." },
    wait_longer:       { description: "The customer prefers to wait a few more days before filing a claim." },
    send_replacement:  { description: "The customer wants a replacement shipped." },
    issue_refund:      { description: "The customer wants a refund." },
    keep_going:        { description: "The customer wants to keep going with the assistant rather than talk to a person." },
    escalate_to_agent: { description: "The customer explicitly asks for a human, agent or person, or says they want to stop using the assistant. Frustration alone does not count." },
    unclear:           { description: "The customer's message does not clearly match any other action. Use this instead of guessing." }
  };

  /* ---------- The states on the flowchart ----------
     actions:  the moves allowed from this state (escalate/unclear are always allowed)
     reprompt: what to say when the customer's reply doesn't match
     chips:    the quick replies to show                                           */
  const STATES = {
    ask_order: {
      actions: ["lookup_order"],
      ask: () => "What's the order number?",
      reprompt: () => "That doesn't look like an order number. They're two letters, a dash, then " +
                      "4–6 digits — like EG-58120. Mind checking your confirmation email?",
      chips: () => [...Object.keys(ORDERS), "agent"]
    },
    looked_around: {
      actions: ["already_checked", "will_look"],
      reprompt: () => "Have you already looked around, or do you want to check first?",
      chips: () => ["I already checked", "I'll go look now"]
    },
    recheck: {
      actions: ["found_it", "still_missing"],
      reprompt: () => "Did it turn up, or is it still missing?",
      chips: () => ["Still missing", "Found it"]
    },
    in_transit: {
      actions: ["notify_on_arrival", "new_lookup"],
      reprompt: () => "I can watch it for you, look up a different order, or get you an agent.",
      chips: () => ["Notify me when it arrives", "Start a new lookup", "agent"]
    },
    stalled: {
      actions: ["file_claim", "wait_longer"],
      reprompt: () => "I can file the claim now, keep watching it a few more days, or get you an agent.",
      chips: () => ["File a claim", "Give it a few more days", "agent"]
    },
    claim_type: {
      actions: ["send_replacement", "issue_refund"],
      reprompt: () => "Replacement or refund?",
      chips: () => ["Send a replacement", "Refund me"]
    },
    confirm_escalation: {
      actions: ["keep_going"],
      reprompt: () => "Should I connect you with a person, or keep going here?",
      chips: () => ["Yes, get me an agent", "No, let's keep going"]
    },
    ended: {
      actions: ["new_lookup"],
      reprompt: () => "We're all wrapped up here — want to look up another package?",
      chips: () => ["Start a new lookup"]
    }
  };

  /* ---------- Session ---------- */
  function createSession() {
    return { state: "ask_order", order: null, misses: 0, upsets: 0, resumeState: null };
  }

  function greeting() {
    return reply([bot("Hi, I'm TrackBot. Sorry your package hasn't shown up — let's find it. " +
                      "What's the order number?")], Object.keys(ORDERS));
  }

  function allowedActions(s) {
    return [...STATES[s.state].actions, "escalate_to_agent", "unclear"];
  }

  /* ---------- Helpers ---------- */
  const bot = text => ({ kind: "bot", text });
  const err = text => ({ kind: "err", text });
  const reply = (messages, chips) => ({ messages, chips });

  // Accepts "EG-58120", "eg58120", "eg 58120". Returns null if it isn't one.
  function normalizeOrderId(raw) {
    const m = String(raw || "").toUpperCase().replace(/\s+/g, "").match(/^([A-Z]{2})-?(\d{4,6})$/);
    return m ? `${m[1]}-${m[2]}` : null;
  }

  function go(s, next, text) {
    s.state = next;
    s.misses = 0;
    return reply([bot(text)], STATES[next].chips(s));
  }

  /* ---------- Error handling ----------
     Always say what went wrong first. After MISS_LIMIT misses in a
     row, stop asking the same question and offer a person instead. */
  const MISS_LIMIT = 3;
  const UPSET_LIMIT = 2;

  // Park the current step and ask whether to bring in a person.
  function offerPerson(s, messages, text) {
    s.resumeState = s.state;
    s.state = "confirm_escalation";
    s.misses = 0;
    s.upsets = 0;
    messages.push(bot(text));
    return reply(messages, STATES.confirm_escalation.chips(s));
  }

  function miss(s, specific) {
    s.misses += 1;
    const messages = [err(specific || STATES[s.state].reprompt(s))];
    if (s.misses >= MISS_LIMIT && s.state !== "confirm_escalation")
      return offerPerson(s, messages, "I'm sorry, I'm having trouble getting this right. " +
        "Would you like me to connect you with a person, or keep trying here?");
    return reply(messages, STATES[s.state].chips(s));
  }

  /* ---------- Mood ----------
     The decision maker says whether the customer sounded upset on this turn.
     One upset message gets empathy from the reply wording. Upset messages
     back to back also offer a person, since the flow clearly isn't helping.
     Returns the reply, possibly with the offer added.                     */
  function noteMood(s, upset, r) {
    s.upsets = upset ? s.upsets + 1 : 0;
    if (s.upsets < UPSET_LIMIT || s.state === "confirm_escalation" || s.state === "ended") return r;
    return offerPerson(s, r.messages, "I can tell this has been frustrating, and I'm sorry. " +
      "Would you like me to connect you with a person, or keep going here?");
  }

  /* ---------- Execute a decided action ----------
     Whoever decided (Gemini or rules), the engine re-checks that the
     action is legal from the current state before doing anything.   */
  function apply(s, action, args) {
    args = args || {};
    if (!allowedActions(s).includes(action)) return miss(s);

    switch (action) {
      case "escalate_to_agent":
        return go(s, "ended", "Of course. I'll connect you with a support specialist and pass along what we have so far" +
          (s.order ? `: order ${s.order}, reported missing.` : "."));

      case "unclear":
        return miss(s);

      case "keep_going": {
        const back = s.resumeState || "ask_order";
        s.resumeState = null;
        return go(s, back, "Okay, let's keep at it. " + (STATES[back].ask || STATES[back].reprompt)(s));
      }

      case "lookup_order": {
        const id = normalizeOrderId(args.order_id);
        if (!id) return miss(s);                                    // error case 1: not an order number
        const rec = ORDERS[id];
        if (!rec) return miss(s,                                    // error case 2: valid shape, no record
          `I can't find a package under ${id}. It may be mistyped, or placed under a ` +
          `different account or email. Want to try another number?`);
        s.order = id;

        // Tracking says delivered — rule out the ordinary explanations first.
        if (rec.status === "delivered") return go(s, "looked_around",
          `Tracking shows ${id} was delivered on ${rec.on} — ${rec.where}. Since it's not where ` +
          `you expect it, have you been able to check around the door, with neighbors, or with ` +
          `anyone else at the address?`);

        // Still inside the delivery window — reassure, don't open a claim.
        if (rec.status === "in_transit") return go(s, "in_transit",
          `Good news: ${id} isn't lost, it's still moving. Last scan was ${rec.where}, with ` +
          `delivery expected ${rec.eta}. I'd give it until then before we call it missing.`);

        // Past its window with no movement — genuinely lost.
        return go(s, "stalled",
          `${id} was due ${rec.due}, and ${rec.where} — nothing since. That's past the point ` +
          `where it should have moved, so I'd treat this one as lost. Sorry about that.`);
      }

      case "already_checked":
        return go(s, "claim_type", "Thanks for checking. Since it's showing delivered but isn't " +
          "there, a claim is the fastest route. What would you like as the outcome?");
      case "will_look":
        return go(s, "recheck", "Go ahead and take a look — I'll be here. Come back and tell me either way.");
      case "found_it":
        return go(s, "ended", "That's a relief. Glad it turned up.");
      case "still_missing":
        return go(s, "claim_type", "Understood — let's open a claim. What would you like as the outcome?");
      case "notify_on_arrival":
        return go(s, "ended", `Done — I'll alert you the moment ${s.order} is delivered.`);
      case "new_lookup":
        s.order = null;
        return go(s, "ask_order", "No problem — what's the order number?");
      case "file_claim":
        return go(s, "claim_type", "What would you like as the outcome?");
      case "wait_longer":
        return go(s, "ended", `Okay — I've flagged ${s.order} as at-risk and I'll keep watching it. Check back anytime.`);
      case "send_replacement":
        return go(s, "ended", `Claim opened for ${s.order} — a replacement is on the way. ` +
          `Confirmation and case number are headed to your email.`);
      case "issue_refund":
        return go(s, "ended", `Claim opened for ${s.order} — the refund will post to your original ` +
          `payment method in 3–5 business days. Confirmation is headed to your email.`);
    }
    return miss(s);
  }

  /* ---------- Rule-based decision maker ----------
     Used in the browser, when no API key is set, and as the
     fallback when a Gemini call fails. Returns null if unsure.   */
  const AGENT_WORDS = /\b(agent|human|representative|(?:a|real) person|(?:talk|speak) to (?:someone|somebody))\b/i;

  function ruleIntent(s, text) {
    const t = text.trim();
    if (s.state === "confirm_escalation") {
      if (/^yes|agent|human|person/i.test(t)) return { action: "escalate_to_agent" };
      if (/^no|keep going|continue/i.test(t)) return { action: "keep_going" };
      return null;
    }
    if (AGENT_WORDS.test(t)) return { action: "escalate_to_agent" };

    switch (s.state) {
      case "ask_order":
        // Hand anything order-ish to lookup_order; the engine rejects bad shapes.
        return normalizeOrderId(t) ? { action: "lookup_order", args: { order_id: t } } : null;
      case "looked_around":
        if (/go look|i'll|later|will check/i.test(t)) return { action: "will_look" };
        if (/check|looked|already|yes|missing|nope|not there/i.test(t)) return { action: "already_checked" };
        return null;
      case "recheck":
        if (/found|got it|turned up|yes/i.test(t)) return { action: "found_it" };
        if (/still|missing|no|nothing/i.test(t)) return { action: "still_missing" };
        return null;
      case "in_transit":
        if (/notify|alert|tell me/i.test(t)) return { action: "notify_on_arrival" };
        if (/new lookup|another|different/i.test(t)) return { action: "new_lookup" };
        return null;
      case "stalled":
        if (/claim|replace|refund/i.test(t)) return { action: "file_claim" };
        if (/wait|few more|hold|days/i.test(t)) return { action: "wait_longer" };
        return null;
      case "claim_type":
        if (/replace|resend|send/i.test(t)) return { action: "send_replacement" };
        if (/refund|money back|credit/i.test(t)) return { action: "issue_refund" };
        return null;
      case "ended":
        if (/new lookup|another|different|track/i.test(t)) return { action: "new_lookup" };
        return null;
    }
    return null;
  }

  return { ORDERS, ACTIONS, STATES, createSession, greeting, allowedActions, apply, noteMood, ruleIntent, normalizeOrderId };
});

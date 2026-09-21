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
  if (typeof module === "object" && module.exports) module.exports = factory(require("./orders.json"));
  else root.TrackBotEngine = factory(null);
})(typeof self !== "undefined" ? self : this, function (loadedOrders) {

  /* ---------- Mock data (stands in for a carrier tracking API) ----------
     The full set lives in orders.json. Node loads it directly; the browser
     loads it with setOrders(). If a page opened straight from disk can't
     fetch it, these three keep the offline demo working.                  */
  const ORDERS = loadedOrders || {
    "EG-58120": { useCase: "Delivered, left at the front door with a photo", status: "delivered",  on: "Sept 12", where: "left at front door, photo on file", featured: true },
    "EG-77441": { useCase: "In transit, on schedule", status: "in_transit", eta: "Sept 19", where: "regional hub, Reno NV", featured: true },
    "EG-10293": { useCase: "Stalled, past due with no movement", status: "stalled",    due: "Sept 14", where: "last scanned Sept 13 in Memphis TN", featured: true }
  };

  function setOrders(next) {
    for (const k of Object.keys(ORDERS)) delete ORDERS[k];
    Object.assign(ORDERS, next);
  }

  // The order numbers offered as quick replies. Only a few, not all of them.
  const featuredOrders = () => {
    const ids = Object.keys(ORDERS), pick = ids.filter(id => ORDERS[id].featured);
    return pick.length ? pick : ids.slice(0, 3);
  };

  /* ---------- Never leave the customer hanging ----------
     Every reply ends by asking what they want to do next and naming the
     options, or (once a chat is wrapped up) by saying how to start again. */
  const ASK_TRANSIT = "Would you like me to alert you when it's delivered, or look up a different order?";
  const ASK_CLAIM   = "Would you like me to file a claim now, or keep watching it for a few more days?";
  const MORE_HELP   = 'If there\'s another order you\'d like me to check, just tap "Start a new lookup" or send me the number.';

  /* ---------- What each tracking status means for the conversation ----------
     Each route returns the step to move to and the draft wording. Delivered
     orders get ruled out first, in-window orders get reassurance, and orders
     that will never arrive go straight to a claim.                          */
  const ROUTES = {
    delivered: (id, r) => ["looked_around",
      `Tracking shows ${id} was delivered on ${r.on} — ${r.where}. Since it's not where ` +
      `you expect it, have you been able to check around the door, with neighbors, or with ` +
      `anyone else at the address?`],

    in_transit: (id, r) => ["in_transit",
      `Good news: ${id} isn't lost, it's still moving. Last scan was ${r.where}, with ` +
      `delivery expected ${r.eta}. I'd give it until then before we call it missing. ${ASK_TRANSIT}`],

    out_for_delivery: (id, r) => ["in_transit",
      `${id} is out for delivery — ${r.where}. It should reach you ${r.eta}, so I'd give ` +
      `it until then before we call it missing. ${ASK_TRANSIT}`],

    attempted: (id, r) => ["in_transit",
      `The carrier tried to deliver ${id} on ${r.on}, but ${r.where}. They'll try again ` +
      `${r.retry}, so it isn't lost. ${ASK_TRANSIT}`],

    not_shipped: (id, r) => ["in_transit",
      `${id} hasn't actually shipped yet — ${r.where}. It's due to ship by ${r.shipBy}, so ` +
      `it isn't lost, it just hasn't left the warehouse. ${ASK_TRANSIT}`],

    held: (id, r) => ["in_transit",
      `${id} is being held: ${r.where}. Once that clears it should start moving again, with ` +
      `delivery expected ${r.eta}. It isn't lost. ${ASK_TRANSIT}`],

    stalled: (id, r) => ["stalled",
      `${id} was due ${r.due}, and ${r.where} — nothing since. That's past the point ` +
      `where it should have moved, so I'd treat this one as lost. Sorry about that. ${ASK_CLAIM}`],

    returned: (id, r) => ["claim_type",
      `${id} was returned to the sender on ${r.on} — ${r.where}. It isn't coming back to ` +
      `you, so the fix is a replacement or a refund. Which would you like?`],

    misdelivered: (id, r) => ["claim_type",
      `Tracking shows ${id} was delivered on ${r.on}, but to the wrong address: ${r.where}. ` +
      `I'm sorry about that. Would you like a replacement or a refund?`],

    damaged: (id, r) => ["claim_type",
      `Tracking shows ${id} was delivered on ${r.on}, but ${r.where}. I'm sorry about that. ` +
      `Would you like a replacement or a refund?`],

    cancelled: (id, r) => ["ended",
      `${id} was cancelled on ${r.on} — ${r.where}, so nothing is on its way to you. ${MORE_HELP}`]
  };

  /* ---------- Every move the conversation can make ----------
     These double as Gemini's tool definitions: the description is
     exactly what the model reads when deciding which to call.     */
  const ACTIONS = {
    lookup_order: {
      description: "The customer gave an order number to look up. This is allowed at any step, including switching to a different order in the middle of a conversation.",
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
    switch_order:      { description: "The customer confirms they want to check the new order instead of the one already in progress." },
    stay_on_order:     { description: "The customer wants to stay with the order already in progress instead of switching to the new one." },
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
      chips: () => [...featuredOrders(), "agent"]
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
    confirm_switch: {
      actions: ["switch_order", "stay_on_order"],
      reprompt: s => `Should I check ${s.pendingOrder} instead, or stay with ${s.order}?`,
      chips: s => [`Yes, check ${s.pendingOrder}`, `No, stay with ${s.order}`]
    },
    ended: {
      actions: ["new_lookup"],
      reprompt: () => "We're all wrapped up here — want to look up another package?",
      chips: () => ["Start a new lookup"]
    }
  };

  /* ---------- Session ---------- */
  function createSession() {
    return { state: "ask_order", order: null, misses: 0, upsets: 0, resumeState: null, pendingOrder: null, switchFrom: null };
  }

  function greeting() {
    return reply([bot("Hi, I'm TrackBot. Sorry your package hasn't shown up — let's find it. " +
                      "What's the order number?")], featuredOrders());
  }

  // Looking up an order is always allowed: customers paste a different order number mid-chat.
  function allowedActions(s) {
    return [...new Set([...STATES[s.state].actions, "lookup_order", "escalate_to_agent", "unclear"])];
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

      case "switch_order": {
        const id = s.pendingOrder;
        if (!id) return miss(s);
        s.pendingOrder = null; s.switchFrom = null; s.order = null;
        return apply(s, "lookup_order", { order_id: id });
      }

      case "stay_on_order": {
        const back = s.switchFrom || "ask_order";
        s.pendingOrder = null; s.switchFrom = null;
        return go(s, back, `Okay, we'll stay with ${s.order}. ` + (STATES[back].ask || STATES[back].reprompt)(s));
      }

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
        const route = ROUTES[rec.status];
        if (!route) return miss(s,                                  // error case 3: record we can't interpret
          `I found ${id}, but I can't read its tracking status right now. Want to try another number?`);

        // Already working on a different order? Say so and ask before dropping it.
        if (s.order && s.order !== id && !["ask_order", "ended", "confirm_switch"].includes(s.state)) {
          s.pendingOrder = id;
          s.switchFrom = s.state;
          return go(s, "confirm_switch", `We're still working on ${s.order} right now. ` +
            `Would you like me to check ${id} instead, or stay with ${s.order}?`);
        }
        s.order = id;
        return go(s, ...route(id, rec));
      }

      case "already_checked":
        return go(s, "claim_type", "Thanks for checking. Since it's showing delivered but isn't " +
          "there, a claim is the fastest route. What would you like as the outcome?");
      case "will_look":
        return go(s, "recheck", "Go ahead and take a look — I'll be here. Come back and tell me either way.");
      case "found_it":
        return go(s, "ended", `That's a relief. Glad it turned up. ${MORE_HELP}`);
      case "still_missing":
        return go(s, "claim_type", "Understood — let's open a claim. What would you like as the outcome?");
      case "notify_on_arrival":
        return go(s, "ended", `Done — I'll alert you the moment ${s.order} is delivered. ${MORE_HELP}`);
      case "new_lookup":
        s.order = null;
        return go(s, "ask_order", "No problem — what's the order number?");
      case "file_claim":
        return go(s, "claim_type", "What would you like as the outcome?");
      case "wait_longer":
        return go(s, "ended", `Okay — I've flagged ${s.order} as at-risk and I'll keep watching it. ${MORE_HELP}`);
      case "send_replacement":
        return go(s, "ended", `Claim opened for ${s.order} — a replacement is on the way. ` +
          `Confirmation and case number are headed to your email. ${MORE_HELP}`);
      case "issue_refund":
        return go(s, "ended", `Claim opened for ${s.order} — the refund will post to your original ` +
          `payment method in 3–5 business days. Confirmation is headed to your email. ${MORE_HELP}`);
    }
    return miss(s);
  }

  /* ---------- Rule-based decision maker ----------
     Used in the browser, when no API key is set, and as the
     fallback when a Gemini call fails. Returns null if unsure.   */
  const AGENT_WORDS = /\b(agent|human|representative|(?:a|real) person|(?:talk|speak) to (?:someone|somebody))\b/i;

  function ruleIntent(s, text) {
    const t = text.trim();
    if (normalizeOrderId(t)) return { action: "lookup_order", args: { order_id: t } };
    if (s.state === "confirm_switch") {
      if (/^(yes|yeah|yep|sure|ok)|switch|instead/i.test(t)) return { action: "switch_order" };
      if (/^no|stay|keep|continue|current/i.test(t)) return { action: "stay_on_order" };
      return null;
    }
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

  return { ORDERS, setOrders, ACTIONS, STATES, createSession, greeting, allowedActions, apply, noteMood, ruleIntent, normalizeOrderId };
});

// api/webhook.js
import { db } from "../lib/firebase.js";
import { categories, drinksByBase, getDrinkByName, parsePrice, addOnPriceList } from "../lib/menu.js";

const MENU_IMAGE_URLS = [
  "https://coz-fb-vercel.vercel.app/menu1.png",
  "https://coz-fb-vercel.vercel.app/menu2.png"
];

export const config = {
  api: {
    bodyParser: true // default on Vercel; OK since we skip signature verification here
  }
};

async function sendImage(recipientId, url, reusable = true) {
  await fetch(`https://graph.facebook.com/v23.0/me/messages?access_token=${process.env.PAGE_ACCESS_TOKEN}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: {
        attachment: {
          type: "image",
          payload: { url, is_reusable: reusable }
        }
      }
    })
  });
}

async function sendMenuCarousel(recipientId, imageUrls) {
  const elements = imageUrls.slice(0, 10).map((url, idx) => ({
    title: `Menu ${idx + 1}`,
    image_url: url
    // (optional) buttons can go here if you want deep links/actions
  }));

  await fetch(`https://graph.facebook.com/v23.0/me/messages?access_token=${process.env.PAGE_ACCESS_TOKEN}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: {
        attachment: {
          type: "template",
          payload: { template_type: "generic", elements }
        }
      }
    })
  });
}

export default async function handler(req, res) {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
  const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

  // 1) VERIFY (GET)
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  }

  // 2) EVENTS (POST)
  if (req.method !== "POST") {
    res.setHeader("Allow", ["GET", "POST"]);
    return res.status(405).end("Method Not Allowed");
  }

  const body = req.body;
  if (body.object !== "page") return res.sendStatus(404);

  for (const entry of body.entry || []) {
    const event = entry.messaging?.[0];
    if (!event) continue;

    const senderId = event.sender?.id;

    // Commands via text
    const rawText = event.message?.text?.trim().toLowerCase();

    // Quick reply payload (from quick_replies)
    const qrPayload = event.message?.quick_reply?.payload;
    // Postback payload (from buttons)
    const pbPayload = event.postback?.payload;

    const payload = qrPayload || pbPayload;

    try {
      if (rawText === "menu" || rawText === "order") {
        await setSession(senderId, { step: "category", draftItem: null });

        // EITHER: Send a 2-card carousel (recommended UX)
        await sendMenuCarousel(senderId, MENU_IMAGE_URLS);

        // OR: send two separate image messages (uncomment if you prefer two single images)
        // for (const url of MENU_IMAGE_URLS) {
        //   await sendImage(senderId, url);
        // }

        // Follow with categories
        await sendCategoryList(senderId);
        continue;
      }

      if (rawText === "cart") {
        await sendCart(senderId);
        continue;
      }

      if (rawText === "clear") {
        await clearCart(senderId);
        await sendText(senderId, "🧹 Cart cleared. Type 'menu' to start a new order.");
        continue;
      }

      if (rawText === "checkout") {
        await handleCheckout(senderId);
        continue;
      }

      if (payload) {
        await handlePayload(senderId, payload);
        continue;
      }

      // Default help
      if (rawText) {
        await sendText(senderId, "Hi! Type 'menu' to start ordering, 'cart' to view cart, or 'checkout' to place your order.");
      }
    } catch (e) {
      console.error("Handler error:", e);
      await sendText(senderId, "Oops, something went wrong. Please try again.");
    }
  }

  return res.status(200).send("EVENT_RECEIVED");

  // ----- FLOW HANDLERS -----

  async function handlePayload(userId, payload) {
    // CATEGORY_xxx
    if (payload.startsWith("CATEGORY_")) {
      const base = payload.split("CATEGORY_")[1];
      await setSession(userId, { step: "drink", draftItem: { base } });
      return sendDrinks(userId, base);
    }

    // DRINK_<encodedName>
    if (payload.startsWith("DRINK_")) {
      const name = decodeURIComponent(payload.slice("DRINK_".length));
      const drink = getDrinkByName(name);
      if (!drink) return sendText(userId, "Drink not found. Type 'menu' to try again.");

      const draft = {
        base: drink.base,
        drink: drink.name,
        size: drink.sizeOptions?.[0] ?? "regular",
        milk: drink.milkOptions?.[0] ?? "none",
        temperature: drink.options?.[0] ?? "none",
        addOns: [],
        price: parsePrice(drink.price),
        quantity: 1
      };

      // Decide next step dynamically
      const nextStep = nextStepAfter("drink", drink);
      await setSession(userId, { step: nextStep, draftItem: draft });

      // Ask next question
      return askNextStep(userId, drink, nextStep);
    }

    // SIZE_, MILK_, TEMP_, ADDON_, ADDON_SKIP, QTY_, CONFIRM_ADD, MORE, CHECKOUT
    const session = await getSession(userId);
    const draft = session?.draftItem;
    const drink = draft?.drink ? getDrinkByName(draft.drink) : null;
    if (!draft || !drink) {
      return sendText(userId, "Session expired. Type 'menu' to start again.");
    }

    if (payload.startsWith("SIZE_")) {
      draft.size = payload.slice("SIZE_".length);
      const step = nextStepAfter("size", drink);
      await setSession(userId, { step, draftItem: draft });
      return askNextStep(userId, drink, step);
    }

    if (payload.startsWith("MILK_")) {
      draft.milk = payload.slice("MILK_".length);
      const step = nextStepAfter("milk", drink);
      await setSession(userId, { step, draftItem: draft });
      return askNextStep(userId, drink, step);
    }

    if (payload.startsWith("TEMP_")) {
      draft.temperature = payload.slice("TEMP_".length);
      const step = nextStepAfter("temperature", drink);
      await setSession(userId, { step, draftItem: draft });
      return askNextStep(userId, drink, step);
    }

    if (payload === "ADDON_SKIP") {
      const step = nextStepAfter("add_ons", drink);
      await setSession(userId, { step, draftItem: draft });
      return askNextStep(userId, drink, step);
    }

    if (payload.startsWith("ADDON_")) {
      // toggle add-on
      const addOnName = decodeURIComponent(payload.slice("ADDON_".length));
      const exists = draft.addOns.includes(addOnName);
      draft.addOns = exists ? draft.addOns.filter(a => a !== addOnName) : [...draft.addOns, addOnName];
      await setSession(userId, { step: "add_ons", draftItem: draft });
      // Re-ask add-ons with current selection
      return askNextStep(userId, drink, "add_ons");
    }

    if (payload.startsWith("QTY_")) {
      const qty = Math.max(1, parseInt(payload.slice("QTY_".length), 10) || 1);
      draft.quantity = qty;
      await setSession(userId, { step: "confirm", draftItem: draft });
      return askNextStep(userId, drink, "confirm");
    }

    if (payload === "CONFIRM_ADD") {
      // compute subtotal
      const basePrice = parsePrice(drink.price);
      const addOnPrices = addOnPriceList(drink).filter(a => draft.addOns.includes(a.name));
      const addOnTotal = addOnPrices.reduce((s, a) => s + Number(a.price || 0), 0);
      const perItem = basePrice + addOnTotal;
      const subtotal = perItem * draft.quantity;

      const item = {
        drink: draft.drink,
        base: draft.base,
        size: draft.size,
        milk: draft.milk,
        temperature: draft.temperature,
        addOns: draft.addOns,
        quantity: draft.quantity,
        price: perItem,
        subtotal
      };

      await addToCart(userId, item);
      await setSession(userId, { step: "category", draftItem: null });

      await sendText(
        userId,
        `✅ Added to cart: ${item.quantity} × ${item.drink} (${item.size}${draft.milk !== "none" ? ", " + draft.milk : ""}${draft.temperature !== "none" ? ", " + draft.temperature : ""})\nSubtotal: ₱${item.subtotal}`
      );

      return sendQuickReplies(userId, "Would you like to add more or checkout?", [
        { title: "➕ Add more", payload: "MORE" },
        { title: "🛒 View cart", payload: "VIEW_CART" },
        { title: "✅ Checkout", payload: "CHECKOUT" }
      ]);
    }

    if (payload === "MORE") {
      await setSession(userId, { step: "category", draftItem: null });
      return sendCategoryList(userId);
    }

    if (payload === "VIEW_CART") {
      return sendCart(userId);
    }

    if (payload === "CHECKOUT") {
      return handleCheckout(userId);
    }

    // Fallback
    return sendText(userId, "I didn't get that. Type 'menu' to start ordering.");
  }

  function nextStepAfter(currentStep, drink) {
    // Decide the next mandatory step based on what options exist
    // Order: size -> milk -> temperature -> add_ons -> quantity -> confirm
    const sizeAvailable = (drink.sizeOptions ?? []).length > 0;
    const milkAvailable = (drink.milkOptions ?? []).length > 0;
    const tempAvailable = (drink.options ?? []).length > 0;
    const addOnsAvailable = (drink.add_ons ?? []).length > 0;

    const chain = [];
    if (sizeAvailable) chain.push("size");
    if (milkAvailable) chain.push("milk");
    if (tempAvailable) chain.push("temperature");
    if (addOnsAvailable) chain.push("add_ons");
    chain.push("quantity");
    chain.push("confirm");

    if (currentStep === "drink") return chain[0] ?? "quantity";
    const idx = chain.indexOf(currentStep);
    return idx >= 0 && idx < chain.length - 1 ? chain[idx + 1] : "confirm";
  }

  async function askNextStep(userId, drink, step) {
    if (step === "size") {
      const opts = (drink.sizeOptions ?? []).map(s => ({ title: cap(s), payload: `SIZE_${s}` }));
      return sendQuickReplies(userId, `Choose size for ${drink.name}:`, opts);
    }
    if (step === "milk") {
      const opts = (drink.milkOptions ?? []).map(m => ({ title: cap(m), payload: `MILK_${m}` }));
      return sendQuickReplies(userId, `Milk option for ${drink.name}:`, opts);
    }
    if (step === "temperature") {
      const opts = (drink.options ?? []).map(t => ({ title: cap(t), payload: `TEMP_${t}` }));
      return sendQuickReplies(userId, `Hot or cold for ${drink.name}?`, opts);
    }
    if (step === "add_ons") {
      const list = addOnPriceList(drink);
      if (!list.length) {
        // skip
        return askNextStep(userId, drink, "quantity");
      }
      const session = await getSession(userId);
      const chosen = session?.draftItem?.addOns ?? [];
      // Show toggles and Skip / Next
      const buttons = list.slice(0, 11).map(a => ({
        title: `${chosen.includes(a.name) ? "✅ " : ""}${a.name} (+₱${a.price})`,
        payload: `ADDON_${encodeURIComponent(a.name)}`
      }));
      buttons.push({ title: "Skip/Next", payload: "ADDON_SKIP" });
      const selectedText = chosen.length ? `Selected: ${chosen.join(", ")}` : "None";
      return sendQuickReplies(userId, `Add-ons for ${drink.name}? (${selectedText})`, buttons);
    }
    if (step === "quantity") {
      const buttons = [1, 2, 3, 4, 5].map(n => ({ title: `${n}`, payload: `QTY_${n}` }));
      return sendQuickReplies(userId, `How many ${drink.name}?`, buttons);
    }
    if (step === "confirm") {
      const session = await getSession(userId);
      const d = session?.draftItem;
      const addOnTxt = d?.addOns?.length ? ` + ${d.addOns.join(", ")}` : "";
      return sendQuickReplies(
        userId,
        `Confirm: ${d.quantity} × ${d.drink} (${d.size}${d.milk !== "none" ? ", " + d.milk : ""}${d.temperature !== "none" ? ", " + d.temperature : ""})${addOnTxt}`,
        [
          { title: "Add to cart ✅", payload: "CONFIRM_ADD" },
          { title: "Change qty", payload: "QTY_1" },
          { title: "Cancel item", payload: "MORE" }
        ]
      );
    }
    // category
    return sendCategoryList(userId);
  }

  // ----- CART / ORDER STORAGE -----

  async function addToCart(userId, item) {
    const ref = db.collection("carts").doc(userId);
    const doc = await ref.get();
    if (!doc.exists) {
      await ref.set({ items: [item], updatedAt: Date.now() });
    } else {
      const items = doc.data().items || [];
      items.push(item);
      await ref.update({ items, updatedAt: Date.now() });
    }
  }

  async function getCart(userId) {
    const ref = db.collection("carts").doc(userId);
    const doc = await ref.get();
    return doc.exists ? (doc.data().items || []) : [];
  }

  async function clearCart(userId) {
    await db.collection("carts").doc(userId).delete().catch(() => { });
  }

  async function handleCheckout(userId) {
    const items = await getCart(userId);
    if (!items.length) {
      return sendText(userId, "Your cart is empty. Type 'menu' to start ordering.");
    }
    const grandTotal = items.reduce((s, it) => s + (it.subtotal ?? (it.price * it.quantity)), 0);
    const order = {
      userId,
      status: "pending",
      createdAt: Date.now(),
      items,
      grandTotal
    };
    await db.collection("orders").add(order);
    await clearCart(userId);

    await sendText(userId, `✅ Order placed! Grand total: ₱${grandTotal}. Thank you!`);
    return sendQuickReplies(userId, "Need anything else?", [
      { title: "Order again", payload: "MORE" },
      { title: "View cart", payload: "VIEW_CART" }
    ]);
  }

  async function sendCart(userId) {
    const items = await getCart(userId);
    if (!items.length) {
      return sendText(userId, "🛒 Your cart is empty.");
    }
    const lines = items.map((it, i) =>
      `${i + 1}) ${it.quantity}× ${it.drink} (${it.size}${it.milk !== "none" ? ", " + it.milk : ""}${it.temperature !== "none" ? ", " + it.temperature : ""})${it.addOns?.length ? " + " + it.addOns.join(", ") : ""} — ₱${it.subtotal ?? (it.price * it.quantity)}`
    );
    const total = items.reduce((s, it) => s + (it.subtotal ?? (it.price * it.quantity)), 0);
    await sendText(userId, `🛒 Cart:\n${lines.join("\n")}\n\nTotal: ₱${total}`);
    return sendQuickReplies(userId, "Proceed to checkout?", [
      { title: "✅ Checkout", payload: "CHECKOUT" },
      { title: "➕ Add more", payload: "MORE" },
      { title: "🧹 Clear", payload: "CLEAR_CART" } // Handle below
    ]);
  }

  // handle clear via payload too
  async function handlePayloadClear(userId, payload) {
    if (payload === "CLEAR_CART") {
      await clearCart(userId);
      return sendText(userId, "🧹 Cart cleared.");
    }
  }

  // ----- SESSION STATE (for step-by-step building) -----

  async function setSession(userId, data) {
    await db.collection("sessions").doc(userId).set(data, { merge: true });
  }

  async function getSession(userId) {
    const doc = await db.collection("sessions").doc(userId).get();
    return doc.exists ? doc.data() : null;
  }

  // ----- UI SENDERS -----

  async function sendCategoryList(userId) {
    const buttons = categories.map(c => ({ title: c.title, payload: `CATEGORY_${c.base}` })).slice(0, 11);
    await sendQuickReplies(userId, "Choose a category:", buttons);
  }

  async function sendDrinks(userId, base) {
    const list = drinksByBase(base);
    if (!list.length) {
      return sendText(userId, "No drinks in this category yet. Type 'menu' to pick another.");
    }
    // limit to 11 quick replies (Messenger limit = 13; keep some for control)
    const buttons = list.slice(0, 11).map(d => ({
      title: trim13(d.name),
      payload: `DRINK_${encodeURIComponent(d.name)}`
    }));
    await sendQuickReplies(userId, `Pick a ${base} item:`, buttons);
  }

  async function sendText(recipientId, text) {
    await fetch(`https://graph.facebook.com/v23.0/me/messages?access_token=${process.env.PAGE_ACCESS_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipient: { id: recipientId }, message: { text } })
    });
  }

  async function sendQuickReplies(recipientId, text, buttons) {
    await fetch(`https://graph.facebook.com/v23.0/me/messages?access_token=${process.env.PAGE_ACCESS_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: {
          text,
          quick_replies: buttons.map(b => ({
            content_type: "text",
            title: b.title,
            payload: b.payload
          }))
        }
      })
    });
  }

  // ----- utils -----
  function cap(s) { return (s || "").charAt(0).toUpperCase() + (s || "").slice(1); }
  function trim13(s) { return s.length > 13 ? s.slice(0, 12) + "…" : s; }
}

// api/webhook.js
export default async function handler(req, res) {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
  const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

  // 1) Facebook GET verification
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403); // verify token mismatch
  }

  // 2) Messenger events (POST)
  if (req.method === "POST") {
    const body = req.body;

    if (body.object === "page") {
      for (const entry of body.entry || []) {
        const event = entry.messaging?.[0];
        console.log("Event:", JSON.stringify(event, null, 2));

        const text = event?.message?.text;
        const senderId = event?.sender?.id;

        // Simple echo reply
        if (text && senderId && PAGE_ACCESS_TOKEN) {
          try {
            const url = `https://graph.facebook.com/v23.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;
            await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                recipient: { id: senderId },
                message: { text: `You said: ${text}` },
              }),
            });
          } catch (err) {
            console.error("Send API error:", err);
          }
        }
      }
      return res.status(200).send("EVENT_RECEIVED");
    }

    return res.sendStatus(404);
  }

  res.setHeader("Allow", ["GET", "POST"]);
  return res.status(405).end("Method Not Allowed");
}

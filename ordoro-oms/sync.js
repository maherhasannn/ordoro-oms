import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const auth = Buffer.from(
  `${process.env.ORDORO_CLIENT}:${process.env.ORDORO_SECRET}`
).toString("base64");

let lastSync = new Date(Date.now() - 5 * 60 * 1000).toISOString();

async function pollOrders() {
  try {
    console.log("🔄 Polling since:", lastSync);

    const res = await axios.get(
      `https://api.ordoro.com/v3/order?updated_after=${encodeURIComponent(lastSync)}&limit=50`,
      {
        headers: {
          Authorization: `Basic ${auth}`,
        },
      }
    );

    const orders = res.data.order || [];

    if (orders.length === 0) {
      console.log("🟡 No new orders");
      return;
    }

    console.log(`🟢 Found ${orders.length} orders`);

    // process orders
    orders.forEach(o => {
      console.log("📦 Order:", o.id, o.created_at);
    });

    // advance watermark
    const newest = orders.reduce((max, o) =>
      new Date(o.updated_at || o.created_at) > new Date(max)
        ? o.updated_at || o.created_at
        : max
    , lastSync);

    lastSync = newest;

    console.log("✅ New watermark:", lastSync);

  } catch (err) {
    console.error("❌ Error:", err.response?.data || err.message);
  }
}

// run forever
setInterval(pollOrders, 15000); // 15 seconds for testing

pollOrders();
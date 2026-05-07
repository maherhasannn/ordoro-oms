import dotenv from "dotenv";
dotenv.config();
import axios from "axios";

const auth = Buffer.from(`${process.env.ORDORO_CLIENT}:${process.env.ORDORO_SECRET}`).toString("base64");
const skus = ["I-B1", "I-F1", "I-E5", "I-A1", "I-A2"];

for (const sku of skus) {
  try {
    const res = await axios.get(
      `https://api.ordoro.com/product/${encodeURIComponent(sku)}/`,
      { headers: { Authorization: `Basic ${auth}` } }
    );
    const p = res.data;
    console.log(`${sku}: name="${p.name}" is_kit=${p.is_kit_parent} tags=${JSON.stringify((p.tags || []).map(t => t.text || t))}`);
  } catch (e) {
    console.log(`${sku}: ${e.response?.status || e.message}`);
  }
}

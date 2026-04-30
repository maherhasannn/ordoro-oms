import axios from "axios";
import { withTimeout } from "../lib/timeout.js";

const BASE = process.env.TURN14_BASE_URL || "https://api.turn14.com/v1";
const TURN14_API_TIMEOUT = 10_000;

let tokenCache = { token: null, expiresAt: 0 };

// ── OAuth Token ─────────────────────────────────────────

async function getToken(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && tokenCache.token && now < tokenCache.expiresAt) {
    return tokenCache.token;
  }

  const res = await axios.post(`${BASE}/token`, {
    grant_type: "client_credentials",
    client_id: process.env.TURN14_CLIENT_ID,
    client_secret: process.env.TURN14_CLIENT_SECRET,
  });

  const { access_token, expires_in } = res.data;
  // refresh 15 min before actual expiry
  tokenCache = {
    token: access_token,
    expiresAt: now + (expires_in - 900) * 1000,
  };
  return access_token;
}

async function authHeaders(forceRefresh = false) {
  const token = await getToken(forceRefresh);
  return { Authorization: `Bearer ${token}` };
}

// ── Retry wrapper (handles 401 → token refresh) ────────

async function apiGet(path, retried = false) {
  try {
    const headers = await authHeaders(retried);
    const res = await withTimeout(
      axios.get(`${BASE}${path}`, { headers }),
      TURN14_API_TIMEOUT,
      `turn14 GET ${path}`
    );
    return res.data;
  } catch (err) {
    if (err.response?.status === 401 && !retried) {
      return apiGet(path, true);
    }
    throw err;
  }
}

// ── Public API ──────────────────────────────────────────

export async function checkInventory(productId) {
  const data = await apiGet(`/inventory/${productId}`);
  // data.data is an array with one item containing warehouse stock objects
  const inv = data?.data?.[0]?.attributes?.inventory || {};

  // sum all warehouse stocks
  let total = 0;
  for (const warehouse of Object.values(inv)) {
    total += Number(warehouse?.stock ?? 0);
  }
  return { supplier: "turn14", productId, stock: total };
}

export async function getPrice(productId) {
  const data = await apiGet(`/items/${productId}`);
  const pricing = data?.data?.[0]?.attributes?.pricing || {};
  const cost = Number(pricing.turn14cost ?? 0);
  return { supplier: "turn14", productId, cost };
}

export async function check(productId) {
  const [inv, price] = await Promise.all([
    checkInventory(productId),
    getPrice(productId),
  ]);
  return {
    supplier: "turn14",
    stock: inv.stock,
    cost: price.cost,
  };
}

export async function liveCheck(productId) {
  try {
    const result = await check(productId);
    return { status: "ok", stock: result.stock, cost: result.cost };
  } catch (err) {
    return { status: "error", error: err.message };
  }
}

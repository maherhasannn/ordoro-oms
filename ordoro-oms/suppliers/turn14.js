import axios from "axios";
import { withTimeout } from "../lib/timeout.js";
import { rateLimit } from "../lib/rateLimit.js";
import { getTurn14ById, getTurn14ByMpn } from "../db.js";

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

  // sum all warehouse stocks — handle both { stock: N } and plain N shapes
  let total = 0;
  for (const wh of Object.values(inv)) {
    const val = typeof wh === "object" && wh !== null ? wh.stock : wh;
    total += Number(val ?? 0);
  }
  return { supplier: "turn14", productId, stock: total };
}

export async function getPrice(productId) {
  const data = await apiGet(`/pricing/${productId}`);
  const attrs = data?.data?.attributes || {};
  const cost = Number(attrs.purchase_cost ?? 0);
  return { supplier: "turn14", productId, cost };
}

export async function check(productId) {
  await rateLimit("turn14");
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

export async function checkByMpn(mpn, mappedProductId = null) {
  // 1. Try cached data first
  let row = null;
  if (mappedProductId) row = await getTurn14ById(mappedProductId);
  if (!row) row = await getTurn14ByMpn(mpn);
  if (row) {
    return {
      supplier: "turn14",
      stock: row.stock,
      cost: Number(row.cost) || 0,
      supplierId: row.product_id,
      cachedAt: row.updated_at || null,
    };
  }

  // 2. No cache — fall back to live API if we have a mapped product ID
  if (mappedProductId) {
    try {
      const result = await check(mappedProductId);
      return {
        supplier: "turn14",
        stock: result.stock,
        cost: result.cost,
        supplierId: mappedProductId,
        cachedAt: null,
      };
    } catch (err) {
      console.error(`  [turn14] live fallback failed for product ${mappedProductId}: ${err.message}`);
    }
  }

  return { supplier: "turn14", stock: 0, cost: 0, supplierId: null, cachedAt: null };
}

export async function liveCheck(productId) {
  try {
    const result = await check(productId);
    return { status: "ok", stock: result.stock, cost: result.cost };
  } catch (err) {
    return { status: "error", error: err.message };
  }
}

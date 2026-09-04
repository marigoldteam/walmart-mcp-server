import express from "express";
import axios from "axios";
import { randomUUID } from "crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const REQUIRED_ENV = ["WALMART_CLIENT_ID", "WALMART_CLIENT_SECRET", "MCP_API_KEY"];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing required env vars: ${missing.join(", ")}`);
  process.exit(1);
}

const BASE_URL = "https://marketplace.walmartapis.com/v3";
const SVC_NAME = "Walmart Marketplace";

// --- OAuth token cache (module-scope: persists across requests in this process) ---
let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 30_000) {
    return cachedToken; // reuse until ~30s before expiry
  }
  const basicAuth = Buffer.from(
    `${process.env.WALMART_CLIENT_ID}:${process.env.WALMART_CLIENT_SECRET}`
  ).toString("base64");

  const { data } = await axios.post(
    `${BASE_URL}/token`,
    "grant_type=client_credentials",
    {
      headers: {
        Authorization: `Basic ${basicAuth}`,
        "WM_SVC.NAME": SVC_NAME,
        "WM_QOS.CORRELATION_ID": randomUUID(),
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      timeout: 15000,
    }
  );
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in || 900) * 1000; // Walmart tokens run ~15 min
  return cachedToken;
}

async function walmartGet(path, params) {
  const token = await getAccessToken();
  const { data } = await axios.get(`${BASE_URL}${path}`, {
    params,
    headers: {
      "WM_SEC.ACCESS_TOKEN": token,
      "WM_SVC.NAME": SVC_NAME,
      "WM_QOS.CORRELATION_ID": randomUUID(),
      Accept: "application/json",
    },
    timeout: 20000,
  });
  return data;
}

// Pull every page of orders in a date range via cursor pagination, for ONE
// shipNodeType. Walmart's /orders endpoint does not return all fulfillment
// channels by default - it must be told which one via shipNodeType, or WFS
// orders are silently omitted entirely (this was the root cause of WFS SKUs,
// including top sellers, never showing up in query_sales_by_sku/list_orders).
async function fetchOrdersForShipNodeType(date_from, date_to, shipNodeType) {
  let orders = [];
  let nextCursor = null;
  let page = 0;
  while (true) {
    const params = nextCursor
      ? { nextCursor }
      : {
          createdStartDate: date_from,
          createdEndDate: date_to,
          limit: 200,
          productInfo: false,
          shipNodeType,
        };
    const data = await walmartGet("/orders", params);
    const els = data?.list?.elements?.order || [];
    orders = orders.concat(els);
    nextCursor = data?.list?.meta?.nextCursor;
    page++;
    if (!nextCursor || els.length === 0 || page > 20) break; // safety cap: 20 pages
  }
  return orders;
}

// Fetch orders across BOTH fulfillment channels and merge. Dedup by
// purchaseOrderId defensively, in case Walmart ever double-reports an order
// under both channel queries.
async function fetchAllOrders(date_from, date_to) {
  const [sellerFulfilled, wfsFulfilled] = await Promise.all([
    fetchOrdersForShipNodeType(date_from, date_to, "SellerFulfilled"),
    fetchOrdersForShipNodeType(date_from, date_to, "WFSFulfilled"),
  ]);
  const byPoId = new Map();
  for (const o of [...sellerFulfilled, ...wfsFulfilled]) {
    byPoId.set(o?.purchaseOrderId, o);
  }
  return Array.from(byPoId.values());
}

function lineRevenue(orderLine) {
  const charges = orderLine?.charges?.charge || [];
  return charges
    .filter((c) => c.chargeType === "PRODUCT")
    .reduce((sum, c) => sum + parseFloat(c.chargeAmount?.amount || 0), 0);
}

function lineQuantity(orderLine) {
  return parseInt(orderLine?.orderLineQuantity?.amount || 0, 10);
}

// Walmart returns orderDate as epoch millis; fall back to the raw value
// if it's ever a plain date string instead.
function formatOrderDate(rawDate) {
  if (!rawDate) return null;
  const asNumber = Number(rawDate);
  return !isNaN(asNumber) ? new Date(asNumber).toISOString() : rawDate;
}

function buildServer() {
  const server = new McpServer({ name: "walmart-mcp", version: "1.0.0" });

  server.registerTool(
    "get_orders_summary",
    {
      title: "Get Walmart orders summary",
      description: "Order count, total revenue, and total units for a date range.",
      inputSchema: {
        date_from: z.string().describe("Start date, YYYY-MM-DD"),
        date_to: z.string().describe("End date, YYYY-MM-DD"),
      },
    },
    async ({ date_from, date_to }) => {
      const orders = await fetchAllOrders(date_from, date_to);
      let revenue = 0;
      let units = 0;
      for (const o of orders) {
        const lines = o?.orderLines?.orderLine || [];
        for (const li of lines) {
          revenue += lineRevenue(li);
          units += lineQuantity(li);
        }
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                channel: "walmart",
                date_from,
                date_to,
                order_count: orders.length,
                revenue: Number(revenue.toFixed(2)),
                units,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.registerTool(
    "get_product_catalog",
    {
      title: "Get Walmart product catalog",
      description:
        "List items with SKU, price, and published status. Optional SKU filter. (Live stock quantity requires the separate Inventory API - not included here.)",
      inputSchema: {
        sku: z.string().optional().describe("Filter to a single SKU"),
        per_page: z.number().optional().describe("Max results, default 50, max 200"),
      },
    },
    async ({ sku, per_page }) => {
      const data = await walmartGet("/items", {
        sku,
        limit: Math.min(per_page || 50, 200),
      });
      // Walmart's Items API returns the array under the capitalized key
      // "ItemResponse". Fall back to the lowercase form just in case, but
      // ItemResponse is the correct key - this was the source of the bug
      // where the catalog tool always returned an empty list.
      const items = (data.ItemResponse || data.itemResponse || []).map((it) => ({
        sku: it.sku,
        name: it.productName,
        price: it.price?.amount,
        currency: it.price?.currency,
        published_status: it.publishedStatus,
        lifecycle_status: it.lifecycleStatus,
      }));
      return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
    }
  );

  server.registerTool(
    "query_sales_by_sku",
    {
      title: "Query Walmart sales by SKU",
      description:
        "Revenue and units sold per SKU across all orders in a date range, sorted by revenue descending.",
      inputSchema: {
        date_from: z.string().describe("Start date, YYYY-MM-DD"),
        date_to: z.string().describe("End date, YYYY-MM-DD"),
      },
    },
    async ({ date_from, date_to }) => {
      const orders = await fetchAllOrders(date_from, date_to);
      const bySku = {};
      // Diagnostic: any order line where Walmart didn't give us a usable
      // item.sku gets bucketed under "unknown-sku" below so no revenue is
      // silently dropped, but we also capture the raw line here so the
      // actual cause (missing SKU, different field, malformed item, etc.)
      // is visible instead of the order just disappearing from the report.
      const missingSkuLines = [];
      for (const o of orders) {
        const lines = o?.orderLines?.orderLine || [];
        for (const li of lines) {
          const rawSku = li?.item?.sku;
          const key = rawSku || "unknown-sku";
          if (!rawSku) {
            const detail = {
              purchaseOrderId: o?.purchaseOrderId,
              customerOrderId: o?.customerOrderId,
              orderLineNumber: li?.lineNumber,
              rawItem: li?.item ?? null,
              rawOrderLine: li,
            };
            missingSkuLines.push(detail);
            console.warn(
              "[query_sales_by_sku] order line missing item.sku:",
              JSON.stringify(detail)
            );
          }
          if (!bySku[key]) {
            bySku[key] = { sku: key, name: li?.item?.productName, units: 0, revenue: 0 };
          }
          bySku[key].units += lineQuantity(li);
          bySku[key].revenue += lineRevenue(li);
        }
      }
      const rows = Object.values(bySku)
        .map((r) => ({ ...r, revenue: Number(r.revenue.toFixed(2)) }))
        .sort((a, b) => b.revenue - a.revenue);
      const response = { channel: "walmart", date_from, date_to, rows };
      // Only included when something was actually missing, so normal
      // responses stay clean.
      if (missingSkuLines.length) {
        response.missing_sku_order_lines = missingSkuLines;
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(response, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool(
    "get_token_details",
    {
      title: "Get Walmart API access levels",
      description:
        "Shows which Walmart Marketplace API categories (Orders, Items, Reports, etc.) these credentials are approved for, and at what access level (e.g. view_only, full_access, no_access). Check this before building anything on top of an API category (like Reports) to confirm access is actually granted, rather than discovering a 'no_access' failure later.",
      inputSchema: {},
    },
    async () => {
      const data = await walmartGet("/token/detail", {});
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "list_orders",
    {
      title: "List individual Walmart orders",
      description:
        "List individual orders in a date range, with order ID, order date, and line-item detail (SKU, item name, quantity, revenue) - unlike query_sales_by_sku, this is not aggregated, so it's useful for looking up a specific sale rather than a total. Optional sku filter narrows results to orders containing that item.",
      inputSchema: {
        date_from: z.string().describe("Start date, YYYY-MM-DD"),
        date_to: z.string().describe("End date, YYYY-MM-DD"),
        sku: z.string().optional().describe("Only return orders containing this SKU"),
        limit: z
          .number()
          .optional()
          .describe("Max orders to return, most recent first. Default 50, max 500."),
      },
    },
    async ({ date_from, date_to, sku, limit }) => {
      const orders = await fetchAllOrders(date_from, date_to);
      const cap = Math.min(limit || 50, 500);

      let results = orders.map((o) => {
        const lines = o?.orderLines?.orderLine || [];
        const items = lines.map((li) => ({
          line_number: li?.lineNumber,
          sku: li?.item?.sku || null,
          name: li?.item?.productName || null,
          quantity: lineQuantity(li),
          revenue: Number(lineRevenue(li).toFixed(2)),
        }));
        return {
          purchase_order_id: o?.purchaseOrderId,
          customer_order_id: o?.customerOrderId,
          order_date: formatOrderDate(o?.orderDate),
          items,
        };
      });

      if (sku) {
        results = results
          .filter((o) => o.items.some((it) => it.sku === sku))
          .map((o) => ({ ...o, items: o.items.filter((it) => it.sku === sku) }));
      }

      // Most recent first
      results.sort((a, b) => (b.order_date || "").localeCompare(a.order_date || ""));

      const total_matching = results.length;
      results = results.slice(0, cap);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                channel: "walmart",
                date_from,
                date_to,
                sku_filter: sku || null,
                total_matching_orders: total_matching,
                orders_returned: results.length,
                truncated: total_matching > results.length,
                orders: results,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  return server;
}

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  if (req.path === "/") return next(); // health check unauthenticated
  const key = req.headers["x-api-key"];
  if (key !== process.env.MCP_API_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

app.get("/", (req, res) => res.send("Walmart MCP server is running"));

app.post("/mcp", async (req, res) => {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err?.response?.data || err.message || err);
    if (!res.headersSent) res.status(500).json({ error: "internal_error" });
  }
});

app.get("/mcp", (req, res) => res.status(405).set("Allow", "POST").json({ error: "method_not_allowed" }));
app.delete("/mcp", (req, res) => res.status(405).set("Allow", "POST").json({ error: "method_not_allowed" }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`walmart-mcp-server listening on port ${port}`));

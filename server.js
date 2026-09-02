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

// Pull every page of orders in a date range via cursor pagination
async function fetchAllOrders(date_from, date_to) {
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

function lineRevenue(orderLine) {
  const charges = orderLine?.charges?.charge || [];
  return charges
    .filter((c) => c.chargeType === "PRODUCT")
    .reduce((sum, c) => sum + parseFloat(c.chargeAmount?.amount || 0), 0);
}

function lineQuantity(orderLine) {
  return parseInt(orderLine?.orderLineQuantity?.amount || 0, 10);
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
      const items = (data.itemResponse || []).map((it) => ({
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
      for (const o of orders) {
        const lines = o?.orderLines?.orderLine || [];
        for (const li of lines) {
          const key = li?.item?.sku || "unknown-sku";
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
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ channel: "walmart", date_from, date_to, rows }, null, 2),
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

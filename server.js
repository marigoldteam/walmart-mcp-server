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

# Supplier Integration Reference

## Overview

This document covers the API/integration details for three auto parts suppliers: **Turn14 Distribution**, **eKeystone (Keystone Automotive / LKQ)**, and **Meyer Distributing**. The OMS polls Ordoro for new orders, checks inventory and pricing across all three, selects the best deal where stock is available, places the order via API or SFTP, and emails on errors.

---

## Turn14 Distribution

**Protocol:** REST API (JSON)
**Auth:** OAuth 2.0 client credentials — token expires every 60 min, renew at ~45 min
**Base URLs:**
- Production: `https://api.turn14.com/v1/`
- Sandbox: `https://apitest.turn14.com/v1/`

### Authentication

- `POST /v1/token` with `client_id` and `client_secret` (JSON body)
- Returns a Bearer token valid for ~3600 seconds
- Do NOT request a new token per call — cache it and renew every 40-50 min
- NPM helper: [`turn14-api-auth`](https://www.npmjs.com/package/turn14-api-auth)

### How to Get Credentials

1. Log in to your Turn14 dealer account
2. Navigate to **Settings & Data > API** tab
3. Submit request — approved by your sales rep within ~24 hours
4. Client ID and Client Secret appear on the same page once approved

### Rate Limits

| Limit                    | Value   |
|--------------------------|---------|
| GET requests per second  | 5       |
| Token requests per minute| 10      |
| GET requests per hour    | 5,000   |
| GET requests per day     | 30,000  |

Exceeding limits returns HTTP **429**.
Contact: `apisupport@turn14.com`

### Endpoints

| Endpoint                        | Method | Purpose                                                  |
|---------------------------------|--------|----------------------------------------------------------|
| `/v1/token`                     | POST   | Obtain OAuth bearer token                                |
| `/v1/items`                     | GET    | Product catalog (titles, descriptions, specs, UPC, MPN)  |
| `/v1/brands`                    | GET    | List of all available brands/manufacturers               |
| `/v1/inventory/{productId}`     | GET    | Inventory for a specific product (per-warehouse)         |
| `/v1/inventory/updates`         | GET    | Incremental inventory updates (`minutes` parameter)      |
| `/v1/quote`                     | GET    | Request a shipping quote                                 |
| `/v1/order/from_quote`          | POST   | Create an order from a quote using `quote_id`            |
| `/v1/tracking/package_details`  | GET    | Shipment/tracking details                                |

### Inventory

- `GET /v1/inventory/{productId}` — single product, per-warehouse breakdown
- `GET /v1/inventory/updates?minutes=N` — incremental updates, supports pagination
- Full import: no more than once per 24 hours
- Incremental: safe to run hourly

**Warehouses (4 DCs):**

| Warehouse | Location          | API Field       |
|-----------|-------------------|-----------------|
| 01        | Hatfield, PA      | `turn14stockpa` |
| 02        | Arlington, TX     | `turn14stocktx` |
| NV        | Reno, NV          | `turn14stocknv` |
| IN        | Indianapolis, IN  | `turn14stockin` |

### Pricing

Returned with product data. Fields:

| Field                  | Description                     |
|------------------------|---------------------------------|
| `turn14cost`           | Dealer/wholesale cost           |
| `turn14map`            | Minimum Advertised Price        |
| `turn14retail`         | Retail/MSRP                     |
| `turn14jobber`         | Jobber price                    |
| `turn14suggestedretail`| Suggested retail                |
| `turn14corecharge`     | Core charge                     |
| `turn14canpurchase`    | Boolean: can you purchase this  |

### Order Placement (Quote-to-Order Flow)

**Step 1: Create a Quote**
```
GET /v1/quote
```
Payload includes: PO number, line items (`item_identifier`, `quantity`), shipping config, recipient address, Prop 65 acknowledgment.

Response: `quote_id`, available shipping methods per segment (orders may split across warehouses).

**Step 2: Create Order from Quote**
```
POST /v1/order/from_quote
```
Payload: `quote_id`, `po_number`, `shipping_id` (selected method), Prop 65/EPA acknowledgments.

Response: `order_id` (confirmation).

**Order splitting:** Turn14 auto-splits across shipping origins based on warehouse stock and drop-ship eligibility.

### Tracking

```
GET /v1/tracking/package_details
```
Must poll — no webhooks. Third-party platforms poll hourly.

### Sandbox / Test Environment

1. Build integration using `https://apitest.turn14.com/v1/`
2. Submit a test order
3. Email `apisupport@turn14.com` with customer name and PO number
4. Turn14 verifies and enables production access

### SFTP

No public SFTP documentation. API-first model. Contact `support@turn14.com` to ask.

### Support

| Resource              | Contact                                      |
|-----------------------|----------------------------------------------|
| API Support Email     | `apisupport@turn14.com`                      |
| API Support Portal    | `apisupport.turn14.com` (Freshdesk)          |
| General Support       | `support@turn14.com`                         |
| API Release Notes     | `t14api.releasenotes.io`                     |

---

## eKeystone (Keystone Automotive / LKQ)

**Protocol:** SOAP Web Service (`.asmx`)
**Endpoint:** `https://order.ekeystone.com/WSElectronicOrder/ElectronicOrder.asmx`
**WSDL:** `https://order.ekeystone.com/WSElectronicOrder/ElectronicOrder.asmx?WSDL`
**Auth:** API key + 5-7 character account number in SOAP body. Public IP must be whitelisted.

### Authentication

Two key types:
- **Storefront Web Services Key** — standard access (orders, inventory, pricing)
- **Drop Ship Web Services Key** — for drop-ship methods specifically

Additional requirements:
- Account number required with every call
- Server public IP must be whitelisted by Keystone

### API Methods (26 total)

#### Inventory Methods

| Method                       | Description                                              | Rate Limit         |
|------------------------------|----------------------------------------------------------|--------------------|
| `CheckInventory`             | Single part, returns per-warehouse counts                | None specified     |
| `CheckInventoryBulk`         | Multiple parts (comma-separated VCPNs), returns XML      | None specified     |
| `GetInventoryFull`           | Complete inventory for ALL stocking items                 | Once per day       |
| `GetInventoryQuantityFull`   | Aggregated total quantity for all items                   | Once per day       |
| `GetInventoryUpdates`        | Incremental changes by warehouse since last call          | Every 15 minutes   |
| `GetInventoryQuantityUpdates`| Incremental total quantity changes                        | Every 15 minutes   |

**Warehouses (8+):** EAST (Exeter, PA), MIDWEST (Kansas City, KS), CALIFORNIA (Eastvale, CA), SOUTHEAST (Atlanta, GA), TEXAS, GREATLAKES, PACIFICNORTHWEST, FLORIDA

#### Pricing Methods

| Method           | Description                                           | Limit              |
|------------------|-------------------------------------------------------|---------------------|
| `CheckPriceBulk` | Returns `CustomerPrice` per VCPN. Max 10 parts/call. | 10 parts per call   |

#### Order Placement Methods

| Method                             | Description                                                                                  |
|------------------------------------|----------------------------------------------------------------------------------------------|
| `ShipOrder`                        | Single-item order, ships to account address                                                  |
| `ShipOrderDropShip`                | Single-item order with custom ship-to address                                                |
| `ShipOrderDropShipMultipleParts`   | Multi-item drop-ship orders, up to 250 line items. Format: `VCPN,Qty\|VCPN,Qty`             |
| `SubmitOrder`                      | Creates and places special orders with multiple items                                        |

**OrderProcessMethod values:**
- `0` = Verify only (validates without placing)
- `1` = Complete order (fails entirely if any part is rejected)

**Order response:** Status table ("OK", "Verified", "Error") + PartResults table (per-part status, `X` = rejected).

#### Shipping Methods

| Method                                        | Description                                    |
|-----------------------------------------------|------------------------------------------------|
| `GetShippingOptions`                          | Shipping options for a single part             |
| `GetShippingOptionsMultipleParts`             | Shipping options for multiple parts            |
| `GetShippingOptionsMultiplePartsPerWarehouse` | Per-warehouse breakdown                        |

Input format: `SearchType,PartNumber,Quantity` pipe-separated. SearchTypes: `N`=NTP, `U`=UPC, `K`=VCPN.

#### Order History / Tracking

| Method                          | Description                                                          |
|---------------------------------|----------------------------------------------------------------------|
| `GetOrderHistory`               | Order history with tracking. Date range max 120 days. Format: YYYYMMDD |
| `GetOrderHistoryByParentAccount`| History across child accounts                                        |

**GetOrderHistory output fields:** EKORD# (order number), EKPART (part), EKXQTY (quantity), EKEXTD (extended price), EKSWHS (ship warehouse), EKSVIA (ship method), EKTRCK (tracking number), EKSTAT (status), EKINV# (invoice number).

#### Other Methods

| Method                   | Description                              |
|--------------------------|------------------------------------------|
| `GetImagePartInformation`| Product image URLs (max 10 parts/call)   |
| `GetKitComponents`       | Kit part components and quantities       |

### SOAP Request Example

```xml
<?xml version="1.0" encoding="utf-8"?>
<soap12:Envelope
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
  xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">
  <soap12:Body>
    <CheckInventoryBulk xmlns="http://eKeystone.com">
      <Key>YOUR_API_KEY</Key>
      <FullAccountNo>YOUR_ACCT</FullAccountNo>
      <FullPartNo>K33332206,G12100</FullPartNo>
    </CheckInventoryBulk>
  </soap12:Body>
</soap12:Envelope>
```

### FTPS Data Feed

| Detail              | Value                                  |
|---------------------|----------------------------------------|
| Host                | `ftp.ekeystone.com`                    |
| Port                | 990 (implicit FTPS)                    |
| Credentials         | Separate from API key, request from rep|
| IP whitelisting     | Required                               |
| File generation     | Up to 3 business days after setup      |

**Feed fields:** guid, keystonesku (VCPN), upc, vendorname, title, longdescription, jobberprice, cost, corecharge, fedexable, uspsable, upsable, caseqty, hazardousmaterial, prop65toxicity, boxweight, boxheight, boxlength, boxwidth

### Part Number Format

**VCPN** = Vendor Line Code + Part Number (e.g., `K33332206`, `G12100`).
- Multiple parts comma-separated in bulk methods
- Multi-part orders pipe-separated: `VCPN,Quantity|VCPN,Quantity`

### EDI Support

| EDI Code | Document                           |
|----------|------------------------------------|
| 850      | Purchase Order                     |
| 855      | Purchase Order Acknowledgment      |
| 856      | Advance Ship Notice                |
| 810      | Invoice                            |
| 997      | Functional Acknowledgment          |

Protocols: AS2 (HTTP/S based), VAN connections.

### Dev Portal

`https://sdkportal.ekeystone.com` — gated, must request access from rep.

### Getting Started

1. Complete new customer application on Keystone's website
2. Contact eCommerce New Business Manager: Kurt Kincel (`kjkincel@key-stone.com`)
3. Request API keys (Storefront and/or Drop Ship)
4. Request FTPS credentials separately
5. Provide public IP for whitelisting
6. Request SDK Portal access

---

## Meyer Distributing

**Protocol:** Private REST API (not publicly documented) + FTP/SFTP for data feeds
**Auth:** API key + VendorID + CustomerNumber — all provided privately by Meyer rep
**No public developer portal or documentation.**

### API Configuration Parameters

| Parameter                              | Type             | Description                        |
|----------------------------------------|------------------|------------------------------------|
| `MeyerDistributing_APIKey`             | string (required)| Your API key                       |
| `MeyerDistributing_BaseURL`            | string (required)| Root address of the API server     |
| `MeyerDistributing_CreateOrderURL`     | string (required)| Endpoint to submit new orders      |
| `MeyerDistributing_TrackingURL`        | string (required)| Endpoint to retrieve tracking      |
| `MeyerDistributing_OrderDetailURL`     | string (optional)| Endpoint for order details         |
| `MeyerDistributing_VendorID`           | integer (required)| Your vendor identifier            |
| `MeyerDistributing_CustomerNumber`     | string (required)| Your customer number              |
| `MeyerDistributing_UpdateShippingCost` | boolean          | Whether to fetch shipping cost     |

Actual endpoint URLs are provided privately by Meyer.

### Inventory (FTP/SFTP Only)

Inventory is **not** available via API. It comes from an FTP/SFTP feed.

- **Feed file:** `Meyer Pricing.csv`
- **Update frequency:** Hourly at :30
- **Feed type:** Full feed only (no deltas)
- **Match key:** UPC code

**Feed fields:**

| Field                 | Description                    |
|-----------------------|--------------------------------|
| `meyersku`            | Meyer part number              |
| `meyerstock`          | Inventory quantity available   |
| `meyercost`           | Dealer cost                    |
| `meyermap`            | Minimum Advertised Price       |
| `meyerltleligible`    | LTL shipping eligibility       |
| `meyeroversize`       | Oversize designation           |
| `meyeraddtlhandling`  | Additional handling charges    |

### Pricing (FTP/SFTP Only)

Same CSV feed as inventory:
- `meyercost` — dealer cost, updated every 3 hours at :00
- `meyermap` — MAP pricing

### Order Placement (API)

- Endpoint: private `CreateOrderURL`
- Product identifier: `VendorSKU`
- Response: returns order number (stored as `OrderSourceOrderID`)
- Orders >= $500: auto-require signature unless "Meyer Choice" shipping enabled
- Processing frequency: every 5 minutes (per third-party platforms)

### Order Tracking (API)

- Endpoint: private `TrackingURL`
- Returns: tracking numbers, estimated delivery, shipping methods
- Partial shipments supported
- Shipping cost optionally retrieved via `OrderDetailURL`
- Update frequency: hourly at :45

### Shipping Methods

1. **Will Call** — local pickup
2. **UPS-type shipments** — standard parcel
3. **Meyer Truck Delivery** — via Meyer Logistics (own fleet, 500+ trucks)
4. **Meyer Choice** — Meyer selects most cost-effective method

### FTP/SFTP Credentials

Separate from API credentials. Request from Meyer rep:
- FTP Host
- FTP Username / Password
- FTP Port (21 for FTP, 22 for SFTP)
- FTP Path
- FTP Type (FTP or SFTP)

### Drop Shipping Test Requirement

1. Create a test order with a Meyer product
2. Set order item vendor to `"meyer"`
3. Confirm with `eorders.mailbox@meyerdistributing.com`
4. Once approved, automated drop shipping is enabled

### Getting Started

1. Become a Meyer Distributing dealer
2. Request API credentials from your rep (API key, base URL, endpoint URLs, vendor ID, customer number)
3. Request FTP/SFTP credentials for inventory/pricing feeds
4. Complete the drop shipping test
5. Contact: `eorders.mailbox@meyerdistributing.com` / `800.731.3407`

---

## OMS Architecture: End-to-End Flow

### 1. Poll for New Orders

Existing `sync.js` polls Ordoro every 15 seconds. New orders are upserted to Supabase.

### 2. Check Inventory Across All Suppliers

For each line item, look up the part by UPC or manufacturer part number:

| Supplier  | Lookup Method                      | Match Key                                          |
|-----------|------------------------------------|----------------------------------------------------|
| Turn14    | `GET /v1/inventory/{productId}`    | Turn14 product ID (mapped via MPN/UPC from catalog) |
| eKeystone | `CheckInventoryBulk` (SOAP)        | VCPN (vendor line code + part number)              |
| Meyer     | Query local DB (from FTP CSV)       | Meyer SKU (matched by UPC)                         |

**Requires a product mapping table** in Supabase: maps each product to supplier-specific identifiers.

### 3. Compare Pricing Where Stock is Available

| Supplier  | Cost Field                                |
|-----------|-------------------------------------------|
| Turn14    | `turn14cost`                              |
| eKeystone | `CustomerPrice` from `CheckPriceBulk`     |
| Meyer     | `meyercost` from CSV feed (cached locally)|

Filter to suppliers with `stock > 0`, pick lowest cost. Optionally factor in shipping (Turn14 quote endpoint, eKeystone `GetShippingOptions`).

### 4. Place Order with Winning Supplier

| Supplier  | Method                                                      |
|-----------|-------------------------------------------------------------|
| Turn14    | `GET /v1/quote` → `POST /v1/order/from_quote`              |
| eKeystone | `ShipOrderDropShipMultipleParts` (SOAP, up to 250 items)    |
| Meyer     | `POST` to private `CreateOrderURL`                          |

All three support drop-shipping direct to end customer.

### 5. Error Handling with Email Notifications

On failure at any step (inventory check, pricing lookup, order placement, tracking), send email with:
- Order number (from Ordoro)
- Which supplier was attempted
- Error message/code
- Affected line items

Use **Nodemailer** (Gmail/SMTP), **SendGrid**, or **Resend**.

### 6. Polling Schedule Summary

| Task                        | Turn14          | eKeystone        | Meyer          |
|-----------------------------|-----------------|------------------|----------------|
| Inventory sync (full)       | 1x/day          | 1x/day           | Hourly at :30 (FTP) |
| Inventory sync (incremental)| Hourly           | Every 15 min     | N/A (full only)|
| Pricing sync                | 2x/day           | On demand (API)  | Every 3 hrs (FTP) |
| Order placement             | Real-time (API)  | Real-time (SOAP) | Every 5 min (API) |
| Tracking updates            | Hourly (poll)    | Hourly (poll)    | Hourly at :45 (API) |

---

## Architecture Comparison

| Concern              | Turn14        | eKeystone      | Meyer              |
|----------------------|---------------|----------------|---------------------|
| Protocol             | REST/JSON     | SOAP/XML       | REST (private) + FTP|
| Real-time inventory  | Yes (API)     | Yes (API)      | No (FTP hourly)     |
| Real-time pricing    | Yes (API)     | Yes (API)      | No (FTP every 3hr)  |
| Order placement      | API           | API (SOAP)     | API                 |
| Webhooks             | No            | No             | No                  |
| Sandbox              | Yes           | Verify-only    | No                  |
| SFTP/FTP feeds       | Not confirmed | FTPS available | Required for inventory |

**Key risk:** Meyer inventory is up to 1 hour stale. Handle out-of-stock errors gracefully when placing Meyer orders.

---

## Prerequisites Before Building

1. Must be an **approved dealer** with all three suppliers
2. **Turn14:** Get API access via dealer portal → `client_id`/`client_secret` → test order → email `apisupport@turn14.com`
3. **eKeystone:** Contact rep → API key + account number → whitelist server IP → request SDK portal access at `sdkportal.ekeystone.com`
4. **Meyer:** Contact rep → API key, base URL, endpoint URLs, VendorID, CustomerNumber → FTP credentials → drop-ship test with `eorders.mailbox@meyerdistributing.com`
5. **Product mapping:** One-time catalog sync from each supplier to build cross-reference table (UPC → Turn14 ID / eKeystone VCPN / Meyer SKU)

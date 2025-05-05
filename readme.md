# Alloy Automation QuickBooks Desktop Adapter

This is an on-premise Quickbooks Desktop (Node.js SOAP + REST) adapter that integrates QuickBooks Desktop with external systems (like Alloy) using the QuickBooks Web Connector (QBWC).  It pulls data from QuickBooks, normalizes it, and sends it as webhook POSTs to a configured API (such as Alloy Embedded).

### Features

Supports polling QuickBooks entities:

  - Invoices
  - Bills
  - Customers
  - Vendors
  - Payments (including voided payments)
  - Credit Memos
  - Estimates
  - Purchase Orders
  - Deposits
  - Journal Entries

Normalizes and transforms data into clean JSON. It also sends webhook POSTs to an external system (Alloy).

## Setup

#### Install dependencies

`npm install`

#### Prepare .env

Create a .env file:

```bash
WEBHOOK_URL=https://webhooks.runalloy.com/quickbooks-deskop/<userId>

DEAD_LETTER_DIR=dead_letters
```

#### Run the Adapter
`node server.js`

#### Import .qwc files into QuickBooks Web Connector

Use the provided .qwc files or generate them for each entity:

  

invoices.qwc
payments.qwc
bills.qwc
customers.qwc
vendors.qwc
creditmemos.qwc
estimates.qwc
purchaseorders.qwc
deposits.qwc
journalentries.qwc

**Ensure the AppURL in .qwc points to:** http://localhost:3000/soap

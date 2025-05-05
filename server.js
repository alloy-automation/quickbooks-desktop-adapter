require("dotenv").config();
const express = require("express");
const soap = require("strong-soap").soap;
const fs = require("fs");
const path = require("path");
const xml2js = require("xml2js");
const auth = require("basic-auth");
const axios = require("axios");
const _ = require("lodash");

const app = express();
const port = 3000;
const wsdl = fs.readFileSync("qbws.wsdl", "utf8");
const parser = new xml2js.Parser();

const WEBHOOK_URL = process.env.WEBHOOK_URL;
const DEAD_LETTER_DIR = process.env.DEAD_LETTER_DIR || "dead_letters";

const folders = [
  "invoices",
  "bills",
  "customers",
  "vendors",
  "payments",
  "creditmemos",
  "estimates",
  "purchaseorders",
  "deposits",
  "journalentries",
];

folders.forEach((folder) => {
  const dir = path.join(__dirname, "./", folder);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

if (!fs.existsSync(DEAD_LETTER_DIR))
  fs.mkdirSync(DEAD_LETTER_DIR, { recursive: true });


let requestTypes = [
  "InvoiceQueryRq",
  "BillQueryRq",
  "CustomerQueryRq",
  "VendorQueryRq",
  "PaymentQueryRq",
  "CreditMemoQueryRq",
  "EstimateQueryRq",
  "PurchaseOrderQueryRq",
  "DepositQueryRq",
  "JournalEntryQueryRq",
];
let currentRequestIndex = 0;

function getNextRequestXML() {
  const type = requestTypes[currentRequestIndex];
  currentRequestIndex = (currentRequestIndex + 1) % requestTypes.length;
  return `
      <?xml version="1.0"?>
      <?qbxml version="13.0"?>
      <QBXML>
        <QBXMLMsgsRq onError="stopOnError">
          <${type}>
            <MaxReturned>20</MaxReturned>
            <IncludeRetElement>TimeCreated</IncludeRetElement>
            <IncludeRetElement>TimeModified</IncludeRetElement>
          </${type}>
        </QBXMLMsgsRq>
      </QBXML>`;
}

async function sendWebhook(eventType, payload) {
  try {
    const headers = {
      "Content-Type": "application/json",
      "X-Adapter-Event": eventType,
    };
    if (!WEBHOOK_URL) {
      console.warn(
        `⚠️ WEBHOOK_URL is not set — skipping webhook send for ${eventType}`
      );
      return;
    }
    const response = await axios.post(WEBHOOK_URL, payload, { headers });
    console.log(`✅ Webhook sent: ${eventType} → ${response.status}`);
  } catch (err) {
    console.error(`❌ Failed webhook for ${eventType}:`, err.message);
    const deadLetter = {
      eventType,
      payload,
      error: err.message,
      timestamp: new Date().toISOString(),
    };
    const fileName = `${eventType.replace(".", "_")}_${Date.now()}.json`;
    const filePath = path.join(DEAD_LETTER_DIR, fileName);
    try {
      fs.writeFileSync(filePath, JSON.stringify(deadLetter, null, 2));
      console.warn(`⚠️ Dead-letter saved: ${filePath}`);
    } catch (fileErr) {
      console.error(`❌ Failed to save dead-letter:`, fileErr.message);
    }
  }
}

const service = {
  QBWebConnectorSvc: {
    QBWebConnectorSvcSoap: {
      serverVersion() {
        return { serverVersionResult: "1.0" };
      },
      clientVersion() {
        return { clientVersionResult: "1.0" };
      },
      authenticate() {
        console.log("Authenticating SOAP call...");
        return { authenticateResult: [USERNAME, ""] };
      },
      sendRequestXML() {
        console.log("Sending QB request...");
        const qbXML = getNextRequestXML();
        return { sendRequestXMLResult: qbXML };
      },
      receiveResponseXML(args) {
        console.log("Received QB response...");
        const rawXML = args.response;
        parser.parseString(rawXML, async (err, result) => {
          if (err) return console.error("XML parse error:", err);

          let folder = "invoices";
          let queryPath = "InvoiceQueryRs.InvoiceRet";
          let eventType = "invoice_updated";

          const mappings = [
            {
              key: "InvoiceQueryRs",
              folder: "invoices",
              path: "InvoiceQueryRs.InvoiceRet",
              event: "invoice_updated",
            },
            {
              key: "BillQueryRs",
              folder: "bills",
              path: "BillQueryRs.BillRet",
              event: "bill_updated",
            },
            {
              key: "CustomerQueryRs",
              folder: "customers",
              path: "CustomerQueryRs.CustomerRet",
              event: "customer_updated",
            },
            {
              key: "VendorQueryRs",
              folder: "vendors",
              path: "VendorQueryRs.VendorRet",
              event: "vendor_updated",
            },
            {
              key: "PaymentQueryRs",
              folder: "payments",
              path: "PaymentQueryRs.PaymentRet",
              event: "payment_updated",
            },
            {
              key: "CreditMemoQueryRs",
              folder: "creditmemos",
              path: "CreditMemoQueryRs.CreditMemoRet",
              event: "credit_memo_updated",
            },
            {
              key: "EstimateQueryRs",
              folder: "estimates",
              path: "EstimateQueryRs.EstimateRet",
              event: "estimate_updated",
            },
            {
              key: "PurchaseOrderQueryRs",
              folder: "purchaseorders",
              path: "PurchaseOrderQueryRs.PurchaseOrderRet",
              event: "purchase_order_updated",
            },
            {
              key: "DepositQueryRs",
              folder: "deposits",
              path: "DepositQueryRs.DepositRet",
              event: "deposit_updated",
            },
            {
              key: "JournalEntryQueryRs",
              folder: "journalentries",
              path: "JournalEntryQueryRs.JournalEntryRet",
              event: "journal_entry_updated",
            },
          ];

          mappings.forEach((m) => {
            if (result.QBXML.QBXMLMsgsRs[m.key]) {
              folder = m.folder;
              queryPath = m.path;
              eventType = m.event;
            }
          });

          const dirPath = path.join(__dirname, "./", folder);
          const fileName = `${folder}_${Date.now()}.json`;
          const filePath = path.join(dirPath, fileName);
          fs.writeFileSync(filePath, JSON.stringify(result, null, 2));

          try {
            const items = _.get(result.QBXML.QBXMLMsgsRs, queryPath, []);
            let normalized = [];

            if (folder === "invoices") {
              normalized = items.map((i) => ({
                invoice_id: _.get(i, "RefNumber[0]", ""),
                customer: _.get(i, "CustomerRef[0].FullName[0]", ""),
                balance_remaining: _.get(i, "BalanceRemaining[0]", ""),
                is_paid: _.get(i, "IsPaid[0]", "false") === "true",
                created_at: _.get(i, "TimeCreated[0]", ""),
                updated_at: _.get(i, "TimeModified[0]", ""),
              }));
            } else if (folder === "payments") {
              normalized = items.map((i) => ({
                payment_id: _.get(i, "TxnID[0]", ""),
                customer: _.get(i, "CustomerRef[0].FullName[0]", ""),
                amount: _.get(i, "TotalAmount[0]", ""),
                is_voided: _.get(i, "IsVoided[0]", "false") === "true",
                created_at: _.get(i, "TimeCreated[0]", ""),
                updated_at: _.get(i, "TimeModified[0]", ""),
              }));
              const voided = normalized.filter((p) => p.is_voided);
              if (voided.length > 0)
                await sendWebhook("payment_voided", voided);
            } else if (folder === "bills") {
              normalized = items.map((i) => ({
                bill_id: _.get(i, "TxnID[0]", ""),
                vendor: _.get(i, "VendorRef[0].FullName[0]", ""),
                amount: _.get(i, "AmountDue[0]", ""),
                created_at: _.get(i, "TimeCreated[0]", ""),
                updated_at: _.get(i, "TimeModified[0]", ""),
              }));
            } else if (folder === "customers") {
              normalized = items.map((i) => ({
                customer_id: _.get(i, "ListID[0]", ""),
                name: _.get(i, "Name[0]", ""),
                company_name: _.get(i, "CompanyName[0]", ""),
                email: _.get(i, "Email[0]", ""),
                created_at: _.get(i, "TimeCreated[0]", ""),
                updated_at: _.get(i, "TimeModified[0]", ""),
              }));
            } else if (folder === "vendors") {
              normalized = items.map((i) => ({
                vendor_id: _.get(i, "ListID[0]", ""),
                name: _.get(i, "Name[0]", ""),
                company_name: _.get(i, "CompanyName[0]", ""),
                email: _.get(i, "Email[0]", ""),
                created_at: _.get(i, "TimeCreated[0]", ""),
                updated_at: _.get(i, "TimeModified[0]", ""),
              }));
            } else if (folder === "creditmemos") {
              normalized = items.map((i) => ({
                credit_memo_id: _.get(i, "TxnID[0]", ""),
                customer: _.get(i, "CustomerRef[0].FullName[0]", ""),
                amount: _.get(i, "TotalAmount[0]", ""),
                created_at: _.get(i, "TimeCreated[0]", ""),
                updated_at: _.get(i, "TimeModified[0]", ""),
              }));
            } else if (folder === "estimates") {
              normalized = items.map((i) => ({
                estimate_id: _.get(i, "TxnID[0]", ""),
                customer: _.get(i, "CustomerRef[0].FullName[0]", ""),
                amount: _.get(i, "TotalAmount[0]", ""),
                created_at: _.get(i, "TimeCreated[0]", ""),
                updated_at: _.get(i, "TimeModified[0]", ""),
              }));
            } else if (folder === "purchaseorders") {
              normalized = items.map((i) => ({
                purchase_order_id: _.get(i, "TxnID[0]", ""),
                vendor: _.get(i, "VendorRef[0].FullName[0]", ""),
                amount: _.get(i, "TotalAmount[0]", ""),
                created_at: _.get(i, "TimeCreated[0]", ""),
                updated_at: _.get(i, "TimeModified[0]", ""),
              }));
            } else if (folder === "deposits") {
              normalized = items.map((i) => ({
                deposit_id: _.get(i, "TxnID[0]", ""),
                account: _.get(i, "DepositToAccountRef[0].FullName[0]", ""),
                amount: _.get(i, "TotalAmount[0]", ""),
                created_at: _.get(i, "TimeCreated[0]", ""),
                updated_at: _.get(i, "TimeModified[0]", ""),
              }));
            } else if (folder === "journalentries") {
              normalized = items.map((i) => ({
                journal_entry_id: _.get(i, "TxnID[0]", ""),
                memo: _.get(i, "Memo[0]", ""),
                total_amount: _.get(i, "TotalAmount[0]", ""),
                created_at: _.get(i, "TimeCreated[0]", ""),
                updated_at: _.get(i, "TimeModified[0]", ""),
              }));
            }

            if (normalized.length > 0) {
              await sendWebhook(eventType, normalized);
            }
          } catch (err) {
            console.error(`Webhook normalization error:`, err.message);
          }
        });

        return { receiveResponseXMLResult: 100 };
      },
      closeConnection() {
        console.log("Closing connection...");
        return { closeConnectionResult: "OK" };
      },
    },
  },
};

app.use(express.json());

// Start server
const soapServer = app.listen(port, () => {
  console.log(`REST API running on port ${port}`);
  const soapService = soap.listen(soapServer, "/soap", service, wsdl);
  console.log("SOAP service mounted at /soap");
});

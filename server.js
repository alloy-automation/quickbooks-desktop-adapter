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
const port = 9999;
const wsdl = fs.readFileSync("qbws.wsdl", "utf8");
const parser = new xml2js.Parser();

const WEBHOOK_URL = process.env.WEBHOOK_URL;
const DEAD_LETTER_DIR = process.env.DEAD_LETTER_DIR || "dead_letters";

const { initQueue, addToQueue, popFromQueue } = require("./queue");

const USERNAME = process.env.BASIC_AUTH_USER || "admin";
const PASSWORD = process.env.BASIC_AUTH_PASS || "changeme";

function basicAuth(req, res, next) {
  const user = auth(req);
  if (user && user.name === USERNAME && user.pass === PASSWORD) {
    return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="QuickBooks Adapter"');
  res.status(401).send("Authentication required");
}

initQueue();

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
        let qbXML = popFromQueue();
        if (!qbXML) {
          qbXML = getNextRequestXML();
        }
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

function buildAddRequestXML(entity, data) {
  switch (entity) {
    case "invoices":
      return `
          <?xml version="1.0"?>
          <?qbxml version="13.0"?>
          <QBXML>
            <QBXMLMsgsRq onError="stopOnError">
              <InvoiceAddRq>
                <InvoiceAdd>
                  <CustomerRef>
                    <FullName>${data.customer}</FullName>
                  </CustomerRef>
                  <TxnDate>${data.date}</TxnDate>
                  <RefNumber>${data.refNumber}</RefNumber>
                  <InvoiceLineAdd>
                    <ItemRef>
                      <FullName>${data.item}</FullName>
                    </ItemRef>
                    <Amount>${data.amount}</Amount>
                  </InvoiceLineAdd>
                </InvoiceAdd>
              </InvoiceAddRq>
            </QBXMLMsgsRq>
          </QBXML>`;

    case "bills":
      return `
          <?xml version="1.0"?>
          <?qbxml version="13.0"?>
          <QBXML>
            <QBXMLMsgsRq onError="stopOnError">
              <BillAddRq>
                <BillAdd>
                  <VendorRef>
                    <FullName>${data.vendor}</FullName>
                  </VendorRef>
                  <TxnDate>${data.date}</TxnDate>
                  <RefNumber>${data.refNumber}</RefNumber>
                  <ExpenseLineAdd>
                    <AccountRef>
                      <FullName>${data.account}</FullName>
                    </AccountRef>
                    <Amount>${data.amount}</Amount>
                  </ExpenseLineAdd>
                </BillAdd>
              </BillAddRq>
            </QBXMLMsgsRq>
          </QBXML>`;

    case "customers":
      return `
          <?xml version="1.0"?>
          <?qbxml version="13.0"?>
          <QBXML>
            <QBXMLMsgsRq onError="stopOnError">
              <CustomerAddRq>
                <CustomerAdd>
                  <Name>${data.name}</Name>
                  <CompanyName>${data.companyName}</CompanyName>
                  <Email>${data.email}</Email>
                </CustomerAdd>
              </CustomerAddRq>
            </QBXMLMsgsRq>
          </QBXML>`;

    case "vendors":
      return `
          <?xml version="1.0"?>
          <?qbxml version="13.0"?>
          <QBXML>
            <QBXMLMsgsRq onError="stopOnError">
              <VendorAddRq>
                <VendorAdd>
                  <Name>${data.name}</Name>
                  <CompanyName>${data.companyName}</CompanyName>
                  <Email>${data.email}</Email>
                </VendorAdd>
              </VendorAddRq>
            </QBXMLMsgsRq>
          </QBXML>`;

    case "payments":
      return `
          <?xml version="1.0"?>
          <?qbxml version="13.0"?>
          <QBXML>
            <QBXMLMsgsRq onError="stopOnError">
              <ReceivePaymentAddRq>
                <ReceivePaymentAdd>
                  <CustomerRef>
                    <FullName>${data.customer}</FullName>
                  </CustomerRef>
                  <TotalAmount>${data.amount}</TotalAmount>
                  <TxnDate>${data.date}</TxnDate>
                </ReceivePaymentAdd>
              </ReceivePaymentAddRq>
            </QBXMLMsgsRq>
          </QBXML>`;

    case "creditmemos":
      return `
          <?xml version="1.0"?>
          <?qbxml version="13.0"?>
          <QBXML>
            <QBXMLMsgsRq onError="stopOnError">
              <CreditMemoAddRq>
                <CreditMemoAdd>
                  <CustomerRef>
                    <FullName>${data.customer}</FullName>
                  </CustomerRef>
                  <TxnDate>${data.date}</TxnDate>
                  <CreditMemoLineAdd>
                    <ItemRef>
                      <FullName>${data.item}</FullName>
                    </ItemRef>
                    <Amount>${data.amount}</Amount>
                  </CreditMemoLineAdd>
                </CreditMemoAdd>
              </CreditMemoAddRq>
            </QBXMLMsgsRq>
          </QBXML>`;

    case "estimates":
      return `
          <?xml version="1.0"?>
          <?qbxml version="13.0"?>
          <QBXML>
            <QBXMLMsgsRq onError="stopOnError">
              <EstimateAddRq>
                <EstimateAdd>
                  <CustomerRef>
                    <FullName>${data.customer}</FullName>
                  </CustomerRef>
                  <TxnDate>${data.date}</TxnDate>
                  <EstimateLineAdd>
                    <ItemRef>
                      <FullName>${data.item}</FullName>
                    </ItemRef>
                    <Amount>${data.amount}</Amount>
                  </EstimateLineAdd>
                </EstimateAdd>
              </EstimateAddRq>
            </QBXMLMsgsRq>
          </QBXML>`;

    case "purchaseorders":
      return `
          <?xml version="1.0"?>
          <?qbxml version="13.0"?>
          <QBXML>
            <QBXMLMsgsRq onError="stopOnError">
              <PurchaseOrderAddRq>
                <PurchaseOrderAdd>
                  <VendorRef>
                    <FullName>${data.vendor}</FullName>
                  </VendorRef>
                  <TxnDate>${data.date}</TxnDate>
                  <PurchaseOrderLineAdd>
                    <ItemRef>
                      <FullName>${data.item}</FullName>
                    </ItemRef>
                    <Amount>${data.amount}</Amount>
                  </PurchaseOrderLineAdd>
                </PurchaseOrderAdd>
              </PurchaseOrderAddRq>
            </QBXMLMsgsRq>
          </QBXML>`;

    case "deposits":
      return `
          <?xml version="1.0"?>
          <?qbxml version="13.0"?>
          <QBXML>
            <QBXMLMsgsRq onError="stopOnError">
              <DepositAddRq>
                <DepositAdd>
                  <DepositToAccountRef>
                    <FullName>${data.account}</FullName>
                  </DepositToAccountRef>
                  <TxnDate>${data.date}</TxnDate>
                  <DepositLineAdd>
                    <AccountRef>
                      <FullName>${data.fromAccount}</FullName>
                    </AccountRef>
                    <Amount>${data.amount}</Amount>
                  </DepositLineAdd>
                </DepositAdd>
              </DepositAddRq>
            </QBXMLMsgsRq>
          </QBXML>`;

    case "journalentries":
      return `
          <?xml version="1.0"?>
          <?qbxml version="13.0"?>
          <QBXML>
            <QBXMLMsgsRq onError="stopOnError">
              <JournalEntryAddRq>
                <JournalEntryAdd>
                  <TxnDate>${data.date}</TxnDate>
                  <JournalDebitLine>
                    <AccountRef>
                      <FullName>${data.debitAccount}</FullName>
                    </AccountRef>
                    <Amount>${data.amount}</Amount>
                  </JournalDebitLine>
                  <JournalCreditLine>
                    <AccountRef>
                      <FullName>${data.creditAccount}</FullName>
                    </AccountRef>
                    <Amount>${data.amount}</Amount>
                  </JournalCreditLine>
                </JournalEntryAdd>
              </JournalEntryAddRq>
            </QBXMLMsgsRq>
          </QBXML>`;

    default:
      return null;
  }
}

function buildDeleteRequestXML(entity, id) {
  const txnEntities = [
    "invoices",
    "bills",
    "payments",
    "creditmemos",
    "estimates",
    "purchaseorders",
    "deposits",
    "journalentries",
  ];
  const listEntities = ["customers", "vendors"];

  if (txnEntities.includes(entity)) {
    return `
        <?xml version="1.0"?>
        <?qbxml version="13.0"?>
        <QBXML>
          <QBXMLMsgsRq onError="stopOnError">
            <TxnDelRq>
              <TxnDelType>${entity.replace("s", "")}</TxnDelType>
              <TxnID>${id}</TxnID>
            </TxnDelRq>
          </QBXMLMsgsRq>
        </QBXML>`;
  }

  if (listEntities.includes(entity)) {
    return `
        <?xml version="1.0"?>
        <?qbxml version="13.0"?>
        <QBXML>
          <QBXMLMsgsRq onError="stopOnError">
            <ListDelRq>
              <ListDelType>${entity.replace("s", "")}</ListDelType>
              <ListID>${id}</ListID>
            </ListDelRq>
          </QBXMLMsgsRq>
        </QBXML>`;
  }

  return null;
}

app.use(express.json());

app.get('/api/:entity/:id', basicAuth, (req, res) => {
    const entity = req.params.entity;
    const id = req.params.id;
  
    // Map entity → query request + ID type
    const entityMap = {
      invoices: { query: 'InvoiceQueryRq', idType: 'TxnID' },
      bills: { query: 'BillQueryRq', idType: 'TxnID' },
      payments: { query: 'PaymentQueryRq', idType: 'TxnID' },
      creditmemos: { query: 'CreditMemoQueryRq', idType: 'TxnID' },
      estimates: { query: 'EstimateQueryRq', idType: 'TxnID' },
      purchaseorders: { query: 'PurchaseOrderQueryRq', idType: 'TxnID' },
      deposits: { query: 'DepositQueryRq', idType: 'TxnID' },
      journalentries: { query: 'JournalEntryQueryRq', idType: 'TxnID' },
      customers: { query: 'CustomerQueryRq', idType: 'ListID' },
      vendors: { query: 'VendorQueryRq', idType: 'ListID' }
    };
  
    const config = entityMap[entity];
    if (!config) {
      return res.status(400).send('Unsupported entity');
    }
  
    const qbxml = `
      <?xml version="1.0"?>
      <?qbxml version="13.0"?>
      <QBXML>
        <QBXMLMsgsRq onError="stopOnError">
          <${config.query}>
            <${config.idType}>${id}</${config.idType}>
          </${config.query}>
        </QBXMLMsgsRq>
      </QBXML>`;
  
    addToQueue(qbxml);
    res.send({ success: true, message: `${entity} ${id} query queued` });
  });

  
app.post("/api/sync/:entity", basicAuth, (req, res) => {
  const entity = req.params.entity;
  const supported = requestTypes.map((r) => r.replace("QueryRq", "s"));
  if (!supported.includes(entity)) {
    return res.status(400).send("Unsupported entity");
  }
  const type = entity.slice(0, -1) + "QueryRq";
  const qbxml = `
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
  addToQueue(qbxml);
  res.send({ success: true, message: `${entity} sync queued` });
});

// CREATE (POST)
app.post("/api/:entity", basicAuth, async (req, res) => {
  const entity = req.params.entity;
  const data = req.body;

  const qbxml = buildAddRequestXML(entity, data);
  console.log(qbxml)
  if (!qbxml) return res.status(400).send("Unsupported entity");

  addToQueue(qbxml); // Add to processing queue
  res.send({ success: true, message: `${entity} queued for creation` });
});

// READ (GET)
app.get("/api/:entity/latest", basicAuth, (req, res) => {
  const entity = req.params.entity;
  const folder = folders.find((f) => f === entity);
  if (!folder) return res.status(404).send("Entity not supported");

  const dir = path.join(__dirname, "./", folder);
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  if (files.length === 0) return res.status(404).send("No data found");

  const latestFile = path.join(dir, files[files.length - 1]);
  const data = fs.readFileSync(latestFile, "utf8");
  res.send(JSON.parse(data));
});

// DELETE
app.delete("/api/:entity/:id", basicAuth, async (req, res) => {
  const entity = req.params.entity;
  const id = req.params.id;

  const qbxml = buildDeleteRequestXML(entity, id);
  if (!qbxml) return res.status(400).send("Unsupported entity");

  addToQueue(qbxml);
  res.send({ success: true, message: `${entity} ${id} queued for deletion` });
});

// Start server
const soapServer = app.listen(port, () => {
  console.log(`REST API running on port ${port}`);
  const soapService = soap.listen(soapServer, "/soap", service, wsdl);
  console.log("SOAP service mounted at /soap");
});

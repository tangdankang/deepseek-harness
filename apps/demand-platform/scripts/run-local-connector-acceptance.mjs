import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { connectorAcceptanceMarkdown, runConnectorAcceptance } from "../src/conformance/connector-acceptance.mjs";

function option(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function body(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch (error) { reject(error); }
    });
    req.on("error", reject);
  });
}

function reply(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function startSandbox(secret) {
  const tickets = new Map();
  let sequence = 0;
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${secret}`) return reply(res, 401, { error: "unauthorized" });
    if (req.method === "POST" && req.url === "/api/v1/tickets") {
      const payload = await body(req);
      const key = String(req.headers["idempotency-key"] ?? "");
      const fingerprint = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
      const existing = tickets.get(key);
      if (existing && existing.fingerprint !== fingerprint) return reply(res, 409, { error: "idempotency_conflict" });
      if (existing) return reply(res, 200, existing.response);
      sequence += 1;
      const ticketNo = `SANDBOX-${String(sequence).padStart(6, "0")}`;
      const response = { data: { ticket_no: ticketNo, status: "OPEN", ticket_url: `http://127.0.0.1/tickets/${ticketNo}` } };
      tickets.set(key, { fingerprint, response });
      return reply(res, 201, response);
    }
    if (req.method === "GET" && /^\/api\/v1\/tickets\/[^/]+$/.test(req.url)) {
      const ticketNo = decodeURIComponent(req.url.split("/").at(-1));
      return reply(res, 200, { data: { ticket_no: ticketNo, status: "WORKING", ticket_url: `http://127.0.0.1/tickets/${ticketNo}` } });
    }
    return reply(res, 404, { error: "not_found" });
  });
  return { server, tickets };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address());
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function writeNew(target, content) {
  const resolved = path.resolve(target);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, content, { encoding: "utf8", flag: "wx" });
}

const fixturePath = path.resolve(option("--fixture", "config/connector-acceptance-fixture.example.json"));
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
const secret = `local-only-${crypto.randomBytes(24).toString("hex")}`;
const sandbox = startSandbox(secret);
let report;
try {
  const address = await listen(sandbox.server);
  const configuration = {
    version: 1,
    connectors: [{
      type: "http-json",
      systemCode: fixture.systemCode,
      baseUrl: `http://127.0.0.1:${address.port}`,
      allowInsecureHttp: true,
      timeoutMs: 3000,
      maxResponseBytes: 65536,
      auth: { type: "bearer-env", envVar: "LOCAL_CONNECTOR_ACCEPTANCE_TOKEN" },
      createTicket: {
        path: "/api/v1/tickets",
        method: "POST",
        idempotencyHeader: "Idempotency-Key",
        headers: { "X-Client-System": "AI_DEMAND_PLATFORM" },
        services: {
          [fixture.validRequest.case.serviceCode]: {
            requestMapping: {
              global_request_no: "case.globalRequestNo",
              service_code: "case.serviceCode",
              "requester.employee_id": "requester.employeeId",
              "requester.department_id": "requester.departmentId",
              "payload.customer_no": "fields.customerCode",
              "payload.current_owner_employee_id": "fields.currentOwnerEmployeeId",
              "payload.new_owner_employee_id": "fields.newOwnerEmployeeId",
              "payload.reason": "fields.reason",
              "payload.effective_date": "fields.effectiveDate",
            },
          },
        },
        responseMapping: { ticketNo: "data.ticket_no", rawStatus: "data.status", ticketUrl: "data.ticket_url" },
      },
      getTicket: {
        pathTemplate: "/api/v1/tickets/{ticketNo}",
        method: "GET",
        headers: { "X-Client-System": "AI_DEMAND_PLATFORM" },
        responseMapping: { ticketNo: "data.ticket_no", rawStatus: "data.status", ticketUrl: "data.ticket_url" },
      },
      statusMapping: {
        OPEN: "SUBMITTED",
        WORKING: "IN_PROGRESS",
        NEED_INFO: "WAITING_USER",
        RESOLVED: "RESOLVED",
        CLOSED: "CLOSED",
        REJECTED: "REJECTED",
      },
      unknownStatus: "IN_PROGRESS",
    }],
  };
  report = await runConnectorAcceptance({
    configuration,
    fixture,
    env: { LOCAL_CONNECTOR_ACCEPTANCE_TOKEN: secret },
    allowWrite: true,
    productionMode: false,
  });
} finally {
  await close(sandbox.server);
}

const outputJson = option("--output-json");
const outputMarkdown = option("--output-markdown");
if (outputJson) writeNew(outputJson, `${JSON.stringify(report, null, 2)}\n`);
if (outputMarkdown) writeNew(outputMarkdown, connectorAcceptanceMarkdown(report));
console.log(JSON.stringify(report, null, 2));
if (report.outcome !== "PASS") process.exitCode = 1;

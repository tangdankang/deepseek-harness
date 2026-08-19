export class BaseConnector {
  constructor(systemCode) {
    this.systemCode = systemCode;
  }

  capabilities() {
    return { validate: true, createTicket: true, getTicket: false, addComment: false, cancelTicket: false, statusWebhook: true };
  }

  validate() {
    return { valid: true, errors: [] };
  }

  async createTicket() {
    throw new Error("createTicket尚未实现");
  }

  mapStatus(rawStatus) {
    const mapping = {
      OPEN: "SUBMITTED",
      ACCEPTED: "SUBMITTED",
      WORKING: "IN_PROGRESS",
      NEED_INFO: "WAITING_USER",
      RESOLVED: "RESOLVED",
      CLOSED: "CLOSED",
    };
    return mapping[rawStatus] ?? "IN_PROGRESS";
  }
}

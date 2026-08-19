import crypto from "node:crypto";

function ratio(numerator, denominator) {
  return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : 0;
}

function grouped(rows, key, count = "count") {
  return Object.fromEntries(rows.map((row) => [row[key], Number(row[count])]));
}

export class AnalyticsService {
  constructor({ db, hashSecret }) {
    this.db = db;
    this.hashSecret = hashSecret;
  }

  recordInteraction(employee, request, response, traceId = null) {
    const message = String(request.message ?? "");
    const employeeHash = crypto.createHmac("sha256", this.hashSecret).update(employee.employeeId).digest("hex");
    const messageHash = crypto.createHash("sha256").update(message).digest("hex");
    const services = (response.services ?? []).map((service) => service.serviceCode);
    this.db.prepare(`
      INSERT INTO assistant_interactions
      (interaction_id, employee_hash, department_id, conversation_id, response_type, message_hash,
       message_length, citations_count, suggested_services_json, trace_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(), employeeHash, employee.departmentId, response.conversationId ?? request.conversationId ?? null,
      response.type ?? "UNKNOWN", messageHash, message.length, (response.citations ?? []).length,
      JSON.stringify(services), traceId, new Date().toISOString(),
    );
  }

  metrics({ days = 7 } = {}) {
    const normalizedDays = Math.max(1, Math.min(365, Number(days) || 7));
    const since = new Date(Date.now() - normalizedDays * 86400000).toISOString();
    const interactionRows = this.db.prepare("SELECT response_type, COUNT(*) AS count FROM assistant_interactions WHERE created_at >= ? GROUP BY response_type").all(since);
    const interactionTypes = grouped(interactionRows, "response_type");
    const interactions = Object.values(interactionTypes).reduce((sum, value) => sum + value, 0);
    const uniqueEmployees = Number(this.db.prepare("SELECT COUNT(DISTINCT employee_hash) AS count FROM assistant_interactions WHERE created_at >= ?").get(since).count);
    const caseStatuses = grouped(this.db.prepare("SELECT status, COUNT(*) AS count FROM demand_cases WHERE created_at >= ? GROUP BY status").all(since), "status");
    const caseServices = grouped(this.db.prepare("SELECT service_code, COUNT(*) AS count FROM demand_cases WHERE created_at >= ? GROUP BY service_code").all(since), "service_code");
    const cases = Object.values(caseStatuses).reduce((sum, value) => sum + value, 0);
    const externalTickets = Number(this.db.prepare("SELECT COUNT(*) AS count FROM external_tickets WHERE created_at >= ?").get(since).count);
    const handoffStatuses = grouped(this.db.prepare("SELECT status, COUNT(*) AS count FROM handoff_items WHERE created_at >= ? GROUP BY status").all(since), "status");
    const handoffs = Object.values(handoffStatuses).reduce((sum, value) => sum + value, 0);
    const integrationStatuses = grouped(this.db.prepare("SELECT status, COUNT(*) AS count FROM integration_tasks WHERE created_at >= ? GROUP BY status").all(since), "status");
    const integrationTasks = Object.values(integrationStatuses).reduce((sum, value) => sum + value, 0);
    const feedbackSummary = this.db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN resolved = 1 THEN 1 ELSE 0 END) AS resolved_count,
        COUNT(rating) AS rating_count,
        AVG(rating) AS average_rating,
        SUM(CASE WHEN rating >= 4 THEN 1 ELSE 0 END) AS positive_rating_count
      FROM employee_feedback WHERE created_at >= ?
    `).get(since);
    const feedbackBySubject = grouped(this.db.prepare("SELECT subject_type, COUNT(*) AS count FROM employee_feedback WHERE created_at >= ? GROUP BY subject_type").all(since), "subject_type");
    const feedbackReasons = {};
    for (const row of this.db.prepare("SELECT reason_codes_json FROM employee_feedback WHERE created_at >= ?").all(since)) {
      for (const reason of JSON.parse(row.reason_codes_json)) feedbackReasons[reason] = (feedbackReasons[reason] ?? 0) + 1;
    }
    const feedbackTotal = Number(feedbackSummary.total ?? 0);
    const conversationFeedback = Number(feedbackBySubject.CONVERSATION ?? 0);
    const resolvedCount = Number(feedbackSummary.resolved_count ?? 0);
    const ratingCount = Number(feedbackSummary.rating_count ?? 0);
    const positiveRatingCount = Number(feedbackSummary.positive_rating_count ?? 0);
    const conversations = Number(this.db.prepare("SELECT COUNT(DISTINCT conversation_id) AS count FROM assistant_interactions WHERE created_at >= ? AND conversation_id IS NOT NULL").get(since).count);
    const integrationSucceeded = integrationStatuses.SUCCEEDED ?? 0;
    const integrationTerminal = integrationSucceeded + (integrationStatuses.DEAD ?? 0);
    const answers = interactionTypes.ANSWER ?? 0;
    const suggestions = interactionTypes.SERVICE_SUGGESTIONS ?? 0;
    const handoffSuggested = interactionTypes.HANDOFF_SUGGESTED ?? 0;
    return {
      window: { days: normalizedDays, since, generatedAt: new Date().toISOString() },
      interactions: { total: interactions, uniqueEmployees, byType: interactionTypes },
      demands: { total: cases, byStatus: caseStatuses, byService: caseServices, externalTickets },
      handoffs: { total: handoffs, byStatus: handoffStatuses },
      integrations: { total: integrationTasks, byStatus: integrationStatuses },
      feedback: {
        total: feedbackTotal,
        resolvedCount,
        ratingCount,
        averageRating: feedbackSummary.average_rating === null ? null : Number(Number(feedbackSummary.average_rating).toFixed(2)),
        positiveRatingCount,
        bySubjectType: feedbackBySubject,
        byReasonCode: feedbackReasons,
      },
      indicators: {
        answerRate: ratio(answers, interactions),
        serviceSuggestionRate: ratio(suggestions, interactions),
        handoffSuggestionRate: ratio(handoffSuggested, interactions),
        demandCreationRate: ratio(cases, interactions),
        externalTicketRate: ratio(externalTickets, cases),
        confirmedHandoffRate: ratio(handoffs, handoffSuggested),
        feedbackResponseRate: ratio(conversationFeedback, conversations),
        employeeConfirmedResolutionRate: ratio(resolvedCount, feedbackTotal),
        positiveRatingRate: ratio(positiveRatingCount, ratingCount),
        integrationTerminalSuccessRate: ratio(integrationSucceeded, integrationTerminal),
      },
      privacy: { rawMessagesStoredInAnalytics: false, employeeIdentifiersPseudonymized: true, freeTextFeedbackStored: false },
    };
  }
}

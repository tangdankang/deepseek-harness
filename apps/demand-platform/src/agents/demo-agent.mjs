import crypto from "node:crypto";

export class DemoAgent {
  constructor({ knowledge, catalog, demands, handoffs }) {
    this.knowledge = knowledge;
    this.catalog = catalog;
    this.demands = demands;
    this.handoffs = handoffs;
  }

  respond(employee, { message, conversationId = null }) {
    const text = String(message ?? "").trim();
    const nextConversationId = conversationId || crypto.randomUUID();
    if (!text) return { conversationId: nextConversationId, type: "CLARIFY", message: "请描述你遇到的问题或需要办理的事项。" };

    const requestNo = text.match(/REQ-\d{8}-\d{6}/)?.[0];
    if (requestNo && /(进度|状态|怎么样|处理到哪|查询)/.test(text)) {
      const demandCase = this.demands.getOwned(employee, requestNo);
      return {
        conversationId: nextConversationId,
        type: "STATUS",
        message: `需求 ${requestNo} 当前状态为 ${demandCase.status}。`,
        case: demandCase,
      };
    }

    const handoffNo = text.match(/HOF-\d{8}-\d{6}/)?.[0];
    if (handoffNo && /(进度|状态|怎么样|处理到哪|查询)/.test(text)) {
      const handoff = this.handoffs.getOwned(employee, handoffNo);
      return {
        conversationId: nextConversationId,
        type: "HANDOFF_STATUS",
        message: `转人工事项 ${handoffNo} 当前状态为 ${handoff.status}。`,
        handoff,
      };
    }

    const knowledge = this.knowledge.search(text, employee);
    if (knowledge) {
      return {
        conversationId: nextConversationId,
        type: "ANSWER",
        message: knowledge.answer,
        citations: knowledge.citations,
        resolvedPrompt: "以上信息是否解决了你的问题？如果仍需办理，我可以继续帮你整理需求。",
      };
    }

    const suggestions = this.catalog.search(text, employee).slice(0, 3);
    if (suggestions.length > 0) {
      return {
        conversationId: nextConversationId,
        type: "SERVICE_SUGGESTIONS",
        message: "我找到以下可能相关的服务。请选择最符合的一项，我会按要求收集信息并生成提交预览。",
        services: suggestions,
      };
    }

    return {
      conversationId: nextConversationId,
      type: "HANDOFF_SUGGESTED",
      message: "当前知识和服务目录中没有找到可靠答案。请补充涉及的系统、期望结果、影响范围和报错信息；仍无法判断时应转人工受理，我不会编造答案。",
    };
  }
}

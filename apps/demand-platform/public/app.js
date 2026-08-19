const identityHeaders = {
  "X-Employee-Id": "E10001",
  "X-Department-Id": "D-ORG",
  "X-Employee-Name": encodeURIComponent("演示员工"),
};

let services = [];
let activeService = null;
let activeSchema = null;
let activeConfirmation = null;
let activeDraft = null;
let activeGuided = false;
let conversationId = null;
let sessionAuth = false;
let csrfToken = null;
let authReady;

const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" }[char]));

async function api(path, options = {}) {
  await authReady;
  const method = String(options.method ?? "GET").toUpperCase();
  const authHeaders = sessionAuth
    ? (!["GET", "HEAD", "OPTIONS"].includes(method) ? { "X-CSRF-Token": csrfToken } : {})
    : identityHeaders;
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers: { ...authHeaders, ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers ?? {}) },
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message ?? "请求失败");
  return payload;
}

async function initializeIdentity() {
  const response = await fetch("/api/v1/auth/me", { credentials: "same-origin", headers: { accept: "application/json" } });
  if (response.status === 401) return;
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message ?? "会话检查失败");
  sessionAuth = true;
  csrfToken = payload.csrfToken;
  const title = document.querySelector(".identity strong");
  const detail = document.querySelector(".identity small");
  if (title) title.textContent = payload.employee.name || payload.employee.employeeId;
  if (detail) detail.textContent = `${payload.employee.employeeId} · ${payload.employee.departmentId}`;
}

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.remove("hidden");
  setTimeout(() => element.classList.add("hidden"), 3200);
}

function addMessage(role, message, citations = []) {
  const article = document.createElement("article");
  article.className = `message ${role}`;
  article.innerHTML = `<div class="bubble">${escapeHtml(message).replaceAll("\n", "<br>")}${citations.map((c) => `<a class="citation" href="${escapeHtml(c.url)}" target="_blank" rel="noreferrer">来源：${escapeHtml(c.title)}</a>`).join("")}</div>`;
  $("#messages").appendChild(article);
  $("#messages").scrollTop = $("#messages").scrollHeight;
  return article;
}

function addHandoffAction(article, originalMessage) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ghost message-action";
  button.textContent = "确认转人工受理";
  const idempotencyKey = `handoff-${crypto.randomUUID()}`;
  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = "正在创建……";
    try {
      const result = await api("/api/v1/handoffs", {
        method: "POST",
        body: JSON.stringify({
          employeeConfirmed: true,
          originalMessage,
          summary: `员工提出目录外事项：${originalMessage}`.slice(0, 1000),
          reasonCode: "NO_MATCH",
          conversationId,
          idempotencyKey,
        }),
      });
      button.textContent = "已转人工";
      addMessage("assistant", `已创建人工受理事项：${result.handoff.handoffNo}。你可以直接询问该编号的处理进度。`);
      await loadCases();
    } catch (error) {
      button.disabled = false;
      button.textContent = "重试转人工";
      toast(error.message);
    }
  });
  article.querySelector(".bubble").appendChild(button);
}

function addFeedbackAction(article, subjectId) {
  const host = document.createElement("div");
  host.className = "feedback-action";
  host.innerHTML = `<span>这次回答解决了吗？</span><select aria-label="满意度"><option value="5">5分</option><option value="4">4分</option><option value="3">3分</option><option value="2">2分</option><option value="1">1分</option></select><button type="button" class="ghost" data-resolved="true">已解决</button><button type="button" class="ghost" data-resolved="false">未解决</button>`;
  const idempotencyKey = `feedback-${crypto.randomUUID()}`;
  host.querySelectorAll("button").forEach((button) => button.addEventListener("click", async () => {
    host.querySelectorAll("button").forEach((item) => { item.disabled = true; });
    const resolved = button.dataset.resolved === "true";
    try {
      await api("/api/v1/feedback", {
        method: "POST",
        body: JSON.stringify({
          employeeConfirmed: true,
          subjectType: "CONVERSATION",
          subjectId,
          resolved,
          rating: Number(host.querySelector("select").value),
          reasonCodes: [resolved ? "ANSWER_HELPFUL" : "MISSING_INFORMATION"],
          idempotencyKey,
        }),
      });
      host.textContent = "感谢反馈，已用于改进服务。";
    } catch (error) {
      host.querySelectorAll("button").forEach((item) => { item.disabled = false; });
      toast(error.message);
    }
  }));
  article.querySelector(".bubble").appendChild(host);
}

function renderServices(items = services) {
  const host = $("#service-list");
  host.innerHTML = items.length ? items.map((service) => `
    <article class="service-card" data-code="${escapeHtml(service.serviceCode)}" role="button" tabindex="0" aria-label="办理${escapeHtml(service.serviceName)}">
      <h3>${escapeHtml(service.serviceName)}</h3>
      <p>${escapeHtml(service.description)}</p>
      <div class="tags"><span class="tag">${escapeHtml(service.targetSystem)}</span><span class="tag">风险 ${escapeHtml(service.riskLevel)}</span></div>
    </article>`).join("") : `<p class="muted">未找到匹配的服务</p>`;
  host.querySelectorAll(".service-card").forEach((card) => {
    const activate = () => openService(card.dataset.code).catch((error) => toast(error.message));
    card.addEventListener("click", activate);
    card.addEventListener("keydown", (event) => {
      if (!["Enter", " "].includes(event.key)) return;
      event.preventDefault();
      activate();
    });
  });
}

async function loadServices() {
  const result = await api("/api/v1/services");
  services = result.services;
  renderServices();
}

async function openService(code) {
  const result = await api(`/api/v1/services/${encodeURIComponent(code)}/schema`);
  activeService = result.service;
  activeSchema = result.schema;
  activeDraft = null;
  activeConfirmation = null;
  activeGuided = true;
  const guided = await api("/api/v1/guided-intake/turn", {
    method: "POST",
    body: JSON.stringify({ action: "COLLECT", serviceCode: code, conversationId, fieldUpdates: {} }),
  });
  activeDraft = guided.case;
  conversationId = guided.case.conversationId;
  renderGuidedTurn(guided);
}

function renderField(field) {
  const required = field.required ? `<span class="required">*</span>` : "";
  let input;
  if (field.type === "textarea") input = `<textarea id="field-${field.name}" name="${field.name}" rows="3" ${field.required ? "required" : ""}></textarea>`;
  else if (field.type === "enum") input = `<select id="field-${field.name}" name="${field.name}" ${field.required ? "required" : ""}><option value="">请选择</option>${field.options.map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`).join("")}</select>`;
  else if (field.type === "boolean") input = `<select id="field-${field.name}" name="${field.name}" ${field.required ? "required" : ""}><option value="">请选择</option><option value="true">是</option><option value="false">否</option></select>`;
  else if (field.type === "array") input = `<textarea id="field-${field.name}" name="${field.name}" rows="2" placeholder="多项请用逗号分隔" ${field.required ? "required" : ""}></textarea>`;
  else input = `<input id="field-${field.name}" name="${field.name}" type="${field.type === "date" ? "date" : "text"}" ${field.required ? "required" : ""} />`;
  return `<div class="field"><label for="field-${field.name}">${escapeHtml(field.label)} ${required}</label>${input}${field.help ? `<p class="help">${escapeHtml(field.help)}</p>` : ""}</div>`;
}

function collectFields() {
  return Object.fromEntries(activeSchema.fields.map((field) => {
    const raw = $(`[name="${field.name}"]`).value;
    if (field.type === "boolean") return [field.name, raw === "" ? "" : raw === "true"];
    if (field.type === "array") return [field.name, raw.split(/[，,]/).map((item) => item.trim()).filter(Boolean)];
    return [field.name, raw];
  }).filter(([, value]) => value !== "" && (!Array.isArray(value) || value.length > 0)));
}

function showFullForm() {
  $("#dialog-title").textContent = activeService.serviceName;
  $("#dialog-description").textContent = `${activeService.description}（也可以一次填写完整表单）`;
  $("#form-error").classList.add("hidden");
  $("#form-fields").innerHTML = activeSchema.fields.map(renderField).join("");
  for (const field of activeSchema.fields) {
    const value = activeDraft?.fields?.[field.name];
    if (value === undefined || value === null) continue;
    $(`[name="${field.name}"]`).value = Array.isArray(value) ? value.join("，") : String(value);
  }
  $("#service-dialog").showModal();
}

function renderGuidedInput(question) {
  const required = question.required ? "required" : "";
  if (question.type === "enum") return `<select name="${escapeHtml(question.fieldName)}" ${required}><option value="">请选择</option>${(question.options ?? []).map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`).join("")}</select>`;
  if (question.type === "boolean") return `<select name="${escapeHtml(question.fieldName)}" ${required}><option value="">请选择</option><option value="true">是</option><option value="false">否</option></select>`;
  if (["textarea", "array"].includes(question.type)) return `<textarea name="${escapeHtml(question.fieldName)}" rows="2" ${required} placeholder="${question.type === "array" ? "多项请用逗号分隔" : ""}"></textarea>`;
  const constraints = question.constraints ?? {};
  return `<input name="${escapeHtml(question.fieldName)}" type="${question.type === "date" ? "date" : "text"}" ${required}${constraints.minLength ? ` minlength="${Number(constraints.minLength)}"` : ""}${constraints.maxLength ? ` maxlength="${Number(constraints.maxLength)}"` : ""}${constraints.pattern ? ` pattern="${escapeHtml(constraints.pattern)}"` : ""}>`;
}

function guidedFieldUpdates(form, questions) {
  const data = new FormData(form);
  return Object.fromEntries(questions.map((question) => {
    const raw = String(data.get(question.fieldName) ?? "").trim();
    if (question.type === "boolean") return [question.fieldName, raw === "true"];
    if (question.type === "array") return [question.fieldName, raw.split(/[，,]/).map((item) => item.trim()).filter(Boolean)];
    return [question.fieldName, raw];
  }));
}

async function prepareGuidedConfirmation() {
  activeConfirmation = await api("/api/v1/guided-intake/turn", {
    method: "POST",
    body: JSON.stringify({ action: "PREPARE_CONFIRMATION", globalRequestNo: activeDraft.globalRequestNo, conversationId }),
  });
  activeDraft = activeConfirmation.case;
  renderPreview(activeConfirmation.preview);
  $("#confirm-dialog").showModal();
}

function renderGuidedTurn(result) {
  activeDraft = result.case;
  const renderedCase = result.case;
  const article = addMessage("assistant", result.message);
  if (result.stage === "READY_FOR_CONFIRMATION") {
    prepareGuidedConfirmation().catch((error) => addMessage("assistant", `无法生成预览：${error.message}`));
    return;
  }
  const questions = (result.nextQuestions ?? []).slice(0, 3);
  const form = document.createElement("form");
  form.className = "guided-form";
  form.innerHTML = `${questions.map((question) => `<label><span>${escapeHtml(question.label)}${question.required ? " *" : ""}</span>${renderGuidedInput(question)}${question.help ? `<small>${escapeHtml(question.help)}</small>` : ""}</label>`).join("")}<div class="guided-actions"><button type="button" class="ghost" data-full-form>一次填写完整表单</button><button type="submit" class="primary">继续</button></div>`;
  form.querySelector("[data-full-form]").addEventListener("click", showFullForm);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const next = await api("/api/v1/guided-intake/turn", {
        method: "POST",
        body: JSON.stringify({
          action: "COLLECT",
          conversationId,
          globalRequestNo: renderedCase.globalRequestNo,
          expectedVersion: renderedCase.version,
          fieldUpdates: guidedFieldUpdates(form, questions),
        }),
      });
      form.querySelectorAll("input,select,textarea,button").forEach((element) => { element.disabled = true; });
      renderGuidedTurn(next);
    } catch (error) {
      submit.disabled = false;
      toast(error.message);
    }
  });
  article.querySelector(".bubble").appendChild(form);
  form.querySelector("input,select,textarea")?.focus();
}

async function createPreview(event) {
  event.preventDefault();
  const errorBox = $("#form-error");
  errorBox.classList.add("hidden");
  try {
    const draft = activeDraft
      ? await api(`/api/v1/cases/${activeDraft.globalRequestNo}/draft`, { method: "PATCH", body: JSON.stringify({ expectedVersion: activeDraft.version, fields: collectFields() }) })
      : await api("/api/v1/cases/drafts", { method: "POST", body: JSON.stringify({ serviceCode: activeService.serviceCode, fields: collectFields(), conversationId }) });
    activeDraft = draft.case;
    if (!draft.validation.valid) throw new Error([...draft.validation.missingFields.map((field) => `缺少：${field.label}`), ...draft.validation.fieldErrors.map((field) => field.message)].join("；"));
    $("#service-dialog").close();
    if (activeGuided) await prepareGuidedConfirmation();
    else {
      activeConfirmation = await api(`/api/v1/cases/${draft.case.globalRequestNo}/prepare-confirmation`, { method: "POST", body: "{}" });
      activeDraft = activeConfirmation.case;
      renderPreview(activeConfirmation.preview);
      $("#confirm-dialog").showModal();
    }
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.classList.remove("hidden");
  }
}

function renderPreview(preview) {
  $("#preview").innerHTML = `<div class="preview-row"><span>统一编号</span><strong>${escapeHtml(preview.globalRequestNo)}</strong></div><div class="preview-row"><span>服务</span><strong>${escapeHtml(preview.serviceName)}</strong></div><div class="preview-row"><span>目标系统</span><span>${escapeHtml(preview.targetSystem)}</span></div>${preview.fields.map((field) => `<div class="preview-row"><span>${escapeHtml(field.label)}</span><span>${escapeHtml(field.value)}</span></div>`).join("")}`;
}

async function confirmSubmit() {
  const errorBox = $("#submit-error");
  errorBox.classList.add("hidden");
  try {
    const demandCase = activeConfirmation.case;
    const submission = {
      draftVersion: demandCase.version,
      confirmationToken: activeConfirmation.confirmationToken,
      idempotencyKey: `${demandCase.globalRequestNo}-v${demandCase.version}-submit`,
    };
    const result = activeGuided
      ? await api("/api/v1/guided-intake/turn", { method: "POST", body: JSON.stringify({ action: "CONFIRM_SUBMIT", conversationId, globalRequestNo: demandCase.globalRequestNo, employeeConfirmed: true, ...submission }) })
      : await api(`/api/v1/cases/${demandCase.globalRequestNo}/submit`, {
        method: "POST",
        body: JSON.stringify({
          ...submission,
        }),
      });
    $("#confirm-dialog").close();
    toast(result.queued ? `已受理：${result.case.globalRequestNo}` : `提交成功：${result.case.globalRequestNo}`);
    addMessage("assistant", result.queued
      ? `需求已安全受理。统一编号：${result.case.globalRequestNo}；下游暂时不可用，平台正在后台重试，不需要重复提交。`
      : `需求已提交。统一编号：${result.case.globalRequestNo}；下游工单：${result.externalTickets[0]?.ticketNo ?? "处理中"}。`);
    await loadCases();
    activeDraft = null;
    activeConfirmation = null;
    activeGuided = false;
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.classList.remove("hidden");
  }
}

const statusNames = { DRAFT:"草稿", WAITING_INFORMATION:"待补充", WAITING_CONFIRMATION:"待确认", SUBMITTING:"提交中", SUBMITTED:"已提交", IN_PROGRESS:"处理中", WAITING_USER:"待你反馈", RESOLVED:"已解决", CLOSED:"已关闭", REJECTED:"已拒绝", SUBMIT_FAILED:"提交失败", CANCELLED:"已取消" };
async function loadCases() {
  const [caseResult, handoffResult] = await Promise.all([api("/api/v1/cases"), api("/api/v1/handoffs")]);
  const caseCards = caseResult.cases.map((item) => `<article class="case-card"><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.globalRequestNo)}</p><div class="tags"><span class="tag status">${escapeHtml(statusNames[item.status] ?? item.status)}</span>${item.externalTickets.map((ticket) => `<span class="tag">${escapeHtml(ticket.ticketNo)}</span>`).join("")}</div></article>`);
  const handoffStatusNames = { OPEN:"待分派", ASSIGNED:"人工处理中", RESOLVED:"已解决", CLOSED:"已关闭" };
  const handoffCards = handoffResult.handoffs.map((item) => `<article class="case-card"><h3>人工受理 · ${escapeHtml(item.summary)}</h3><p>${escapeHtml(item.handoffNo)}</p><div class="tags"><span class="tag status">${escapeHtml(handoffStatusNames[item.status] ?? item.status)}</span><span class="tag">${escapeHtml(item.queueCode)}</span></div>${item.resolutionSummary ? `<p class="help">处理结果：${escapeHtml(item.resolutionSummary)}</p>` : ""}</article>`);
  const cards = [...caseCards, ...handoffCards];
  $("#case-list").innerHTML = cards.length ? cards.join("") : `<p class="muted">暂无需求或人工受理事项</p>`;
}

$("#chat-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("#chat-input");
  const message = input.value.trim();
  if (!message) return;
  addMessage("user", message);
  input.value = "";
  try {
    const result = await api("/api/v1/assistant/messages", { method: "POST", body: JSON.stringify({ message, conversationId }) });
    conversationId = result.conversationId;
    const article = addMessage("assistant", [result.message, result.resolvedPrompt].filter(Boolean).join("\n"), result.citations ?? []);
    if (result.type === "HANDOFF_SUGGESTED") addHandoffAction(article, message);
    if (result.type === "ANSWER") addFeedbackAction(article, result.conversationId);
    if (result.services?.length) renderServices(result.services);
  } catch (error) { addMessage("assistant", `暂时无法处理：${error.message}`); }
});

$("#service-form").addEventListener("submit", createPreview);
$("#confirm-submit").addEventListener("click", confirmSubmit);
$("#refresh-cases").addEventListener("click", loadCases);
$("#close-dialog").addEventListener("click", () => $("#service-dialog").close());
$("#cancel-dialog").addEventListener("click", () => $("#service-dialog").close());
$("#close-confirm").addEventListener("click", () => $("#confirm-dialog").close());
$("#back-edit").addEventListener("click", () => { $("#confirm-dialog").close(); showFullForm(); });

authReady = initializeIdentity();
authReady.then(() => Promise.all([loadServices(), loadCases()])).catch((error) => toast(error.message));

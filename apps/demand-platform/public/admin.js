const state = { operator: null, csrfToken: null, currentView: "overview" };

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" })[char]);
const formatTime = (value) => value ? new Intl.DateTimeFormat("zh-CN", { month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", hour12:false }).format(new Date(value)) : "—";
const statusNames = { OPEN:"待分派", ASSIGNED:"处理中", RESOLVED:"已解决", CLOSED:"已关闭", PENDING:"待执行", RUNNING:"执行中", RETRY_WAIT:"等待重试", DEAD:"死信", SUCCEEDED:"成功", WAITING_INFORMATION:"待补信息", WAITING_CONFIRMATION:"待确认", SUBMITTING:"提交中", SUBMITTED:"已提交", IN_PROGRESS:"处理中", SUBMIT_FAILED:"提交失败", FAILURE:"失败", SUCCESS:"成功" };

function has(permission) { return state.operator?.permissions?.includes(permission); }
function badge(status) { return `<span class="badge ${escapeHtml(String(status).toLowerCase())}">${escapeHtml(statusNames[status] ?? status)}</span>`; }
function toast(message, error = false) { const node = $("#toast"); node.textContent = message; node.className = `toast${error ? " error" : ""}`; node.hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => { node.hidden = true; }, 3600); }

async function api(path, options = {}) {
  const method = options.method ?? "GET";
  const headers = { ...(options.body !== undefined ? { "content-type":"application/json" } : {}), ...(options.headers ?? {}) };
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) headers["X-CSRF-Token"] = state.csrfToken;
  const response = await fetch(path, { method, credentials:"same-origin", headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) { showLogin(); throw new Error(payload.error?.message ?? "运营会话已失效"); }
  if (!response.ok) throw new Error(payload.error?.message ?? `请求失败（${response.status}）`);
  return payload;
}

function showLogin(message = "") {
  state.operator = null; state.csrfToken = null;
  $("#app-shell").hidden = true; $("#login-view").hidden = false;
  $("#login-error").textContent = message;
}

function enterApp(auth) {
  state.operator = auth.operator; state.csrfToken = auth.csrfToken;
  $("#login-view").hidden = true; $("#app-shell").hidden = false;
  $("#operator-name-display").textContent = auth.operator.name;
  $("#operator-avatar").textContent = auth.operator.name.slice(0, 1);
  $("#operator-role-display").textContent = auth.operator.roles.join(" · ");
  $$('[data-permission]').forEach((node) => { node.hidden = !has(node.dataset.permission); });
  $$('[data-action-permission]').forEach((node) => { node.hidden = !has(node.dataset.actionPermission); });
  const firstAvailable = $('[data-view]:not([hidden])')?.dataset.view ?? "overview";
  switchView(has("VIEW_OVERVIEW") ? "overview" : firstAvailable);
}

async function initializeAuth() {
  try {
    const response = await fetch("/api/v1/operator/auth/me", { credentials:"same-origin" });
    if (response.ok) return enterApp(await response.json());
    if (new URLSearchParams(location.search).get("sso") === "1") {
      const gateway = await fetch("/api/v1/operator/auth/session", { method:"POST", credentials:"same-origin", headers:{"content-type":"application/json"}, body:"{}" });
      if (gateway.ok) return enterApp(await gateway.json());
    }
  } catch { /* 登录面板提供恢复入口。 */ }
  showLogin();
}

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault(); $("#login-error").textContent = "";
  const adminKey = $("#admin-key").value;
  try {
    const response = await fetch("/api/v1/operator/auth/session", { method:"POST", credentials:"same-origin", headers:{"content-type":"application/json"}, body:JSON.stringify({ adminKey, operatorId:$("#operator-id").value, operatorName:$("#operator-name").value }) });
    const payload = await response.json();
    $("#admin-key").value = "";
    if (!response.ok) throw new Error(payload.error?.message ?? "登录失败");
    enterApp(payload); toast("运营会话已建立");
  } catch (error) { $("#admin-key").value = ""; $("#login-error").textContent = error.message; }
});

$("#logout-button").addEventListener("click", async () => { try { await api("/api/v1/operator/auth/logout", { method:"POST", body:{} }); } catch {} showLogin("已安全退出"); });

const viewMeta = { overview:["运营总览","今天需要关注什么"], handoffs:["人工队列","需要人工跟进的事项"], cases:["需求台账","统一需求全局进度"], integrations:["集成任务","业务系统链路状态"], sessions:["会话安全","员工访问与紧急撤销"], "tool-calls":["Agent调用","DEAP工具链可观测性"], audit:["审计事件","谁在何时做了什么"] };
function switchView(view) {
  state.currentView = view;
  $$(".view").forEach((node) => node.classList.toggle("active-view", node.id === `view-${view}`));
  $$('[data-view]').forEach((node) => node.classList.toggle("active", node.dataset.view === view));
  $("#breadcrumb").textContent = viewMeta[view][0]; $("#page-title").textContent = viewMeta[view][1];
  loadView(view).catch((error) => toast(error.message, true));
}
$$('[data-view]').forEach((node) => node.addEventListener("click", () => switchView(node.dataset.view)));

async function loadView(view) {
  if (view === "overview") return loadOverview();
  if (view === "handoffs") return loadHandoffs();
  if (view === "cases") return loadCases();
  if (view === "integrations") return loadIntegrations();
  if (view === "sessions") return loadSessions();
  if (view === "tool-calls") return loadToolCalls();
  if (view === "audit") return loadAudit();
}

async function loadOverview() {
  const days = $("#metrics-days").value;
  const [overview, metrics] = await Promise.all([api("/api/v1/admin/overview"), api(`/api/v1/admin/metrics?days=${encodeURIComponent(days)}`)]);
  const cards = [
    ["累计需求", overview.demands.total, `${overview.demands.byStatus.IN_PROGRESS ?? 0} 条处理中`],
    ["人工待办", (overview.handoffs.byStatus.OPEN ?? 0) + (overview.handoffs.byStatus.ASSIGNED ?? 0), `${overview.handoffs.total} 条累计`],
    ["集成异常", overview.integrations.byStatus.DEAD ?? 0, `${overview.integrations.byStatus.RETRY_WAIT ?? 0} 条等待重试`],
    ["活跃员工", overview.sessions.activeEmployees, `${overview.sessions.activeEmployeeSessions} 个有效会话`],
  ];
  $("#overview-cards").innerHTML = cards.map(([label,value,help]) => `<article class="metric-card"><p>${escapeHtml(label)}</p><strong>${escapeHtml(value)}</strong><small>${escapeHtml(help)}</small></article>`).join("");
  const flow = { ...overview.demands.byStatus, "人工待分派":overview.handoffs.byStatus.OPEN ?? 0, "集成死信":overview.integrations.byStatus.DEAD ?? 0 };
  const max = Math.max(1, ...Object.values(flow));
  $("#flow-summary").innerHTML = Object.entries(flow).slice(0, 8).map(([name,value]) => `<div class="status-row"><span>${escapeHtml(statusNames[name] ?? name)}</span><div class="bar"><span style="width:${Math.round(value/max*100)}%"></span></div><strong>${value}</strong></div>`).join("") || '<p class="muted">暂无运行数据</p>';
  const indicators = [["AI直接回答率",metrics.indicators.answerRate],["服务推荐率",metrics.indicators.serviceSuggestionRate],["员工确认解决率",metrics.indicators.employeeConfirmedResolutionRate],["集成终态成功率",metrics.indicators.integrationTerminalSuccessRate],["正向评价率",metrics.indicators.positiveRatingRate]];
  $("#indicator-summary").innerHTML = indicators.map(([name,value]) => `<div class="indicator"><span>${escapeHtml(name)}</span><strong>${Math.round(value*100)}%</strong></div>`).join("");
}

async function loadHandoffs() {
  const status = $("#handoff-filter").value;
  const result = await api(`/api/v1/admin/handoffs?limit=100${status ? `&status=${encodeURIComponent(status)}` : ""}`);
  $("#handoff-list").innerHTML = result.handoffs.map((item) => `<article class="queue-card"><div class="queue-meta">${badge(item.status)}<span>${escapeHtml(item.handoffNo)}</span><span>${escapeHtml(item.queueCode)}</span></div><h3>${escapeHtml(item.summary)}</h3><p>${escapeHtml(item.originalMessage)}</p><div class="queue-meta"><span>申请人 ${escapeHtml(item.requester.name)} · ${escapeHtml(item.requester.departmentId)}</span><span>更新 ${formatTime(item.updatedAt)}</span>${item.assignedTo ? `<span>处理人 ${escapeHtml(item.assignedTo)}</span>` : ""}</div>${has("MANAGE_HANDOFFS") && item.status !== "CLOSED" ? `<div class="queue-actions"><button class="secondary edit-handoff" data-handoff="${escapeHtml(item.handoffNo)}" data-status="${escapeHtml(item.status)}" data-assignee="${escapeHtml(item.assignedTo ?? "")}">处理</button></div>` : ""}</article>`).join("") || '<div class="panel empty">当前筛选条件下没有人工事项</div>';
  $$(".edit-handoff").forEach((button) => button.addEventListener("click", () => openHandoffDialog(button.dataset)));
}

function openHandoffDialog(data) { $("#handoff-no").value = data.handoff; $("#handoff-dialog-title").textContent = `更新 ${data.handoff}`; $("#handoff-status").value = data.status === "OPEN" ? "ASSIGNED" : "RESOLVED"; $("#handoff-assignee").value = data.assignee || state.operator.operatorId; $("#handoff-resolution").value = ""; $("#handoff-dialog").showModal(); }
$("#close-handoff-dialog").addEventListener("click", () => $("#handoff-dialog").close());
$("#cancel-handoff-dialog").addEventListener("click", () => $("#handoff-dialog").close());
$("#handoff-form").addEventListener("submit", async (event) => { event.preventDefault(); const status=$("#handoff-status").value; try { await api(`/api/v1/admin/handoffs/${encodeURIComponent($("#handoff-no").value)}`, { method:"PATCH", body:{ status, assignedTo:$("#handoff-assignee").value || undefined, resolutionSummary:$("#handoff-resolution").value || undefined } }); $("#handoff-dialog").close(); toast("人工事项已更新"); loadHandoffs(); } catch(error){ toast(error.message,true); } });

async function loadCases() { const status=$("#case-filter").value; const result=await api(`/api/v1/admin/cases?limit=100${status ? `&status=${encodeURIComponent(status)}`:""}`); $("#case-table").innerHTML=result.cases.map((item)=>`<tr><td><strong>${escapeHtml(item.globalRequestNo)}</strong><br><small>${formatTime(item.createdAt)}</small></td><td>${escapeHtml(item.title)}<br><small>${escapeHtml(item.serviceCode)}</small></td><td>${escapeHtml(item.requester.name)}<br><small>${escapeHtml(item.requester.departmentId)}</small></td><td>${badge(item.status)}</td><td>${item.externalTickets.length ? item.externalTickets.map((ticket)=>`${escapeHtml(ticket.systemCode)} · ${escapeHtml(ticket.ticketNo)}`).join("<br>") : "—"}</td><td>${formatTime(item.updatedAt)}</td></tr>`).join("") || '<tr><td class="empty" colspan="6">暂无需求数据</td></tr>'; }

async function loadIntegrations() { const status=$("#integration-filter").value; const result=await api(`/api/v1/admin/integration-tasks${status ? `?status=${encodeURIComponent(status)}`:""}`); $("#integration-table").innerHTML=result.tasks.map((item)=>`<tr><td><strong>${escapeHtml(item.taskId.slice(0,8))}</strong><br><small>${escapeHtml(item.operation)}</small></td><td>${escapeHtml(item.systemCode)}</td><td>${badge(item.status)}</td><td>${item.attemptCount}/${item.maxAttempts}</td><td>${formatTime(item.nextAttemptAt)}</td><td>${escapeHtml(item.lastErrorCode ?? "—")}</td><td>${has("MANAGE_INTEGRATIONS") && ["DEAD","RETRY_WAIT"].includes(item.status) ? `<button class="secondary retry-task" data-task="${escapeHtml(item.taskId)}">重试</button>`:"—"}</td></tr>`).join("") || '<tr><td class="empty" colspan="7">暂无集成任务</td></tr>'; $$(".retry-task").forEach((button)=>button.addEventListener("click",async()=>{try{await api(`/api/v1/admin/integration-tasks/${encodeURIComponent(button.dataset.task)}/retry`,{method:"POST",body:{}});toast("任务已重试");loadIntegrations();}catch(error){toast(error.message,true);}})); }

async function loadSessions() { const result=await api("/api/v1/admin/auth-sessions?limit=100"); $("#session-table").innerHTML=result.sessions.map((item)=>`<tr><td><strong>${escapeHtml(item.name)}</strong><br><small>${escapeHtml(item.employeeId)}</small></td><td>${escapeHtml(item.departmentId)}</td><td>${item.activeSessions}</td><td>${formatTime(item.latestCreatedAt)}</td><td>${formatTime(item.latestExpiresAt)}</td><td><button class="danger revoke-row" data-employee="${escapeHtml(item.employeeId)}">撤销</button></td></tr>`).join("") || '<tr><td class="empty" colspan="6">暂无有效员工会话</td></tr>'; $$(".revoke-row").forEach((button)=>button.addEventListener("click",()=>{ $("#revoke-employee").value=button.dataset.employee; $("#revoke-employee").focus(); })); }

async function loadAudit() { const outcome=$("#audit-outcome").value; const result=await api(`/api/v1/admin/audit-events?limit=100${outcome ? `&outcome=${encodeURIComponent(outcome)}`:""}`); $("#audit-table").innerHTML=result.events.map((item)=>`<tr><td>${formatTime(item.createdAt)}</td><td><strong>${escapeHtml(item.actorId)}</strong><br><small>${escapeHtml(item.actorType)}</small></td><td>${escapeHtml(item.action)}</td><td>${badge(item.outcome)}</td><td>${escapeHtml(item.caseId ?? "—")}</td><td><small>${escapeHtml(item.traceId ?? "—")}</small></td></tr>`).join("") || '<tr><td class="empty" colspan="6">暂无审计事件</td></tr>'; }

async function loadToolCalls() { const operationId=$("#tool-call-operation").value; const outcome=$("#tool-call-outcome").value; const query=new URLSearchParams({limit:"100"}); if(operationId)query.set("operationId",operationId); if(outcome)query.set("outcome",outcome); const result=await api(`/api/v1/admin/tool-invocations?${query}`); $("#tool-call-table").innerHTML=result.invocations.map((item)=>`<tr><td>${formatTime(item.createdAt)}</td><td><strong>${escapeHtml(item.invocationId)}</strong></td><td>${escapeHtml(item.operationId)}</td><td>${escapeHtml(item.departmentId)}</td><td>${badge(item.outcome)}</td><td>${escapeHtml(item.httpStatus ?? "—")}<br><small>${escapeHtml(item.errorCode ?? "—")}</small></td><td>${item.durationMs === null ? "—" : `${item.durationMs} ms`}</td><td><small>${escapeHtml(item.traceId)}</small></td></tr>`).join("") || '<tr><td class="empty" colspan="8">暂无工具调用记录</td></tr>'; }

$("#refresh-overview").addEventListener("click",()=>loadOverview().catch((e)=>toast(e.message,true))); $("#metrics-days").addEventListener("change",()=>loadOverview().catch((e)=>toast(e.message,true)));
$("#refresh-handoffs").addEventListener("click",()=>loadHandoffs().catch((e)=>toast(e.message,true))); $("#handoff-filter").addEventListener("change",()=>loadHandoffs().catch((e)=>toast(e.message,true)));
$("#refresh-cases").addEventListener("click",()=>loadCases().catch((e)=>toast(e.message,true))); $("#case-filter").addEventListener("change",()=>loadCases().catch((e)=>toast(e.message,true)));
$("#integration-filter").addEventListener("change",()=>loadIntegrations().catch((e)=>toast(e.message,true)));
$("#run-worker").addEventListener("click",async()=>{try{const result=await api("/api/v1/admin/integration-tasks/run",{method:"POST",body:{limit:20}});toast(`已执行 ${result.selected} 个到期任务`);loadIntegrations();}catch(e){toast(e.message,true);}});
$("#reconcile-tickets").addEventListener("click",async()=>{try{const result=await api("/api/v1/admin/external-tickets/reconcile",{method:"POST",body:{limit:20}});toast(`对账完成：更新 ${result.updated}，失败 ${result.failed}`);loadIntegrations();}catch(e){toast(e.message,true);}});
$("#refresh-sessions").addEventListener("click",()=>loadSessions().catch((e)=>toast(e.message,true)));
$("#revoke-form").addEventListener("submit",async(event)=>{event.preventDefault();try{const result=await api("/api/v1/admin/auth-sessions/revoke",{method:"POST",body:{employeeId:$("#revoke-employee").value,reason:$("#revoke-reason").value}});toast(`已撤销 ${result.revokedSessions} 个会话`);$("#revoke-employee").value="";loadSessions();}catch(e){toast(e.message,true);}});
$("#refresh-tool-calls").addEventListener("click",()=>loadToolCalls().catch((e)=>toast(e.message,true))); $("#tool-call-operation").addEventListener("change",()=>loadToolCalls().catch((e)=>toast(e.message,true))); $("#tool-call-outcome").addEventListener("change",()=>loadToolCalls().catch((e)=>toast(e.message,true)));
$("#refresh-audit").addEventListener("click",()=>loadAudit().catch((e)=>toast(e.message,true))); $("#audit-outcome").addEventListener("change",()=>loadAudit().catch((e)=>toast(e.message,true)));

initializeAuth();

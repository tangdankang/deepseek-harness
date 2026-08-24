/**
 * Carrier-independent dispatch for Host API client requests. Physical
 * carriers validate their outer framing, then hand the parsed full-form
 * message here for method-specific payload validation and invocation.
 *
 * @module @deepseek-ai/dsh-host-apiproxy/dispatch
 */

import type { z } from 'zod'
import type { ApiProxy } from './api/index.ts'
import type { RequestPayload, ResponseValue, RpcMethodMap } from './api/rpc-map.ts'
import type { ClientRequest, RpcError, RpcRequest, RpcResponse, ServerResponse } from './api/rpc.ts'
import { RpcId } from './api/rpc.ts'
import type { Wire } from './api/rpc.schema.ts'
import {
  sessionCancelRequestSchema,
  sessionAttachmentRequestSchema,
  sessionCreateRequestSchema,
  sessionForkRequestSchema,
  sessionHistoryRequestSchema,
  sessionListRequestSchema,
  sessionModelsRequestSchema,
  sessionPromptRequestSchema,
  sessionRenameRequestSchema,
  sessionSearchRequestSchema,
  sessionSelectModelRequestSchema,
  sessionUpdateQueueRequestSchema,
} from './api/sessions.schema.ts'
import {
  hostCreateDirectoryRequestSchema, hostDescribeRequestSchema,
  hostListDirectoryRequestSchema, hostOpenPathRequestSchema,
  hostPickDirectoryRequestSchema,
} from './api/host.schema.ts'
import {
  workspaceArchiveSessionRequestSchema,
  workspaceCreateRequestSchema,
  workspaceDeleteRequestSchema,
  workspaceInsertBeforeRequestSchema,
  workspaceInsertSessionBeforeRequestSchema,
  workspaceListRequestSchema,
  workspaceRenameRequestSchema,
} from './api/workspace.schema.ts'
import { skillListRequestSchema } from './api/skills.schema.ts'
import {
  agentPresetCopyRequestSchema, agentPresetListRequestSchema, agentPresetOpenDocumentRequestSchema,
  agentPresetReadRequestSchema, agentPresetRemoveRequestSchema, agentPresetSelectRequestSchema,
} from './api/agent-presets.schema.ts'
import {
  goalCreateRequestSchema,
  goalEditRequestSchema,
  goalPauseRequestSchema,
  goalResumeRequestSchema,
  goalCompleteRequestSchema,
  goalClearRequestSchema,
} from './api/goals.schema.ts'
import {
  settingsDescribeRequestSchema, settingsMutateRequestSchema, settingsOpenDocumentRequestSchema,
  settingsReplaceRequestSchema, settingsUpdateRequestSchema,
} from './api/settings.schema.ts'
import {
  credentialsDescribeRequestSchema, credentialsSetRequestSchema, credentialsUnsetRequestSchema,
} from './api/credentials.schema.ts'
import { llmDiscoverModelsRequestSchema, llmModelsRequestSchema, llmProvidersRequestSchema } from './api/llm.schema.ts'
import {
  subagentHistoryRequestSchema,
  subagentInterruptRequestSchema,
  subagentListRequestSchema,
  subagentPromptRequestSchema,
} from './api/subagents.schema.ts'

/**
 * Unary dispatch table, keyed by and compiler-locked to {@link RpcMethodMap}.
 * Schemas validate JSON values before the typed same-process API sees them.
 */
type UnaryRoutes = {
  [K in keyof RpcMethodMap]: {
    schema: z.ZodType<Wire<RequestPayload<K>>>
    invoke(api: ApiProxy, request: RpcRequest<RequestPayload<K>>, signal: AbortSignal): Promise<RpcResponse<ResponseValue<K>>>
  }
}

const UNARY_ROUTES: UnaryRoutes = {
  'session.list': { schema: sessionListRequestSchema, invoke: (api, r) => api.sessions.list(r) },
  'session.search': { schema: sessionSearchRequestSchema, invoke: (api, r, signal) => api.sessions.search(r, signal) },
  'session.create': { schema: sessionCreateRequestSchema, invoke: (api, r) => api.sessions.create(r) },
  'session.history': { schema: sessionHistoryRequestSchema, invoke: (api, r) => api.sessions.history(r) },
  'session.models': { schema: sessionModelsRequestSchema, invoke: (api, r) => api.sessions.models(r) },
  'session.selectModel': { schema: sessionSelectModelRequestSchema, invoke: (api, r) => api.sessions.selectModel(r) },
  'session.rename': { schema: sessionRenameRequestSchema, invoke: (api, r) => api.sessions.rename(r) },
  'session.fork': { schema: sessionForkRequestSchema, invoke: (api, r) => api.sessions.fork(r) },
  'session.prompt': { schema: sessionPromptRequestSchema, invoke: (api, r) => api.sessions.prompt(r) },
  'session.attachment': { schema: sessionAttachmentRequestSchema, invoke: (api, r) => api.sessions.attachment(r) },
  'session.updateQueue': { schema: sessionUpdateQueueRequestSchema, invoke: (api, r) => api.sessions.updateQueue(r) },
  'session.cancel': { schema: sessionCancelRequestSchema, invoke: (api, r) => api.sessions.cancel(r) },
  'subagent.list': { schema: subagentListRequestSchema, invoke: (api, r, signal) => api.subagents.list(r, signal) },
  'subagent.history': { schema: subagentHistoryRequestSchema, invoke: (api, r, signal) => api.subagents.history(r, signal) },
  'subagent.prompt': { schema: subagentPromptRequestSchema, invoke: (api, r, signal) => api.subagents.prompt(r, signal) },
  'subagent.interrupt': { schema: subagentInterruptRequestSchema, invoke: (api, r) => api.subagents.interrupt(r) },
  'host.describe': { schema: hostDescribeRequestSchema, invoke: (api, r) => api.host.describe(r) },
  'host.pickDirectory': { schema: hostPickDirectoryRequestSchema, invoke: (api, r, signal) => api.host.pickDirectory(r, signal) },
  'host.listDirectory': { schema: hostListDirectoryRequestSchema, invoke: (api, r, signal) => api.host.listDirectory(r, signal) },
  'host.createDirectory': { schema: hostCreateDirectoryRequestSchema, invoke: (api, r) => api.host.createDirectory(r) },
  'host.openPath': { schema: hostOpenPathRequestSchema, invoke: (api, r, signal) => api.host.openPath(r, signal) },
  'workspace.list': { schema: workspaceListRequestSchema, invoke: (api, r) => api.workspace.list(r) },
  'workspace.create': { schema: workspaceCreateRequestSchema, invoke: (api, r) => api.workspace.create(r) },
  'workspace.rename': { schema: workspaceRenameRequestSchema, invoke: (api, r) => api.workspace.rename(r) },
  'workspace.delete': { schema: workspaceDeleteRequestSchema, invoke: (api, r) => api.workspace.delete(r) },
  'workspace.insertBefore': { schema: workspaceInsertBeforeRequestSchema, invoke: (api, r) => api.workspace.insertBefore(r) },
  'workspace.insertSessionBefore': { schema: workspaceInsertSessionBeforeRequestSchema, invoke: (api, r) => api.workspace.insertSessionBefore(r) },
  'workspace.archiveSession': { schema: workspaceArchiveSessionRequestSchema, invoke: (api, r) => api.workspace.archiveSession(r) },
  'skill.list': { schema: skillListRequestSchema, invoke: (api, r) => api.skills.list(r) },
  'agentPreset.list': { schema: agentPresetListRequestSchema, invoke: (api, r) => api.agentPresets.list(r) },
  'agentPreset.select': { schema: agentPresetSelectRequestSchema, invoke: (api, r) => api.agentPresets.select(r) },
  'agentPreset.read': { schema: agentPresetReadRequestSchema, invoke: (api, r) => api.agentPresets.read(r) },
  'agentPreset.copy': { schema: agentPresetCopyRequestSchema, invoke: (api, r) => api.agentPresets.copy(r) },
  'agentPreset.openDocument': { schema: agentPresetOpenDocumentRequestSchema, invoke: (api, r, signal) => api.agentPresets.openDocument(r, signal) },
  'agentPreset.remove': { schema: agentPresetRemoveRequestSchema, invoke: (api, r) => api.agentPresets.remove(r) },
  'goal.create': { schema: goalCreateRequestSchema, invoke: (api, r) => api.goals.create(r) },
  'goal.edit': { schema: goalEditRequestSchema, invoke: (api, r) => api.goals.edit(r) },
  'goal.pause': { schema: goalPauseRequestSchema, invoke: (api, r) => api.goals.pause(r) },
  'goal.resume': { schema: goalResumeRequestSchema, invoke: (api, r) => api.goals.resume(r) },
  'goal.complete': { schema: goalCompleteRequestSchema, invoke: (api, r) => api.goals.complete(r) },
  'goal.clear': { schema: goalClearRequestSchema, invoke: (api, r) => api.goals.clear(r) },
  'settings.describe': { schema: settingsDescribeRequestSchema, invoke: (api, r) => api.settings.describe(r) },
  'settings.openDocument': { schema: settingsOpenDocumentRequestSchema, invoke: (api, r, signal) => api.settings.openDocument(r, signal) },
  'settings.update': { schema: settingsUpdateRequestSchema, invoke: (api, r) => api.settings.update(r) },
  'settings.replace': { schema: settingsReplaceRequestSchema, invoke: (api, r) => api.settings.replace(r) },
  'settings.mutate': { schema: settingsMutateRequestSchema, invoke: (api, r) => api.settings.mutate(r) },
  'credentials.describe': { schema: credentialsDescribeRequestSchema, invoke: (api, r) => api.credentials.describe(r) },
  'credentials.set': { schema: credentialsSetRequestSchema, invoke: (api, r) => api.credentials.set(r) },
  'credentials.unset': { schema: credentialsUnsetRequestSchema, invoke: (api, r) => api.credentials.unset(r) },
  'llm.providers': { schema: llmProvidersRequestSchema, invoke: (api, r) => api.llm.providers(r) },
  'llm.models': { schema: llmModelsRequestSchema, invoke: (api, r) => api.llm.models(r) },
  'llm.discoverModels': { schema: llmDiscoverModelsRequestSchema, invoke: (api, r, signal) => api.llm.discoverModels(r, signal) },
}

/**
 * Narrow an arbitrary method name to the Host API registry.
 * @param method - method name from a physical carrier.
 * @returns the registered method, or `undefined` when it is unknown.
 */
export function rpcMethodFor(method: string): keyof RpcMethodMap | undefined {
  return Object.hasOwn(UNARY_ROUTES, method) ? method as keyof RpcMethodMap : undefined
}

/** Correlation id used when a malformed carrier envelope has no readable id. */
export const INVALID_REQUEST_RPC_ID = RpcId('invalid-request')

/**
 * Complete one business error into the full-form server response.
 * @param rpcId - client correlation id.
 * @param error - typed Host API business error.
 * @returns a carrier-independent server response.
 */
export function serverErrorResponse(rpcId: RpcId, error: RpcError): ServerResponse {
  return { type: 'server-response', rpcId, result: { ok: false, error } }
}

/** Complete a narrow domain response into the full-form server response. */
function fullResponse(narrow: RpcResponse<unknown>): ServerResponse {
  return { type: 'server-response', rpcId: narrow.rpcId, result: narrow.result }
}

/**
 * Validate and invoke one parsed full-form client request. Business failures
 * return in the response; an implementation crash rejects so the physical
 * carrier can report its own failure semantics.
 * @param api - Host API implementation.
 * @param message - parsed client request.
 * @param signal - physical request lifetime.
 * @returns the correlated full-form server response.
 */
export async function dispatchClientRequest(
  api: ApiProxy,
  message: ClientRequest,
  signal: AbortSignal,
): Promise<ServerResponse> {
  const method = rpcMethodFor(message.method)
  if (method === undefined) {
    return serverErrorResponse(message.rpcId, {
      code: 'bad-request',
      message: `unknown Host API method ${JSON.stringify(message.method)}`,
      details: { issues: [] },
    })
  }
  return dispatchKnownRequest(api, method, message, signal)
}

// K ties the selected row's schema and invoke signature together. A union key
// would otherwise degrade the invoke member to an unusable intersection.
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters
async function dispatchKnownRequest<K extends keyof RpcMethodMap>(
  api: ApiProxy,
  method: K,
  message: ClientRequest,
  signal: AbortSignal,
): Promise<ServerResponse> {
  const route = UNARY_ROUTES[method]
  const payload = route.schema.safeParse(message.payload)
  if (!payload.success) {
    return serverErrorResponse(message.rpcId, {
      code: 'bad-request',
      message: `invalid payload for ${method}`,
      details: { issues: payload.error.issues },
    })
  }
  return fullResponse(await route.invoke(api, { rpcId: message.rpcId, payload: payload.data }, signal))
}

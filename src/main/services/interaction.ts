import { nanoid } from 'nanoid'
import type { PermissionRequest, PermissionResponse, Question, QuestionRequest, QuestionResponse } from '@shared/types'

/**
 * Permission prompts and clarifying questions, shared by both engines. The
 * IPC layer wires the emitters; the renderer answers by request id.
 */
let emitPermission: (r: PermissionRequest) => void = () => undefined
let emitQuestion: (r: QuestionRequest) => void = () => undefined
const pendingPermissions = new Map<string, (r: PermissionResponse) => void>()
const pendingQuestions = new Map<string, (r: QuestionResponse) => void>()

export function setInteractionEmitters(p: typeof emitPermission, q: typeof emitQuestion): void {
  emitPermission = p
  emitQuestion = q
}

export function askPermission(req: Omit<PermissionRequest, 'requestId'>, signal?: AbortSignal): Promise<PermissionResponse> {
  const requestId = nanoid(8)
  return new Promise((resolve) => {
    pendingPermissions.set(requestId, resolve)
    emitPermission({ ...req, requestId })
    signal?.addEventListener('abort', () => {
      pendingPermissions.delete(requestId)
      resolve({ requestId, decision: 'deny', message: 'Cancelled' })
    })
  }).then((r) => {
    pendingPermissions.delete(requestId)
    return r as PermissionResponse
  })
}

export function askQuestion(workspaceId: string, questions: Question[], signal?: AbortSignal): Promise<QuestionResponse> {
  const requestId = nanoid(8)
  return new Promise((resolve) => {
    pendingQuestions.set(requestId, resolve)
    emitQuestion({ requestId, workspaceId, questions })
    signal?.addEventListener('abort', () => {
      pendingQuestions.delete(requestId)
      resolve({ requestId, answers: {}, cancelled: true })
    })
  }).then((r) => {
    pendingQuestions.delete(requestId)
    return r as QuestionResponse
  })
}

export function answerPermission(r: PermissionResponse): void {
  pendingPermissions.get(r.requestId)?.(r)
}
export function answerQuestion(r: QuestionResponse): void {
  pendingQuestions.get(r.requestId)?.(r)
}

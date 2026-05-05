import { newRequestId } from "../util/ids.js";

export interface WorkflowAuditEntry {
  tool: string;
  bundleVersion: string;
  resultHash: string;
  input?: unknown;
  output?: unknown;
  recordedAt: string;
}

export interface WorkflowAuditSession {
  id: string;
  bundleVersion: string;
  createdAt: string;
  entries: WorkflowAuditEntry[];
}

export class WorkflowAuditStore {
  readonly #sessions = new Map<string, WorkflowAuditSession>();

  start(bundleVersion: string): WorkflowAuditSession {
    const now = new Date().toISOString();
    const session: WorkflowAuditSession = {
      id: `workflow-${newRequestId()}`,
      bundleVersion,
      createdAt: now,
      entries: [],
    };
    this.#sessions.set(session.id, session);
    return session;
  }

  record(sessionId: string, entry: Omit<WorkflowAuditEntry, "recordedAt">): void {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    session.entries.push({ ...entry, recordedAt: new Date().toISOString() });
  }

  get(sessionId: string): WorkflowAuditSession | undefined {
    return this.#sessions.get(sessionId);
  }
}

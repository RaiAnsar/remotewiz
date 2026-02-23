export type AdapterName = "discord" | "web";

export type TaskStatus = "queued" | "running" | "needs_approval" | "done" | "failed";

export type ErrorCode =
  | "timeout"
  | "silence_timeout"
  | "budget_exceeded"
  | "approval_denied"
  | "approval_timeout"
  | "cli_error"
  | "parse_error"
  | "queue_full"
  | "worker_crashed_recovery";

export type ApprovalStatus = "pending" | "approved" | "denied";

export type ApprovalActionType =
  | "file_delete"
  | "git_push"
  | "git_force"
  | "destructive_cmd"
  | "external_request"
  | "install_package"
  | "unknown";

export interface Project {
  alias: string;
  path: string;
  description?: string;
  skipPermissions: boolean;
  skipPermissionsReason?: string;
  tokenBudget: number;
  timeout: number;
}

export interface AppConfig {
  projects: Record<string, Project>;
}

export interface RuntimeConfig {
  discordToken?: string;
  discordGuildId?: string;
  discordChannelIds: Set<string>;
  discordAllowedUsers: Set<string>;
  anthropicApiKey?: string;
  webPort: number;
  webBindHost: string;
  webAuthToken?: string;
  maxConcurrentTasks: number;
  maxQueuedPerProject: number;
  defaultTokenBudget: number;
  defaultTimeoutMs: number;
  silenceTimeoutMs: number;
  approvalTimeoutMs: number;
  replayTimeoutMs: number;
  summarizerEnabled: boolean;
}

export interface TaskRecord {
  id: string;
  projectAlias: string;
  projectPath: string;
  prompt: string;
  threadId: string;
  adapter: AdapterName;
  continueSession: boolean;
  status: TaskStatus;
  result?: string;
  error?: string;
  tokensUsed: number;
  tokenBudget?: number;
  workerPid?: number;
  workerPidStart?: number;
  checkpoint?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}

export interface EnqueueTaskInput {
  id: string;
  projectAlias: string;
  projectPath: string;
  prompt: string;
  threadId: string;
  adapter: AdapterName;
  continueSession: boolean;
  tokenBudget?: number;
}

export interface ApprovalRecord {
  id: string;
  taskId: string;
  actionType: ApprovalActionType;
  description: string;
  status: ApprovalStatus;
  requestedAt: number;
  resolvedAt?: number;
  resolvedBy?: string;
}

export interface ThreadBinding {
  threadId: string;
  projectAlias: string;
  adapter: AdapterName;
  createdBy: string;
  createdAt: number;
}

export interface SessionRecord {
  threadId: string;
  projectAlias: string;
  sessionId: string;
  lastUsed: number;
}

export interface AuditEntry {
  id?: number;
  timestamp: number;
  taskId?: string;
  projectAlias?: string;
  actor: string;
  action: string;
  detail?: unknown;
  threadId?: string;
}

export interface WorkerExecutionContext {
  task: TaskRecord;
  project: Project;
  resumedSessionId?: string;
  replayMode: boolean;
  replayApprovedAction?: string;
  replayCheckpointSummary?: string;
}

export interface ParsedStreamOutcome {
  assistantText: string;
  toolSummary: string[];
  detectedSessionId?: string;
  tokenUsage?: number;
  permissionDenied?: {
    actionType: ApprovalActionType;
    description: string;
  };
  replayActions: string[];
  parseWarnings: string[];
}

export interface SummarizerInput {
  rawText: string;
  toolSummary: string[];
  tokensUsed: number;
  tokenBudget: number;
  replayActions?: string[];
}

export interface TaskResult {
  status: TaskStatus;
  summary: string;
  tokensUsed: number;
  sessionId?: string;
  replayActions: string[];
  errorCode?: ErrorCode;
  approvalActionType?: ApprovalActionType;
  rawOutputFile?: string;
}

export interface AdapterTaskRequest {
  projectAlias: string;
  prompt: string;
  threadId: string;
  adapter: AdapterName;
  continueSession: boolean;
  actorId: string;
}

export interface AdapterTaskUpdate {
  taskId: string;
  threadId: string;
  status: TaskStatus;
  summary?: string;
  error?: string;
}

export interface ApprovalPrompt {
  approvalId: string;
  taskId: string;
  threadId: string;
  description: string;
}

export interface Adapter {
  name: AdapterName;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendTaskUpdate(update: AdapterTaskUpdate): Promise<void>;
  requestApproval(prompt: ApprovalPrompt): Promise<void>;
}

export interface UploadRef {
  id: string;
  projectAlias: string;
  originalName: string;
  serverPath: string;
  createdAt: number;
}

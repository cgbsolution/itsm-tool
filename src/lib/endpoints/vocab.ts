/** Fixed vocabularies of the endpoint and patch module (mirrors 0004_endpoints.sql). */

export const OS_FAMILIES = ["windows", "linux", "macos", "other"] as const
export type OsFamily = (typeof OS_FAMILIES)[number]
export const OS_LABELS: Record<OsFamily, string> = { windows: "Windows", linux: "Linux", macos: "macOS", other: "Other" }

/** Patch sources an agent may report (`package` is reserved for offline-only catalog entries). */
export const SCAN_SOURCES = ["windows_update", "apt", "dnf", "yum", "zypper", "macos"] as const
export type ScanSource = (typeof SCAN_SOURCES)[number]
export const SOURCE_LABELS: Record<string, string> = {
  windows_update: "Windows Update",
  apt: "APT",
  dnf: "DNF",
  yum: "YUM",
  zypper: "Zypper",
  macos: "macOS Software Update",
  package: "Offline package",
}

export function osFamilyForSource(source: ScanSource): OsFamily {
  if (source === "windows_update") return "windows"
  if (source === "macos") return "macos"
  return "linux"
}

export const CLASSIFICATIONS = ["security", "critical", "update", "feature", "driver", "definition", "other"] as const
export type Classification = (typeof CLASSIFICATIONS)[number]

export const SEVERITIES = ["critical", "important", "moderate", "low", "unspecified"] as const
export type Severity = (typeof SEVERITIES)[number]

export const APPROVALS = ["pending", "approved", "declined"] as const
export type Approval = (typeof APPROVALS)[number]

export const PATCH_STATES = ["missing", "installed", "failed", "pending_reboot"] as const
export type PatchState = (typeof PATCH_STATES)[number]
/** States that count as "not installed yet". */
export const MISSING_STATES: PatchState[] = ["missing", "failed"]

/** Classifications that count for compliance. */
export const COMPLIANCE_CLASSIFICATIONS: Classification[] = ["security", "critical"]

export const JOB_KINDS = ["inventory", "scan", "install_patches", "run_script", "reboot", "update_agent"] as const
export type JobKind = (typeof JOB_KINDS)[number]
export const JOB_KIND_LABELS: Record<JobKind, string> = {
  inventory: "Inventory",
  scan: "Patch scan",
  install_patches: "Install patches",
  run_script: "Run script",
  reboot: "Reboot",
  update_agent: "Update agent",
}

export const JOB_STATUSES = ["queued", "dispatched", "running", "succeeded", "failed", "cancelled", "expired"] as const
export type JobStatus = (typeof JOB_STATUSES)[number]
export const ACTIVE_JOB_STATUSES: JobStatus[] = ["queued", "dispatched", "running"]

export const REBOOT_BEHAVIORS = ["never", "if_required", "always"] as const
export type RebootBehavior = (typeof REBOOT_BEHAVIORS)[number]
export const REBOOT_LABELS: Record<RebootBehavior, string> = {
  never: "Never reboot",
  if_required: "Reboot if an update needs it",
  always: "Always reboot",
}

export const DEPLOYMENT_STATUSES = ["draft", "scheduled", "running", "completed", "cancelled"] as const
export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number]

export const SHELLS = ["powershell", "cmd", "bash", "sh"] as const
export type Shell = (typeof SHELLS)[number]
export function shellsFor(os: string): Shell[] {
  return os === "windows" ? ["powershell", "cmd"] : ["bash", "sh"]
}

export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

/** A device is online when seen in the last 10 minutes, stale after 7 days. */
export const ONLINE_MINUTES = 10
export const STALE_DAYS = 7

export type Tone = "gray" | "blue" | "green" | "amber" | "red" | "purple" | "slate"

export function severityTone(s: string): Tone {
  return s === "critical" ? "red" : s === "important" ? "amber" : s === "moderate" ? "blue" : "gray"
}

export function approvalTone(a: string): Tone {
  return a === "approved" ? "green" : a === "declined" ? "red" : "amber"
}

export function jobTone(s: string): Tone {
  return s === "succeeded" ? "green" : s === "failed" ? "red" : s === "running" || s === "dispatched" ? "blue" : s === "queued" ? "amber" : "gray"
}

export function deploymentTone(s: string): Tone {
  return s === "completed" ? "green" : s === "running" ? "blue" : s === "scheduled" ? "amber" : s === "cancelled" ? "red" : "gray"
}

export function patchStateTone(s: string): Tone {
  return s === "installed" ? "green" : s === "failed" ? "red" : s === "pending_reboot" ? "purple" : "amber"
}

export function isOneOf<T extends string>(list: readonly T[], v: unknown): v is T {
  return typeof v === "string" && (list as readonly string[]).includes(v)
}

/** "3 d 4 h", "5 h 10 min", "12 min". */
export function formatUptime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "—"
  const s = Math.max(0, Math.floor(seconds))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d} d ${h} h`
  if (h > 0) return `${h} h ${m} min`
  return `${m} min`
}

/** Only http(s) links are rendered as links (agent-supplied URLs). */
export function safeHttpUrl(u: string | null | undefined): string | null {
  if (!u) return null
  return /^https?:\/\//i.test(u) ? u : null
}

/** Agent install one-liners (enrolment page). */
export function installCommands(serverUrl: string, token: string) {
  return {
    windows: `powershell -ExecutionPolicy Bypass -File itsm-agent.ps1 -Install -Server ${serverUrl} -Token ${token}`,
    linux: `sudo python3 itsm-agent.py install --server ${serverUrl} --token ${token}`,
  }
}

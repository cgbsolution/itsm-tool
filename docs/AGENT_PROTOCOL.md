# Endpoint agent protocol (v1)

The agent is a small program on each managed device. It talks to the ITSM server over HTTPS
(HTTP is allowed only for lab installs). The server never connects to the agent: the agent
polls for work. This works through NAT and firewalls, and needs only outbound 443 from the device.

All bodies are JSON (`Content-Type: application/json`), UTF-8. Times are ISO-8601 UTC.
Base path: `{SERVER}/api/agent/v1`.

## Authentication

1. **Enrolment** uses a one-time or multi-use *enrolment token* created by an admin in
   *Endpoints > Enrol devices*. The token is only used for `POST /enroll`.
2. Enrolment returns a `device_id` and a `device_secret`. The agent stores both locally
   (readable only by SYSTEM/root) and sends them on every other call:

   ```
   Authorization: Bearer <device_id>.<device_secret>
   ```

3. `401` on any call means the device was retired or its secret rotated: the agent must stop
   and log the error (re-enrol by an admin).

## Endpoints

### `POST /enroll`
Request:
```json
{
  "token": "enr_xxx",
  "hostname": "LAPTOP-042",
  "os_family": "windows",            // windows | linux | macos
  "os_name": "Microsoft Windows 11 Pro",
  "os_version": "10.0.26100",
  "arch": "x64",
  "agent_version": "1.0.0",
  "serial_no": "PF3ABC12",           // optional
  "mac_addresses": ["00:11:22:33:44:55"]  // optional
}
```
Response `200`:
```json
{ "device_id": "uuid", "device_secret": "base64url", "poll_interval_seconds": 60, "server_time": "..." }
```
Errors: `400` bad body, `403` token invalid/expired/used up, `402` licence device limit reached.

If a device with the same `hostname` + `serial_no` already exists and is active in the tenant,
the server rotates its secret and returns the existing `device_id` (re-install case).

### `POST /heartbeat`
Sent every poll interval (default 60 s).
```json
{
  "agent_version": "1.0.0",
  "hostname": "LAPTOP-042",
  "logged_on_user": "CORP\\asha",
  "uptime_seconds": 12345,
  "reboot_pending": false,
  "ip_addresses": ["10.0.0.12"]
}
```
Response: `{ "poll_interval_seconds": 60, "jobs_pending": 2, "server_time": "..." }`

### `POST /inventory`
Sent after enrolment, then every 24 h, and when an `inventory` job asks for it.
```json
{
  "hardware": {
    "manufacturer": "Dell Inc.", "model": "Latitude 7440", "serial_no": "PF3ABC12",
    "cpu": "13th Gen Intel(R) Core(TM) i7-1365U", "cpu_cores": 10, "ram_mb": 16384,
    "disks": [{ "name": "C:", "size_gb": 476.3, "free_gb": 210.1 }]
  },
  "os": { "name": "Microsoft Windows 11 Pro", "version": "10.0.26100", "build": "26100.2314", "arch": "x64", "domain": "CORP", "install_date": "2025-01-10" },
  "network": { "mac_addresses": ["00:11:22:33:44:55"], "ip_addresses": ["10.0.0.12"] },
  "software": [
    { "name": "Google Chrome", "version": "131.0.6778.86", "publisher": "Google LLC", "installed_on": "2026-11-02" }
  ]
}
```
Response: `{ "ok": true }`. The server updates the device, its software list, and the linked CMDB item.

### `POST /patches`
Patch scan results. Sent after every scan (daily by default, and on `scan` jobs).
```json
{
  "source": "windows_update",        // windows_update | apt | dnf | yum | zypper | macos
  "scanned_at": "2026-11-26T10:00:00Z",
  "available": [
    {
      "external_id": "c2b0f9a2-...",  // WUA UpdateID, or the package name for Linux
      "kb": "KB5046617",              // optional
      "title": "2026-11 Cumulative Update for Windows 11 ...",
      "classification": "security",   // security | critical | update | feature | driver | definition | other
      "severity": "critical",         // critical | important | moderate | low | unspecified
      "version": "",                  // Linux: candidate version
      "size_bytes": 123456789,
      "reboot_required": true,
      "release_date": "2026-11-11",
      "description": "...",
      "support_url": "https://..."
    }
  ],
  "installed": [
    { "external_id": "...", "kb": "KB5044284", "title": "...", "installed_on": "2026-10-10" }
  ]
}
```
`installed` may be empty or partial (Windows Update history; recent Linux upgrades).
Response: `{ "ok": true, "missing": 12 }`

### `GET /jobs?wait=25`
Long poll. The server answers as soon as jobs are queued for the device, or after `wait`
seconds (max 30) with an empty list. Returned jobs are marked `dispatched`.
```json
{ "jobs": [ { "id": "uuid", "kind": "install_patches", "payload": { } } ] }
```

Job kinds and payloads:

| kind | payload | agent does |
|---|---|---|
| `inventory` | `{}` | collect and `POST /inventory` |
| `scan` | `{}` | patch scan and `POST /patches` |
| `install_patches` | `{ "patches": [ { "patch_id", "external_id", "kb", "title", "package_url"?, "package_sha256"?, "package_name"? } ], "reboot": "never" \| "if_required" \| "always" }` | install each; if `package_url` is set, download from the server (offline/air-gap repository) with the device bearer token, verify SHA-256, install the file; otherwise install from the OS update source. Then rescan and `POST /patches` |
| `run_script` | `{ "shell": "powershell" \| "cmd" \| "bash" \| "sh", "script": "...", "timeout_seconds": 300 }` | run, capture stdout+stderr (truncate to 64 KB), report exit code |
| `reboot` | `{ "delay_seconds": 60, "message": "..." }` | schedule a reboot |
| `update_agent` | `{ "url": "...", "sha256": "..." }` | optional: download new agent script, verify, replace self |

### `POST /jobs/{id}`
Progress and result.
```json
{ "status": "running" }
```
```json
{
  "status": "succeeded",            // succeeded | failed
  "exit_code": 0,
  "output": "text (max 64 KB)",
  "result": {                        // install_patches only
    "results": [ { "external_id": "...", "status": "installed", "error": null } ],  // installed | failed | pending_reboot
    "reboot_required": false
  }
}
```
Response: `{ "ok": true }`. `409` if the job was cancelled (the agent should stop it if it can).

### `GET /packages/{patch_id}`
Download an offline package (air-gapped installs). Device bearer auth. Returns the file bytes
with `X-Content-SHA256`.

## Agent behaviour

- One loop: heartbeat → long-poll jobs → run jobs one at a time → repeat. Inventory every 24 h,
  patch scan every 24 h (also right after enrolment).
- Network errors: back off exponentially (5 s → 5 min) and keep running.
- Never run anything except the job kinds above. `run_script` runs as the agent's account
  (SYSTEM/root), so the server restricts it to admins with the `endpoint.run_script`
  permission and audit-logs every script.
- Log to a local file (rotate at 5 MB). Never log the device secret or enrolment token.
- TLS: verify certificates by default. A `ca_file` setting allows a private CA. An
  `insecure_skip_verify` setting exists for lab use only and logs a warning on each start.

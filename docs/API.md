# REST API

For integrations: HR systems, monitoring and alerting, scripts.

**Authentication:** create a token in *Administration › API tokens* and send it as
`Authorization: Bearer itsm_pat_…`. The token acts as the user it was created for, with that
user's permissions and tenant. Requests from a signed-in browser session also work (same-origin only
for writes).

Errors look like `{ "error": "message", "code": "…" }` with HTTP 400 / 401 / 403 / 404 / 409 / 429.

## Tickets

### `GET /api/v1/tickets`
Query parameters (all optional):

| Parameter | Values |
|---|---|
| `type` | incident, service_request, problem, change |
| `view` | active (default), resolved, done, all, or a status |
| `assignee` | me, unassigned, or a user id |
| `group` | mine, or a group id |
| `priority` | low, medium, high, critical |
| `requester` | me, or a user id |
| `sla` | breached, at_risk |
| `q` | number or text |
| `sort` | created, updated, priority, due |
| `page`, `page_size` | page_size up to 200 |

```json
{ "data": [ { "id": "…", "number": "INC0001016", "ticket_type": "incident", "status": "in_progress", "subject": "…", "priority": "high", … } ], "page": 1, "page_size": 50, "total": 3 }
```

### `POST /api/v1/tickets`
```json
{
  "type": "incident",
  "subject": "Disk almost full on SRV-DB01",
  "description": "Free space below 5%",
  "impact": "medium",
  "urgency": "high",
  "categoryId": "…",
  "requesterId": "…",
  "assignmentGroupId": "…",
  "ciIds": ["…"]
}
```
Returns `201 { "id", "number", "status", "priority", "url" }`. The same rules as the UI apply:
requesters can raise incidents and requests; problems and changes need the matching permission.
For changes you may also send `changeType`, `risk`, `implementationPlan`, `backoutPlan`,
`plannedStart`, `plannedEnd` (ISO-8601).

### `GET /api/v1/tickets/{number}`
Returns the ticket with SLA clocks, comments (internal notes only for IT staff), links, CIs,
`available_actions` and `version`.

### `POST /api/v1/tickets/{number}`
Add a comment:
```json
{ "comment": "Restarted the service", "internal": false }
```
Run a workflow action (one of `available_actions`):
```json
{ "action": "resolve", "resolutionCode": "Solved (permanently)", "resolutionNotes": "Cleaned up old logs", "version": 4 }
```
Action inputs: `hold` → `holdReason`, `holdHours`; `resolve` → `resolutionCode`, `resolutionNotes`
(problems: `rootCause`); `known_error` → `workaround`; `complete` (changes) → `outcome`;
`cancel` / `reopen` → `comment`.
`version` is optional; when sent, a stale version returns 409.

## Exports (CSV, signed-in users with `report.view` / `cmdb.view` / `audit.view`)
`/api/export/tickets?…same filters…`, `/api/export/cis`, `/api/export/compliance`, `/api/export/audit`.

## Health
- `GET /api/health`: the process is up (no database check).
- `GET /api/ready`: database reachable and no pending migrations (HTTP 503 otherwise).

## Endpoint agents
See `docs/AGENT_PROTOCOL.md`.

# ITSM endpoint agents

These are the programs that run on managed devices. Each agent enrols with the ITSM server, sends
heartbeats, inventory and patch-scan results, and long-polls the server for jobs. The server never
connects to the device. The agents follow the contract in [`docs/AGENT_PROTOCOL.md`](../docs/AGENT_PROTOCOL.md).

| Platform | File | Runtime | Runs as |
|---|---|---|---|
| Windows 10/11, Server 2016+ | `windows/itsm-agent.ps1` | Windows PowerShell 5.1 (built in) | `SYSTEM` (scheduled task `ITSM Agent`) |
| Debian/Ubuntu, RHEL/Rocky/Alma/Fedora, SUSE | `linux/itsm-agent.py` | Python 3.8+, standard library only | `root` (systemd unit `itsm-agent.service`) |
| macOS (best effort) | `linux/itsm-agent.py` | `python3` (Xcode Command Line Tools) | `root` (launchd daemon `com.itsm.agent`) |

## Network and firewall

- **The agent needs outbound TCP 443 to the ITSM server, and nothing else.** No inbound ports are
  opened. It works through NAT. Plain HTTP (`http://`) is accepted only for lab installs.
- The device's normal update sources still need to be reachable for OS patching: Windows Update or
  your WSUS server, apt/dnf/zypper mirrors, or Apple software update. This traffic comes from the
  OS update tools, not from the agent. On air-gapped networks, upload offline packages to the ITSM
  server. The agent then downloads them from the server (`package_url`) over the same 443 connection.
- Proxies: on Windows the agent uses the SYSTEM account's WinINET proxy settings (normally none).
  On Linux, set `https_proxy` in the service environment, for example with
  `systemctl edit itsm-agent` and `Environment=https_proxy=http://proxy:3128`.

## Install

Get an enrolment token from **Endpoints > Enrol devices** in the ITSM console. The token is used
only for enrolment and is never written to disk or to the log.

### Windows

From an **elevated** PowerShell prompt:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\itsm-agent.ps1 -Install `
    -Server https://itsm.example.com -Token enr_xxxxxxxx
```

Optional switches:

- `-CaFile C:\path\corp-root-ca.pem`: trust a private CA in addition to the Windows store. The file
  is copied to `C:\ProgramData\ITSMAgent\ca.pem`.
- `-InsecureSkipVerify`: skip TLS certificate verification. Use this in a lab only.
- To keep the token out of the process list and shell history, leave out `-Token` and set
  `$env:ITSM_ENROLL_TOKEN` before you run the script.

The install does the following:

1. It copies the script to `C:\Program Files\ITSMAgent\itsm-agent.ps1`.
2. It creates `C:\ProgramData\ITSMAgent\` with an ACL for SYSTEM and Administrators only.
3. It enrols, then writes `config.json`.
4. It registers the scheduled task **ITSM Agent** and starts it. The task runs as SYSTEM, at startup,
   with no time limit, and restarts every minute on failure. A 5-minute watchdog trigger restarts the
   agent if it ever exits, and is a no-op while the agent is running.

Running `-Install` again re-enrols the device. The server recognises the same hostname and serial
number, keeps the device record, and rotates the secret.

Mass deployment: run the same command from Intune, ConfigMgr, a GPO startup script, or your RMM as
SYSTEM. If Group Policy enforces the `AllSigned` execution policy, sign `itsm-agent.ps1` with your
code-signing certificate. `-ExecutionPolicy Bypass` cannot override a machine policy.

### Linux

```bash
sudo python3 itsm-agent.py install --server https://itsm.example.com --token enr_xxxxxxxx
# optional: --ca-file /path/corp-root-ca.pem   --insecure-skip-verify (lab only)
# or keep the token off the command line:
sudo ITSM_ENROLL_TOKEN=enr_xxxxxxxx python3 itsm-agent.py install --server https://itsm.example.com
```

The install copies the agent to `/opt/itsm-agent/itsm-agent.py`. It then enrols and writes
`/etc/itsm-agent/config.json` (mode 0600). Finally it writes, enables and starts the systemd unit
`/etc/systemd/system/itsm-agent.service`, with `Restart=always`. On a system without systemd, the
installer prints the command to run from your init system.

For mass deployment, use Ansible, Salt or cloud-init: copy the file and run the same command.

### macOS

```bash
sudo /usr/bin/python3 itsm-agent.py install --server https://itsm.example.com --token enr_xxxxxxxx
```

This installs the launchd daemon `/Library/LaunchDaemons/com.itsm.agent.plist`. State is kept in
`/Library/Application Support/ITSMAgent`. `/usr/bin/python3` needs the Xcode Command Line Tools.

## Uninstall

```powershell
# Windows (elevated)
& "C:\Program Files\ITSMAgent\itsm-agent.ps1" -Uninstall
```

```bash
# Linux / macOS
sudo python3 /opt/itsm-agent/itsm-agent.py uninstall
```

Uninstall stops and removes the task or service, then deletes the program files, config, state,
downloaded packages and logs. The device record stays on the server. Retire it in the console.

## Files

| | Windows | Linux | macOS |
|---|---|---|---|
| Program | `C:\Program Files\ITSMAgent\itsm-agent.ps1` | `/opt/itsm-agent/itsm-agent.py` | same as Linux |
| Config (secret) | `C:\ProgramData\ITSMAgent\config.json` (SYSTEM + Administrators ACL) | `/etc/itsm-agent/config.json` (0600 root) | same as Linux |
| Private CA copy | `C:\ProgramData\ITSMAgent\ca.pem` | `/etc/itsm-agent/ca.pem` | same as Linux |
| State (last inventory/scan, 401 flag) | `C:\ProgramData\ITSMAgent\state.json` | `/var/lib/itsm-agent/state.json` | `/Library/Application Support/ITSMAgent/state.json` |
| Offline package downloads (temporary) | `C:\ProgramData\ITSMAgent\packages\` | `/var/lib/itsm-agent/packages/` | under the state dir |
| Log (rotated at 5 MB, 3 old files) | `C:\ProgramData\ITSMAgent\agent.log` | `/var/log/itsm-agent.log` | `/var/log/itsm-agent.log` |
| Service | scheduled task `ITSM Agent` | `itsm-agent.service` | `com.itsm.agent` |

### `config.json` fields

| Field | Meaning |
|---|---|
| `server_url` | Server base URL without `/api/agent/v1`, for example `https://itsm.example.com` |
| `device_id` | Device UUID returned by `POST /enroll` |
| `device_secret` | Device secret returned by `POST /enroll`. Sent as `Authorization: Bearer <device_id>.<device_secret>`. Treat it like a password. |
| `ca_file` | Path of a private CA bundle to trust in addition to the OS store, or `null` |
| `insecure_skip_verify` | `true` disables TLS verification (lab only; a warning is logged on every start) |
| `poll_interval_seconds` | Heartbeat interval from the server (default 60). Updated from each heartbeat response. |
| `enrolled_at`, `agent_version` | Informational |

To move a device to a new server URL or CA, run the install again.

## How it behaves

- **Loop.** The agent sends a heartbeat every `poll_interval_seconds`. Between heartbeats it
  long-polls `GET /jobs?wait=25` with a 45 s client timeout, and runs the jobs it gets one at a time.
- **Inventory and patch scan.** Both run right after enrolment and then every 24 h, plus on
  `inventory` and `scan` jobs. If a scan fails for a non-network reason (for example a Windows
  Update error or a broken repository), the agent tries again in 1 h.
- **Network errors and HTTP 5xx, 408 or 429.** The agent backs off exponentially from 5 s to 5 min,
  with jitter, and keeps running.
- **HTTP 401 on any call.** The agent logs the error, records it in `state.json`, and stops. Until
  an admin re-enrols the device, the service or task exits as soon as it starts. Re-enrol by running
  the install again.
- **HTTP 409 when reporting a job.** The job was cancelled. If the agent sees the 409 before it
  starts the job, it skips the job.
- **Job results.** The agent posts `running` when a job starts. When the job finishes, it posts the
  result, retrying up to 6 times on network errors. Output is limited to 64 KB, keeping the head and
  the tail of the output.

### Jobs

| Kind | Windows | Linux / macOS |
|---|---|---|
| `inventory` | CIM classes plus 64-bit and 32-bit Uninstall registry keys | `/etc/os-release`, `/proc`, `/sys/class/dmi/id`, `df`/`lsblk`, `ip -j addr`, `dpkg-query` or `rpm` (macOS: `sysctl`, `ioreg`, `/Applications`) |
| `scan` | Windows Update Agent search `IsInstalled=0 and Type='Software' and IsHidden=0`, plus the last 100 history entries. Honours the device's WSUS configuration. | apt (`apt-get update` + `apt list --upgradable`), dnf/yum (`check-update` + `updateinfo list --security`), zypper (`list-updates` + `list-patches`), `softwareupdate -l` |
| `install_patches` | WUA download and install by UpdateID. Offline `.msu` (wusa), `.cab` (DISM), `.msi` (msiexec), `.exe` (`/quiet /norestart`). Exit codes 3010 and 1641 mean `pending_reboot`. | `apt-get install --only-upgrade`, `dnf upgrade`, `yum update`, `zypper update`, `softwareupdate -i`. Offline `.deb` (`dpkg -i`) and `.rpm` (`rpm -Uvh`). |
| `run_script` | `powershell` or `cmd`. The whole process tree is killed on timeout. | `bash` or `sh`. The whole process group is killed on timeout. |
| `reboot` | `shutdown.exe /r /t <delay> /c <message>` (minimum 10 s) | `shutdown -r +<minutes> <message>` (rounded up to whole minutes, minimum 1) |
| `update_agent` | Downloads, checks the SHA-256, parse-checks, replaces the script and restarts the task | Downloads, checks the SHA-256, compiles, replaces the script and re-execs |

The `reboot` field of `install_patches` works the same on all platforms. `never` never restarts.
`if_required` restarts after 60 s if any update reports that a reboot is needed or the OS reports a
pending reboot. `always` always restarts. The agent posts the job result before it schedules the
restart. If `reboot` is missing, the agent treats it as `never`.

After an install, the agent rescans and posts `/patches` before it reports the job result.

## Testing

Read-only checks. These need no enrolment and do not contact the ITSM server:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\itsm-agent.ps1 -Collect             # heartbeat + inventory JSON
powershell -NoProfile -ExecutionPolicy Bypass -File .\itsm-agent.ps1 -Collect -IncludePatches   # also a WU scan
```

```bash
python3 itsm-agent.py collect             # heartbeat + inventory JSON
sudo python3 itsm-agent.py collect --patches
```

To test an installed agent end to end (one heartbeat, then an inventory and a patch scan, then exit
with code 0 on success):

```powershell
& "C:\Program Files\ITSMAgent\itsm-agent.ps1" -Once
```

```bash
sudo python3 /opt/itsm-agent/itsm-agent.py once
```

`-Once` and `once` can run while the service is running. The service then sees the fresh
inventory and scan timestamps and does not repeat them.

## Troubleshooting

Start with the log: `C:\ProgramData\ITSMAgent\agent.log` or `/var/log/itsm-agent.log`. On Linux,
`journalctl -u itsm-agent` also shows startup errors. `Get-ScheduledTask 'ITSM Agent' | Get-ScheduledTaskInfo`
shows the task's last result.

| Symptom | Cause and fix |
|---|---|
| `Enrolment refused (403)` | The token is wrong, expired, revoked or used up. Create a new token. |
| `Enrolment refused (402)` | The licence device limit has been reached. |
| `401 Unauthorized ... agent is stopping` | The device was retired or its secret was rotated. Run the install again with a new token. The `auth_failed` flag in `state.json` keeps the agent stopped until then. |
| `network error: ... could not establish trust relationship` / `CERTIFICATE_VERIFY_FAILED` | The server certificate is not trusted. Install with `-CaFile` / `--ca-file` pointing to your CA (PEM). Check that the URL hostname matches the certificate. A name mismatch is never accepted, even with a CA file. |
| `retrying in N s` repeatedly | The device cannot reach the server on 443: check DNS, firewall and proxy. The agent keeps retrying, up to every 5 minutes. |
| Windows scan fails with `0x8024402C` / `0x80072EE2` | Windows Update or WSUS is unreachable. Check `HKLM\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate`. |
| Windows script does not start | The machine policy is `AllSigned`. Sign `itsm-agent.ps1`. |
| apt: `Could not get lock /var/lib/dpkg/lock-frontend` | `unattended-upgrades` or another apt process is running. The job fails and can be retried. |
| `update not offered by Windows Update` | The update is no longer applicable (superseded, already installed, or hidden). Run a `scan` job to refresh. |
| `package_sha256 is missing` | The server sent a `package_url` without a hash. The agent never installs an unverified file. |

To run the agent in the foreground for debugging, stop the service or task first, then run
`itsm-agent.ps1 -Run` from an elevated prompt or `sudo python3 /opt/itsm-agent/itsm-agent.py run`.
A second `-Run`/`run` instance exits at once because of the single-instance lock.

## Security notes

- **The agent runs as SYSTEM or root.** It must, to install updates, so anyone who controls the
  server or the device credentials can run code on the device. Protect the server accordingly.
- **`run_script` runs arbitrary scripts as SYSTEM or root.** The server limits it to admins with
  the `endpoint.run_script` permission and audit-logs every script. The agent does not log script
  contents, only the job id, the shell and the exit code. The agent runs only the six job kinds in
  the protocol. Anything else is reported as failed.
- **Credentials.** The device secret is stored only in `config.json`. On Windows the file is
  readable only by SYSTEM and Administrators. On Linux and macOS it is mode 0600, owned by root. The
  secret and the enrolment token are never written to the log: they are masked as `***` even if
  they appear in a server error message.
- **TLS.** Certificates are verified by default against the OS trust store, with a minimum of
  TLS 1.2. `ca_file` adds a private CA. It does not replace the OS store, and hostname checks still
  apply. `insecure_skip_verify` turns verification off, for labs only, and logs a warning on every
  start. Plain `http://` works but exposes the device secret on the network. Use it in a lab only.
- **Downloads.** Offline packages and agent updates must match the SHA-256 in the job payload, or
  they are not installed. The bearer token is sent only to the ITSM server's own origin. It is
  never sent to another host, and never forwarded on a cross-origin redirect.
- **Files.** Package names from the server are sanitised before use as file or package names. Linux
  package names that look like command-line options are rejected.

## Known limitations

- **Windows:** WUA search and install calls cannot be cancelled while running. A cancelled job is
  detected only when the agent reports its status. A user-scoped software inventory (per-user
  Uninstall keys under HKCU) is not collected.
- **Linux:** severity is available only from dnf/yum `updateinfo` and zypper patches. Other apt
  updates report `unspecified`. For zypper, security patches are matched to packages by the source
  names in the patch summary, which is a heuristic. For offline `.deb` files, dependencies are not
  resolved: `dpkg -i` fails if dependencies are missing.
- **macOS:** best effort. Installing macOS upgrades with `softwareupdate` may need user
  authorisation on Apple silicon. Software inventory covers `/Applications` only.
- The `installed` list in patch reports is partial by design. On Windows it comes from update
  history. On apt systems it comes from `/var/log/apt/history.log`. On rpm systems it comes from
  recent install times.

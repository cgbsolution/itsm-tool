#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ITSM endpoint agent for Linux and macOS (agent protocol v1).

Standard library only, Python 3.8+. Runs as root. The server never connects to the
device: the agent polls over HTTPS (outbound 443 only).

Commands:
  install --server URL --token TOKEN [--ca-file PATH] [--insecure-skip-verify]
  run         main loop (used by the systemd unit / launchd daemon)
  once        one heartbeat + inventory + patch scan, then exit (testing)
  uninstall   remove the service, program files, config and state
  collect     print heartbeat/inventory JSON locally, without contacting the server

Supported package managers: apt (Debian/Ubuntu), dnf / yum (RHEL, Rocky, Alma, Fedora),
zypper (SUSE) and softwareupdate (macOS, best effort).

Protocol: docs/AGENT_PROTOCOL.md
"""

import argparse
import hashlib
import http.client
import json
import logging
import logging.handlers
import math
import os
import platform
import plistlib
import random
import re
import shlex
import shutil
import signal
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

try:
    import fcntl
except ImportError:  # pragma: no cover - not available on Windows (development only)
    fcntl = None
try:
    import pwd
except ImportError:  # pragma: no cover
    pwd = None

AGENT_VERSION = "1.0.0"
IS_MACOS = sys.platform == "darwin"
OS_FAMILY = "macos" if IS_MACOS else "linux"

# ITSM_AGENT_ROOT prefixes every path below. Development and testing only.
_ROOT = os.environ.get("ITSM_AGENT_ROOT", "").rstrip("/")


def _p(path):
    return _ROOT + path if _ROOT else path


INSTALL_DIR = _p("/opt/itsm-agent")
INSTALLED_SCRIPT = INSTALL_DIR + "/itsm-agent.py"
CONFIG_DIR = _p("/etc/itsm-agent")
CONFIG_PATH = CONFIG_DIR + "/config.json"
CA_COPY_PATH = CONFIG_DIR + "/ca.pem"
STATE_DIR = _p("/Library/Application Support/ITSMAgent" if IS_MACOS else "/var/lib/itsm-agent")
STATE_PATH = STATE_DIR + "/state.json"
LOCK_PATH = STATE_DIR + "/agent.lock"
PACKAGE_DIR = STATE_DIR + "/packages"
WORK_DIR = STATE_DIR + "/work"
LOG_PATH = _p("/var/log/itsm-agent.log")
SYSTEMD_UNIT_NAME = "itsm-agent.service"
SYSTEMD_UNIT_PATH = _p("/etc/systemd/system/" + SYSTEMD_UNIT_NAME)
LAUNCHD_LABEL = "com.itsm.agent"
LAUNCHD_PLIST = _p("/Library/LaunchDaemons/" + LAUNCHD_LABEL + ".plist")

API_PREFIX = "/api/agent/v1"
USER_AGENT = "itsm-agent/%s (%s; python %s)" % (AGENT_VERSION, OS_FAMILY, platform.python_version())
LOG_MAX_BYTES = 5 * 1024 * 1024
LOG_BACKUPS = 3
OUTPUT_LIMIT = 64000            # bytes of UTF-8 (protocol: max 64 KB)
INVENTORY_INTERVAL = 86400
SCAN_INTERVAL = 86400
LONG_POLL_WAIT = 25
LONG_POLL_TIMEOUT = 45          # client timeout above the 30 s server maximum
PACKAGE_TIMEOUT = 7200
BACKOFF_MIN = 5
BACKOFF_MAX = 300
# systemd: Restart=always + RestartPreventExitStatus=78 keeps a 401-stopped agent stopped.
# launchd: KeepAlive SuccessfulExit=false does the same for exit code 0.
AUTH_EXIT_CODE = 0 if IS_MACOS else 78

SAFE_PKG = re.compile(r"^[A-Za-z0-9][A-Za-z0-9+._:@~-]*$")
SAFE_JOB_ID = re.compile(r"^[A-Za-z0-9_-]{1,100}$")
SEV_RANK = {"unspecified": 0, "low": 1, "moderate": 2, "important": 3, "critical": 4}
JUNK_VALUES = set([
    "to be filled by o.e.m.", "default string", "system serial number", "system product name",
    "system manufacturer", "not specified", "not applicable", "none", "n/a", "0", "00000000",
    "0123456789", "chassis serial number", "serial number", "invalid", "unknown", "oem",
])
VIRTUAL_IFACE_PREFIXES = ("lo", "docker", "veth", "br-", "virbr", "cni", "flannel", "cali", "lxc",
                          "tun", "tap", "vmnet", "utun", "awdl", "llw", "bridge", "gif", "stf", "anpi", "ap1")
REBOOT_PKG_PREFIXES = ("linux-image", "linux-generic", "linux-signed", "linux-modules", "kernel",
                       "glibc", "libc6", "systemd", "dbus", "linux-firmware", "microcode", "intel-microcode",
                       "amd64-microcode", "ucode")

log = logging.getLogger("itsm-agent")
_SECRETS = []
_STOP = {"requested": False, "in_job": False}


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
def add_secret(value):
    if value and value not in _SECRETS:
        _SECRETS.append(value)


def scrub(text):
    if not text:
        return text
    for s in _SECRETS:
        if s and len(s) >= 6:
            text = text.replace(s, "***")
    return text


class _ScrubFilter(logging.Filter):
    def filter(self, record):
        try:
            msg = record.getMessage()
        except Exception:  # noqa: BLE001 - never let logging break the agent
            msg = str(record.msg)
        record.msg = scrub(msg)
        record.args = None
        return True


def setup_logging(console):
    log.setLevel(logging.INFO)
    log.handlers[:] = []
    log.addFilter(_ScrubFilter())
    fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s", "%Y-%m-%dT%H:%M:%SZ")
    fmt.converter = time.gmtime
    try:
        log_dir = os.path.dirname(LOG_PATH)
        if log_dir and not os.path.isdir(log_dir):
            os.makedirs(log_dir, 0o755)
        fh = logging.handlers.RotatingFileHandler(LOG_PATH, maxBytes=LOG_MAX_BYTES,
                                                  backupCount=LOG_BACKUPS, encoding="utf-8")
        fh.setFormatter(fmt)
        log.addHandler(fh)
        try:
            os.chmod(LOG_PATH, 0o600)
        except OSError:
            pass
    except OSError as e:
        if console:
            sys.stderr.write("warning: cannot write log file %s: %s\n" % (LOG_PATH, e))
    if console:
        sh = logging.StreamHandler(sys.stderr)
        sh.setFormatter(fmt)
        log.addHandler(sh)
    if not log.handlers:
        log.addHandler(logging.NullHandler())


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------
class ApiError(Exception):
    """kind: network (retry with backoff) | http (rejected) | auth (401: stop) | cancelled (409)."""

    def __init__(self, kind, status, message):
        Exception.__init__(self, message)
        self.kind = kind
        self.status = status


class ScanError(Exception):
    pass


def utc_now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def date_from_epoch(ts):
    try:
        return datetime.fromtimestamp(float(ts), timezone.utc).strftime("%Y-%m-%d")
    except (TypeError, ValueError, OverflowError, OSError):
        return None


def file_date(path):
    try:
        return date_from_epoch(os.path.getmtime(path))
    except OSError:
        return None


def read_text(path, default=""):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return default


def read_json(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def write_json(path, obj, mode=0o600):
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2, sort_keys=True)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())
    os.chmod(tmp, mode)
    os.replace(tmp, path)


def ensure_dir(path, mode=0o700):
    if not os.path.isdir(path):
        os.makedirs(path, mode)
    try:
        os.chmod(path, mode)
    except OSError:
        pass


def clean_value(value):
    if value is None:
        return None
    s = str(value).strip().strip("\x00").strip()
    if not s or s.lower() in JUNK_VALUES:
        return None
    return s


def clamp_int(value, lo, hi, default):
    try:
        v = int(value)
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, v))


def tail(text, limit=600):
    text = (text or "").strip()
    if len(text) <= limit:
        return text
    return "..." + text[-limit:]


def limit_output(text, limit=OUTPUT_LIMIT):
    """Keep job output within the protocol limit (64 KB), preserving head and tail."""
    if not text:
        return ""
    if len(text.encode("utf-8", "replace")) <= limit:
        return text
    for keep in (30000, 10000):
        if len(text) > 2 * keep:
            cut = text[:keep] + "\n...[output truncated]...\n" + text[-keep:]
            if len(cut.encode("utf-8", "replace")) <= limit:
                return cut
    return text[:15000]


def read_head_tail(fobj, max_bytes=65536):
    fobj.seek(0, os.SEEK_END)
    size = fobj.tell()
    fobj.seek(0)
    if size <= max_bytes:
        return fobj.read().decode("utf-8", "replace")
    half = max_bytes // 2
    head = fobj.read(half)
    fobj.seek(size - half)
    rest = fobj.read(half)
    return (head.decode("utf-8", "replace") + "\n...[%d bytes truncated]...\n" % (size - 2 * half)
            + rest.decode("utf-8", "replace"))


def normalize_sha(value):
    if not value:
        return None
    v = str(value).strip().lower()
    if v.startswith("sha256:"):
        v = v[7:]
    if not re.match(r"^[0-9a-f]{64}$", v):
        return None
    return v


def normalize_server_url(url):
    u = (url or "").strip().rstrip("/")
    if u.lower().endswith(API_PREFIX):
        u = u[: -len(API_PREFIX)]
    return u.rstrip("/")


def url_origin(url):
    p = urllib.parse.urlsplit(url)
    port = p.port
    if port is None:
        port = 443 if p.scheme == "https" else 80
    return (p.scheme.lower(), (p.hostname or "").lower(), port)


def ensure_path():
    if os.name == "nt":
        return
    parts = [x for x in os.environ.get("PATH", "").split(os.pathsep) if x]
    for d in ("/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"):
        if d not in parts:
            parts.append(d)
    os.environ["PATH"] = os.pathsep.join(parts)


def c_env(extra=None):
    env = dict(os.environ)
    env["LC_ALL"] = "C"
    env["LANG"] = "C"
    env["LANGUAGE"] = "C"
    if extra:
        env.update(extra)
    return env


def apt_env():
    return c_env({"DEBIAN_FRONTEND": "noninteractive", "NEEDRESTART_MODE": "a",
                  "APT_LISTCHANGES_FRONTEND": "none", "UCF_FORCE_CONFFOLD": "1"})


def _dec(data):
    if not data:
        return ""
    if isinstance(data, bytes):
        return data.decode("utf-8", "replace")
    return data


def run_cmd(args, timeout=600, env=None):
    """Run a command. Returns (returncode, stdout, stderr); returncode None if it could not
    be started, -1 on timeout."""
    try:
        p = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           stdin=subprocess.DEVNULL, timeout=timeout, env=env)
    except FileNotFoundError:
        return None, "", "%s: command not found" % args[0]
    except subprocess.TimeoutExpired as e:
        return -1, _dec(e.stdout), "%s timed out after %s s" % (args[0], timeout)
    except OSError as e:
        return None, "", "%s: %s" % (args[0], e)
    return p.returncode, _dec(p.stdout), _dec(p.stderr)


def which(name):
    return shutil.which(name)


def require_root():
    if os.name != "nt" and os.geteuid() != 0:
        sys.stderr.write("error: this command must be run as root (sudo)\n")
        sys.exit(1)


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------
class _SafeRedirect(urllib.request.HTTPRedirectHandler):
    """Never forward the device bearer token to a different origin on redirect."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        new = urllib.request.HTTPRedirectHandler.redirect_request(self, req, fp, code, msg, headers, newurl)
        if new is not None and url_origin(newurl) != url_origin(req.full_url):
            new.remove_header("Authorization")
        return new


def build_ssl_context(ca_file, insecure):
    ctx = ssl.create_default_context()
    try:
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    except (AttributeError, ValueError):
        ctx.options |= getattr(ssl, "OP_NO_TLSv1", 0) | getattr(ssl, "OP_NO_TLSv1_1", 0)
    if ca_file:
        ctx.load_verify_locations(cafile=ca_file)   # in addition to the system trust store
    if insecure:
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    return ctx


class Http(object):
    def __init__(self, server_url, device_id=None, device_secret=None, ca_file=None, insecure=False):
        self.server = normalize_server_url(server_url)
        self.api_base = self.server + API_PREFIX
        self.device_id = device_id
        self.device_secret = device_secret
        self.ctx = build_ssl_context(ca_file, insecure)
        self.opener = urllib.request.build_opener(_SafeRedirect(), urllib.request.HTTPSHandler(context=self.ctx))

    def auth_header(self):
        return "Bearer %s.%s" % (self.device_id, self.device_secret)

    def request(self, method, path, body=None, timeout=60, auth=True):
        url = self.api_base + path
        what = "%s %s" % (method, path.split("?", 1)[0])
        headers = {"Accept": "application/json", "User-Agent": USER_AGENT}
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json; charset=utf-8"
        if auth:
            headers["Authorization"] = self.auth_header()
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with self.opener.open(req, timeout=timeout) as resp:
                raw = resp.read()
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read(2048).decode("utf-8", "replace").strip()
            except Exception:  # noqa: BLE001
                pass
            raise self._http_error(e.code, what, detail)
        except (urllib.error.URLError, socket.timeout, ssl.SSLError, http.client.HTTPException,
                ConnectionError, OSError) as e:
            reason = getattr(e, "reason", None) or e
            raise ApiError("network", 0, "%s: network error: %s" % (what, reason))
        if not raw or not raw.strip():
            return {}
        try:
            return json.loads(raw.decode("utf-8"))
        except ValueError:
            raise ApiError("http", 200, "%s: server returned invalid JSON" % what)

    @staticmethod
    def _http_error(status, what, detail):
        msg = "%s: HTTP %s" % (what, status)
        if detail:
            msg += ": " + detail[:300]
        if status == 401:
            return ApiError("auth", status, msg)
        if status == 409:
            return ApiError("cancelled", status, msg)
        if status >= 500 or status in (408, 429):
            return ApiError("network", status, msg)
        return ApiError("http", status, msg)

    def resolve_url(self, url):
        if re.match(r"^[A-Za-z][A-Za-z0-9+.-]*://", url):
            return url
        if url.startswith("/"):
            p = urllib.parse.urlsplit(self.server)
            return "%s://%s%s" % (p.scheme, p.netloc, url)
        return self.api_base + "/" + url

    def download(self, url, dest, timeout=120):
        """Stream a file to dest. Returns (sha256_hex, x_content_sha256_header, content_disposition).
        The bearer token is only sent to the ITSM server itself."""
        absu = self.resolve_url(url)
        headers = {"User-Agent": USER_AGENT}
        if url_origin(absu) == url_origin(self.server):
            headers["Authorization"] = self.auth_header()
        else:
            log.info("downloading from %s without device credentials (not the ITSM server)",
                     urllib.parse.urlsplit(absu).hostname)
        what = "download %s" % urllib.parse.urlsplit(absu).path
        req = urllib.request.Request(absu, headers=headers)
        digest = hashlib.sha256()
        try:
            with self.opener.open(req, timeout=timeout) as resp:
                header_sha = resp.headers.get("X-Content-SHA256")
                disposition = resp.headers.get("Content-Disposition")
                with open(dest, "wb") as f:
                    while True:
                        chunk = resp.read(1024 * 1024)
                        if not chunk:
                            break
                        f.write(chunk)
                        digest.update(chunk)
        except urllib.error.HTTPError as e:
            raise self._http_error(e.code, what, "")
        except (urllib.error.URLError, socket.timeout, ssl.SSLError, http.client.HTTPException,
                ConnectionError, OSError) as e:
            raise ApiError("network", 0, "%s: %s" % (what, getattr(e, "reason", None) or e))
        return digest.hexdigest(), header_sha, disposition


# ---------------------------------------------------------------------------
# Config and state
# ---------------------------------------------------------------------------
class Config(object):
    def __init__(self, d):
        self.raw = d
        self.server_url = normalize_server_url(d.get("server_url") or "")
        self.device_id = str(d.get("device_id") or "")
        self.device_secret = str(d.get("device_secret") or "")
        self.ca_file = d.get("ca_file") or None
        self.insecure = bool(d.get("insecure_skip_verify"))
        self.poll_interval = clamp_int(d.get("poll_interval_seconds"), 10, 3600, 60)


def load_config():
    if not os.path.exists(CONFIG_PATH):
        raise SystemExit("error: agent is not enrolled (%s not found); run 'install' first" % CONFIG_PATH)
    d = read_json(CONFIG_PATH)
    if not isinstance(d, dict) or not d.get("server_url") or not d.get("device_id") or not d.get("device_secret"):
        raise SystemExit("error: %s is unreadable or incomplete; re-run 'install'" % CONFIG_PATH)
    cfg = Config(d)
    add_secret(cfg.device_secret)
    return cfg


def make_http(cfg):
    if cfg.insecure:
        log.warning("insecure_skip_verify is enabled: the server TLS certificate is NOT verified. "
                    "Use this for lab installs only.")
    if cfg.ca_file:
        log.info("trusting private CA file %s in addition to the system trust store", cfg.ca_file)
    return Http(cfg.server_url, cfg.device_id, cfg.device_secret, cfg.ca_file, cfg.insecure)


class State(object):
    def __init__(self):
        d = read_json(STATE_PATH)
        self.data = d if isinstance(d, dict) else {}

    def get(self, key, default=None):
        return self.data.get(key, default)

    def set(self, key, value):
        self.data[key] = value
        try:
            ensure_dir(STATE_DIR)
            write_json(STATE_PATH, self.data)
        except OSError as e:
            log.warning("could not save state: %s", e)

    def due(self, key, interval):
        try:
            last = float(self.data.get(key) or 0)
        except (TypeError, ValueError):
            last = 0
        return time.time() - last >= interval


# ---------------------------------------------------------------------------
# System information
# ---------------------------------------------------------------------------
def hostname():
    return socket.gethostname()


def arch_name():
    m = platform.machine().lower()
    return {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64", "arm64": "arm64", "i386": "x86",
            "i686": "x86", "x86": "x86", "armv7l": "arm", "armv6l": "arm"}.get(m, m or "unknown")


def os_release():
    data = {}
    text = read_text("/etc/os-release") or read_text("/usr/lib/os-release")
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        try:
            parts = shlex.split(v)
            v = parts[0] if parts else ""
        except ValueError:
            v = v.strip().strip('"').strip("'")
        data[k.strip()] = v
    return data


def os_info():
    if IS_MACOS:
        rc, name, _ = run_cmd(["sw_vers", "-productName"], timeout=15)
        rc2, ver, _ = run_cmd(["sw_vers", "-productVersion"], timeout=15)
        rc3, build, _ = run_cmd(["sw_vers", "-buildVersion"], timeout=15)
        version = ver.strip() or platform.mac_ver()[0]
        pname = name.strip() or "macOS"
        return {"name": ("%s %s" % (pname, version)).strip(), "version": version,
                "build": build.strip() or None}
    rel = os_release()
    name = rel.get("PRETTY_NAME") or ("%s %s" % (rel.get("NAME", "Linux"), rel.get("VERSION", ""))).strip()
    return {"name": name or "Linux", "version": rel.get("VERSION_ID") or platform.release(),
            "build": platform.release()}


def os_install_date():
    if IS_MACOS:
        return file_date("/var/db/.AppleSetupDone")
    for path in ("/var/log/installer", "/root/anaconda-ks.cfg", "/var/log/anaconda", "/etc/machine-id"):
        if os.path.exists(path):
            d = file_date(path)
            if d:
                return d
    return None


def os_domain():
    try:
        fqdn = socket.getfqdn()
    except OSError:
        return None
    if "." in fqdn and not fqdn.endswith(".localdomain") and not fqdn.startswith("localhost"):
        dom = fqdn.split(".", 1)[1]
        if dom and dom not in ("local", "lan", "home", "localdomain"):
            return dom
    return None


def dmi(name):
    return clean_value(read_text("/sys/class/dmi/id/" + name))


def sysctl(name):
    rc, out, _ = run_cmd(["sysctl", "-n", name], timeout=15)
    return out.strip() if rc == 0 else ""


def cpu_info():
    model = None
    cores = set()
    procs = 0
    phys = None
    for line in read_text("/proc/cpuinfo").splitlines():
        if ":" not in line:
            continue
        k, v = [x.strip() for x in line.split(":", 1)]
        if k == "processor":
            procs += 1
        elif k == "model name" and not model:
            model = v
        elif k in ("Hardware", "Model", "cpu model") and not model:
            model = v
        elif k == "physical id":
            phys = v
        elif k == "core id":
            cores.add((phys, v))
    if not model:
        rc, out, _ = run_cmd(["lscpu"], timeout=15, env=c_env())
        if rc == 0:
            for line in out.splitlines():
                if line.lower().startswith("model name:"):
                    model = line.split(":", 1)[1].strip()
                    break
    count = len(cores) or procs or (os.cpu_count() or None)
    return clean_value(model) or (platform.processor() or None), count


def ram_mb():
    for line in read_text("/proc/meminfo").splitlines():
        if line.startswith("MemTotal:"):
            try:
                return int(line.split()[1]) // 1024
            except (IndexError, ValueError):
                return None
    return None


def disks():
    result = []
    seen = set()
    rc, out, _ = run_cmd(["df", "-P", "-k"], timeout=30, env=c_env())
    if rc == 0:
        for line in out.splitlines()[1:]:
            parts = line.split()
            if len(parts) < 6:
                continue
            fs, mount = parts[0], " ".join(parts[5:])
            if not fs.startswith("/dev/") or fs.startswith("/dev/loop"):
                continue
            if IS_MACOS and mount.startswith("/System/Volumes/") and mount != "/System/Volumes/Data":
                continue
            if fs in seen:
                continue
            seen.add(fs)
            try:
                total_kb, avail_kb = int(parts[1]), int(parts[3])
            except ValueError:
                continue
            result.append({"name": mount, "size_gb": round(total_kb / 1048576.0, 1),
                           "free_gb": round(avail_kb / 1048576.0, 1)})
    if result or IS_MACOS:
        return result
    rc, out, _ = run_cmd(["lsblk", "-J", "-b", "-o", "NAME,SIZE,TYPE"], timeout=30)
    if rc == 0:
        try:
            for dev in json.loads(out).get("blockdevices", []):
                if dev.get("type") == "disk":
                    size = int(dev.get("size") or 0)
                    result.append({"name": "/dev/" + dev.get("name", "?"),
                                   "size_gb": round(size / 1073741824.0, 1), "free_gb": None})
        except (ValueError, TypeError, AttributeError):
            pass
    return result


def _is_virtual_iface(name):
    return (name or "").startswith(VIRTUAL_IFACE_PREFIXES)


def network_info(server_url=None):
    macs, ips = [], []
    if IS_MACOS:
        rc, out, _ = run_cmd(["ifconfig"], timeout=15, env=c_env())
        iface = None
        for line in out.splitlines():
            if line and not line[0].isspace():
                iface = line.split(":", 1)[0]
                continue
            if _is_virtual_iface(iface):
                continue
            s = line.strip()
            if s.startswith("ether "):
                mac = s.split()[1].lower()
                if mac not in macs:
                    macs.append(mac)
            elif s.startswith("inet "):
                ip = s.split()[1]
                if not ip.startswith(("127.", "169.254.")) and ip not in ips:
                    ips.append(ip)
            elif s.startswith("inet6 "):
                ip = s.split()[1].split("%", 1)[0]
                if not ip.lower().startswith("fe80") and ip != "::1" and ip not in ips:
                    ips.append(ip)
    else:
        rc, out, _ = run_cmd(["ip", "-j", "addr"], timeout=15)
        if rc == 0 and out.strip():
            try:
                for iface in json.loads(out):
                    name = iface.get("ifname", "")
                    if iface.get("link_type") == "loopback" or _is_virtual_iface(name):
                        continue
                    mac = (iface.get("address") or "").lower()
                    if iface.get("link_type") == "ether" and mac and mac != "00:00:00:00:00:00" and mac not in macs:
                        macs.append(mac)
                    for a in iface.get("addr_info", []) or []:
                        ip = a.get("local")
                        if ip and a.get("scope") == "global" and ip not in ips:
                            ips.append(ip)
            except (ValueError, TypeError, AttributeError):
                pass
        if not macs:
            try:
                for name in sorted(os.listdir("/sys/class/net")):
                    if _is_virtual_iface(name):
                        continue
                    mac = read_text("/sys/class/net/%s/address" % name).strip().lower()
                    if mac and mac != "00:00:00:00:00:00" and mac not in macs:
                        macs.append(mac)
            except OSError:
                pass
    if not ips:
        # Fallback: the source address the kernel would use to reach the server (no packets sent).
        target = "192.0.2.1"
        if server_url:
            target = urllib.parse.urlsplit(server_url).hostname or target
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            try:
                s.connect((target, 443))
                ip = s.getsockname()[0]
                if ip and not ip.startswith("127."):
                    ips.append(ip)
            finally:
                s.close()
        except OSError:
            pass
    return macs, ips


def logged_on_user():
    if IS_MACOS:
        try:
            uid = os.stat("/dev/console").st_uid
            if uid and pwd is not None:
                return pwd.getpwuid(uid).pw_name
        except (OSError, KeyError):
            pass
        return None
    rc, out, _ = run_cmd(["who"], timeout=10, env=c_env())
    if rc != 0:
        return None
    users = []
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 2:
            users.append((parts[0], parts[1], line))
    for user, tty, line in users:            # prefer a local graphical/console session
        if tty.startswith((":", "tty", "seat", "console")) or "(:" in line:
            return user
    return users[0][0] if users else None


def uptime_seconds():
    if IS_MACOS:
        m = re.search(r"sec\s*=\s*(\d+)", sysctl("kern.boottime"))
        if m:
            return max(0, int(time.time()) - int(m.group(1)))
        return None
    try:
        return int(float(read_text("/proc/uptime").split()[0]))
    except (IndexError, ValueError):
        return None


def serial_number():
    if IS_MACOS:
        rc, out, _ = run_cmd(["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"], timeout=15)
        m = re.search(r'"IOPlatformSerialNumber"\s*=\s*"([^"]+)"', out)
        return clean_value(m.group(1)) if m else None
    return dmi("product_serial") or dmi("chassis_serial")


def hardware_info():
    if IS_MACOS:
        mem = sysctl("hw.memsize")
        cores = sysctl("hw.physicalcpu")
        return {
            "manufacturer": "Apple Inc.",
            "model": clean_value(sysctl("hw.model")),
            "serial_no": serial_number(),
            "cpu": clean_value(sysctl("machdep.cpu.brand_string")),
            "cpu_cores": int(cores) if cores.isdigit() else os.cpu_count(),
            "ram_mb": int(mem) // 1048576 if mem.isdigit() else None,
            "disks": disks(),
        }
    cpu, cores = cpu_info()
    return {
        "manufacturer": dmi("sys_vendor") or dmi("board_vendor"),
        "model": dmi("product_name"),
        "serial_no": serial_number(),
        "cpu": cpu,
        "cpu_cores": cores,
        "ram_mb": ram_mb(),
        "disks": disks(),
    }


def installed_software():
    if IS_MACOS:
        return macos_apps()
    items = []
    if which("dpkg-query"):
        fmt = "${Status}\t${binary:Package}\t${Package}\t${Version}\t${Maintainer}\n"
        rc, out, err = run_cmd(["dpkg-query", "-W", "-f", fmt], timeout=120, env=c_env())
        seen = set()
        for line in out.splitlines():
            parts = line.split("\t")
            if len(parts) < 5 or not parts[0].endswith(" installed"):
                continue
            binpkg, name, version, maint = parts[1], parts[2], parts[3], parts[4]
            if (name, version) in seen:
                continue
            seen.add((name, version))
            installed_on = (file_date("/var/lib/dpkg/info/%s.list" % binpkg)
                            or file_date("/var/lib/dpkg/info/%s.list" % name))
            items.append({"name": name, "version": version, "publisher": clean_value(maint),
                          "installed_on": installed_on})
    elif which("rpm"):
        fmt = "%{NAME}\t%{VERSION}-%{RELEASE}\t%{VENDOR}\t%{INSTALLTIME}\n"
        rc, out, err = run_cmd(["rpm", "-qa", "--queryformat", fmt], timeout=120, env=c_env())
        seen = set()
        for line in out.splitlines():
            parts = line.split("\t")
            if len(parts) < 4 or parts[0] == "gpg-pubkey":
                continue
            if (parts[0], parts[1]) in seen:
                continue
            seen.add((parts[0], parts[1]))
            vendor = parts[2] if parts[2] != "(none)" else None
            items.append({"name": parts[0], "version": parts[1], "publisher": clean_value(vendor),
                          "installed_on": date_from_epoch(parts[3])})
    return items


def macos_apps():
    items = []
    seen = set()
    roots = ["/Applications", "/Applications/Utilities"]
    for root in roots:
        try:
            entries = sorted(os.listdir(root))
        except OSError:
            continue
        for entry in entries:
            if not entry.endswith(".app"):
                continue
            app = os.path.join(root, entry)
            info = {}
            try:
                with open(os.path.join(app, "Contents", "Info.plist"), "rb") as f:
                    info = plistlib.load(f)
            except Exception:  # noqa: BLE001 - malformed plists are common
                info = {}
            name = info.get("CFBundleDisplayName") or info.get("CFBundleName") or entry[:-4]
            version = str(info.get("CFBundleShortVersionString") or info.get("CFBundleVersion") or "")
            if (name, version) in seen:
                continue
            seen.add((name, version))
            bundle = str(info.get("CFBundleIdentifier") or "")
            publisher = None
            if bundle.count(".") >= 2:
                publisher = bundle.split(".")[1]
            items.append({"name": str(name), "version": version, "publisher": publisher,
                          "installed_on": file_date(app)})
    return items


_REBOOT_CACHE = {"at": 0.0, "value": False}


def reboot_required(force=False):
    if not force and time.time() - _REBOOT_CACHE["at"] < 600:
        return _REBOOT_CACHE["value"]
    value = _check_reboot_required()
    _REBOOT_CACHE["at"] = time.time()
    _REBOOT_CACHE["value"] = value
    return value


def _check_reboot_required():
    if IS_MACOS:
        return False
    for path in ("/var/run/reboot-required", "/run/reboot-required", "/run/reboot-needed",
                 "/var/run/reboot-needed"):
        if os.path.exists(path):
            return True
    if which("needs-restarting"):
        rc = run_cmd(["needs-restarting", "-r"], timeout=120, env=c_env())[0]
        if rc == 1:
            return True
        if rc == 0:
            return False
    elif which("dnf"):
        rc = run_cmd(["dnf", "-q", "needs-restarting", "-r"], timeout=120, env=c_env())[0]
        if rc == 1:
            return True
    if which("zypper"):
        rc = run_cmd(["zypper", "-q", "needs-rebooting"], timeout=120, env=c_env())[0]
        if rc == 102:
            return True
    return False


def reboot_package_names():
    names = set()
    for path in ("/var/run/reboot-required.pkgs", "/run/reboot-required.pkgs"):
        for line in read_text(path).splitlines():
            if line.strip():
                names.add(line.strip())
    if which("needs-restarting"):
        rc, out, _ = run_cmd(["needs-restarting", "-r"], timeout=120, env=c_env())
        for line in out.splitlines():
            m = re.match(r"^\s*\*\s*(\S+)", line)
            if m:
                names.add(m.group(1))
    return names


def is_reboot_pkg(name):
    return name.startswith(REBOOT_PKG_PREFIXES)


def heartbeat_body(server_url=None):
    macs, ips = network_info(server_url)
    return {
        "agent_version": AGENT_VERSION,
        "hostname": hostname(),
        "logged_on_user": logged_on_user(),
        "uptime_seconds": uptime_seconds(),
        "reboot_pending": bool(reboot_required()),
        "ip_addresses": ips,
    }


def enroll_body(token, server_url):
    osi = os_info()
    macs, ips = network_info(server_url)
    return {
        "token": token,
        "hostname": hostname(),
        "os_family": OS_FAMILY,
        "os_name": osi["name"],
        "os_version": osi["version"],
        "arch": arch_name(),
        "agent_version": AGENT_VERSION,
        "serial_no": serial_number(),
        "mac_addresses": macs,
    }


def collect_inventory(server_url=None):
    osi = os_info()
    macs, ips = network_info(server_url)
    return {
        "hardware": hardware_info(),
        "os": {
            "name": osi["name"],
            "version": osi["version"],
            "build": osi["build"],
            "arch": arch_name(),
            "domain": os_domain(),
            "install_date": os_install_date(),
        },
        "network": {"mac_addresses": macs, "ip_addresses": ips},
        "software": installed_software(),
    }


# ---------------------------------------------------------------------------
# Patch scan
# ---------------------------------------------------------------------------
def detect_pkg_manager():
    if IS_MACOS:
        return "macos" if which("softwareupdate") else None
    if which("apt-get") and which("dpkg-query"):
        return "apt"
    if which("dnf"):
        return "dnf"
    if which("yum"):
        return "yum"
    if which("zypper"):
        return "zypper"
    return None


def make_item(name, version, classification="update", severity="unspecified", kb=None, title=None,
              description=None, reboot=None, size=None, release_date=None, support_url=None):
    if reboot is None:
        reboot = is_reboot_pkg(name)
    return {
        "external_id": name,
        "kb": kb,
        "title": title or ("%s %s" % (name, version)).strip(),
        "classification": classification,
        "severity": severity,
        "version": version or "",
        "size_bytes": size,
        "reboot_required": bool(reboot),
        "release_date": release_date,
        "description": description,
        "support_url": support_url,
    }


APT_LIST_RE = re.compile(r"^(?P<name>[^/\s]+)/(?P<suites>\S+)\s+(?P<ver>\S+)\s+(?P<arch>\S+)\s+"
                         r"\[upgradable from:\s*(?P<old>[^\]]+)\]")
APT_SIM_RE = re.compile(r"^Inst\s+(?P<name>\S+)\s+(?:\[(?P<old>[^\]]*)\]\s+)?\((?P<ver>\S+)\s+"
                        r"(?P<origin>[^\[\)]*)(?:\[(?P<arch>[^\]]*)\])?\)")


def apt_upgradable():
    """{name: (candidate_version, is_security, installed_version, origin)} without refreshing."""
    result = {}
    rc, out, err = run_cmd(["apt", "list", "--upgradable"], timeout=300, env=apt_env())
    if rc == 0:
        for line in out.splitlines():
            m = APT_LIST_RE.match(line.strip())
            if m and m.group("name") not in result:
                suites = m.group("suites")
                result[m.group("name")] = (m.group("ver"), "-security" in suites, m.group("old").strip(), suites)
        return result
    rc, out, err = run_cmd(["apt-get", "-s", "-q", "upgrade"], timeout=300, env=apt_env())
    if rc != 0:
        raise ScanError("apt-get -s upgrade failed (exit %s): %s" % (rc, tail(err or out)))
    for line in out.splitlines():
        m = APT_SIM_RE.match(line)
        if m and m.group("name") not in result:
            origin = (m.group("origin") or "").strip().rstrip(",")
            result[m.group("name")] = (m.group("ver"), "-security" in origin, m.group("old") or "", origin)
    return result


def scan_apt():
    rc, out, err = run_cmd(["apt-get", "update", "-q"], timeout=1200, env=apt_env())
    if rc != 0:
        log.warning("apt-get update exited %s: %s", rc, tail(err or out, 400))
    items = []
    for name, (ver, security, old, origin) in sorted(apt_upgradable().items()):
        items.append(make_item(name, ver, "security" if security else "update",
                               description="%s %s -> %s (%s)" % (name, old or "?", ver, origin)))
    return items


def recent_apt_upgrades(limit=100):
    entries = []
    date = None
    for line in read_text("/var/log/apt/history.log").splitlines():
        if line.startswith("Start-Date:"):
            date = line.split(":", 1)[1].strip().split()[0] if line.split(":", 1)[1].strip() else None
        elif line.startswith("Upgrade:") and date:
            for m in re.finditer(r"([^\s,()]+?)(?::[a-z0-9]+)?\s+\(([^,()]+),\s*([^()]+?)\)", line[8:]):
                entries.append({"external_id": m.group(1), "kb": None,
                                "title": "%s %s" % (m.group(1), m.group(3).strip()), "installed_on": date})
    entries.reverse()
    seen, result = set(), []
    for e in entries:
        if e["external_id"] in seen:
            continue
        seen.add(e["external_id"])
        result.append(e)
        if len(result) >= limit:
            break
    return result


NEVRA_RE = re.compile(r"^(?P<name>.+)-(?:(?P<epoch>\d+):)?(?P<ver>[^-:]+)-(?P<rel>[^-]+)\.(?P<arch>[A-Za-z0-9_]+)$")
SKIP_PREFIXES = ("Obsoleting", "Security:", "Last metadata", "Loaded plugins", "Loading mirror",
                 "Updating Subscription", "Repository", "Upgrades", "Available Upgrades")


def parse_check_update(out):
    """Parse `dnf/yum check-update` output into {name: (version, arch, repo)}."""
    pkgs = {}
    tokens = []
    for line in out.splitlines():
        s = line.strip()
        if not s:
            continue
        if s.startswith("Obsoleting"):
            break
        if s.startswith(SKIP_PREFIXES) or s.startswith("*"):
            continue
        tokens.extend(s.split())
        while len(tokens) >= 3:
            name_arch, ver, repo = tokens[0], tokens[1], tokens[2]
            tokens = tokens[3:]
            if "." not in name_arch or not re.search(r"\d", ver):
                tokens = []
                break
            name, arch = name_arch.rsplit(".", 1)
            if name not in pkgs:
                pkgs[name] = (ver, arch, repo)
    return pkgs


def parse_updateinfo(out):
    """Parse `updateinfo list --security` (dnf4, dnf5, yum) into {name: (advisory, severity)}."""
    res = {}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) < 3:
            continue
        adv = parts[0]
        sev = "unspecified"
        for p in parts[1:]:
            k = p.split("/")[0].lower()
            if k in SEV_RANK and k != "unspecified":
                sev = k
                break
        pkg = None
        for p in reversed(parts[1:]):
            m = NEVRA_RE.match(p)
            if m:
                pkg = m.group("name")
                break
        if not pkg:
            continue
        prev = res.get(pkg)
        if prev is None or SEV_RANK[sev] > SEV_RANK[prev[1]]:
            res[pkg] = (adv, sev)
    return res


def dnf_check_update(tool, refresh):
    args = [tool, "-q", "check-update"]
    if refresh and tool == "dnf":
        args.append("--refresh")
    rc, out, err = run_cmd(args, timeout=1800, env=c_env())
    if rc not in (0, 100):
        raise ScanError("%s check-update failed (exit %s): %s" % (tool, rc, tail(err or out)))
    return parse_check_update(out)


def dnf_security(tool):
    attempts = [[tool, "-q", "updateinfo", "list", "--security"]]
    if tool == "yum":
        attempts.append([tool, "-q", "updateinfo", "list", "security"])
    for args in attempts:
        rc, out, err = run_cmd(args, timeout=900, env=c_env())
        if rc == 0:
            return parse_updateinfo(out)
    log.info("security advisory data is not available from %s updateinfo", tool)
    return {}


def scan_dnf(tool):
    pkgs = dnf_check_update(tool, refresh=True)
    sec = dnf_security(tool) if pkgs else {}
    items = []
    for name in sorted(pkgs):
        ver, arch, repo = pkgs[name]
        adv = sec.get(name)
        if adv:
            items.append(make_item(name, ver, "security", adv[1], kb=adv[0],
                                   description="%s.%s %s from %s (%s)" % (name, arch, ver, repo, adv[0])))
        else:
            items.append(make_item(name, ver, description="%s.%s %s from %s" % (name, arch, ver, repo)))
    return items


def recent_rpm_installs(limit=100):
    rc, out, err = run_cmd(["rpm", "-qa", "--queryformat", "%{INSTALLTIME}\t%{NAME}\t%{VERSION}-%{RELEASE}\n"],
                           timeout=120, env=c_env())
    if rc != 0:
        return []
    rows = []
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) != 3 or parts[1] == "gpg-pubkey":
            continue
        try:
            rows.append((int(parts[0]), parts[1], parts[2]))
        except ValueError:
            continue
    if not rows:
        return []
    base = min(r[0] for r in rows)
    rows = [r for r in rows if r[0] > base + 3600]    # skip the initial OS installation
    rows.sort(reverse=True)
    seen, result = set(), []
    for ts, name, ver in rows:
        if name in seen:
            continue
        seen.add(name)
        result.append({"external_id": name, "kb": None, "title": "%s %s" % (name, ver),
                       "installed_on": date_from_epoch(ts)})
        if len(result) >= limit:
            break
    return result


def zypper_xml(args, timeout=1800):
    rc, out, err = run_cmd(["zypper", "-n", "--xmlout"] + args, timeout=timeout, env=c_env())
    # 0 ok; 100-103 are informational (updates/security/reboot/restart needed); 106 repos skipped
    if rc is None or (rc != 0 and rc < 100):
        raise ScanError("zypper %s failed (exit %s): %s" % (" ".join(args), rc, tail(err or out)))
    start = out.find("<?xml")
    if start > 0:
        out = out[start:]
    try:
        return ET.fromstring(out)
    except ET.ParseError as e:
        raise ScanError("could not parse zypper XML output: %s" % e)


def zypper_updates():
    root = zypper_xml(["list-updates"])
    pkgs = {}
    for u in root.iter("update"):
        if u.get("kind", "package") != "package" or not u.get("name"):
            continue
        src = u.find("source")
        repo = src.get("alias", "") if src is not None else ""
        pkgs[u.get("name")] = (u.get("edition") or "", u.get("arch") or "", repo)
    return pkgs


def zypper_security_sources():
    """Needed security patches as (patch_name, severity, [source names from the summary])."""
    try:
        root = zypper_xml(["list-patches"])
    except ScanError as e:
        log.info("zypper list-patches unavailable: %s", e)
        return []
    out = []
    for u in root.iter("update"):
        if u.get("kind") != "patch" or (u.get("category") or "").lower() != "security":
            continue
        sev = (u.get("severity") or "").lower()
        if sev not in SEV_RANK:
            sev = "unspecified"
        summary = (u.findtext("summary") or "").strip()
        names = []
        m = re.search(r"[Ss]ecurity update for (.+)", summary)
        if m:
            for part in re.split(r",\s*|\s+and\s+", m.group(1)):
                part = part.strip().lower()
                if part.startswith("the "):
                    part = part[4:]
                if part:
                    names.append(part.replace(" ", "-"))
        out.append((u.get("name") or "", sev, names))
    return out


def zypper_match(pkg, sources):
    best = None
    lp = pkg.lower()
    for pname, sev, names in sources:
        for n in names:
            if lp.startswith(n) or ("kernel" in n and lp.startswith("kernel")):
                if best is None or SEV_RANK[sev] > SEV_RANK[best[1]]:
                    best = (pname, sev)
    return best


def scan_zypper():
    rc, out, err = run_cmd(["zypper", "-n", "refresh"], timeout=1200, env=c_env())
    if rc != 0:
        log.warning("zypper refresh exited %s: %s", rc, tail(err or out, 400))
    pkgs = zypper_updates()
    sources = zypper_security_sources() if pkgs else []
    items = []
    for name in sorted(pkgs):
        ver, arch, repo = pkgs[name]
        hit = zypper_match(name, sources)
        if hit:
            items.append(make_item(name, ver, "security", hit[1], kb=hit[0] or None,
                                   description="%s.%s %s from %s (%s)" % (name, arch, ver, repo, hit[0])))
        else:
            items.append(make_item(name, ver, description="%s.%s %s from %s" % (name, arch, ver, repo)))
    return items


def _size_to_bytes(text):
    m = re.match(r"^\s*([\d.]+)\s*([KMG]?)(i?B)?\s*$", text or "", re.I)
    if not m:
        return None
    mult = {"": 1, "K": 1024, "M": 1024 ** 2, "G": 1024 ** 3}[m.group(2).upper()]
    try:
        return int(float(m.group(1)) * mult)
    except ValueError:
        return None


def scan_macos():
    rc, out, err = run_cmd(["softwareupdate", "-l"], timeout=1800, env=c_env())
    text = out + "\n" + err
    if rc not in (0, None) and "No new software available" not in text and "* " not in text:
        raise ScanError("softwareupdate -l failed (exit %s): %s" % (rc, tail(text)))
    if rc is None:
        raise ScanError("softwareupdate is not available")
    lines = text.splitlines()
    items = []
    for i, line in enumerate(lines):
        m = re.match(r"^\s*\*\s*Label:\s*(.+?)\s*$", line)
        if m:
            label = m.group(1)
            details = lines[i + 1] if i + 1 < len(lines) else ""
            fields = dict((k.lower(), v.strip()) for k, v in re.findall(r"(\w+):\s*([^,]*)", details))
            title = fields.get("title") or label
            version = fields.get("version", "")
            reboot = "restart" in fields.get("action", "").lower()
            size = _size_to_bytes(fields.get("size", ""))
            rec = fields.get("recommended", "")
        else:
            m = re.match(r"^\s*\*\s+(\S.*?)\s*$", line)       # pre-10.15 format
            if not m:
                continue
            label = m.group(1)
            details = lines[i + 1].strip() if i + 1 < len(lines) else ""
            dm = re.match(r"^(.*?)\s*\(([^)]*)\),\s*(\d+)K", details)
            title = dm.group(1) if dm else label
            version = dm.group(2) if dm else ""
            size = int(dm.group(3)) * 1024 if dm else None
            reboot = "[restart]" in details
            rec = "yes" if "[recommended]" in details else ""
        blob = (label + " " + title).lower()
        cls = "security" if "security" in blob else "update"
        items.append(make_item(label, version, cls, kb=None, title=title, reboot=reboot, size=size,
                               description="%s %s%s" % (title, version, " (recommended)" if rec.lower().startswith("yes") else "")))
    return items


def recent_macos_updates(limit=100):
    rc, out, err = run_cmd(["softwareupdate", "--history"], timeout=120, env=c_env())
    if rc != 0:
        return []
    result = []
    for line in out.splitlines():
        m = re.match(r"^(.+?)\s{2,}(\S+)\s{2,}(\d{1,2})/(\d{1,2})/(\d{4})", line)
        if not m:
            continue
        name, ver = m.group(1).strip(), m.group(2)
        date = "%s-%02d-%02d" % (m.group(5), int(m.group(3)), int(m.group(4)))
        result.append({"external_id": name, "kb": None, "title": "%s %s" % (name, ver), "installed_on": date})
        if len(result) >= limit:
            break
    return result


def patch_scan():
    pm = detect_pkg_manager()
    if pm is None:
        raise ScanError("no supported package manager found (apt, dnf, yum, zypper, softwareupdate)")
    started = time.time()
    log.info("patch scan started (%s)", pm)
    if pm == "apt":
        available, installed = scan_apt(), recent_apt_upgrades()
    elif pm in ("dnf", "yum"):
        available, installed = scan_dnf(pm), recent_rpm_installs()
    elif pm == "zypper":
        available, installed = scan_zypper(), recent_rpm_installs()
    else:
        available, installed = scan_macos(), recent_macos_updates()
    log.info("patch scan finished in %d s: %d available (%d security), %d recently installed",
             time.time() - started, len(available),
             len([a for a in available if a["classification"] == "security"]), len(installed))
    return {"source": pm, "scanned_at": utc_now_iso(), "available": available, "installed": installed}


# ---------------------------------------------------------------------------
# Sending
# ---------------------------------------------------------------------------
def send_heartbeat(ctx):
    resp = ctx.http.request("POST", "/heartbeat", heartbeat_body(ctx.cfg.server_url), timeout=30)
    if isinstance(resp, dict) and resp.get("poll_interval_seconds"):
        ctx.poll_interval = clamp_int(resp.get("poll_interval_seconds"), 10, 3600, ctx.poll_interval)
    return resp


def send_inventory(ctx):
    inv = collect_inventory(ctx.cfg.server_url)
    ctx.http.request("POST", "/inventory", inv, timeout=120)
    ctx.state.set("last_inventory_at", time.time())
    log.info("inventory sent (%d software entries)", len(inv["software"]))
    return inv


def send_patches(ctx):
    scan = patch_scan()
    resp = ctx.http.request("POST", "/patches", scan, timeout=120)
    ctx.state.set("last_scan_at", time.time())
    missing = resp.get("missing") if isinstance(resp, dict) else None
    log.info("patch scan sent (%d available; server reports %s missing)", len(scan["available"]), missing)
    return scan, missing


# ---------------------------------------------------------------------------
# Jobs
# ---------------------------------------------------------------------------
class Context(object):
    def __init__(self, cfg, http_client, state):
        self.cfg = cfg
        self.http = http_client
        self.state = state
        self.poll_interval = cfg.poll_interval


class JobResult(object):
    def __init__(self, status, exit_code=0, output="", result=None, post_action=None):
        self.status = status
        self.exit_code = exit_code
        self.output = output
        self.result = result
        self.post_action = post_action


def patch_label(item):
    return str(item.get("kb") or item.get("title") or item.get("external_id") or "?")


def safe_filename(name):
    name = (name or "").replace("\\", "/").rsplit("/", 1)[-1]
    name = re.sub(r"[^A-Za-z0-9._+-]", "_", name).lstrip(".")
    return name[-120:] if name else ""


def schedule_reboot(delay_seconds, message):
    minutes = max(1, int(math.ceil(max(0, delay_seconds) / 60.0)))
    msg = re.sub(r"[\x00-\x1f\"'`$\\]", " ", message or "").strip()[:200]
    if not msg:
        msg = "Your IT department has scheduled a restart of this computer."
    log.info("scheduling reboot in %d minute(s)", minutes)
    rc, out, err = run_cmd(["shutdown", "-r", "+%d" % minutes, msg], timeout=60)
    return rc, (out + err).strip(), minutes


def install_package_file(ctx, item):
    """Offline / air-gapped package: download, verify SHA-256, install. Returns (status, error)."""
    expected = normalize_sha(item.get("package_sha256"))
    if not expected:
        return "failed", "package_sha256 is missing or invalid; refusing to install an unverified package"
    ensure_dir(PACKAGE_DIR)
    workdir = tempfile.mkdtemp(prefix="pkg-", dir=PACKAGE_DIR)
    try:
        url = str(item.get("package_url"))
        name = safe_filename(item.get("package_name") or urllib.parse.unquote(urllib.parse.urlsplit(url).path))
        dest = os.path.join(workdir, name or "package")
        log.info("downloading package %s", name or url)
        digest, header_sha, disposition = ctx.http.download(url, dest, timeout=120)
        if digest != expected:
            return "failed", "SHA-256 mismatch (expected %s, got %s)" % (expected, digest)
        if header_sha and normalize_sha(header_sha) and normalize_sha(header_sha) != digest:
            return "failed", "SHA-256 mismatch with X-Content-SHA256 header"
        ext = os.path.splitext(dest)[1].lower()
        if ext not in (".deb", ".rpm", ".pkg") and disposition:
            m = re.search(r'filename\*?=(?:UTF-8\'\')?"?([^";]+)"?', disposition)
            if m:
                fixed = safe_filename(urllib.parse.unquote(m.group(1)))
                if fixed:
                    newdest = os.path.join(workdir, fixed)
                    os.rename(dest, newdest)
                    dest = newdest
                    ext = os.path.splitext(dest)[1].lower()
        if ext == ".deb":
            args, env = ["dpkg", "-i", dest], apt_env()
        elif ext == ".rpm":
            args, env = ["rpm", "-Uvh", dest], c_env()
        elif ext == ".pkg" and IS_MACOS:
            args, env = ["installer", "-pkg", dest, "-target", "/"], c_env()
        else:
            return "failed", "unsupported package type %r (expected .deb or .rpm; set package_name)" % (ext or "")
        log.info("installing %s", os.path.basename(dest))
        rc, out, err = run_cmd(args, timeout=PACKAGE_TIMEOUT, env=env)
        if rc == 0:
            return "installed", None
        return "failed", "%s exited %s: %s" % (args[0], rc, tail(err or out, 400))
    except ApiError as e:
        if e.kind == "auth":
            raise
        return "failed", str(e)
    except OSError as e:
        return "failed", str(e)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def installed_versions(pm, names):
    res = {}
    if not names:
        return res
    if pm == "apt":
        rc, out, err = run_cmd(["dpkg-query", "-W", "-f", "${Package}\t${Version}\t${Status}\n"] + list(names),
                               timeout=120, env=c_env())
        for line in out.splitlines():
            parts = line.split("\t")
            if len(parts) >= 3 and parts[2].endswith(" installed"):
                res[parts[0]] = parts[1]
    elif pm in ("dnf", "yum", "zypper"):
        rc, out, err = run_cmd(["rpm", "-q", "--queryformat", "%{NAME}\t%{VERSION}-%{RELEASE}\n"] + list(names),
                               timeout=120, env=c_env())
        for line in out.splitlines():
            parts = line.split("\t")
            if len(parts) == 2:
                res[parts[0]] = parts[1]
    return res


def upgradable_now(pm):
    try:
        if pm == "apt":
            return set(apt_upgradable().keys())
        if pm in ("dnf", "yum"):
            return set(dnf_check_update(pm, refresh=False).keys())
        if pm == "zypper":
            return set(zypper_updates().keys())
    except ScanError as e:
        log.warning("could not re-check upgradable packages: %s", e)
    return set()


def install_os_packages(pm, names):
    """Upgrade named packages. Returns ({name: (status, error)}, summary_text)."""
    results = {}
    before = installed_versions(pm, names)
    targets = []
    for n in names:
        if n in before:
            targets.append(n)
        else:
            results[n] = ("failed", "package is not installed on this device")
    if not targets:
        return results, ""
    if pm == "apt":
        rc0, out0, err0 = run_cmd(["apt-get", "update", "-q"], timeout=1200, env=apt_env())
        if rc0 != 0:
            log.warning("apt-get update exited %s: %s", rc0, tail(err0 or out0, 300))
        args = ["apt-get", "install", "-y", "-q", "--only-upgrade",
                "-o", "Dpkg::Options::=--force-confdef", "-o", "Dpkg::Options::=--force-confold"] + targets
        env = apt_env()
    elif pm == "dnf":
        args, env = ["dnf", "-y", "upgrade"] + targets, c_env()
    elif pm == "yum":
        args, env = ["yum", "-y", "update"] + targets, c_env()
    else:
        args, env = ["zypper", "-n", "update", "--auto-agree-with-licenses"] + targets, c_env()
    log.info("running %s %s for %d package(s)", args[0], args[1], len(targets))
    rc, out, err = run_cmd(args, timeout=PACKAGE_TIMEOUT, env=env)
    log.info("%s exited %s", args[0], rc)
    still = upgradable_now(pm)
    for n in targets:
        if n in still:
            results[n] = ("failed", "package was not upgraded (%s exit %s): %s" % (args[0], rc, tail(err or out, 400)))
        else:
            results[n] = ("installed", None)
    return results, "%s exit code %s\n%s" % (" ".join(args[:3]), rc, tail(out + "\n" + err, 2000))


def install_macos_labels(labels):
    results = {}
    lines = []
    for label in labels:
        if not label or label.startswith("-") or re.search(r"[\x00-\x1f]", label):
            results[label] = ("failed", "invalid softwareupdate label")
            continue
        rc, out, err = run_cmd(["softwareupdate", "-i", label], timeout=PACKAGE_TIMEOUT, env=c_env())
        text = out + "\n" + err
        lines.append("softwareupdate -i %s: exit %s" % (label, rc))
        if rc == 0:
            results[label] = ("pending_reboot" if "restart" in text.lower() else "installed", None)
        else:
            results[label] = ("failed", "softwareupdate exited %s: %s" % (rc, tail(text, 400)))
    return results, "\n".join(lines)


def job_inventory(ctx, payload, job_id):
    inv = send_inventory(ctx)
    return JobResult("succeeded", 0, "inventory sent: %d software entries, %d disk(s)"
                     % (len(inv["software"]), len(inv["hardware"]["disks"])))


def job_scan(ctx, payload, job_id):
    scan, missing = send_patches(ctx)
    text = "scan sent: %d available, %d recently installed" % (len(scan["available"]), len(scan["installed"]))
    if missing is not None:
        text += "; server reports %s missing" % missing
    return JobResult("succeeded", 0, text)


def job_install_patches(ctx, payload, job_id):
    patches = payload.get("patches") or []
    mode = str(payload.get("reboot") or "never").lower()
    if mode not in ("never", "if_required", "always"):
        mode = "never"
    pm = detect_pkg_manager()
    order, outcome, lines = [], {}, []
    os_names, by_name = [], {}

    def record(item, status, error):
        order.append(item)
        outcome[id(item)] = [status, error]

    for item in patches:
        if not isinstance(item, dict):
            continue
        ext = str(item.get("external_id") or "")
        if item.get("package_url"):
            st, er = install_package_file(ctx, item)
            record(item, st, er)
        elif pm == "macos":
            record(item, None, None)
            os_names.append(ext)
            by_name.setdefault(ext, []).append(item)
        elif not SAFE_PKG.match(ext):
            record(item, "failed", "invalid package name")
        else:
            record(item, None, None)
            if ext not in by_name:
                os_names.append(ext)
            by_name.setdefault(ext, []).append(item)

    if os_names:
        if pm is None:
            res, summary = dict((n, ("failed", "no supported package manager found")) for n in os_names), ""
        elif pm == "macos":
            res, summary = install_macos_labels(os_names)
        else:
            res, summary = install_os_packages(pm, os_names)
        if summary:
            lines.append(summary)
        for name, items in by_name.items():
            st, er = res.get(name, ("failed", "no result"))
            for item in items:
                outcome[id(item)] = [st, er]

    rb = reboot_required(force=True)
    reboot = bool(rb)
    if rb:
        rb_names = reboot_package_names()
        for item in order:
            o = outcome[id(item)]
            name = str(item.get("external_id") or "")
            if o[0] == "installed" and (name in rb_names or is_reboot_pkg(name)):
                o[0] = "pending_reboot"
    results = []
    failed = 0
    detail = []
    for item in order:
        st, er = outcome[id(item)]
        if st is None:
            st, er = "failed", "no result"
        if st == "failed":
            failed += 1
        if st == "pending_reboot":
            reboot = True
        results.append({"external_id": str(item.get("external_id") or ""), "status": st, "error": er})
        detail.append("%s: %s%s" % (patch_label(item), st, (" - " + er) if er else ""))
        log.info("patch %s: %s%s", patch_label(item), st, (" - " + er) if er else "")
    if not patches:
        detail.append("no patches in the job payload")

    try:
        send_patches(ctx)
    except ApiError as e:
        if e.kind == "auth":
            raise
        log.warning("post-install scan failed: %s", e)
        detail.append("post-install scan failed: %s" % e)
    except ScanError as e:
        log.warning("post-install scan failed: %s", e)
        detail.append("post-install scan failed: %s" % e)

    do_reboot = mode == "always" or (mode == "if_required" and reboot)
    if reboot:
        detail.append("a reboot is required to complete installation")
    if do_reboot:
        detail.append('reboot policy "%s": restarting in 1 minute' % mode)
    elif reboot:
        detail.append('reboot policy "%s": not restarting' % mode)
    output = "\n".join(detail + ([""] + lines if lines else []))
    status = "failed" if failed else "succeeded"
    post = None
    if do_reboot:
        def post():
            schedule_reboot(60, "Your IT department is restarting this computer to finish installing updates.")
    return JobResult(status, 1 if failed else 0, output,
                     {"results": results, "reboot_required": reboot}, post)


def job_run_script(ctx, payload, job_id):
    shell = str(payload.get("shell") or "").lower()
    script = str(payload.get("script") or "")
    timeout = clamp_int(payload.get("timeout_seconds") or 300, 1, 86400, 300)
    if shell not in ("bash", "sh"):
        return JobResult("failed", 1, 'unsupported shell "%s" on %s (use bash or sh)' % (shell, OS_FAMILY))
    exe = which(shell) or "/bin/" + shell
    ensure_dir(WORK_DIR)
    fd, path = tempfile.mkstemp(prefix="job-", suffix=".sh", dir=WORK_DIR)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(script)
    os.chmod(path, 0o700)
    log.info("running %s script for job %s (timeout %d s)", shell, job_id, timeout)
    timed_out = False
    try:
        with tempfile.TemporaryFile(dir=WORK_DIR) as outf:
            env = dict(os.environ)
            env.setdefault("HOME", "/root")
            p = subprocess.Popen([exe, path], stdout=outf, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                 cwd=WORK_DIR, env=env, start_new_session=True)
            try:
                rc = p.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                timed_out = True
                _kill_group(p)
                rc = p.returncode
            output = read_head_tail(outf)
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass
    if timed_out:
        return JobResult("failed", -1, output + "\n[timed out after %d s; process group killed]" % timeout)
    log.info("script for job %s exited with code %s", job_id, rc)
    return JobResult("succeeded" if rc == 0 else "failed", rc, output)


def _kill_group(p):
    for sig, wait in ((signal.SIGTERM, 5), (getattr(signal, "SIGKILL", signal.SIGTERM), 10)):
        try:
            if hasattr(os, "killpg"):
                os.killpg(p.pid, sig)
            else:
                p.kill()
        except OSError:
            pass
        try:
            p.wait(timeout=wait)
            return
        except subprocess.TimeoutExpired:
            continue


def job_reboot(ctx, payload, job_id):
    delay = clamp_int(payload.get("delay_seconds") if payload.get("delay_seconds") is not None else 60,
                      0, 315360000, 60)
    rc, out, minutes = schedule_reboot(delay, payload.get("message") or "")
    if rc == 0:
        return JobResult("succeeded", 0, "reboot scheduled in %d minute(s)" % minutes)
    return JobResult("failed", rc if rc is not None else 1, "shutdown failed: %s" % out)


def job_update_agent(ctx, payload, job_id):
    url = payload.get("url")
    expected = normalize_sha(payload.get("sha256"))
    if not url or not expected:
        return JobResult("failed", 1, "update_agent requires url and a valid sha256")
    ensure_dir(WORK_DIR)
    tmp = os.path.join(WORK_DIR, "itsm-agent.py.new")
    try:
        digest, header_sha, _ = ctx.http.download(str(url), tmp, timeout=120)
        if digest != expected:
            return JobResult("failed", 1, "SHA-256 mismatch (expected %s, got %s)" % (expected, digest))
        with open(tmp, "rb") as f:
            source = f.read()
        try:
            compile(source, INSTALLED_SCRIPT, "exec")
        except SyntaxError as e:
            return JobResult("failed", 1, "downloaded agent does not compile: %s" % e)
        ensure_dir(INSTALL_DIR, 0o755)
        staged = INSTALLED_SCRIPT + ".new"
        shutil.copyfile(tmp, staged)
        os.chmod(staged, 0o755)
        if os.path.exists(INSTALLED_SCRIPT):
            shutil.copyfile(INSTALLED_SCRIPT, INSTALLED_SCRIPT + ".bak")
        os.replace(staged, INSTALLED_SCRIPT)
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass
    log.info("agent script replaced; restarting")
    return JobResult("succeeded", 0, "agent updated; restarting", post_action="restart")


HANDLERS = {
    "inventory": job_inventory,
    "scan": job_scan,
    "install_patches": job_install_patches,
    "run_script": job_run_script,
    "reboot": job_reboot,
    "update_agent": job_update_agent,
}


def post_job_status(ctx, job_id, body, attempts=1):
    """Returns 'ok', 'cancelled' or 'error'. Raises only on 401."""
    delay = BACKOFF_MIN
    for i in range(attempts):
        try:
            ctx.http.request("POST", "/jobs/%s" % job_id, body, timeout=60)
            return "ok"
        except ApiError as e:
            if e.kind == "auth":
                raise
            if e.kind == "cancelled":
                return "cancelled"
            log.warning("could not report job %s status: %s", job_id, e)
            if e.kind != "network":
                return "error"
            if i < attempts - 1:
                time.sleep(delay)
                delay = min(delay * 2, BACKOFF_MAX)
    return "error"


def run_job(ctx, job):
    """Runs one job. Returns 'restart' when the agent must re-exec itself."""
    if not isinstance(job, dict):
        return None
    job_id = str(job.get("id") or "")
    kind = str(job.get("kind") or "")
    payload = job.get("payload") or {}
    if not isinstance(payload, dict):
        payload = {}
    if not SAFE_JOB_ID.match(job_id):
        log.warning("ignoring a job with a missing or invalid id")
        return None
    log.info("job %s (%s) received", job_id, kind)
    if post_job_status(ctx, job_id, {"status": "running"}, attempts=1) == "cancelled":
        log.info("job %s was cancelled on the server; skipping", job_id)
        return None
    _STOP["in_job"] = True
    try:
        handler = HANDLERS.get(kind)
        if handler is None:
            res = JobResult("failed", 1, 'unsupported job kind "%s"' % kind)
        else:
            res = handler(ctx, payload, job_id)
    except ApiError as e:
        if e.kind == "auth":
            raise
        log.error("job %s (%s) failed: %s", job_id, kind, e)
        res = JobResult("failed", 1, "job failed: %s" % e)
    except Exception as e:  # noqa: BLE001 - a failing job must not stop the agent
        log.exception("job %s (%s) failed", job_id, kind)
        res = JobResult("failed", 1, "job failed: %s: %s" % (type(e).__name__, e))
    finally:
        _STOP["in_job"] = False
    body = {"status": res.status, "exit_code": res.exit_code, "output": limit_output(res.output)}
    if res.result is not None:
        body["result"] = res.result
    st = post_job_status(ctx, job_id, body, attempts=6)
    log.info("job %s (%s) finished: %s (report: %s)", job_id, kind, res.status, st)
    if callable(res.post_action):
        try:
            res.post_action()
        except Exception as e:  # noqa: BLE001
            log.error("post-job action failed: %s", e)
    elif res.post_action == "restart":
        return "restart"
    return None


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------
def _on_sigterm(signum, frame):
    _STOP["requested"] = True
    if not _STOP["in_job"]:
        raise SystemExit(0)
    log.info("stop requested; finishing the current job first")


def acquire_lock():
    if fcntl is None:
        return True, None
    ensure_dir(STATE_DIR)
    f = open(LOCK_PATH, "w")
    try:
        fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        f.close()
        return False, None
    return True, f


def run_loop():
    cfg = load_config()
    state = State()
    if state.get("auth_failed"):
        log.error("The server rejected this device's credentials earlier (HTTP 401: device retired or "
                  "secret rotated). The agent stays stopped until an administrator re-enrols it with 'install'.")
        return AUTH_EXIT_CODE
    ok, lock = acquire_lock()
    if not ok:
        log.error("another agent instance is already running")
        return 1
    try:
        signal.signal(signal.SIGTERM, _on_sigterm)
    except (ValueError, AttributeError):
        pass
    ensure_dir(WORK_DIR)
    ctx = Context(cfg, make_http(cfg), state)
    log.info("ITSM Agent %s started (device %s, server %s)", AGENT_VERSION, cfg.device_id, cfg.server_url)
    last_hb = 0.0
    retry_inventory_at = 0.0
    retry_scan_at = 0.0
    backoff = BACKOFF_MIN
    while not _STOP["requested"]:
        try:
            if time.time() - last_hb >= ctx.poll_interval:
                send_heartbeat(ctx)
                last_hb = time.time()
            if state.due("last_inventory_at", INVENTORY_INTERVAL) and time.time() >= retry_inventory_at:
                try:
                    send_inventory(ctx)
                except ApiError as e:
                    if e.kind in ("auth", "network"):
                        raise
                    log.warning("inventory failed; retrying in 1 h: %s", e)
                    retry_inventory_at = time.time() + 3600
                except Exception as e:  # noqa: BLE001
                    log.warning("inventory failed; retrying in 1 h: %s", e)
                    retry_inventory_at = time.time() + 3600
            if state.due("last_scan_at", SCAN_INTERVAL) and time.time() >= retry_scan_at:
                try:
                    send_patches(ctx)
                except ApiError as e:
                    if e.kind in ("auth", "network"):
                        raise
                    log.warning("patch scan failed; retrying in 1 h: %s", e)
                    retry_scan_at = time.time() + 3600
                except Exception as e:  # noqa: BLE001
                    log.warning("patch scan failed; retrying in 1 h: %s", e)
                    retry_scan_at = time.time() + 3600
            t0 = time.time()
            resp = ctx.http.request("GET", "/jobs?wait=%d" % LONG_POLL_WAIT, timeout=LONG_POLL_TIMEOUT)
            backoff = BACKOFF_MIN
            jobs = resp.get("jobs") if isinstance(resp, dict) else None
            jobs = jobs if isinstance(jobs, list) else []
            for job in jobs:
                if run_job(ctx, job) == "restart":
                    log.info("re-executing the updated agent")
                    for h in log.handlers:
                        h.flush()
                    os.execv(sys.executable, [sys.executable, INSTALLED_SCRIPT, "run"])
                if _STOP["requested"]:
                    break
            if not jobs and time.time() - t0 < 5:
                time.sleep(5)
        except ApiError as e:
            if e.kind == "auth":
                log.error("The server returned 401 Unauthorized: this device was retired or its secret was "
                          "rotated. The agent is stopping; an administrator must re-enrol it. (%s)", e)
                state.set("auth_failed", True)
                return AUTH_EXIT_CODE
            sleep = backoff + random.uniform(0, backoff / 4.0)
            log.warning("%s; retrying in %d s", e, sleep)
            time.sleep(sleep)
            backoff = min(backoff * 2, BACKOFF_MAX)
        except Exception as e:  # noqa: BLE001 - keep running on unexpected errors
            log.exception("unexpected error: %s", e)
            time.sleep(backoff)
            backoff = min(backoff * 2, BACKOFF_MAX)
    log.info("agent stopped")
    return 0


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------
SYSTEMD_UNIT = """[Unit]
Description=ITSM endpoint agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
ExecStart={python} {script} run
Restart=always
RestartSec=10
# 78 = stopped after HTTP 401 (device retired); do not restart until re-enrolled.
RestartPreventExitStatus=78
# Only signal the agent on stop, so a package manager it started can finish cleanly.
KillMode=process

[Install]
WantedBy=multi-user.target
"""


def service_python():
    if IS_MACOS and os.path.exists("/usr/bin/python3"):
        return "/usr/bin/python3"
    return sys.executable or "/usr/bin/python3"


def install_systemd():
    if not which("systemctl") or not os.path.isdir("/run/systemd/system"):
        print("warning: systemd not found. Configure your init system to run as root:\n  %s %s run"
              % (service_python(), INSTALLED_SCRIPT))
        return False
    with open(SYSTEMD_UNIT_PATH, "w") as f:
        f.write(SYSTEMD_UNIT.format(python=service_python(), script=INSTALLED_SCRIPT))
    os.chmod(SYSTEMD_UNIT_PATH, 0o644)
    for args in (["systemctl", "daemon-reload"], ["systemctl", "enable", SYSTEMD_UNIT_NAME],
                 ["systemctl", "restart", SYSTEMD_UNIT_NAME]):
        rc, out, err = run_cmd(args, timeout=60)
        if rc != 0:
            raise SystemExit("error: %s failed: %s" % (" ".join(args), (err or out).strip()))
    return True


def install_launchd():
    plist = {
        "Label": LAUNCHD_LABEL,
        "ProgramArguments": [service_python(), INSTALLED_SCRIPT, "run"],
        "RunAtLoad": True,
        "KeepAlive": {"SuccessfulExit": False},
        "ThrottleInterval": 30,
        "ProcessType": "Background",
        "StandardErrorPath": "/dev/null",
        "StandardOutPath": "/dev/null",
    }
    run_cmd(["launchctl", "bootout", "system/" + LAUNCHD_LABEL], timeout=60)
    with open(LAUNCHD_PLIST, "wb") as f:
        plistlib.dump(plist, f)
    os.chmod(LAUNCHD_PLIST, 0o644)
    rc, out, err = run_cmd(["launchctl", "bootstrap", "system", LAUNCHD_PLIST], timeout=60)
    if rc != 0:
        rc, out, err = run_cmd(["launchctl", "load", "-w", LAUNCHD_PLIST], timeout=60)
        if rc != 0:
            raise SystemExit("error: launchctl could not load %s: %s" % (LAUNCHD_PLIST, (err or out).strip()))
    return True


def stop_service():
    if IS_MACOS:
        if os.path.exists(LAUNCHD_PLIST):
            run_cmd(["launchctl", "bootout", "system/" + LAUNCHD_LABEL], timeout=60)
    elif which("systemctl") and os.path.exists(SYSTEMD_UNIT_PATH):
        run_cmd(["systemctl", "stop", SYSTEMD_UNIT_NAME], timeout=120)


def cmd_install(args):
    require_root()
    setup_logging(console=True)
    token = args.token or os.environ.get("ITSM_ENROLL_TOKEN")
    if not token:
        raise SystemExit("error: --token is required (or set ITSM_ENROLL_TOKEN)")
    add_secret(token)
    server = normalize_server_url(args.server)
    if not re.match(r"^https?://[^/\s]+", server, re.I):
        raise SystemExit("error: --server must be an http(s) URL, for example https://itsm.example.com")
    if server.lower().startswith("http://"):
        log.warning("the server URL uses plain HTTP; this is allowed only for lab installs")
    if args.insecure_skip_verify:
        log.warning("--insecure-skip-verify: TLS certificates will NOT be verified (lab use only)")

    log.info("stopping any existing agent")
    stop_service()

    ensure_dir(INSTALL_DIR, 0o755)
    src = os.path.abspath(__file__)
    if os.path.abspath(INSTALLED_SCRIPT) != src:
        shutil.copyfile(src, INSTALLED_SCRIPT)
    os.chmod(INSTALLED_SCRIPT, 0o755)
    log.info("agent installed to %s", INSTALLED_SCRIPT)

    ensure_dir(CONFIG_DIR, 0o700)
    ensure_dir(STATE_DIR, 0o700)
    ensure_dir(PACKAGE_DIR, 0o700)
    ensure_dir(WORK_DIR, 0o700)

    ca_path = None
    if args.ca_file:
        if not os.path.isfile(args.ca_file):
            raise SystemExit("error: CA file not found: %s" % args.ca_file)
        if os.path.abspath(args.ca_file) != os.path.abspath(CA_COPY_PATH):
            shutil.copyfile(args.ca_file, CA_COPY_PATH)
        os.chmod(CA_COPY_PATH, 0o644)
        ca_path = CA_COPY_PATH
        try:
            ssl.create_default_context().load_verify_locations(cafile=ca_path)
        except (ssl.SSLError, OSError) as e:
            raise SystemExit("error: CA file is not a valid PEM certificate bundle: %s" % e)

    http_client = Http(server, ca_file=ca_path, insecure=args.insecure_skip_verify)
    log.info("enrolling with %s", server)
    try:
        resp = http_client.request("POST", "/enroll", enroll_body(token, server), timeout=60, auth=False)
    except ApiError as e:
        if e.status == 403:
            raise SystemExit("error: enrolment refused (403): the token is invalid, expired or used up")
        if e.status == 402:
            raise SystemExit("error: enrolment refused (402): the licence device limit has been reached")
        if e.status == 400:
            raise SystemExit("error: enrolment refused (400): %s" % scrub(str(e)))
        raise SystemExit("error: enrolment failed: %s" % scrub(str(e)))
    if not isinstance(resp, dict) or not resp.get("device_id") or not resp.get("device_secret"):
        raise SystemExit("error: the enrolment response did not contain device_id and device_secret")
    add_secret(str(resp["device_secret"]))
    cfg = {
        "server_url": server,
        "device_id": str(resp["device_id"]),
        "device_secret": str(resp["device_secret"]),
        "ca_file": ca_path,
        "insecure_skip_verify": bool(args.insecure_skip_verify),
        "poll_interval_seconds": clamp_int(resp.get("poll_interval_seconds"), 10, 3600, 60),
        "enrolled_at": utc_now_iso(),
        "agent_version": AGENT_VERSION,
    }
    write_json(CONFIG_PATH, cfg, 0o600)
    if os.path.exists(STATE_PATH):
        os.unlink(STATE_PATH)
    log.info("enrolled as device %s; config written to %s", cfg["device_id"], CONFIG_PATH)

    if IS_MACOS:
        install_launchd()
        log.info("launchd daemon %s loaded", LAUNCHD_LABEL)
    elif install_systemd():
        log.info("systemd unit %s enabled and started", SYSTEMD_UNIT_NAME)
    log.info("ITSM Agent installed. Log file: %s", LOG_PATH)
    return 0


def cmd_uninstall(args):
    require_root()
    if IS_MACOS:
        if os.path.exists(LAUNCHD_PLIST):
            run_cmd(["launchctl", "bootout", "system/" + LAUNCHD_LABEL], timeout=60)
            os.unlink(LAUNCHD_PLIST)
            print("Removed launchd daemon %s" % LAUNCHD_LABEL)
    elif os.path.exists(SYSTEMD_UNIT_PATH):
        run_cmd(["systemctl", "disable", "--now", SYSTEMD_UNIT_NAME], timeout=120)
        os.unlink(SYSTEMD_UNIT_PATH)
        run_cmd(["systemctl", "daemon-reload"], timeout=60)
        print("Removed systemd unit %s" % SYSTEMD_UNIT_NAME)
    for path in (INSTALL_DIR, CONFIG_DIR, STATE_DIR):
        if os.path.isdir(path):
            shutil.rmtree(path, ignore_errors=True)
            print("Removed %s" % path)
    for suffix in [""] + [".%d" % i for i in range(1, LOG_BACKUPS + 1)]:
        if os.path.exists(LOG_PATH + suffix):
            os.unlink(LOG_PATH + suffix)
    print("ITSM Agent uninstalled. Retire the device in the ITSM console to remove it from the device list.")
    return 0


def cmd_run(args):
    setup_logging(console=sys.stderr.isatty())
    return run_loop()


def cmd_once(args):
    setup_logging(console=True)
    cfg = load_config()
    ctx = Context(cfg, make_http(cfg), State())
    log.info("ITSM Agent %s one-shot run (device %s, server %s)", AGENT_VERSION, cfg.device_id, cfg.server_url)
    ok = True
    try:
        resp = send_heartbeat(ctx)
        log.info("heartbeat ok (poll interval %s s, jobs pending: %s)", ctx.poll_interval,
                 resp.get("jobs_pending") if isinstance(resp, dict) else None)
    except Exception as e:  # noqa: BLE001 - report every step
        ok = False
        log.error("heartbeat failed: %s", e)
    for name, fn in (("inventory", send_inventory), ("patch scan", send_patches)):
        try:
            fn(ctx)
        except Exception as e:  # noqa: BLE001
            ok = False
            log.error("%s failed: %s", name, e)
    if ok:
        log.info("one-shot run completed successfully")
    return 0 if ok else 1


def cmd_collect(args):
    setup_logging(console=False)
    out = {"agent_version": AGENT_VERSION, "heartbeat": heartbeat_body(), "inventory": collect_inventory()}
    if args.patches:
        try:
            out["patches"] = patch_scan()
        except ScanError as e:
            out["patches_error"] = str(e)
    print(json.dumps(out, indent=2, sort_keys=False))
    return 0


def build_parser():
    parser = argparse.ArgumentParser(
        prog="itsm-agent.py",
        description="ITSM endpoint agent for Linux and macOS (agent protocol v1). Runs as root.",
        epilog="Example: sudo python3 itsm-agent.py install --server https://itsm.example.com --token enr_xxx")
    parser.add_argument("--version", action="version", version="itsm-agent " + AGENT_VERSION)
    sub = parser.add_subparsers(dest="command", metavar="COMMAND")
    p = sub.add_parser("install", help="install, enrol and start the agent service")
    p.add_argument("--server", required=True, help="server base URL, e.g. https://itsm.example.com")
    p.add_argument("--token", help="enrolment token (or set ITSM_ENROLL_TOKEN to keep it off the command line)")
    p.add_argument("--ca-file", help="PEM bundle of a private CA to trust for the server")
    p.add_argument("--insecure-skip-verify", action="store_true",
                   help="do not verify the server TLS certificate (lab use only)")
    sub.add_parser("run", help="run the agent main loop (used by the service)")
    sub.add_parser("once", help="one heartbeat + inventory + patch scan, then exit")
    sub.add_parser("uninstall", help="remove the service, program files, config and state")
    p = sub.add_parser("collect", help="print heartbeat/inventory JSON without contacting the server")
    p.add_argument("--patches", action="store_true", help="also run a local patch scan")
    return parser


def main(argv=None):
    if sys.version_info < (3, 8):
        sys.stderr.write("error: Python 3.8 or newer is required\n")
        return 1
    ensure_path()
    parser = build_parser()
    args = parser.parse_args(argv)
    if not args.command:
        parser.print_help()
        return 2
    commands = {"install": cmd_install, "run": cmd_run, "once": cmd_once,
                "uninstall": cmd_uninstall, "collect": cmd_collect}
    try:
        return commands[args.command](args)
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())

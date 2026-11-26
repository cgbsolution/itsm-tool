#Requires -Version 5.1
<#
.SYNOPSIS
    ITSM endpoint agent for Windows (agent protocol v1).

.DESCRIPTION
    Runs as SYSTEM on managed Windows devices. It enrols with the ITSM server, sends heartbeats,
    hardware/software inventory and Windows Update scan results, and long-polls the server for
    jobs (inventory, scan, install_patches, run_script, reboot, update_agent). The server never
    connects to the device; only outbound HTTPS is needed.

    Compatible with Windows PowerShell 5.1. Protocol: docs/AGENT_PROTOCOL.md.

.PARAMETER Install
    Copy this script to "C:\Program Files\ITSMAgent", enrol with -Server and -Token, write
    C:\ProgramData\ITSMAgent\config.json (ACL: SYSTEM and Administrators only), register the
    "ITSM Agent" scheduled task (SYSTEM, at startup, restart on failure) and start it.

.PARAMETER Server
    Server base URL, for example https://itsm.example.com (the agent appends /api/agent/v1).

.PARAMETER Token
    Enrolment token from Endpoints > Enrol devices. If omitted, the ITSM_ENROLL_TOKEN
    environment variable is used (keeps the token off the command line).

.PARAMETER CaFile
    PEM or DER file with a private CA certificate (bundle) to trust for the server.

.PARAMETER InsecureSkipVerify
    Do not verify the server's TLS certificate. Lab use only; logs a warning on every start.

.PARAMETER Run
    Main loop (used by the scheduled task).

.PARAMETER Once
    One heartbeat, inventory and patch scan, then exit. For testing an installed agent.

.PARAMETER Uninstall
    Remove the scheduled task, program files, config and logs.

.PARAMETER Collect
    Print the heartbeat and inventory JSON to stdout without contacting the server.

.PARAMETER IncludePatches
    With -Collect, also run a Windows Update scan (contacts Windows Update / WSUS).

.EXAMPLE
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\itsm-agent.ps1 -Install -Server https://itsm.example.com -Token enr_xxx

.EXAMPLE
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Program Files\ITSMAgent\itsm-agent.ps1" -Once
#>
[CmdletBinding()]
param(
    [switch]$Install,
    [string]$Server,
    [string]$Token,
    [string]$CaFile,
    [switch]$InsecureSkipVerify,
    [switch]$Run,
    [switch]$Once,
    [switch]$Uninstall,
    [switch]$Collect,
    [switch]$IncludePatches
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# ---------------------------------------------------------------------------
# Constants and paths
# ---------------------------------------------------------------------------
$script:AgentVersion = '1.0.0'
$script:TaskName = 'ITSM Agent'
$script:ApiPrefix = '/api/agent/v1'
$script:SelfPath = $PSCommandPath
$script:UserAgent = 'itsm-agent/' + $script:AgentVersion + ' (windows; powershell ' + $PSVersionTable.PSVersion.ToString() + ')'

$programFilesDir = $env:ProgramW6432
if (-not $programFilesDir) { $programFilesDir = $env:ProgramFiles }
$script:InstallDir = Join-Path $programFilesDir 'ITSMAgent'
$script:InstalledScript = Join-Path $script:InstallDir 'itsm-agent.ps1'
$script:DataDir = Join-Path $env:ProgramData 'ITSMAgent'
if ($env:ITSM_AGENT_DATA_DIR) { $script:DataDir = $env:ITSM_AGENT_DATA_DIR }   # development / testing only
$script:ConfigPath = Join-Path $script:DataDir 'config.json'
$script:StatePath = Join-Path $script:DataDir 'state.json'
$script:LogPath = Join-Path $script:DataDir 'agent.log'
$script:PackageDir = Join-Path $script:DataDir 'packages'
$script:WorkDir = Join-Path $script:DataDir 'work'

$script:LogMaxBytes = 5MB
$script:LogKeep = 3
$script:OutputLimit = 64000                  # bytes of UTF-8 (protocol: max 64 KB)
$script:InventoryIntervalSeconds = 86400
$script:ScanIntervalSeconds = 86400
$script:LongPollWait = 25
$script:LongPollTimeout = 45                 # client timeout above the 30 s server maximum
$script:PackageTimeoutSeconds = 7200
$script:WuaCriteria = "IsInstalled=0 and Type='Software' and IsHidden=0"
$script:GuidPattern = '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$'

$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$script:Utf8Bom = New-Object System.Text.UTF8Encoding($true)
$script:OemEncoding = [System.Text.Encoding]::GetEncoding([System.Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage)
$script:Invariant = [System.Globalization.CultureInfo]::InvariantCulture
$script:UnixEpoch = New-Object DateTime 1970, 1, 1, 0, 0, 0, ([DateTimeKind]::Utc)

$script:Secrets = New-Object System.Collections.Generic.List[string]
$script:Interactive = $false
$script:Config = $null
$script:ServerUrl = $null
$script:ApiBase = $null
$script:AuthHeader = $null
$script:State = $null
$script:PollInterval = 60
$script:StopRequested = $false
$script:ExitCode = 0

# Certificate validation for a private CA (ca_file) or insecure_skip_verify. Compiled with
# Add-Type only when needed. A C# callback is used because a PowerShell script block can be
# invoked on a thread without a runspace.
$script:CertPolicySource = @'
using System;
using System.Net;
using System.Net.Security;
using System.Security.Cryptography.X509Certificates;

public static class ItsmAgentCertPolicy
{
    private static bool insecure = false;
    private static X509Certificate2Collection roots = new X509Certificate2Collection();

    public static void Enable(bool skipVerify, X509Certificate2Collection extraRoots)
    {
        insecure = skipVerify;
        if (extraRoots != null) { roots = extraRoots; }
        ServicePointManager.ServerCertificateValidationCallback = Validate;
    }

    public static bool Validate(object sender, X509Certificate certificate, X509Chain chain, SslPolicyErrors errors)
    {
        if (insecure) { return true; }
        if (errors == SslPolicyErrors.None) { return true; }
        if (certificate == null || roots.Count == 0) { return false; }
        // Only chain errors can be fixed by the private CA; never accept a name mismatch.
        if ((errors & ~SslPolicyErrors.RemoteCertificateChainErrors) != SslPolicyErrors.None) { return false; }
        X509Chain custom = new X509Chain();
        custom.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
        custom.ChainPolicy.VerificationFlags = X509VerificationFlags.AllowUnknownCertificateAuthority;
        foreach (X509Certificate2 r in roots) { custom.ChainPolicy.ExtraStore.Add(r); }
        X509Certificate2 leaf = new X509Certificate2(certificate);
        if (!custom.Build(leaf)) { return false; }
        bool anchored = false;
        foreach (X509ChainElement el in custom.ChainElements)
        {
            foreach (X509Certificate2 r in roots)
            {
                if (String.Equals(el.Certificate.Thumbprint, r.Thumbprint, StringComparison.OrdinalIgnoreCase)) { anchored = true; }
            }
        }
        if (!anchored) { return false; }
        foreach (X509ChainStatus st in custom.ChainStatus)
        {
            if (st.Status != X509ChainStatusFlags.NoError && st.Status != X509ChainStatusFlags.UntrustedRoot) { return false; }
        }
        return true;
    }
}
'@

# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------
function Get-EpochNow {
    return [int64][Math]::Floor(([DateTime]::UtcNow - $script:UnixEpoch).TotalSeconds)
}

function Get-IsoNow {
    return [DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", $script:Invariant)
}

function Format-DateOnly {
    param($Value)
    if ($null -eq $Value) { return $null }
    try {
        $dt = [DateTime]$Value
        if ($dt.Year -lt 1980) { return $null }
        return $dt.ToString('yyyy-MM-dd', $script:Invariant)
    } catch {
        return $null
    }
}

function Get-StringOrNull {
    param($Value)
    if ($null -eq $Value) { return $null }
    $s = ([string]$Value).Trim()
    if (-not $s) { return $null }
    return $s
}

function Get-CleanValue {
    # Drops placeholder values that firmware vendors leave in DMI/BIOS fields.
    param($Value)
    $s = Get-StringOrNull $Value
    if ($null -eq $s) { return $null }
    $junk = @('to be filled by o.e.m.', 'default string', 'system serial number', 'system product name',
        'system manufacturer', 'not specified', 'not applicable', 'none', 'n/a', '0', '00000000',
        '0123456789', 'chassis serial number', 'serial number', 'invalid', 'unknown', 'oem')
    if ($junk -contains $s.ToLowerInvariant()) { return $null }
    return $s
}

function Add-Secret {
    param([string]$Value)
    if ($Value -and -not $script:Secrets.Contains($Value)) { $script:Secrets.Add($Value) }
}

function Protect-LogText {
    param([string]$Text)
    if ($null -eq $Text) { return '' }
    $out = $Text
    foreach ($s in $script:Secrets) {
        if ($s -and $s.Length -ge 6) { $out = $out.Replace($s, '***') }
    }
    return $out
}

function Write-Log {
    param([string]$Level, [string]$Message)
    $line = '{0} [{1}] {2}' -f (Get-IsoNow), $Level, (Protect-LogText $Message)
    if ($script:Interactive) {
        if ($Level -eq 'ERROR') { Write-Host $line -ForegroundColor Red }
        elseif ($Level -eq 'WARN') { Write-Host $line -ForegroundColor Yellow }
        else { Write-Host $line }
    }
    try {
        if (-not (Test-Path -LiteralPath $script:DataDir)) { return }
        $fi = New-Object System.IO.FileInfo($script:LogPath)
        if ($fi.Exists -and $fi.Length -ge $script:LogMaxBytes) {
            for ($i = $script:LogKeep - 1; $i -ge 1; $i--) {
                $src = '{0}.{1}' -f $script:LogPath, $i
                $dst = '{0}.{1}' -f $script:LogPath, ($i + 1)
                if (Test-Path -LiteralPath $src) {
                    if (Test-Path -LiteralPath $dst) { Remove-Item -LiteralPath $dst -Force }
                    Move-Item -LiteralPath $src -Destination $dst
                }
            }
            $first = $script:LogPath + '.1'
            if (Test-Path -LiteralPath $first) { Remove-Item -LiteralPath $first -Force }
            Move-Item -LiteralPath $script:LogPath -Destination $first
        }
        [System.IO.File]::AppendAllText($script:LogPath, $line + "`r`n", $script:Utf8NoBom)
    } catch {
        # Logging must never break the agent.
    }
}

function Initialize-Directory {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { $null = New-Item -ItemType Directory -Path $Path -Force }
}

function Read-JsonFile {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $text = [System.IO.File]::ReadAllText($Path)
    if (-not $text -or -not $text.Trim()) { return $null }
    return (ConvertFrom-Json -InputObject $text)
}

function Write-JsonFile {
    param([string]$Path, $Object)
    $json = ConvertTo-Json -InputObject $Object -Depth 10
    $tmp = $Path + '.tmp'
    [System.IO.File]::WriteAllText($tmp, $json, $script:Utf8NoBom)
    if (Test-Path -LiteralPath $Path) { [System.IO.File]::Delete($Path) }
    [System.IO.File]::Move($tmp, $Path)
}

function Test-IsAdmin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($id)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-SystemExe {
    # Resolves a System32 tool, avoiding WOW64 redirection when run from 32-bit PowerShell.
    param([string]$Name)
    $sysnative = Join-Path $env:SystemRoot 'Sysnative'
    if ($env:PROCESSOR_ARCHITEW6432 -and (Test-Path -LiteralPath $sysnative)) { return (Join-Path $sysnative $Name) }
    return (Join-Path (Join-Path $env:SystemRoot 'System32') $Name)
}

function Get-NormalizedSha {
    param([string]$Value)
    if (-not $Value) { return $null }
    $v = $Value.Trim().ToLowerInvariant()
    if ($v.StartsWith('sha256:')) { $v = $v.Substring(7) }
    if ($v -notmatch '^[0-9a-f]{64}$') { return $null }
    return $v
}

function Get-NormalizedServerUrl {
    param([string]$Url)
    $u = ([string]$Url).Trim()
    while ($u.EndsWith('/')) { $u = $u.Substring(0, $u.Length - 1) }
    if ($u.ToLowerInvariant().EndsWith($script:ApiPrefix)) { $u = $u.Substring(0, $u.Length - $script:ApiPrefix.Length) }
    while ($u.EndsWith('/')) { $u = $u.Substring(0, $u.Length - 1) }
    return $u
}

function Set-RestrictedAcl {
    # Replaces the DACL with SYSTEM + Administrators full control (no inheritance from parent).
    param([string]$Path, [switch]$Directory)
    $system = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
    $admins = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')
    try {
        if ($Directory) {
            $acl = New-Object System.Security.AccessControl.DirectorySecurity
            $inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
        } else {
            $acl = New-Object System.Security.AccessControl.FileSecurity
            $inherit = [System.Security.AccessControl.InheritanceFlags]::None
        }
        $acl.SetAccessRuleProtection($true, $false)
        foreach ($sid in @($system, $admins)) {
            $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid,
                [System.Security.AccessControl.FileSystemRights]::FullControl, $inherit,
                [System.Security.AccessControl.PropagationFlags]::None,
                [System.Security.AccessControl.AccessControlType]::Allow)
            $acl.AddAccessRule($rule)
        }
        if ($Directory) { [System.IO.Directory]::SetAccessControl($Path, $acl) }
        else { [System.IO.File]::SetAccessControl($Path, $acl) }
    } catch {
        Write-Log 'WARN' ('setting ACL with .NET failed ({0}); falling back to icacls' -f $_.Exception.Message)
        if ($Directory) { $grants = @('*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F') }
        else { $grants = @('*S-1-5-18:F', '*S-1-5-32-544:F') }
        $r = Invoke-Native (Get-SystemExe 'icacls.exe') (@($Path, '/inheritance:r', '/grant:r') + $grants)
        if ($r.ExitCode -ne 0) { throw ('could not restrict permissions on {0}: {1}' -f $Path, $r.Output) }
    }
}

# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------
function New-AgentError {
    # Kinds: network (retry with backoff), http (server rejected the request), auth (401: stop),
    # cancelled (409: job cancelled).
    param([string]$Kind, [int]$Status, [string]$Message)
    $e = New-Object System.Exception -ArgumentList $Message
    $e.Data['ItsmKind'] = $Kind
    $e.Data['ItsmStatus'] = $Status
    return $e
}

function Get-AgentErrorInfo {
    param($ErrorObject, [string]$Key)
    $e = $ErrorObject
    if ($e -is [System.Management.Automation.ErrorRecord]) { $e = $e.Exception }
    while ($null -ne $e) {
        if ($e.Data -and $e.Data.Contains($Key)) { return $e.Data[$Key] }
        $e = $e.InnerException
    }
    return $null
}

function Get-AgentErrorKind {
    param($ErrorObject)
    $k = Get-AgentErrorInfo $ErrorObject 'ItsmKind'
    if ($null -eq $k) { return 'other' }
    return [string]$k
}

function Get-AgentErrorStatus {
    param($ErrorObject)
    $s = Get-AgentErrorInfo $ErrorObject 'ItsmStatus'
    if ($null -eq $s) { return 0 }
    return [int]$s
}

function ConvertTo-AgentError {
    param($ErrorRecord, [string]$What)
    $ex = $ErrorRecord.Exception
    $status = 0
    $we = $null
    $e = $ex
    while ($null -ne $e) {
        if ($e -is [System.Net.WebException]) { $we = $e; break }
        $e = $e.InnerException
    }
    if ($null -ne $we -and $null -ne $we.Response) {
        try { $status = [int]$we.Response.StatusCode } catch { $status = 0 }
        try { $we.Response.Close() } catch { }
    }
    $detail = ''
    if ($ErrorRecord.ErrorDetails -and $ErrorRecord.ErrorDetails.Message) { $detail = [string]$ErrorRecord.ErrorDetails.Message }
    if ($detail.Length -gt 300) { $detail = $detail.Substring(0, 300) + '...' }
    if ($status -eq 0) {
        return (New-AgentError 'network' 0 ('{0}: network error: {1}' -f $What, $ex.Message))
    }
    $msg = '{0}: HTTP {1}' -f $What, $status
    if ($detail) { $msg = $msg + ': ' + $detail }
    if ($status -eq 401) { return (New-AgentError 'auth' 401 $msg) }
    if ($status -eq 409) { return (New-AgentError 'cancelled' 409 $msg) }
    if ($status -ge 500 -or $status -eq 408 -or $status -eq 429) { return (New-AgentError 'network' $status $msg) }
    return (New-AgentError 'http' $status $msg)
}

# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------
function Import-CaCertificates {
    param([string]$Path, $Collection)
    $text = [System.IO.File]::ReadAllText($Path)
    $found = [regex]::Matches($text, '-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----')
    if ($found.Count -gt 0) {
        foreach ($m in $found) {
            $b64 = $m.Groups[1].Value -replace '\s', ''
            $bytes = [Convert]::FromBase64String($b64)
            $cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($bytes)
            [void]$Collection.Add($cert)
        }
    } else {
        $Collection.Import($Path)
    }
}

function Initialize-Http {
    param([string]$CaPath, [bool]$Insecure)
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    [Net.ServicePointManager]::Expect100Continue = $false
    [Net.ServicePointManager]::DefaultConnectionLimit = 8
    $roots = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2Collection
    if ($CaPath) {
        if (-not (Test-Path -LiteralPath $CaPath)) { throw ('CA file not found: ' + $CaPath) }
        Import-CaCertificates -Path $CaPath -Collection $roots
        if ($roots.Count -eq 0) { throw ('no certificates found in CA file ' + $CaPath) }
        Write-Log 'INFO' ('trusting private CA file {0} ({1} certificate(s)) in addition to the Windows store' -f $CaPath, $roots.Count)
    }
    if ($Insecure) {
        Write-Log 'WARN' 'insecure_skip_verify is enabled: the server TLS certificate is NOT verified. Use this for lab installs only.'
    }
    if ($Insecure -or $roots.Count -gt 0) {
        if (-not ('ItsmAgentCertPolicy' -as [type])) { Add-Type -TypeDefinition $script:CertPolicySource -Language CSharp }
        [ItsmAgentCertPolicy]::Enable($Insecure, $roots)
    }
}

function Invoke-AgentApi {
    param(
        [Parameter(Mandatory = $true)][string]$Method,
        [Parameter(Mandatory = $true)][string]$Path,
        $Body = $null,
        [int]$TimeoutSec = 60,
        [switch]$NoAuth
    )
    $uri = $script:ApiBase + $Path
    $headers = @{}
    if (-not $NoAuth) { $headers['Authorization'] = $script:AuthHeader }
    $params = @{
        Uri              = $uri
        Method           = $Method
        Headers          = $headers
        TimeoutSec       = $TimeoutSec
        UseBasicParsing  = $true
        DisableKeepAlive = $true
        UserAgent        = $script:UserAgent
        ErrorAction      = 'Stop'
    }
    if ($null -ne $Body) {
        $json = ConvertTo-Json -InputObject $Body -Depth 12 -Compress
        $params['Body'] = $script:Utf8NoBom.GetBytes($json)
        $params['ContentType'] = 'application/json; charset=utf-8'
    }
    try {
        return (Invoke-RestMethod @params)
    } catch {
        throw (ConvertTo-AgentError -ErrorRecord $_ -What ('{0} {1}' -f $Method, ($Path -replace '\?.*$', '')))
    }
}

function Resolve-ServerUrl {
    param([string]$Url)
    if ($Url -match '^[A-Za-z][A-Za-z0-9+.-]*://') { return $Url }
    $root = ([Uri]$script:ServerUrl).GetLeftPart([UriPartial]::Authority)
    if ($Url.StartsWith('/')) { return ($root + $Url) }
    return ($script:ApiBase + '/' + $Url)
}

function Test-SameOrigin {
    param([string]$A, [string]$B)
    try {
        $ua = [Uri]$A
        $ub = [Uri]$B
        return ($ua.Scheme -eq $ub.Scheme -and $ua.Host -eq $ub.Host -and $ua.Port -eq $ub.Port)
    } catch {
        return $false
    }
}

function Save-ServerFile {
    # Downloads a file. The device bearer token is sent only to the ITSM server itself.
    param([string]$Url, [string]$Destination, [int]$TimeoutSec = 600)
    $abs = Resolve-ServerUrl $Url
    $headers = @{}
    if (Test-SameOrigin $abs $script:ServerUrl) {
        $headers['Authorization'] = $script:AuthHeader
    } else {
        Write-Log 'INFO' ('downloading from {0} without device credentials (not the ITSM server)' -f ([Uri]$abs).Host)
    }
    try {
        Invoke-WebRequest -Uri $abs -Headers $headers -OutFile $Destination -UseBasicParsing -TimeoutSec $TimeoutSec -DisableKeepAlive -UserAgent $script:UserAgent -ErrorAction Stop
    } catch {
        throw (ConvertTo-AgentError -ErrorRecord $_ -What ('download ' + ([Uri]$abs).AbsolutePath))
    }
}

# ---------------------------------------------------------------------------
# Config and state
# ---------------------------------------------------------------------------
function Import-AgentConfig {
    if (-not (Test-Path -LiteralPath $script:ConfigPath)) {
        throw ('Agent is not enrolled: {0} not found. Run -Install first.' -f $script:ConfigPath)
    }
    $cfg = Read-JsonFile $script:ConfigPath
    if ($null -eq $cfg -or -not $cfg.server_url -or -not $cfg.device_id -or -not $cfg.device_secret) {
        throw ('Agent config {0} is incomplete. Re-run -Install.' -f $script:ConfigPath)
    }
    $script:Config = $cfg
    $script:ServerUrl = Get-NormalizedServerUrl ([string]$cfg.server_url)
    $script:ApiBase = $script:ServerUrl + $script:ApiPrefix
    Add-Secret ([string]$cfg.device_secret)
    $script:AuthHeader = 'Bearer ' + [string]$cfg.device_id + '.' + [string]$cfg.device_secret
    if ($cfg.poll_interval_seconds) {
        try { $script:PollInterval = [Math]::Max(10, [Math]::Min(3600, [int]$cfg.poll_interval_seconds)) } catch { }
    }
}

function Import-AgentState {
    $s = @{ last_inventory_at = 0; last_scan_at = 0; auth_failed = $false }
    try {
        $o = Read-JsonFile $script:StatePath
        if ($null -ne $o) { foreach ($p in $o.PSObject.Properties) { $s[$p.Name] = $p.Value } }
    } catch {
        Write-Log 'WARN' ('could not read state file: ' + $_.Exception.Message)
    }
    $script:State = $s
}

function Set-AgentState {
    param([string]$Name, $Value)
    if ($null -eq $script:State) { Import-AgentState }
    $script:State[$Name] = $Value
    try { Write-JsonFile $script:StatePath $script:State } catch { Write-Log 'WARN' ('could not save state: ' + $_.Exception.Message) }
}

function Test-Due {
    param([string]$Name, [int]$IntervalSeconds)
    $last = 0
    try { $last = [int64]$script:State[$Name] } catch { $last = 0 }
    return (((Get-EpochNow) - $last) -ge $IntervalSeconds)
}

# ---------------------------------------------------------------------------
# Processes
# ---------------------------------------------------------------------------
function Invoke-Native {
    # Runs a console tool and returns @{ ExitCode; Output }. Never throws on stderr output.
    param([string]$FilePath, [string[]]$ArgumentList)
    $ErrorActionPreference = 'Continue'
    $lines = @(& $FilePath @ArgumentList 2>&1 | ForEach-Object { [string]$_ })
    $code = $LASTEXITCODE
    return @{ ExitCode = $code; Output = ($lines -join "`r`n") }
}

function Stop-ProcessTree {
    param([int]$ProcessId)
    $null = Invoke-Native (Get-SystemExe 'taskkill.exe') @('/PID', [string]$ProcessId, '/T', '/F')
    try { Stop-Process -Id $ProcessId -Force -ErrorAction Stop } catch { }
}

function Read-TextHeadTail {
    # Reads a (possibly large) output file: everything up to MaxBytes, else head and tail.
    param([string]$Path, [int]$MaxBytes = 65536)
    if (-not (Test-Path -LiteralPath $Path)) { return '' }
    $fs = New-Object System.IO.FileStream($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
        $len = [int64]$fs.Length
        if ($len -le $MaxBytes) {
            $buf = New-Object byte[] ([int]$len)
            $null = $fs.Read($buf, 0, [int]$len)
            return $script:OemEncoding.GetString($buf)
        }
        $half = [int]($MaxBytes / 2)
        $head = New-Object byte[] $half
        $null = $fs.Read($head, 0, $half)
        $tail = New-Object byte[] $half
        $null = $fs.Seek(-$half, [System.IO.SeekOrigin]::End)
        $null = $fs.Read($tail, 0, $half)
        $marker = "`r`n...[{0} bytes truncated]...`r`n" -f ($len - 2 * $half)
        return ($script:OemEncoding.GetString($head) + $marker + $script:OemEncoding.GetString($tail))
    } finally {
        $fs.Dispose()
    }
}

function Limit-Output {
    # Keeps job output within the protocol limit (64 KB), preserving the head and the tail.
    param([string]$Text)
    if (-not $Text) { return '' }
    $enc = $script:Utf8NoBom
    if ($enc.GetByteCount($Text) -le $script:OutputLimit) { return $Text }
    foreach ($keep in @(30000, 10000)) {
        if ($Text.Length -gt (2 * $keep)) {
            $cut = $Text.Substring(0, $keep) + "`r`n...[output truncated]...`r`n" + $Text.Substring($Text.Length - $keep)
            if ($enc.GetByteCount($cut) -le $script:OutputLimit) { return $cut }
        }
    }
    return $Text.Substring(0, [Math]::Min($Text.Length, 15000))
}

function Get-TextTail {
    param([string]$Text, [int]$Max = 600)
    if (-not $Text) { return '' }
    $t = $Text.Trim()
    if ($t.Length -le $Max) { return $t }
    return ('...' + $t.Substring($t.Length - $Max))
}

function Invoke-ProcessWithTimeout {
    # Starts a process with stdout/stderr redirected to files, waits up to TimeoutSeconds and
    # kills the whole process tree on timeout. Returns @{ ExitCode; Output; TimedOut }.
    param([string]$FilePath, [string]$Arguments, [int]$TimeoutSeconds = 3600)
    Initialize-Directory $script:WorkDir
    $tag = [guid]::NewGuid().ToString('N')
    $outFile = Join-Path $script:WorkDir ($tag + '.out')
    $errFile = Join-Path $script:WorkDir ($tag + '.err')
    $sp = @{
        FilePath               = $FilePath
        RedirectStandardOutput = $outFile
        RedirectStandardError  = $errFile
        WorkingDirectory       = $script:WorkDir
        NoNewWindow            = $true
        PassThru               = $true
    }
    if ($Arguments) { $sp['ArgumentList'] = $Arguments }
    $proc = Start-Process @sp
    $null = $proc.Handle   # keeps the handle so ExitCode is available after exit
    $timedOut = $false
    $ms = [int][Math]::Min([double]$TimeoutSeconds * 1000, [double][int]::MaxValue)
    if (-not $proc.WaitForExit($ms)) {
        $timedOut = $true
        Write-Log 'WARN' ('process {0} exceeded {1} s; killing process tree' -f $proc.Id, $TimeoutSeconds)
        Stop-ProcessTree -ProcessId $proc.Id
        $null = $proc.WaitForExit(30000)
    }
    $code = $null
    try { $code = $proc.ExitCode } catch { $code = $null }
    $output = ''
    try {
        $stdout = Read-TextHeadTail $outFile
        $stderr = Read-TextHeadTail $errFile
        $output = $stdout
        if ($stderr -and $stderr.Trim()) {
            if ($output) { $output += "`r`n" }
            $output += $stderr
        }
    } catch {
        $output = '(could not read process output: ' + $_.Exception.Message + ')'
    } finally {
        Remove-Item -LiteralPath $outFile -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $errFile -Force -ErrorAction SilentlyContinue
    }
    return @{ ExitCode = $code; Output = $output; TimedOut = $timedOut }
}

# ---------------------------------------------------------------------------
# System information
# ---------------------------------------------------------------------------
function Get-Cim {
    param([string]$Class, [string]$Filter)
    try {
        if ($Filter) { return @(Get-CimInstance -ClassName $Class -Filter $Filter -ErrorAction Stop) }
        return @(Get-CimInstance -ClassName $Class -ErrorAction Stop)
    } catch {
        Write-Log 'WARN' ('CIM query {0} failed: {1}' -f $Class, $_.Exception.Message)
        return @()
    }
}

function Open-HklmKey {
    param([string]$SubKey)
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64)
    try {
        $k = $base.OpenSubKey($SubKey)
    } finally {
        $base.Close()
    }
    return $k
}

function Get-HklmValue {
    param([string]$SubKey, [string]$Name)
    $k = $null
    try {
        $k = Open-HklmKey $SubKey
        if ($null -eq $k) { return $null }
        return $k.GetValue($Name)
    } catch {
        return $null
    } finally {
        if ($null -ne $k) { $k.Close() }
    }
}

function Test-HklmKey {
    param([string]$SubKey)
    try {
        $k = Open-HklmKey $SubKey
        if ($null -eq $k) { return $false }
        $k.Close()
        return $true
    } catch {
        return $false
    }
}

function Get-OsArch {
    $a = $env:PROCESSOR_ARCHITEW6432
    if (-not $a) { $a = $env:PROCESSOR_ARCHITECTURE }
    if (-not $a) { return 'unknown' }
    switch ($a.ToUpperInvariant()) {
        'AMD64' { return 'x64' }
        'ARM64' { return 'arm64' }
        'X86' { return 'x86' }
        default { return $a.ToLowerInvariant() }
    }
}

function Get-NetworkInfo {
    $macs = New-Object System.Collections.Generic.List[string]
    $ips = New-Object System.Collections.Generic.List[string]
    foreach ($n in @(Get-Cim 'Win32_NetworkAdapterConfiguration' 'IPEnabled = TRUE')) {
        $mac = [string]$n.MACAddress
        if ($mac -and -not $macs.Contains($mac)) { $macs.Add($mac) }
        foreach ($ip in @($n.IPAddress)) {
            $s = [string]$ip
            if (-not $s) { continue }
            if ($s -like 'fe80:*' -or $s -like '169.254.*' -or $s -eq '::1' -or $s -like '127.*') { continue }
            if (-not $ips.Contains($s)) { $ips.Add($s) }
        }
    }
    return @{ mac_addresses = $macs.ToArray(); ip_addresses = $ips.ToArray() }
}

function Get-LoggedOnUser {
    try {
        $cs = @(Get-Cim 'Win32_ComputerSystem') | Select-Object -First 1
        if ($cs -and $cs.UserName) { return [string]$cs.UserName }
        # RDP-only sessions: fall back to the owner of an explorer.exe process.
        $ex = @(Get-Cim 'Win32_Process' "Name = 'explorer.exe'") | Select-Object -First 1
        if ($ex) {
            $o = Invoke-CimMethod -InputObject $ex -MethodName GetOwner -ErrorAction Stop
            if ($o -and $o.User) {
                if ($o.Domain) { return ('{0}\{1}' -f $o.Domain, $o.User) }
                return [string]$o.User
            }
        }
    } catch { }
    return $null
}

function Test-RebootPending {
    if (Test-HklmKey 'SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending') { return $true }
    if (Test-HklmKey 'SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired') { return $true }
    $pfro = @(Get-HklmValue 'SYSTEM\CurrentControlSet\Control\Session Manager' 'PendingFileRenameOperations')
    foreach ($entry in $pfro) { if ($entry) { return $true } }
    try {
        $si = New-Object -ComObject 'Microsoft.Update.SystemInfo'
        if ($si.RebootRequired) { return $true }
    } catch { }
    return $false
}

function Get-InstalledSoftware {
    # Outputs one ordered dictionary per installed product (64-bit and 32-bit Uninstall keys).
    $seen = @{}
    $paths = @('SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
        'SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')
    foreach ($path in $paths) {
        $key = $null
        try { $key = Open-HklmKey $path } catch { $key = $null }
        if ($null -eq $key) { continue }
        try {
            foreach ($subName in $key.GetSubKeyNames()) {
                $k = $null
                try {
                    $k = $key.OpenSubKey($subName)
                    if ($null -eq $k) { continue }
                    $name = Get-StringOrNull $k.GetValue('DisplayName')
                    if ($null -eq $name) { continue }
                    $sc = $k.GetValue('SystemComponent')
                    if ($null -ne $sc -and [string]$sc -eq '1') { continue }
                    $version = Get-StringOrNull $k.GetValue('DisplayVersion')
                    if ($null -eq $version) { $version = '' }
                    $dedupe = $name + '|' + $version
                    if ($seen.ContainsKey($dedupe)) { continue }
                    $seen[$dedupe] = $true
                    $installedOn = $null
                    $raw = Get-StringOrNull $k.GetValue('InstallDate')
                    if ($raw -and $raw -match '^\d{8}$') {
                        try { $installedOn = [DateTime]::ParseExact($raw, 'yyyyMMdd', $script:Invariant).ToString('yyyy-MM-dd', $script:Invariant) } catch { $installedOn = $null }
                    }
                    [ordered]@{
                        name         = $name
                        version      = $version
                        publisher    = Get-StringOrNull $k.GetValue('Publisher')
                        installed_on = $installedOn
                    }
                } catch {
                    # skip unreadable entries
                } finally {
                    if ($null -ne $k) { $k.Close() }
                }
            }
        } finally {
            $key.Close()
        }
    }
}

function Get-HeartbeatBody {
    $os = @(Get-Cim 'Win32_OperatingSystem') | Select-Object -First 1
    $uptime = $null
    if ($os -and $os.LastBootUpTime) { $uptime = [int64]([DateTime]::Now - $os.LastBootUpTime).TotalSeconds }
    $net = Get-NetworkInfo
    $rebootPending = [bool](Test-RebootPending)
    $user = Get-LoggedOnUser
    return [ordered]@{
        agent_version  = $script:AgentVersion
        hostname       = $env:COMPUTERNAME
        logged_on_user = $user
        uptime_seconds = $uptime
        reboot_pending = $rebootPending
        ip_addresses   = $net.ip_addresses
    }
}

function Get-EnrollBody {
    param([string]$EnrollToken)
    $os = @(Get-Cim 'Win32_OperatingSystem') | Select-Object -First 1
    $bios = @(Get-Cim 'Win32_BIOS') | Select-Object -First 1
    $net = Get-NetworkInfo
    $osName = $null
    $osVersion = $null
    if ($os) { $osName = Get-StringOrNull $os.Caption; $osVersion = Get-StringOrNull $os.Version }
    $serial = $null
    if ($bios) { $serial = Get-CleanValue $bios.SerialNumber }
    return [ordered]@{
        token         = $EnrollToken
        hostname      = $env:COMPUTERNAME
        os_family     = 'windows'
        os_name       = $osName
        os_version    = $osVersion
        arch          = Get-OsArch
        agent_version = $script:AgentVersion
        serial_no     = $serial
        mac_addresses = $net.mac_addresses
    }
}

function Get-Inventory {
    $cs = @(Get-Cim 'Win32_ComputerSystem') | Select-Object -First 1
    $os = @(Get-Cim 'Win32_OperatingSystem') | Select-Object -First 1
    $bios = @(Get-Cim 'Win32_BIOS') | Select-Object -First 1
    $cpus = @(Get-Cim 'Win32_Processor')

    $disks = New-Object System.Collections.Generic.List[object]
    foreach ($d in @(Get-Cim 'Win32_LogicalDisk' 'DriveType = 3')) {
        $size = $null
        $free = $null
        if ($null -ne $d.Size) { $size = [Math]::Round([double]$d.Size / 1GB, 1) }
        if ($null -ne $d.FreeSpace) { $free = [Math]::Round([double]$d.FreeSpace / 1GB, 1) }
        $disks.Add([ordered]@{ name = [string]$d.DeviceID; size_gb = $size; free_gb = $free })
    }

    $cpuName = $null
    $cores = $null
    if ($cpus.Count -gt 0) {
        $cpuName = Get-StringOrNull $cpus[0].Name
        $sum = 0
        foreach ($c in $cpus) { if ($c.NumberOfCores) { $sum += [int]$c.NumberOfCores } }
        if ($sum -gt 0) { $cores = $sum }
    }

    $manufacturer = $null
    $model = $null
    $ram = $null
    $domain = $null
    if ($cs) {
        $manufacturer = Get-CleanValue $cs.Manufacturer
        $model = Get-CleanValue $cs.Model
        if ($cs.TotalPhysicalMemory) { $ram = [int64][Math]::Round([double]$cs.TotalPhysicalMemory / 1MB) }
        if ($cs.PartOfDomain) { $domain = Get-StringOrNull $cs.Domain }
    }

    $osName = $null
    $osVersion = $null
    $build = $null
    $installDate = $null
    if ($os) {
        $osName = Get-StringOrNull $os.Caption
        $osVersion = Get-StringOrNull $os.Version
        $build = Get-StringOrNull $os.BuildNumber
        $ubr = Get-HklmValue 'SOFTWARE\Microsoft\Windows NT\CurrentVersion' 'UBR'
        if ($null -ne $ubr -and $build) { $build = '{0}.{1}' -f $build, $ubr }
        $installDate = Format-DateOnly $os.InstallDate
    }

    $serial = $null
    if ($bios) { $serial = Get-CleanValue $bios.SerialNumber }

    $net = Get-NetworkInfo
    $software = @(Get-InstalledSoftware)

    return [ordered]@{
        hardware = [ordered]@{
            manufacturer = $manufacturer
            model        = $model
            serial_no    = $serial
            cpu          = $cpuName
            cpu_cores    = $cores
            ram_mb       = $ram
            disks        = $disks
        }
        os       = [ordered]@{
            name         = $osName
            version      = $osVersion
            build        = $build
            arch         = Get-OsArch
            domain       = $domain
            install_date = $installDate
        }
        network  = [ordered]@{
            mac_addresses = $net.mac_addresses
            ip_addresses  = $net.ip_addresses
        }
        software = $software
    }
}

# ---------------------------------------------------------------------------
# Windows Update scan
# ---------------------------------------------------------------------------
function Get-WuaClassification {
    param($Update)
    # Classification category IDs are fixed GUIDs; names are matched as a fallback.
    $byId = @{
        '0fa1201d-4330-4fa8-8ae9-b877473b6441' = 'security'
        'e6cf1350-c01b-414d-a61f-263d14d133b4' = 'critical'
        'e0789628-ce08-4437-be74-2495b842f43b' = 'definition'
        'ebfc1fc5-71a4-4f7b-9aca-3b9a503104a0' = 'driver'
        'b54e7d24-7add-428f-8b75-90a396fa584f' = 'feature'
        '3689bdc8-b205-4af4-8d4a-a63924c5e9d5' = 'feature'
    }
    $byName = @{
        'Security Updates'   = 'security'
        'Critical Updates'   = 'critical'
        'Definition Updates' = 'definition'
        'Drivers'            = 'driver'
        'Feature Packs'      = 'feature'
        'Upgrades'           = 'feature'
    }
    $rank = @{ security = 6; critical = 5; definition = 4; driver = 3; feature = 2; update = 1 }
    $best = 'update'
    try {
        foreach ($c in $Update.Categories) {
            $cls = $null
            $id = ([string]$c.CategoryID).ToLowerInvariant()
            $name = [string]$c.Name
            if ($byId.ContainsKey($id)) { $cls = $byId[$id] }
            elseif ($name -and $byName.ContainsKey($name)) { $cls = $byName[$name] }
            if ($cls -and $rank[$cls] -gt $rank[$best]) { $best = $cls }
        }
    } catch { }
    return $best
}

function Get-WuaSeverity {
    param([string]$MsrcSeverity)
    switch ($MsrcSeverity) {
        'Critical' { return 'critical' }
        'Important' { return 'important' }
        'Moderate' { return 'moderate' }
        'Low' { return 'low' }
        default { return 'unspecified' }
    }
}

function ConvertTo-PatchItem {
    param($Update)
    $kb = $null
    foreach ($k in $Update.KBArticleIDs) {
        if ($k) { $kb = 'KB' + [string]$k; break }
    }
    $reboot = $false
    try { if ([int]$Update.InstallationBehavior.RebootBehavior -ne 0) { $reboot = $true } } catch { }
    try { if ($Update.RebootRequired) { $reboot = $true } } catch { }
    $size = $null
    try { $size = [int64]$Update.MaxDownloadSize } catch { $size = $null }
    return [ordered]@{
        external_id     = [string]$Update.Identity.UpdateID
        kb              = $kb
        title           = [string]$Update.Title
        classification  = Get-WuaClassification $Update
        severity        = Get-WuaSeverity ([string]$Update.MsrcSeverity)
        version         = ''
        size_bytes      = $size
        reboot_required = $reboot
        release_date    = Format-DateOnly $Update.LastDeploymentChangeTime
        description     = Get-StringOrNull $Update.Description
        support_url     = Get-StringOrNull $Update.SupportUrl
    }
}

function Invoke-PatchScan {
    $started = [DateTime]::UtcNow
    Write-Log 'INFO' 'Windows Update scan started'
    $session = New-Object -ComObject 'Microsoft.Update.Session'
    try { $session.ClientApplicationID = 'ITSM Agent' } catch { }
    $searcher = $session.CreateUpdateSearcher()
    $result = $searcher.Search($script:WuaCriteria)

    $available = New-Object System.Collections.Generic.List[object]
    foreach ($u in $result.Updates) {
        try { $available.Add((ConvertTo-PatchItem $u)) } catch { Write-Log 'WARN' ('skipping an update that could not be read: ' + $_.Exception.Message) }
    }

    $installed = New-Object System.Collections.Generic.List[object]
    try {
        $total = [int]$searcher.GetTotalHistoryCount()
        if ($total -gt 0) {
            $seen = @{}
            $history = $searcher.QueryHistory(0, [Math]::Min(100, $total))
            foreach ($h in $history) {
                try {
                    # ResultCode 2 = succeeded, Operation 1 = installation
                    if ([int]$h.ResultCode -ne 2 -or [int]$h.Operation -ne 1) { continue }
                    $id = [string]$h.UpdateIdentity.UpdateID
                    if (-not $id -or $seen.ContainsKey($id)) { continue }
                    $seen[$id] = $true
                    $title = [string]$h.Title
                    $kb = $null
                    if ($title -match '(KB\d{4,8})') { $kb = $Matches[1].ToUpperInvariant() }
                    $installed.Add([ordered]@{
                            external_id  = $id
                            kb           = $kb
                            title        = $title
                            installed_on = Format-DateOnly $h.Date
                        })
                } catch { }
            }
        }
    } catch {
        Write-Log 'WARN' ('could not read Windows Update history: ' + $_.Exception.Message)
    }

    $secs = [int]([DateTime]::UtcNow - $started).TotalSeconds
    Write-Log 'INFO' ('Windows Update scan finished in {0} s: {1} available, {2} recently installed' -f $secs, $available.Count, $installed.Count)
    return [ordered]@{
        source     = 'windows_update'
        scanned_at = Get-IsoNow
        available  = $available
        installed  = $installed
    }
}

function Send-Inventory {
    $inv = Get-Inventory
    $null = Invoke-AgentApi -Method POST -Path '/inventory' -Body $inv -TimeoutSec 120
    Set-AgentState 'last_inventory_at' (Get-EpochNow)
    Write-Log 'INFO' ('inventory sent ({0} software entries)' -f @($inv.software).Count)
    return $inv
}

function Send-PatchScan {
    $scan = Invoke-PatchScan
    $resp = Invoke-AgentApi -Method POST -Path '/patches' -Body $scan -TimeoutSec 120
    Set-AgentState 'last_scan_at' (Get-EpochNow)
    $missing = $null
    if ($resp -and $null -ne $resp.missing) { $missing = $resp.missing }
    Write-Log 'INFO' ('patch scan sent ({0} available; server reports {1} missing)' -f $scan.available.Count, $missing)
    return @{ Scan = $scan; Missing = $missing }
}

function Send-Heartbeat {
    $body = Get-HeartbeatBody
    $resp = Invoke-AgentApi -Method POST -Path '/heartbeat' -Body $body -TimeoutSec 30
    if ($resp -and $resp.poll_interval_seconds) {
        try { $script:PollInterval = [Math]::Max(10, [Math]::Min(3600, [int]$resp.poll_interval_seconds)) } catch { }
    }
    return $resp
}

# ---------------------------------------------------------------------------
# Jobs
# ---------------------------------------------------------------------------
function New-JobResult {
    param([string]$Status, $ExitCode, [string]$Output)
    return @{ status = $Status; exit_code = $ExitCode; output = $Output; result = $null; PostAction = $null }
}

function Get-PatchLabel {
    param($Item)
    if ($Item.kb) { return [string]$Item.kb }
    if ($Item.title) { return [string]$Item.title }
    return [string]$Item.external_id
}

function Add-PatchResult {
    param($Results, $Log, $Item, [string]$Status, $ErrorText)
    $Results.Add([ordered]@{ external_id = [string]$Item.external_id; status = $Status; error = $ErrorText })
    $line = '{0}: {1}' -f (Get-PatchLabel $Item), $Status
    if ($ErrorText) { $line = $line + ' - ' + $ErrorText }
    $Log.Add($line)
    Write-Log 'INFO' ('patch ' + $line)
}

function Get-PackageFileName {
    param($Item)
    $name = [string]$Item.package_name
    if (-not $name) {
        try { $name = [Uri]::UnescapeDataString(([Uri](Resolve-ServerUrl ([string]$Item.package_url))).AbsolutePath) } catch { $name = '' }
    }
    $idx = [Math]::Max($name.LastIndexOf('/'), $name.LastIndexOf('\'))
    if ($idx -ge 0) { $name = $name.Substring($idx + 1) }
    foreach ($c in [System.IO.Path]::GetInvalidFileNameChars()) { $name = $name.Replace([string]$c, '_') }
    $name = $name.Trim().TrimStart('.')
    if (-not $name) { $name = 'package' }
    if ($name.Length -gt 120) { $name = $name.Substring($name.Length - 120) }
    return $name
}

function Install-PackageItem {
    # Offline / air-gapped package: download with the device token, verify SHA-256, install.
    # Returns $true when a reboot is required.
    param($Item, $Results, $Log)
    $expected = Get-NormalizedSha ([string]$Item.package_sha256)
    if (-not $expected) {
        Add-PatchResult $Results $Log $Item 'failed' 'package_sha256 is missing or invalid; refusing to install an unverified package'
        return $false
    }
    $fileName = Get-PackageFileName $Item
    $ext = [System.IO.Path]::GetExtension($fileName).ToLowerInvariant()
    if (@('.msu', '.cab', '.msi', '.exe') -notcontains $ext) {
        Add-PatchResult $Results $Log $Item 'failed' ('unsupported package type "{0}" (expected .msu, .cab, .msi or .exe in package_name)' -f $ext)
        return $false
    }
    Initialize-Directory $script:PackageDir
    $dir = Join-Path $script:PackageDir ([guid]::NewGuid().ToString('N'))
    Initialize-Directory $dir
    $file = Join-Path $dir $fileName
    $reboot = $false
    try {
        Write-Log 'INFO' ('downloading package {0}' -f $fileName)
        Save-ServerFile -Url ([string]$Item.package_url) -Destination $file -TimeoutSec 600
        $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant()
        if ($actual -ne $expected) {
            Add-PatchResult $Results $Log $Item 'failed' ('SHA-256 mismatch (expected {0}, got {1})' -f $expected, $actual)
            return $false
        }
        switch ($ext) {
            '.msu' { $exe = Get-SystemExe 'wusa.exe'; $argLine = '"{0}" /quiet /norestart' -f $file }
            '.cab' { $exe = Get-SystemExe 'dism.exe'; $argLine = '/online /add-package /packagepath:"{0}" /quiet /norestart' -f $file }
            '.msi' { $exe = Get-SystemExe 'msiexec.exe'; $argLine = '/i "{0}" /qn /norestart' -f $file }
            default { $exe = $file; $argLine = '/quiet /norestart' }
        }
        Write-Log 'INFO' ('installing {0}' -f $fileName)
        $r = Invoke-ProcessWithTimeout -FilePath $exe -Arguments $argLine -TimeoutSeconds $script:PackageTimeoutSeconds
        $code = $r.ExitCode
        if ($r.TimedOut) {
            Add-PatchResult $Results $Log $Item 'failed' ('installer timed out after {0} s' -f $script:PackageTimeoutSeconds)
        } elseif ($code -eq 0) {
            Add-PatchResult $Results $Log $Item 'installed' $null
        } elseif ($code -eq 3010 -or $code -eq 1641) {
            Add-PatchResult $Results $Log $Item 'pending_reboot' $null
            $reboot = $true
        } elseif ($code -eq 2359302) {
            # 0x00240006 WU_S_ALREADY_INSTALLED (wusa)
            Add-PatchResult $Results $Log $Item 'installed' $null
        } else {
            $msg = 'installer exit code {0}' -f $code
            $tail = Get-TextTail $r.Output 400
            if ($tail) { $msg = $msg + ': ' + $tail }
            Add-PatchResult $Results $Log $Item 'failed' $msg
        }
    } catch {
        if ((Get-AgentErrorKind $_) -eq 'auth') { throw }
        Add-PatchResult $Results $Log $Item 'failed' $_.Exception.Message
    } finally {
        Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
    }
    return $reboot
}

function Install-WuaUpdates {
    # Installs updates by UpdateID through the Windows Update Agent. Returns @{ RebootRequired }.
    param([object[]]$Items, $Results, $Log)
    $state = @{ RebootRequired = $false }
    $session = New-Object -ComObject 'Microsoft.Update.Session'
    try { $session.ClientApplicationID = 'ITSM Agent' } catch { }
    $searcher = $session.CreateUpdateSearcher()
    Write-Log 'INFO' 'searching Windows Update for the requested updates'
    $found = @{}
    $search = $searcher.Search($script:WuaCriteria)
    foreach ($u in $search.Updates) { $found[[string]$u.Identity.UpdateID] = $u }

    $coll = New-Object -ComObject 'Microsoft.Update.UpdateColl'
    $pending = New-Object System.Collections.Generic.List[object]
    foreach ($it in $Items) {
        $id = [string]$it.external_id
        if ($id -notmatch $script:GuidPattern) {
            Add-PatchResult $Results $Log $it 'failed' 'external_id is not a Windows Update UpdateID'
            continue
        }
        if (-not $found.ContainsKey($id)) {
            $already = $false
            try {
                $r2 = $searcher.Search("UpdateID='" + $id + "' and IsInstalled=1")
                if ($r2.Updates.Count -gt 0) { $already = $true }
            } catch { }
            if ($already) { Add-PatchResult $Results $Log $it 'installed' $null }
            else { Add-PatchResult $Results $Log $it 'failed' 'update not offered by Windows Update (not applicable, superseded or hidden)' }
            continue
        }
        $u = $found[$id]
        try { if (-not $u.EulaAccepted) { $u.AcceptEula() } } catch { }
        $null = $coll.Add($u)
        $pending.Add(@{ Item = $it; Update = $u; Index = ($coll.Count - 1) })
    }
    if ($coll.Count -eq 0) { return $state }

    Write-Log 'INFO' ('downloading {0} update(s) through Windows Update' -f $coll.Count)
    $dlResult = $null
    $dlError = $null
    try {
        $downloader = $session.CreateUpdateDownloader()
        $downloader.Updates = $coll
        $dlResult = $downloader.Download()
    } catch {
        $dlError = $_.Exception.Message
    }

    $instColl = New-Object -ComObject 'Microsoft.Update.UpdateColl'
    $toInstall = New-Object System.Collections.Generic.List[object]
    foreach ($p in $pending) {
        $downloaded = $false
        try { $downloaded = [bool]$p.Update.IsDownloaded } catch { $downloaded = $false }
        if ($downloaded) {
            $null = $instColl.Add($p.Update)
            $toInstall.Add($p)
            continue
        }
        $msg = 'download failed'
        if ($dlError) { $msg = 'download failed: ' + $dlError }
        elseif ($null -ne $dlResult) {
            try {
                $r = $dlResult.GetUpdateResult($p.Index)
                $msg = 'download failed (result code {0}, HRESULT 0x{1:X8})' -f [int]$r.ResultCode, [int]$r.HResult
            } catch { }
        }
        Add-PatchResult $Results $Log $p.Item 'failed' $msg
    }
    if ($instColl.Count -eq 0) { return $state }

    Write-Log 'INFO' ('installing {0} update(s) through Windows Update' -f $instColl.Count)
    try {
        $installer = $session.CreateUpdateInstaller()
        try { $installer.ForceQuiet = $true } catch { }
        try { $installer.AllowSourcePrompts = $false } catch { }
        $installer.Updates = $instColl
        $ir = $installer.Install()
        try { if ($ir.RebootRequired) { $state.RebootRequired = $true } } catch { }
        for ($i = 0; $i -lt $toInstall.Count; $i++) {
            $p = $toInstall[$i]
            try {
                $r = $ir.GetUpdateResult($i)
                $code = [int]$r.ResultCode
                # 2 = succeeded, 3 = succeeded with errors, 4 = failed, 5 = aborted
                if ($code -eq 2 -or $code -eq 3) {
                    if ($r.RebootRequired) {
                        $state.RebootRequired = $true
                        Add-PatchResult $Results $Log $p.Item 'pending_reboot' $null
                    } else {
                        Add-PatchResult $Results $Log $p.Item 'installed' $null
                    }
                } else {
                    Add-PatchResult $Results $Log $p.Item 'failed' ('install failed (result code {0}, HRESULT 0x{1:X8})' -f $code, [int]$r.HResult)
                }
            } catch {
                Add-PatchResult $Results $Log $p.Item 'failed' ('could not read install result: ' + $_.Exception.Message)
            }
        }
    } catch {
        $msg = 'Windows Update install failed: ' + $_.Exception.Message
        foreach ($p in $toInstall) { Add-PatchResult $Results $Log $p.Item 'failed' $msg }
    }
    return $state
}

function Invoke-ScheduledReboot {
    param([int]$DelaySeconds, [string]$Message)
    # At least 10 s so the job result can be reported before Windows shuts down.
    if ($DelaySeconds -lt 10) { $DelaySeconds = 10 }
    if ($DelaySeconds -gt 315360000) { $DelaySeconds = 315360000 }
    if (-not $Message) { $Message = 'Your IT department has scheduled a restart of this computer.' }
    $Message = ($Message -replace '["\r\n\t]', ' ').Trim().TrimEnd('\')
    if ($Message.Length -gt 500) { $Message = $Message.Substring(0, 500) }
    Write-Log 'INFO' ('scheduling reboot in {0} s' -f $DelaySeconds)
    $r = Invoke-Native (Get-SystemExe 'shutdown.exe') @('/r', '/t', [string]$DelaySeconds, '/c', $Message, '/d', 'p:0:0')
    $r['Delay'] = $DelaySeconds
    return $r
}

function Invoke-InventoryJob {
    $inv = Send-Inventory
    return (New-JobResult 'succeeded' 0 ('inventory sent: {0} software entries, {1} disk(s)' -f @($inv.software).Count, $inv.hardware.disks.Count))
}

function Invoke-ScanJob {
    $r = Send-PatchScan
    $text = 'scan sent: {0} available, {1} recently installed' -f $r.Scan.available.Count, $r.Scan.installed.Count
    if ($null -ne $r.Missing) { $text = $text + ('; server reports {0} missing' -f $r.Missing) }
    return (New-JobResult 'succeeded' 0 $text)
}

function Invoke-InstallPatchesJob {
    param($Job)
    $payload = $Job.payload
    $items = @()
    if ($null -ne $payload -and $null -ne $payload.patches) { $items = @($payload.patches) }
    $mode = 'never'
    if ($null -ne $payload -and $payload.reboot) { $mode = ([string]$payload.reboot).ToLowerInvariant() }
    if (@('never', 'if_required', 'always') -notcontains $mode) { $mode = 'never' }

    $results = New-Object System.Collections.Generic.List[object]
    $log = New-Object System.Collections.Generic.List[string]
    $reboot = $false
    $wuaItems = New-Object System.Collections.Generic.List[object]
    foreach ($it in $items) {
        if ($null -eq $it) { continue }
        if ($it.package_url) {
            if (Install-PackageItem -Item $it -Results $results -Log $log) { $reboot = $true }
        } else {
            $wuaItems.Add($it)
        }
    }
    if ($wuaItems.Count -gt 0) {
        try {
            $st = Install-WuaUpdates -Items $wuaItems.ToArray() -Results $results -Log $log
            if ($st -and $st.RebootRequired) { $reboot = $true }
        } catch {
            if ((Get-AgentErrorKind $_) -eq 'auth') { throw }
            $msg = 'Windows Update error: ' + $_.Exception.Message
            $done = @{}
            foreach ($r in $results) { $done[[string]$r.external_id] = $true }
            foreach ($it in $wuaItems) {
                if (-not $done.ContainsKey([string]$it.external_id)) { Add-PatchResult $results $log $it 'failed' $msg }
            }
        }
    }
    if ($items.Count -eq 0) { $log.Add('no patches in the job payload') }
    foreach ($r in $results) { if ($r.status -eq 'pending_reboot') { $reboot = $true } }
    if (Test-RebootPending) { $reboot = $true }

    # Rescan so the server sees the new state.
    try {
        $null = Send-PatchScan
    } catch {
        if ((Get-AgentErrorKind $_) -eq 'auth') { throw }
        Write-Log 'WARN' ('post-install scan failed: ' + $_.Exception.Message)
        $log.Add('post-install scan failed: ' + $_.Exception.Message)
    }

    $failed = 0
    foreach ($r in $results) { if ($r.status -eq 'failed') { $failed++ } }
    $status = 'succeeded'
    $exit = 0
    if ($failed -gt 0) { $status = 'failed'; $exit = 1 }
    $doReboot = ($mode -eq 'always') -or ($mode -eq 'if_required' -and $reboot)
    if ($reboot) { $log.Add('a reboot is required to complete installation') }
    if ($doReboot) { $log.Add(('reboot policy "{0}": restarting in 60 s' -f $mode)) }
    elseif ($reboot) { $log.Add(('reboot policy "{0}": not restarting' -f $mode)) }

    $res = New-JobResult $status $exit ($log -join "`r`n")
    $res.result = [ordered]@{ results = $results; reboot_required = $reboot }
    if ($doReboot) { $res.PostAction = 'reboot' }
    return $res
}

function Invoke-RunScriptJob {
    param($Job)
    $payload = $Job.payload
    $shell = ''
    $scriptText = ''
    $timeout = 300
    if ($null -ne $payload) {
        $shell = ([string]$payload.shell).ToLowerInvariant()
        $scriptText = [string]$payload.script
        if ($payload.timeout_seconds) { try { $timeout = [int]$payload.timeout_seconds } catch { $timeout = 300 } }
    }
    if ($timeout -lt 1) { $timeout = 1 }
    if ($timeout -gt 86400) { $timeout = 86400 }
    Initialize-Directory $script:WorkDir
    $safeId = ([string]$Job.id) -replace '[^A-Za-z0-9-]', '_'
    switch ($shell) {
        'powershell' {
            $file = Join-Path $script:WorkDir ('job-' + $safeId + '.ps1')
            [System.IO.File]::WriteAllText($file, $scriptText, $script:Utf8Bom)
            $exe = Join-Path $PSHOME 'powershell.exe'
            $argLine = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}"' -f $file
        }
        'cmd' {
            $file = Join-Path $script:WorkDir ('job-' + $safeId + '.cmd')
            $normalized = ($scriptText -replace "`r?`n", "`r`n")
            [System.IO.File]::WriteAllText($file, $normalized, $script:OemEncoding)
            $exe = $env:ComSpec
            if (-not $exe) { $exe = Get-SystemExe 'cmd.exe' }
            $argLine = '/d /c "{0}"' -f $file
        }
        default {
            return (New-JobResult 'failed' 1 ('unsupported shell "{0}" on Windows (use powershell or cmd)' -f $shell))
        }
    }
    Write-Log 'INFO' ('running {0} script for job {1} (timeout {2} s)' -f $shell, $Job.id, $timeout)
    try {
        $r = Invoke-ProcessWithTimeout -FilePath $exe -Arguments $argLine -TimeoutSeconds $timeout
    } finally {
        Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
    }
    $out = [string]$r.Output
    if ($r.TimedOut) {
        $out = $out + ("`r`n[timed out after {0} s; process tree killed]" -f $timeout)
        return (New-JobResult 'failed' -1 $out)
    }
    $code = $r.ExitCode
    if ($null -eq $code) { $code = -1 }
    Write-Log 'INFO' ('script for job {0} exited with code {1}' -f $Job.id, $code)
    $status = 'failed'
    if ($code -eq 0) { $status = 'succeeded' }
    return (New-JobResult $status $code $out)
}

function Invoke-RebootJob {
    param($Job)
    $payload = $Job.payload
    $delay = 60
    $msg = $null
    if ($null -ne $payload) {
        if ($null -ne $payload.delay_seconds) { try { $delay = [int]$payload.delay_seconds } catch { $delay = 60 } }
        $msg = [string]$payload.message
    }
    $r = Invoke-ScheduledReboot -DelaySeconds $delay -Message $msg
    if ($r.ExitCode -eq 0) {
        return (New-JobResult 'succeeded' 0 ('reboot scheduled in {0} s' -f $r.Delay))
    }
    if ($r.ExitCode -eq 1190) {
        # ERROR_SHUTDOWN_IS_SCHEDULED
        return (New-JobResult 'succeeded' 0 'a shutdown or reboot is already scheduled on this device')
    }
    return (New-JobResult 'failed' $r.ExitCode ('shutdown.exe failed: ' + $r.Output))
}

function Invoke-UpdateAgentJob {
    param($Job)
    $payload = $Job.payload
    $url = $null
    $expected = $null
    if ($null -ne $payload) { $url = [string]$payload.url; $expected = Get-NormalizedSha ([string]$payload.sha256) }
    if (-not $url -or -not $expected) { return (New-JobResult 'failed' 1 'update_agent requires url and a valid sha256') }
    Initialize-Directory $script:WorkDir
    $tmp = Join-Path $script:WorkDir 'itsm-agent.ps1.new'
    try {
        Save-ServerFile -Url $url -Destination $tmp -TimeoutSec 300
        $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $tmp).Hash.ToLowerInvariant()
        if ($actual -ne $expected) { return (New-JobResult 'failed' 1 ('SHA-256 mismatch (expected {0}, got {1})' -f $expected, $actual)) }
        $tokens = $null
        $parseErrors = $null
        $null = [System.Management.Automation.Language.Parser]::ParseFile($tmp, [ref]$tokens, [ref]$parseErrors)
        if ($parseErrors -and $parseErrors.Count -gt 0) {
            return (New-JobResult 'failed' 1 ('downloaded agent does not parse: ' + $parseErrors[0].Message))
        }
        Initialize-Directory $script:InstallDir
        if (Test-Path -LiteralPath $script:InstalledScript) {
            Copy-Item -LiteralPath $script:InstalledScript -Destination ($script:InstalledScript + '.bak') -Force
        }
        Copy-Item -LiteralPath $tmp -Destination $script:InstalledScript -Force
        try { Unblock-File -LiteralPath $script:InstalledScript } catch { }
    } finally {
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    }
    Write-Log 'INFO' 'agent script replaced; restarting the agent'
    $res = New-JobResult 'succeeded' 0 'agent updated; restarting'
    $res.PostAction = 'restart'
    return $res
}

function Send-JobStatus {
    # Returns 'ok', 'cancelled' or 'error'. Throws only on 401.
    param([string]$JobId, $Body, [int]$Attempts = 1)
    $delay = 5
    for ($i = 1; $i -le $Attempts; $i++) {
        try {
            $null = Invoke-AgentApi -Method POST -Path ('/jobs/' + $JobId) -Body $Body -TimeoutSec 60
            return 'ok'
        } catch {
            $k = Get-AgentErrorKind $_
            if ($k -eq 'auth') { throw }
            if ($k -eq 'cancelled') { return 'cancelled' }
            Write-Log 'WARN' ('could not report job {0} status: {1}' -f $JobId, $_.Exception.Message)
            if ($k -ne 'network') { return 'error' }
            if ($i -lt $Attempts) {
                Start-Sleep -Seconds $delay
                $delay = [Math]::Min($delay * 2, 300)
            }
        }
    }
    return 'error'
}

function Request-AgentRestart {
    $psExe = Join-Path $PSHOME 'powershell.exe'
    $cmd = "Start-Sleep -Seconds 15; Start-ScheduledTask -TaskName '{0}'" -f $script:TaskName
    try {
        $null = Start-Process -FilePath $psExe -ArgumentList ('-NoProfile -NonInteractive -WindowStyle Hidden -Command "' + $cmd + '"') -WindowStyle Hidden -PassThru
    } catch {
        Write-Log 'WARN' ('could not schedule the agent restart: ' + $_.Exception.Message + ' (the task watchdog trigger restarts it within 5 minutes)')
    }
    $script:StopRequested = $true
}

function Invoke-AgentJob {
    param($Job)
    $id = [string]$Job.id
    $kind = [string]$Job.kind
    if ($id -notmatch '^[A-Za-z0-9_-]{1,100}$') {
        Write-Log 'WARN' 'ignoring a job with a missing or invalid id'
        return
    }
    Write-Log 'INFO' ('job {0} ({1}) received' -f $id, $kind)
    $st = Send-JobStatus -JobId $id -Body ([ordered]@{ status = 'running' }) -Attempts 1
    if ($st -eq 'cancelled') {
        Write-Log 'INFO' ('job {0} was cancelled on the server; skipping' -f $id)
        return
    }
    $res = $null
    try {
        switch ($kind) {
            'inventory' { $res = Invoke-InventoryJob }
            'scan' { $res = Invoke-ScanJob }
            'install_patches' { $res = Invoke-InstallPatchesJob -Job $Job }
            'run_script' { $res = Invoke-RunScriptJob -Job $Job }
            'reboot' { $res = Invoke-RebootJob -Job $Job }
            'update_agent' { $res = Invoke-UpdateAgentJob -Job $Job }
            default { $res = New-JobResult 'failed' 1 ('unsupported job kind "{0}"' -f $kind) }
        }
    } catch {
        if ((Get-AgentErrorKind $_) -eq 'auth') { throw }
        Write-Log 'ERROR' ('job {0} ({1}) failed: {2}' -f $id, $kind, $_.Exception.Message)
        $res = New-JobResult 'failed' 1 ('job failed: ' + $_.Exception.Message)
    }
    # Defensive: a handler that accidentally wrote extra output returns an array.
    if ($res -is [array]) { $res = @($res | Where-Object { $_ -is [hashtable] -and $_.ContainsKey('status') }) | Select-Object -Last 1 }
    if ($null -eq $res) { $res = New-JobResult 'failed' 1 'internal error: job handler returned no result' }

    $body = [ordered]@{
        status    = [string]$res.status
        exit_code = $res.exit_code
        output    = Limit-Output ([string]$res.output)
    }
    if ($null -ne $res.result) { $body['result'] = $res.result }
    $st = Send-JobStatus -JobId $id -Body $body -Attempts 6
    Write-Log 'INFO' ('job {0} ({1}) finished: {2} (report: {3})' -f $id, $kind, $res.status, $st)
    if ($st -eq 'cancelled') { Write-Log 'INFO' ('job {0} was cancelled on the server' -f $id) }

    if ($res.PostAction -eq 'reboot') {
        $null = Invoke-ScheduledReboot -DelaySeconds 60 -Message 'Your IT department is restarting this computer to finish installing updates.'
    } elseif ($res.PostAction -eq 'restart') {
        Request-AgentRestart
    }
}

# ---------------------------------------------------------------------------
# Main loop and modes
# ---------------------------------------------------------------------------
function Start-AgentLoop {
    Import-AgentConfig
    Import-AgentState
    if ($script:State['auth_failed']) {
        Write-Log 'ERROR' 'The server rejected this device''s credentials earlier (HTTP 401: device retired or secret rotated). The agent stays stopped until an administrator re-enrols it with -Install.'
        return
    }
    $mutex = New-Object System.Threading.Mutex($false, 'Global\ITSMAgentRun')
    $owned = $false
    try { $owned = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
    if (-not $owned) {
        Write-Log 'INFO' 'another agent instance is already running; exiting'
        $mutex.Dispose()
        return
    }
    try {
        Initialize-Directory $script:WorkDir
        Initialize-Http -CaPath ([string]$script:Config.ca_file) -Insecure ([bool]$script:Config.insecure_skip_verify)
        Write-Log 'INFO' ('ITSM Agent {0} started (device {1}, server {2})' -f $script:AgentVersion, $script:Config.device_id, $script:ServerUrl)
        $lastHeartbeat = [DateTime]::MinValue
        $retryInventoryAt = [DateTime]::MinValue
        $retryScanAt = [DateTime]::MinValue
        $backoff = 5
        while (-not $script:StopRequested) {
            try {
                if (([DateTime]::UtcNow - $lastHeartbeat).TotalSeconds -ge $script:PollInterval) {
                    $null = Send-Heartbeat
                    $lastHeartbeat = [DateTime]::UtcNow
                }
                if ((Test-Due 'last_inventory_at' $script:InventoryIntervalSeconds) -and [DateTime]::UtcNow -ge $retryInventoryAt) {
                    try {
                        $null = Send-Inventory
                    } catch {
                        $k = Get-AgentErrorKind $_
                        if ($k -eq 'auth' -or $k -eq 'network') { throw }
                        Write-Log 'WARN' ('inventory failed; retrying in 1 h: ' + $_.Exception.Message)
                        $retryInventoryAt = [DateTime]::UtcNow.AddHours(1)
                    }
                }
                if ((Test-Due 'last_scan_at' $script:ScanIntervalSeconds) -and [DateTime]::UtcNow -ge $retryScanAt) {
                    try {
                        $null = Send-PatchScan
                    } catch {
                        $k = Get-AgentErrorKind $_
                        if ($k -eq 'auth' -or $k -eq 'network') { throw }
                        Write-Log 'WARN' ('patch scan failed; retrying in 1 h: ' + $_.Exception.Message)
                        $retryScanAt = [DateTime]::UtcNow.AddHours(1)
                    }
                }
                $t0 = [DateTime]::UtcNow
                $resp = Invoke-AgentApi -Method GET -Path ('/jobs?wait=' + $script:LongPollWait) -TimeoutSec $script:LongPollTimeout
                $backoff = 5
                $jobs = @()
                if ($resp -and $resp.jobs) { $jobs = @($resp.jobs) }
                foreach ($job in $jobs) {
                    Invoke-AgentJob -Job $job
                    if ($script:StopRequested) { break }
                }
                if ($jobs.Count -eq 0 -and ([DateTime]::UtcNow - $t0).TotalSeconds -lt 5) { Start-Sleep -Seconds 5 }
            } catch {
                $k = Get-AgentErrorKind $_
                if ($k -eq 'auth') {
                    Write-Log 'ERROR' ('The server returned 401 Unauthorized: this device was retired or its secret was rotated. The agent is stopping; an administrator must re-enrol it with -Install. (' + $_.Exception.Message + ')')
                    Set-AgentState 'auth_failed' $true
                    return
                }
                $sleep = $backoff + (Get-Random -Minimum 0 -Maximum ([int][Math]::Max(1, $backoff / 4)))
                Write-Log 'WARN' ('{0}; retrying in {1} s' -f $_.Exception.Message, $sleep)
                Start-Sleep -Seconds $sleep
                $backoff = [Math]::Min($backoff * 2, 300)
            }
        }
        Write-Log 'INFO' 'agent loop stopped'
    } finally {
        try { $mutex.ReleaseMutex() } catch { }
        $mutex.Dispose()
    }
}

function Invoke-Once {
    Import-AgentConfig
    Import-AgentState
    Initialize-Directory $script:WorkDir
    Initialize-Http -CaPath ([string]$script:Config.ca_file) -Insecure ([bool]$script:Config.insecure_skip_verify)
    Write-Log 'INFO' ('ITSM Agent {0} one-shot run (device {1}, server {2})' -f $script:AgentVersion, $script:Config.device_id, $script:ServerUrl)
    $ok = $true
    try {
        $hb = Send-Heartbeat
        $pending = $null
        if ($hb) { $pending = $hb.jobs_pending }
        Write-Log 'INFO' ('heartbeat ok (poll interval {0} s, jobs pending: {1})' -f $script:PollInterval, $pending)
    } catch {
        $ok = $false
        Write-Log 'ERROR' ('heartbeat failed: ' + $_.Exception.Message)
    }
    try { $null = Send-Inventory } catch { $ok = $false; Write-Log 'ERROR' ('inventory failed: ' + $_.Exception.Message) }
    try { $null = Send-PatchScan } catch { $ok = $false; Write-Log 'ERROR' ('patch scan failed: ' + $_.Exception.Message) }
    if ($ok) { Write-Log 'INFO' 'one-shot run completed successfully' } else { $script:ExitCode = 1 }
}

function Invoke-Collect {
    $out = [ordered]@{
        agent_version = $script:AgentVersion
        heartbeat     = Get-HeartbeatBody
        inventory     = Get-Inventory
    }
    if ($IncludePatches) { $out['patches'] = Invoke-PatchScan }
    Write-Output (ConvertTo-Json -InputObject $out -Depth 12)
}

function Stop-StrayAgentProcesses {
    try {
        $procs = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction Stop)
        foreach ($p in $procs) {
            if ($p.ProcessId -eq $PID) { continue }
            $cl = [string]$p.CommandLine
            if ($cl -and $cl.IndexOf('itsm-agent.ps1', [StringComparison]::OrdinalIgnoreCase) -ge 0 -and $cl -match '(?i)\s-Run\b') {
                try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch { }
            }
        }
    } catch { }
}

function Stop-AgentTask {
    $task = $null
    try { $task = Get-ScheduledTask -TaskName $script:TaskName -ErrorAction Stop } catch { $task = $null }
    if ($null -ne $task) {
        try { Stop-ScheduledTask -TaskName $script:TaskName -ErrorAction Stop } catch { }
    }
    Stop-StrayAgentProcesses
}

function Register-AgentTask {
    $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $taskArgs = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Run' -f $script:InstalledScript
    $action = New-ScheduledTaskAction -Execute $psExe -Argument $taskArgs -WorkingDirectory $script:InstallDir
    $triggers = @()
    $triggers += New-ScheduledTaskTrigger -AtStartup
    # Watchdog: restarts the agent within 5 minutes if it ever exits (MultipleInstances=IgnoreNew
    # makes this a no-op while the agent is running).
    $triggers += New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
        -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
    $null = Register-ScheduledTask -TaskName $script:TaskName -Action $action -Trigger $triggers -Principal $principal `
        -Settings $settings -Description 'ITSM endpoint agent: heartbeat, inventory, patch management.' -Force
}

function Install-Agent {
    if (-not (Test-IsAdmin)) { throw 'Install must be run from an elevated (Administrator) PowerShell.' }
    if (-not $Server) { throw '-Server is required, for example -Server https://itsm.example.com' }
    $enrollToken = $Token
    if (-not $enrollToken) { $enrollToken = $env:ITSM_ENROLL_TOKEN }
    if (-not $enrollToken) { throw '-Token is required (or set the ITSM_ENROLL_TOKEN environment variable).' }
    Add-Secret $enrollToken
    $serverUrl = Get-NormalizedServerUrl $Server
    if ($serverUrl -notmatch '^(?i)https?://[^/\s]+') { throw '-Server must be an http(s) URL, for example https://itsm.example.com' }
    if ($serverUrl -match '^(?i)http://') { Write-Log 'WARN' 'The server URL uses plain HTTP. This is allowed only for lab installs.' }
    if (-not $script:SelfPath -or -not (Test-Path -LiteralPath $script:SelfPath)) { throw 'Cannot determine the path of this script; run it with powershell.exe -File.' }

    Write-Log 'INFO' 'stopping any existing agent'
    Stop-AgentTask

    Initialize-Directory $script:InstallDir
    $src = (Resolve-Path -LiteralPath $script:SelfPath).Path
    if ($src -ne $script:InstalledScript) { Copy-Item -LiteralPath $src -Destination $script:InstalledScript -Force }
    try { Unblock-File -LiteralPath $script:InstalledScript } catch { }
    Write-Log 'INFO' ('agent script installed to {0}' -f $script:InstalledScript)

    Initialize-Directory $script:DataDir
    Set-RestrictedAcl -Path $script:DataDir -Directory
    Initialize-Directory $script:PackageDir
    Initialize-Directory $script:WorkDir

    $caPath = $null
    if ($CaFile) {
        if (-not (Test-Path -LiteralPath $CaFile)) { throw ('CA file not found: ' + $CaFile) }
        $caPath = Join-Path $script:DataDir 'ca.pem'
        $caSrc = (Resolve-Path -LiteralPath $CaFile).Path
        if ($caSrc -ne $caPath) { Copy-Item -LiteralPath $caSrc -Destination $caPath -Force }
    }

    $script:ServerUrl = $serverUrl
    $script:ApiBase = $serverUrl + $script:ApiPrefix
    Initialize-Http -CaPath $caPath -Insecure ([bool]$InsecureSkipVerify)

    Write-Log 'INFO' ('enrolling with {0}' -f $serverUrl)
    $body = Get-EnrollBody -EnrollToken $enrollToken
    try {
        $resp = Invoke-AgentApi -Method POST -Path '/enroll' -Body $body -NoAuth -TimeoutSec 60
    } catch {
        $status = Get-AgentErrorStatus $_
        if ($status -eq 403) { throw 'Enrolment refused (403): the enrolment token is invalid, expired or used up.' }
        if ($status -eq 402) { throw 'Enrolment refused (402): the licence device limit has been reached.' }
        if ($status -eq 400) { throw ('Enrolment refused (400): ' + $_.Exception.Message) }
        throw
    }
    if (-not $resp -or -not $resp.device_id -or -not $resp.device_secret) { throw 'The enrolment response did not contain device_id and device_secret.' }
    Add-Secret ([string]$resp.device_secret)
    $poll = 60
    if ($resp.poll_interval_seconds) { try { $poll = [int]$resp.poll_interval_seconds } catch { $poll = 60 } }

    $cfg = [ordered]@{
        server_url            = $serverUrl
        device_id             = [string]$resp.device_id
        device_secret         = [string]$resp.device_secret
        ca_file               = $caPath
        insecure_skip_verify  = [bool]$InsecureSkipVerify
        poll_interval_seconds = $poll
        enrolled_at           = Get-IsoNow
        agent_version         = $script:AgentVersion
    }
    Write-JsonFile $script:ConfigPath $cfg
    Set-RestrictedAcl -Path $script:ConfigPath
    if (Test-Path -LiteralPath $script:StatePath) { Remove-Item -LiteralPath $script:StatePath -Force }
    Write-Log 'INFO' ('enrolled as device {0}; config written to {1}' -f $cfg.device_id, $script:ConfigPath)

    Register-AgentTask
    Write-Log 'INFO' ('scheduled task "{0}" registered (SYSTEM, at startup, restart on failure)' -f $script:TaskName)
    Start-ScheduledTask -TaskName $script:TaskName
    Write-Log 'INFO' ('ITSM Agent installed and started. Log file: ' + $script:LogPath)
}

function Uninstall-Agent {
    if (-not (Test-IsAdmin)) { throw 'Uninstall must be run from an elevated (Administrator) PowerShell.' }
    Write-Log 'INFO' 'stopping the agent'
    Stop-AgentTask
    try {
        Unregister-ScheduledTask -TaskName $script:TaskName -Confirm:$false -ErrorAction Stop
        Write-Host ('Removed scheduled task "{0}".' -f $script:TaskName)
    } catch {
        Write-Host ('Scheduled task "{0}" was not registered.' -f $script:TaskName)
    }
    Start-Sleep -Seconds 2
    foreach ($d in @($script:DataDir, $script:InstallDir)) {
        if (Test-Path -LiteralPath $d) {
            Remove-Item -LiteralPath $d -Recurse -Force
            Write-Host ('Removed {0}' -f $d)
        }
    }
    Write-Host 'ITSM Agent uninstalled. Retire the device in the ITSM console to remove it from the device list.'
}

function Show-Usage {
    Write-Host ('ITSM Agent for Windows {0}' -f $script:AgentVersion)
    Write-Host ''
    Write-Host 'Usage (elevated PowerShell):'
    Write-Host '  itsm-agent.ps1 -Install -Server <url> -Token <enrolment token> [-CaFile <path>] [-InsecureSkipVerify]'
    Write-Host '  itsm-agent.ps1 -Run          main loop (used by the "ITSM Agent" scheduled task)'
    Write-Host '  itsm-agent.ps1 -Once         one heartbeat + inventory + patch scan, then exit'
    Write-Host '  itsm-agent.ps1 -Uninstall    remove the task, program files, config and logs'
    Write-Host '  itsm-agent.ps1 -Collect [-IncludePatches]   print heartbeat/inventory JSON (no server contact)'
    Write-Host ''
    Write-Host 'Example:'
    Write-Host '  powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\itsm-agent.ps1 -Install -Server https://itsm.example.com -Token enr_xxx'
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
# Windows PowerShell 5.1 can serialize PSObject-wrapped arrays as {"value":[...],"Count":n}
# because of the System.Array ETS type data; removing it keeps JSON arrays plain.
try { Remove-TypeData -TypeName System.Array -ErrorAction Stop } catch { }

$modeCount = 0
foreach ($m in @($Install, $Run, $Once, $Uninstall, $Collect)) { if ($m) { $modeCount++ } }
if ($modeCount -ne 1) {
    Show-Usage
    exit 2
}

try {
    if ($Install) {
        $script:Interactive = $true
        Install-Agent
    } elseif ($Uninstall) {
        $script:Interactive = $true
        Uninstall-Agent
    } elseif ($Once) {
        $script:Interactive = $true
        Invoke-Once
    } elseif ($Collect) {
        Invoke-Collect
    } elseif ($Run) {
        $script:Interactive = [Environment]::UserInteractive
        Start-AgentLoop
    }
} catch {
    Write-Log 'ERROR' $_.Exception.Message
    if (-not $script:Interactive -and -not $Run) { [Console]::Error.WriteLine((Protect-LogText $_.Exception.Message)) }
    $script:ExitCode = 1
}
exit $script:ExitCode

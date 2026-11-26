<#
.SYNOPSIS
  Pulls a fresh copy of the old helpdesk straight from its live Supabase project and imports it:
  database snapshot (pg_dump) -> throwaway staging container -> importer -> attachment files.

  READ-ONLY on the old project: pg_dump takes a read-only snapshot and Storage files are only
  downloaded. The old project's .env is only read. Secrets are passed through environment
  variables and never printed or written to the repo.

.EXAMPLE
  npm run legacy:pull -- -EnvFile "E:\cgb-code\CGB-Helpdesk-latest\.env"

  Reads PROD_DB_URL, NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from that file
  (or set LEGACY_DB_URL / LEGACY_SUPABASE_URL / LEGACY_SUPABASE_SERVICE_KEY instead).

  Supabase's direct database host (db.<ref>.supabase.co) is IPv6-only; it is rewritten to the
  IPv4 session pooler (-PoolerHost) which reaches the same database.

  The importer only ADDS rows it has not seen (same UUID). To refresh a trial copy with tickets
  that changed since the last pull, recreate the target database first (see docs/MIGRATION.md).
#>
param(
  [string]$EnvFile,
  [string]$PoolerHost = "aws-1-ap-south-1.pooler.supabase.com",
  [string]$Timezone = "Asia/Kolkata",
  [string]$Image = "postgres:17-alpine",
  [switch]$DryRun,
  [switch]$KeepDumps,
  [switch]$SkipAttachments
)
$ErrorActionPreference = "Continue"   # docker writes progress to stderr; exit codes are checked instead
Set-Location (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))

function Read-EnvValue([string]$name) {
  if (-not $EnvFile) { return $null }
  if (-not (Test-Path $EnvFile)) { throw "Env file not found: $EnvFile" }
  $line = Get-Content $EnvFile | Where-Object { $_ -match "^\s*$name\s*=" } | Select-Object -First 1
  if (-not $line) { return $null }
  return (($line -split '=', 2)[1]).Trim().Trim('"').Trim("'")
}

# ── source database ──
$src = $env:LEGACY_DB_URL
if (-not $src) { $src = Read-EnvValue "PROD_DB_URL" }
if (-not $src) { throw "Set LEGACY_DB_URL, or pass -EnvFile with PROD_DB_URL in it" }
$u = [Uri]$src
if ($u.Host -match '^db\.([a-z0-9]+)\.supabase\.co$') {
  $ref = $Matches[1]
  $pw = ($u.UserInfo -split ':', 2)[1]
  $src = "postgresql://postgres.${ref}:${pw}@${PoolerHost}:5432$($u.AbsolutePath)"
  Write-Host "Using the Supabase session pooler ($PoolerHost) because the direct host is IPv6-only."
}
if ($src -notmatch 'sslmode=') { $src += $(if ($src.Contains('?')) { '&' } else { '?' }) + 'sslmode=require' }

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$dumpDir = Join-Path (Get-Location) "data\legacy-dumps"
New-Item -ItemType Directory -Force -Path $dumpDir | Out-Null
$dataDump = "live-$stamp-public.dump"
$authDump = "live-$stamp-auth.dump"

function Remove-Copies {
  docker rm -f itsm-legacy-staging 2>$null | Out-Null
  Remove-Item -Force -ErrorAction SilentlyContinue "data\legacy-staging-url.txt"
  if (-not $KeepDumps) { Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $dumpDir $dataDump), (Join-Path $dumpDir $authDump) }
}

try {
  # ── 1. read-only snapshot ──
  Write-Host "Taking a read-only snapshot of the old database ..."
  $env:LEGACY_PGURL = $src
  docker run --rm -e LEGACY_PGURL -v "${dumpDir}:/out" $Image sh -c "pg_dump `$LEGACY_PGURL -Fc --no-owner --no-acl -n public -f /out/$dataDump && pg_dump `$LEGACY_PGURL -Fc --no-owner --no-acl -t auth.users -f /out/$authDump"
  $code = $LASTEXITCODE
  $env:LEGACY_PGURL = $null
  if ($code -ne 0) { throw "pg_dump failed (exit $code)" }
  foreach ($f in @($dataDump, $authDump)) { Write-Host ("  {0}  {1:N0} KB" -f $f, ((Get-Item (Join-Path $dumpDir $f)).Length / 1KB)) }

  # ── 2. stage ──
  & (Join-Path $PSScriptRoot "stage-legacy.ps1") -DumpDir $dumpDir -DataDump $dataDump -AuthDump $authDump
  if (-not (Test-Path "data\legacy-staging-url.txt")) { throw "Staging failed" }

  # ── 3. import ──
  $importArgs = @("tsx", "scripts/legacy/import-legacy.ts", "--timezone", $Timezone)
  if ($DryRun) { $importArgs += "--dry-run" }
  & npx @importArgs
  if ($LASTEXITCODE -ne 0) { throw "Import failed" }

  # ── 4. attachment files ──
  if (-not $DryRun -and -not $SkipAttachments) {
    $base = $env:LEGACY_SUPABASE_URL; if (-not $base) { $base = Read-EnvValue "NEXT_PUBLIC_SUPABASE_URL" }
    $key = $env:LEGACY_SUPABASE_SERVICE_KEY; if (-not $key) { $key = Read-EnvValue "SUPABASE_SERVICE_ROLE_KEY" }
    if ($base -and $key) {
      $env:LEGACY_SUPABASE_URL = $base
      $env:LEGACY_SUPABASE_SERVICE_KEY = $key
      & npx tsx scripts/legacy/fetch-attachments.ts
      $code = $LASTEXITCODE
      $env:LEGACY_SUPABASE_SERVICE_KEY = $null
      if ($code -ne 0) { Write-Host "Attachment copy failed; re-run with fetch-attachments.ts later." }
    } else {
      Write-Host "No Supabase URL / service key: attachment files were not copied."
    }
  }
} finally {
  Remove-Copies
  Write-Host "Removed the staging container$(if (-not $KeepDumps) { ' and the snapshot files' })."
}

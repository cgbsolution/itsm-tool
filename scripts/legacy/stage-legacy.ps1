<#
.SYNOPSIS
  Restores the old helpdesk's pg_dump files into a throwaway local PostgreSQL
  container so the importer can read them. The dump folder is mounted READ-ONLY;
  nothing in the old project is changed.

.EXAMPLE
  npm run legacy:stage -- -DumpDir "E:\cgb-code\CGB-Helpdesk-latest\backups"

  Restores:
    - public schema (business data) from the newest "prod-before-itsm-*.dump", or -DataDump
    - auth.users (bcrypt password hashes) from the newest full dump that contains it, or -AuthDump
  into database "legacy" of container "itsm-legacy-staging" on 127.0.0.1:5545.

  When the import is done, remove it:  npm run legacy:unstage
#>
param(
  [Parameter(Mandatory = $true)][string]$DumpDir,
  [string]$DataDump,
  [string]$AuthDump,
  [string]$Image = "public.ecr.aws/supabase/postgres:17.11.0.011",
  [int]$Port = 5545
)
$ErrorActionPreference = "Continue"   # docker writes progress to stderr; exit codes are checked instead
$name = "itsm-legacy-staging"

if (-not (Test-Path $DumpDir)) { throw "Dump folder not found: $DumpDir" }
$dir = (Resolve-Path $DumpDir).Path

if (-not $DataDump) {
  $DataDump = (Get-ChildItem $dir -Filter "*before-itsm*.dump" | Sort-Object LastWriteTime -Descending | Select-Object -First 1).Name
  if (-not $DataDump) { $DataDump = (Get-ChildItem $dir -Filter "*.dump" | Sort-Object LastWriteTime -Descending | Select-Object -First 1).Name }
}
if (-not $DataDump) { throw "No .dump file found in $dir" }

# A random password for this throwaway container only (kept in a git-ignored file for the importer)
$pw = -join ((48..57) + (97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })

docker rm -f $name 2>$null | Out-Null
Write-Host "Starting $name ($Image) on 127.0.0.1:$Port ..."
docker run -d --name $name -e POSTGRES_PASSWORD=$pw -p "127.0.0.1:${Port}:5432" -v "${dir}:/dumps:ro" $Image | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Could not start the staging container" }

$ready = $false
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 2
  docker exec $name pg_isready -U postgres -h localhost 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { $ready = $true; break }
}
if (-not $ready) { throw "The staging database did not start" }
Start-Sleep -Seconds 3

docker exec $name psql -U postgres -h localhost -v ON_ERROR_STOP=1 -c "create database legacy" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Could not create the legacy database" }

function Restore([string]$file, [string[]]$extra) {
  Write-Host "Restoring $file $($extra -join ' ') ..."
  # errors about Supabase-only roles, extensions and policies are expected and harmless
  $out = docker exec $name pg_restore -U postgres -h localhost -d legacy --no-owner --no-acl @extra "/dumps/$file" 2>&1
  $errors = ($out | Select-String -Pattern "^pg_restore: error" | Measure-Object).Count
  Write-Host "  done ($errors non-fatal errors about Supabase-specific objects)"
}

Restore $DataDump @("-n", "public")

if (-not $AuthDump) {
  foreach ($f in (Get-ChildItem $dir -Filter "*.dump" | Sort-Object LastWriteTime -Descending)) {
    $toc = docker exec $name pg_restore -l "/dumps/$($f.Name)" 2>$null
    if ($toc | Select-String -Pattern "TABLE DATA auth users ") { $AuthDump = $f.Name; break }
  }
}
if ($AuthDump) {
  docker exec $name psql -U postgres -h localhost -d legacy -c "create schema if not exists auth" | Out-Null
  Restore $AuthDump @("-n", "auth", "-t", "users")
} else {
  Write-Host "No dump with auth.users found: users will need a password reset after import."
}

$counts = docker exec $name psql -U postgres -h localhost -d legacy -At -c "select string_agg(relname || '=' || n_live_tup, ', ' order by relname) from pg_stat_user_tables where schemaname in ('public','auth') and relname in ('tenants','users','organizations','tickets','ticket_messages','ticket_activity','ticket_assignments','ticket_attachments','assets','asset_details','asset_assignments','asset_tickets')"
Write-Host "Row estimates: $counts"

New-Item -ItemType Directory -Force -Path "data" | Out-Null
"postgres://postgres:$pw@127.0.0.1:$Port/legacy" | Set-Content -NoNewline -Encoding ascii "data\legacy-staging-url.txt"
Write-Host ""
Write-Host "Staged. Next: npm run legacy:import -- --timezone Asia/Kolkata"
Write-Host "(the importer reads the staging connection from data\legacy-staging-url.txt)"

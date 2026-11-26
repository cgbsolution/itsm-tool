# Backup of a docker compose install on Windows: database + uploaded files.
#   powershell -ExecutionPolicy Bypass -File scripts\backup.ps1 [-Dir D:\backups]
param([string]$Dir = ".\backups")
$ErrorActionPreference = "Continue"
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
$stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")
$db = Join-Path $Dir "itsm-db-$stamp.dump"
$files = Join-Path $Dir "itsm-files-$stamp.tar.gz"
# write inside the containers, then copy out (avoids PowerShell re-encoding binary pipes)
docker compose exec -T db sh -c "pg_dump -U itsm -d itsm -Fc -f /tmp/itsm.dump"
docker compose cp db:/tmp/itsm.dump $db
docker compose exec -T db rm -f /tmp/itsm.dump
docker compose exec -T app sh -c "tar -C /data -czf /tmp/files.tar.gz files"
docker compose cp app:/tmp/files.tar.gz $files
docker compose exec -T app rm -f /tmp/files.tar.gz
if ((Test-Path $db) -and (Test-Path $files)) { Write-Host "Wrote $db and $files" } else { Write-Error "Backup incomplete" ; exit 1 }
Get-ChildItem $Dir -Filter "itsm-*" | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } | Remove-Item -Force

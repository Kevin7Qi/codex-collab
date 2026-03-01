#Requires -Version 5.1
<#
.SYNOPSIS
    Install codex-collab on Windows.
.PARAMETER Dev
    Symlink source files for live development instead of building.
#>
param(
    [switch]$Dev,
    [switch]$Help
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$SkillDir = Join-Path $env:USERPROFILE ".claude\skills\codex-collab"
$BinDir = Join-Path $env:USERPROFILE ".local\bin"

function Show-Usage {
    Write-Host "Usage: powershell -File install.ps1 [-Dev]"
    Write-Host ""
    Write-Host "  (default)  Build and copy a self-contained skill directory"
    Write-Host "  -Dev       Symlink source files for live development"
}

if ($Help) {
    Show-Usage
    exit 0
}

# Check prerequisites
$missing = @()
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) { $missing += "bun" }
if (-not (Get-Command codex -ErrorAction SilentlyContinue)) { $missing += "codex" }

if ($missing.Count -gt 0) {
    Write-Host "Missing prerequisites: $($missing -join ', ')"
    Write-Host "  bun:   https://bun.sh/"
    Write-Host "  codex: npm install -g @openai/codex"
    exit 1
}

# Install dependencies
Write-Host "Installing dependencies..."
Push-Location $RepoDir
try { bun install } finally { Pop-Location }

if ($Dev) {
    Write-Host "Installing in dev mode (symlinks)..."
    Write-Host "Note: Symlinks on Windows may require Developer Mode or elevated privileges."

    # Create skill directory
    New-Item -ItemType Directory -Path (Join-Path $SkillDir "scripts") -Force | Out-Null

    # Symlink skill files
    $links = @(
        @{ Path = (Join-Path $SkillDir "SKILL.md"); Target = (Join-Path $RepoDir "SKILL.md") }
        @{ Path = (Join-Path $SkillDir "scripts\codex-collab"); Target = (Join-Path $RepoDir "src\cli.ts") }
        @{ Path = (Join-Path $SkillDir "LICENSE.txt"); Target = (Join-Path $RepoDir "LICENSE") }
    )

    foreach ($link in $links) {
        if (Test-Path $link.Path) { Remove-Item $link.Path -Force }
        New-Item -ItemType SymbolicLink -Path $link.Path -Target $link.Target -Force | Out-Null
    }
    Write-Host "Linked skill to $SkillDir"

    # Create .cmd shim
    New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
    $cmdShim = Join-Path $BinDir "codex-collab.cmd"
    Set-Content -Path $cmdShim -Value "@bun `"$(Join-Path $RepoDir 'src\cli.ts')`" %*"
    Write-Host "Created binary shim at $BinDir\codex-collab.cmd"

} else {
    Write-Host "Building..."

    # Build bundled JS
    $skillBuild = Join-Path $RepoDir "skill\codex-collab"
    if (Test-Path $skillBuild) { Remove-Item $skillBuild -Recurse -Force }
    New-Item -ItemType Directory -Path (Join-Path $skillBuild "scripts") -Force | Out-Null

    $built = Join-Path $skillBuild "scripts\codex-collab"
    bun build (Join-Path $RepoDir "src\cli.ts") --outfile $built --target bun

    # Prepend shebang if missing
    $content = Get-Content $built -Raw
    if (-not $content.StartsWith("#!/")) {
        Set-Content -Path $built -Value ("#!/usr/bin/env bun`n" + $content) -NoNewline
    }

    # Copy SKILL.md and LICENSE
    Copy-Item (Join-Path $RepoDir "SKILL.md") (Join-Path $skillBuild "SKILL.md")
    Copy-Item (Join-Path $RepoDir "LICENSE") (Join-Path $skillBuild "LICENSE.txt")

    # Install skill
    if (Test-Path $SkillDir) { Remove-Item $SkillDir -Recurse -Force }
    New-Item -ItemType Directory -Path (Split-Path $SkillDir) -Force | Out-Null
    Copy-Item $skillBuild $SkillDir -Recurse
    Write-Host "Installed skill to $SkillDir"

    # Create .cmd shim
    New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
    $cmdShim = Join-Path $BinDir "codex-collab.cmd"
    Set-Content -Path $cmdShim -Value "@bun `"$(Join-Path $SkillDir 'scripts\codex-collab')`" %*"
    Write-Host "Created binary shim at $BinDir\codex-collab.cmd"
}

# Add bin dir to user PATH if not already present
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$BinDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$BinDir;$userPath", "User")
    Write-Host "Added $BinDir to user PATH (permanent)."
}
# Update current session PATH
if ($env:Path -notlike "*$BinDir*") {
    $env:Path = "$BinDir;$env:Path"
}

# Verify and health check
Write-Host ""
if (Get-Command codex-collab -ErrorAction SilentlyContinue) {
    codex-collab health
} elseif (Get-Command codex-collab.cmd -ErrorAction SilentlyContinue) {
    codex-collab.cmd health
} else {
    Write-Host "Warning: codex-collab not found on PATH."
    Write-Host "Close and reopen your terminal, then run 'codex-collab health' to verify."
}

$mode = if ($Dev) { "dev" } else { "build" }
Write-Host ""
Write-Host "Done ($mode mode). Run 'codex-collab --help' to get started."

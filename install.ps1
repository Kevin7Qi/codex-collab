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
try {
    bun install
    if ($LASTEXITCODE -ne 0) { throw "'bun install' failed with exit code $LASTEXITCODE" }
} catch {
    Write-Host "Error: $_"
    exit 1
} finally {
    Pop-Location
}

if ($Dev) {
    Write-Host "Installing in dev mode (symlinks)..."
    Write-Host "Note: Symlinks on Windows may require Developer Mode or elevated privileges."

    # Create skill directory
    New-Item -ItemType Directory -Path (Join-Path $SkillDir "scripts") -Force | Out-Null

    # Symlink skill files (requires Developer Mode or elevated privileges)
    $links = @(
        @{ Path = (Join-Path $SkillDir "SKILL.md"); Target = (Join-Path $RepoDir "SKILL.md") }
        @{ Path = (Join-Path $SkillDir "scripts\codex-collab"); Target = (Join-Path $RepoDir "src\cli.ts") }
        @{ Path = (Join-Path $SkillDir "LICENSE.txt"); Target = (Join-Path $RepoDir "LICENSE") }
    )

    foreach ($link in $links) {
        if (Test-Path $link.Path) { Remove-Item $link.Path -Force }
        try {
            New-Item -ItemType SymbolicLink -Path $link.Path -Target $link.Target -Force | Out-Null
        } catch {
            Write-Host ""
            Write-Host "Error: Cannot create symlinks. Dev mode requires one of:"
            Write-Host "  1. Enable Developer Mode: Settings > Update & Security > For developers"
            Write-Host "  2. Run this script in an elevated (Administrator) terminal"
            Write-Host ""
            Write-Host "Alternatively, use build mode (without -Dev) which does not need symlinks."
            exit 1
        }
    }
    Write-Host "Linked skill to $SkillDir"

    # Create .cmd shim (CMD/PowerShell) and extensionless bash wrapper (Git Bash/MSYS2)
    # Use %USERPROFILE% so the .cmd file stays pure ASCII (locale-safe)
    $repoRel = $RepoDir.Replace($env:USERPROFILE, "%USERPROFILE%")
    New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
    $cmdShim = Join-Path $BinDir "codex-collab.cmd"
    Set-Content -Path $cmdShim -Value "@bun `"$repoRel\src\cli.ts`" %*" -Encoding ASCII
    $bashShim = Join-Path $BinDir "codex-collab"
    [System.IO.File]::WriteAllText($bashShim, "#!/usr/bin/env bash`nexec bun `"$(Join-Path $RepoDir 'src\cli.ts')`" `"`$@`"", [System.Text.UTF8Encoding]::new($false))
    Write-Host "Created binary shims at $BinDir"

} else {
    Write-Host "Building..."

    # Build bundled JS
    $skillBuild = Join-Path $RepoDir "skill\codex-collab"
    if (Test-Path $skillBuild) { Remove-Item $skillBuild -Recurse -Force }
    New-Item -ItemType Directory -Path (Join-Path $skillBuild "scripts") -Force | Out-Null

    $built = Join-Path $skillBuild "scripts\codex-collab"
    try {
        bun build (Join-Path $RepoDir "src\cli.ts") --outfile $built --target bun
        if ($LASTEXITCODE -ne 0) { throw "'bun build' failed with exit code $LASTEXITCODE" }
    } catch {
        Write-Host "Error: $_"
        exit 1
    }

    # Prepend shebang if missing (needed for Unix execution; harmless on Windows with Bun)
    $content = Get-Content $built -Raw
    if (-not $content.StartsWith("#!/")) {
        [System.IO.File]::WriteAllText($built, "#!/usr/bin/env bun`n" + $content, [System.Text.UTF8Encoding]::new($false))
    }

    # Copy SKILL.md and LICENSE
    Copy-Item (Join-Path $RepoDir "SKILL.md") (Join-Path $skillBuild "SKILL.md")
    Copy-Item (Join-Path $RepoDir "LICENSE") (Join-Path $skillBuild "LICENSE.txt")

    # Install skill
    if (Test-Path $SkillDir) { Remove-Item $SkillDir -Recurse -Force }
    New-Item -ItemType Directory -Path (Split-Path $SkillDir) -Force | Out-Null
    Copy-Item $skillBuild $SkillDir -Recurse
    Write-Host "Installed skill to $SkillDir"

    # Create .cmd shim (CMD/PowerShell) and extensionless bash wrapper (Git Bash/MSYS2)
    # Use %USERPROFILE% so the .cmd file stays pure ASCII (locale-safe)
    $skillRel = $SkillDir.Replace($env:USERPROFILE, "%USERPROFILE%")
    New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
    $cmdShim = Join-Path $BinDir "codex-collab.cmd"
    Set-Content -Path $cmdShim -Value "@bun `"$skillRel\scripts\codex-collab`" %*" -Encoding ASCII
    $bashShim = Join-Path $BinDir "codex-collab"
    [System.IO.File]::WriteAllText($bashShim, "#!/usr/bin/env bash`nexec bun `"$(Join-Path $SkillDir 'scripts\codex-collab')`" `"`$@`"", [System.Text.UTF8Encoding]::new($false))
    Write-Host "Created binary shims at $BinDir"
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
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Error: 'codex-collab health' failed. The installation may be broken."
        exit 1
    }
} elseif (Get-Command codex-collab.cmd -ErrorAction SilentlyContinue) {
    codex-collab.cmd health
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Error: 'codex-collab health' failed. The installation may be broken."
        exit 1
    }
} else {
    Write-Host "Note: codex-collab not found in current PATH. Close and reopen your terminal, then run 'codex-collab health' to verify."
}

$mode = if ($Dev) { "dev" } else { "build" }
Write-Host ""
Write-Host "Done ($mode mode). Run 'codex-collab --help' to get started."

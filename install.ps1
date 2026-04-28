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

$isUpgrade = Test-Path $SkillDir
$installAction = if ($isUpgrade) { "Updating existing" } else { "Installing new" }
$installDone = if ($isUpgrade) { "Updated" } else { "Installed" }

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

# ---------------------------------------------------------------------------
# Generate SKILL.md with injected template table
# ---------------------------------------------------------------------------

function Generate-SkillMd {
    param([string]$OutPath)

    $rows = @()

    # Scan built-in templates
    $builtinDir = Join-Path $RepoDir "src\prompts"
    if (Test-Path $builtinDir) {
        foreach ($tmpl in Get-ChildItem $builtinDir -Filter "*.md") {
            $name = $tmpl.BaseName
            $content = Get-Content $tmpl.FullName -Raw
            $desc = "(no description)"; $sandbox = ""
            if ($content -match "(?ms)^---\s*\n(.+?)\n---") {
                $fm = $Matches[1]
                if ($fm -match "description:\s*(.+)") { $desc = $Matches[1].Trim() }
                if ($fm -match "sandbox:\s*(.+)") { $sandbox = " ($($Matches[1].Trim()))" }
            }
            $rows += "| ``$name`` | $desc$sandbox |"
        }
    }

    # Scan user templates
    $userDir = Join-Path $env:USERPROFILE ".codex-collab\templates"
    if (Test-Path $userDir) {
        foreach ($tmpl in Get-ChildItem $userDir -Filter "*.md") {
            $name = $tmpl.BaseName
            $content = Get-Content $tmpl.FullName -Raw
            $desc = "(no description)"; $sandbox = ""
            if ($content -match "(?ms)^---\s*\n(.+?)\n---") {
                $fm = $Matches[1]
                if ($fm -match "description:\s*(.+)") { $desc = $Matches[1].Trim() }
                if ($fm -match "sandbox:\s*(.+)") { $sandbox = " ($($Matches[1].Trim()))" }
            }
            $rows += "| ``$name`` | $desc$sandbox |"
        }
    }

    $skillContent = Get-Content (Join-Path $RepoDir "SKILL.md") -Raw
    if ($rows.Count -gt 0) {
        $table = "| Template | Description |`n|----------|-------------|`n" + ($rows -join "`n")
        $skillContent = $skillContent -replace "<!-- TEMPLATES -->", $table
    } else {
        $skillContent = $skillContent -replace "<!-- TEMPLATES -->", "No templates found."
    }
    [System.IO.File]::WriteAllText($OutPath, $skillContent, [System.Text.UTF8Encoding]::new($false))
}

if ($Dev) {
    Write-Host "$installAction dev install at $SkillDir (symlinks)..."
    Write-Host "Note: Symlinks on Windows may require Developer Mode or elevated privileges."

    # Create skill directory
    New-Item -ItemType Directory -Path (Join-Path $SkillDir "scripts") -Force | Out-Null

    # Generate SKILL.md with template table (can't inject into a symlink)
    Generate-SkillMd -OutPath (Join-Path $SkillDir "SKILL.md")

    # Symlink skill files (requires Developer Mode or elevated privileges)
    $links = @(
        @{ Path = (Join-Path $SkillDir "scripts\codex-collab"); Target = (Join-Path $RepoDir "src\cli.ts") }
        @{ Path = (Join-Path $SkillDir "scripts\broker-server"); Target = (Join-Path $RepoDir "src\broker-server.ts") }
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
    Write-Host "$installDone dev skill at $SkillDir"

    $shimTarget = Join-Path $RepoDir "src\cli.ts"

} else {
    Write-Host "$installAction install at $SkillDir..."
    Write-Host "Building..."

    # Build bundled JS
    $skillBuild = Join-Path $RepoDir "skill\codex-collab"
    if (Test-Path $skillBuild) { Remove-Item $skillBuild -Recurse -Force }
    New-Item -ItemType Directory -Path (Join-Path $skillBuild "scripts") -Force | Out-Null

    # Build CLI and broker server
    $cliBuild = Join-Path $skillBuild "scripts\codex-collab"
    $brokerBuild = Join-Path $skillBuild "scripts\broker-server"
    try {
        bun build (Join-Path $RepoDir "src\cli.ts") --outfile $cliBuild --target bun
        if ($LASTEXITCODE -ne 0) { throw "'bun build cli' failed with exit code $LASTEXITCODE" }
        bun build (Join-Path $RepoDir "src\broker-server.ts") --outfile $brokerBuild --target bun
        if ($LASTEXITCODE -ne 0) { throw "'bun build broker-server' failed with exit code $LASTEXITCODE" }
    } catch {
        Write-Host "Error: $_"
        exit 1
    }

    # Prepend shebangs if missing (needed for Unix execution; harmless on Windows with Bun)
    foreach ($built in @($cliBuild, $brokerBuild)) {
        $content = Get-Content $built -Raw
        if (-not $content.StartsWith("#!/")) {
            [System.IO.File]::WriteAllText($built, "#!/usr/bin/env bun`n" + $content, [System.Text.UTF8Encoding]::new($false))
        }
    }

    # Copy prompts (needed at runtime for built-in templates)
    Copy-Item (Join-Path $RepoDir "src\prompts") (Join-Path $skillBuild "scripts\prompts") -Recurse

    # Generate SKILL.md with injected template table, copy LICENSE
    Generate-SkillMd -OutPath (Join-Path $skillBuild "SKILL.md")
    Copy-Item (Join-Path $RepoDir "LICENSE") (Join-Path $skillBuild "LICENSE.txt")

    # Install skill
    if (Test-Path $SkillDir) { Remove-Item $SkillDir -Recurse -Force }
    New-Item -ItemType Directory -Path (Split-Path $SkillDir) -Force | Out-Null
    Copy-Item $skillBuild $SkillDir -Recurse
    Write-Host "$installDone skill at $SkillDir"

    $shimTarget = Join-Path $SkillDir "scripts\codex-collab"
}

# Create .cmd shim (CMD/PowerShell) and extensionless bash wrapper (Git Bash/MSYS2)
New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
$cmdShim = Join-Path $BinDir "codex-collab.cmd"
[System.IO.File]::WriteAllText($cmdShim, "@bun `"$shimTarget`" %*`r`n", [System.Text.UTF8Encoding]::new($false))
$bashShim = Join-Path $BinDir "codex-collab"
[System.IO.File]::WriteAllText($bashShim, "#!/usr/bin/env bash`nexec bun `"$shimTarget`" `"`$@`"", [System.Text.UTF8Encoding]::new($false))
Write-Host "Created/updated binary shims at $BinDir"

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
codex-collab health
if ($LASTEXITCODE -ne 0) {
    Write-Host "Error: 'codex-collab health' failed. The installation may be broken."
    exit 1
}

$mode = if ($Dev) { "dev" } else { "build" }
Write-Host ""
Write-Host "Done ($mode mode). Open a new terminal, then run 'codex-collab --help' to get started."

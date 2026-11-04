# Run full SLAI Writer v2.4 Shape Format verification in the actual Windows checkout.
# This is an executable test runner, not a substitute for green test evidence.
[CmdletBinding()]
param([switch]$SkipFullSuite)
$ErrorActionPreference = "Stop"
$Writer = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Root = (Resolve-Path (Join-Path $Writer "../..")).Path
$Documaster = Join-Path $Root "applications/Documaster"
$Venv = Join-Path $Root "venv/Scripts/python.exe"

if (-not (Test-Path (Join-Path $Root "src/utils/sldc.py"))) {
    throw "SLAI v2.4 root not found: $Root"
}
if (-not (Test-Path (Join-Path $Documaster "slai/docmodel/writers/vector_shapes.py"))) {
    throw "Documaster vector writer was not found at: $Documaster"
}

function Invoke-Test {
    param([string]$Description, [string]$Program, [string[]]$Arguments, [string]$Location)
    Write-Host ("\n== {0} ==" -f $Description) -ForegroundColor Cyan
    Push-Location $Location
    try {
        & $Program @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "$Description failed with exit code $LASTEXITCODE"
        }
    } finally {
        Pop-Location
    }
}

$py = if (Test-Path $Venv) { $Venv } else { "python" }
Write-Host "SLAI root: $Root"
Write-Host "Writer: $Writer"
Write-Host "Python: $py"

Invoke-Test "Install/update Writer Node dependencies" "npm.cmd" @("install") $Writer
Invoke-Test "TypeScript strict typecheck" "npm.cmd" @("run","typecheck") $Writer
Invoke-Test "TypeScript compiled tests (shape, geometry, editor)" "npm.cmd" @("run","test:compiled") $Writer
Invoke-Test "Writer production browser bundle" "npm.cmd" @("run","build") $Writer
Invoke-Test "Shape transactions and schema" $py @("-m","pytest","applications/slai_writer/tests/test_shapes.py","-v") $Root
Invoke-Test "Shape PDF and Word export" $py @("-m","pytest","applications/slai_writer/tests/test_shape_export.py","-v") $Root
Invoke-Test "Documaster vector PDF and Word smoke tests" $py @("-m","pytest","applications/Documaster/tests_py/test_vector_shapes.py","-v") $Root
Invoke-Test "Documaster native DrawingML reimport" $py @("-m","pytest","applications/Documaster/tests_py/test_read_vector_shapes.py","-v") $Root
if (-not $SkipFullSuite) {
    Invoke-Test "Writer full Python regression suite" $py @("-m","pytest","applications/slai_writer/tests","-q") $Root
}
Write-Host "\nShape verification script finished successfully." -ForegroundColor Green

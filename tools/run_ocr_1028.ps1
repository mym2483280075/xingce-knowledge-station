#requires -Version 7.0
param(
    [Parameter(Mandatory)]
    [ValidateSet('xc0', 'xc1', 'xc2', 'sn0', 'sn1')]
    [string]$Worker
)

$ErrorActionPreference = 'Stop'

$materialRoot = Join-Path $env:AI_ROOT 'Codex  Thing\素材'
$xcRoot = Join-Path $materialRoot '提升卷二（10月28日）_识别结果'
$snRoot = Join-Path $materialRoot '提升卷二（10月28日）_申论识别结果'
$extractor = Join-Path $env:USERPROFILE '.codex\skills\ocr-extract\scripts\ocr_extract.py'
$python = Join-Path $env:AI_ROOT 'OCR\venv\Scripts\python.exe'

switch ($Worker) {
    'xc0' {
        $sourceRoot = Join-Path $xcRoot '原图'
        $outputRoot = Join-Path $xcRoot 'ocr0'
        $pages = 1..11
    }
    'xc1' {
        $sourceRoot = Join-Path $xcRoot '原图'
        $outputRoot = Join-Path $xcRoot 'ocr1'
        $pages = 12..21
    }
    'xc2' {
        $sourceRoot = Join-Path $xcRoot '原图'
        $outputRoot = Join-Path $xcRoot 'ocr2'
        $pages = 22..31
    }
    'sn0' {
        $sourceRoot = Join-Path $snRoot '原图'
        $outputRoot = Join-Path $snRoot 'ocr_a'
        $pages = 1..5
    }
    'sn1' {
        $sourceRoot = Join-Path $snRoot '原图'
        $outputRoot = Join-Path $snRoot 'ocr_b'
        $pages = 6..10
    }
}

$sliceRoot = Join-Path (Split-Path $sourceRoot -Parent) "_slice_$Worker"
New-Item -ItemType Directory -Path $sliceRoot -Force | Out-Null
foreach ($page in $pages) {
    $name = 'p{0:D2}.jpg' -f $page
    Copy-Item -LiteralPath (Join-Path $sourceRoot $name) -Destination (Join-Path $sliceRoot $name) -Force
}

& $python $extractor $sliceRoot --out $outputRoot --det-limit 2560
if ($LASTEXITCODE -ne 0) {
    throw "OCR $Worker failed with exit code $LASTEXITCODE"
}

# Render SSML to WAV with Windows built-in SAPI (default zh-CN mechanical voice).
# Used as a baseline for AI prosody control experiments when no distilled bank is wanted.
# Keep this file ASCII-only: PowerShell 5.1 reads BOM-less scripts as ANSI/GBK,
# and non-ASCII comments break the parser.
param(
  [Parameter(Mandatory = $true)][string]$SsmlFile,
  [Parameter(Mandatory = $true)][string]$OutFile,
  [string]$Voice = ''
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Speech
$ssml = Get-Content -LiteralPath $SsmlFile -Raw -Encoding UTF8
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $names = @()
  foreach ($v in $synth.GetInstalledVoices()) { if ($v.Enabled) { $names += $v.VoiceInfo.Name } }
  if ($Voice) {
    if ($names -contains $Voice) { $synth.SelectVoice($Voice) }
  } else {
    # Prefer any installed zh-* voice; the system default may be English.
    $zh = $synth.GetInstalledVoices() |
      Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like 'zh*' } |
      Select-Object -First 1
    if ($zh) { $synth.SelectVoice($zh.VoiceInfo.Name) }
  }
  $synth.SetOutputToWaveFile($OutFile)
  $synth.SpeakSsml($ssml)
} finally {
  $synth.Dispose()
}

param([Parameter(Mandatory = $true)][string]$OutputPath)
$ErrorActionPreference = 'Stop'
$framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$compiler = Join-Path $framework 'csc.exe'
if (-not (Test-Path $compiler)) { throw 'The .NET Framework x64 compiler is required.' }
if (Test-Path $OutputPath) { throw 'The computer helper output must not already exist.' }
$references = @('System.Drawing.dll', 'System.Windows.Forms.dll', 'System.Web.Extensions.dll',
  'WPF\UIAutomationClient.dll', 'WPF\UIAutomationTypes.dll', 'WPF\WindowsBase.dll')
$arguments = @('/nologo', '/optimize+', '/platform:x64', '/target:exe', "/out:$OutputPath")
foreach ($reference in $references) {
  $file = Join-Path $framework $reference
  if (-not (Test-Path $file)) { throw "Missing framework reference: $reference" }
  $arguments += "/reference:$file"
}
$arguments += (Join-Path $PSScriptRoot 'Computer.cs')
& $compiler @arguments
if ($LASTEXITCODE -ne 0) { throw 'The Windows computer helper did not compile.' }

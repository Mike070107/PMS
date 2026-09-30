param([Parameter(Mandatory = $true)][string]$Path)

$ErrorActionPreference = 'Stop'
$directory = Split-Path -Parent $Path
$handler = [ResolveEventHandler]{
  param($sender, $eventArgs)
  $name = ([Reflection.AssemblyName]$eventArgs.Name).Name + '.dll'
  $candidate = Join-Path $directory $name
  if (Test-Path -LiteralPath $candidate) {
    return [Reflection.Assembly]::ReflectionOnlyLoadFrom($candidate)
  }
  return $null
}
[AppDomain]::CurrentDomain.add_ReflectionOnlyAssemblyResolve($handler)
try {
  $assembly = [Reflection.Assembly]::ReflectionOnlyLoadFrom($Path)
  $types = try { $assembly.GetTypes() } catch [Reflection.ReflectionTypeLoadException] { $_.Exception.Types }
  foreach ($type in @($types | Where-Object { $_ })) {
    foreach ($method in $type.GetMethods([Reflection.BindingFlags]'Public,NonPublic,Instance,Static,DeclaredOnly')) {
      if ($method.Name -match 'Upload|Privilege|Card|Controller|Connect|Add|Delete|Send|Write|Command') {
        [pscustomobject]@{ type = $type.FullName; method = $method.Name }
      }
    }
  }
}
finally {
  [AppDomain]::CurrentDomain.remove_ReflectionOnlyAssemblyResolve($handler)
}

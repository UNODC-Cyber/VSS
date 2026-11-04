<#
.SYNOPSIS
  Drives the REAL native Open dialog of a packaged VSS build through UI Automation (lane J, R10).

.DESCRIPTION
  Launches the packaged exe with VSS_DATA_DIR pointing at a vault seeded by seed-vault.mjs, unlocks it, opens
  Requests > Import request file and runs N dialog cycles. Each cycle uses one of the modes:
    accept    type the fixture path into the File name box and press Open, wait for the import summary
    cancel    open the dialog and cancel it
    double    invoke the Choose button twice in a row (a second dialog must not open), then accept
    minimise  minimise the main window while the dialog is open, accept, restore
    idle      leave the dialog open for -IdleSeconds (seed the vault with autoLockMinutes = 1 so the idle lock fires)
  Writes one line per cycle and finally lists Application Error / WER events for the exe since launch.
  Needs an interactive desktop session. Synthetic data only; prints no paths beyond the ones given.

  Desktop hygiene (the machine may be in use): no keyboard input is ever sent (no SendKeys); app buttons are
  invoked through UI Automation and the dialog through Win32 messages addressed to its own window handle. After
  every cycle every #32770 dialog of the launched process tree is cancelled (WM_CLOSE fallback) and verified gone
  before the next cycle. A hard -TimeoutSeconds limit (plus an out-of-process watchdog) and the finally block stop
  ONLY the process tree this script started (root pid + descendants whose exe lives in this worktree).

.EXAMPLE
  pwsh -File tools/e2e-native/drive-import.ps1 -Exe 'dist\win-unpacked\Vetting Support System.exe' `
    -DataDir $env:TEMP\vss-probe\vault -Fixture fixtures\requests\req-001-basic.xlsx -Iterations 20 -Modes accept,cancel,double
#>
param(
  [Parameter(Mandatory)] [string] $Exe,
  [Parameter(Mandatory)] [string] $DataDir,
  [Parameter(Mandatory)] [string] $Fixture,
  [int] $Iterations = 10,
  [string[]] $Modes = @('accept', 'cancel', 'double', 'minimise'),
  [int] $IdleSeconds = 90,
  [string] $Password = 'correct horse battery staple 1',
  [int] $SettleMs = 1500,
  [int] $TimeoutSeconds = 240
)
$ErrorActionPreference = 'Stop'
$Modes = @($Modes | ForEach-Object { $_ -split ',' } | Where-Object { $_ })
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$PC = [System.Windows.Automation.PropertyCondition]

$Exe = (Resolve-Path $Exe).Path
$Fixture = (Resolve-Path $Fixture).Path

function Find-ByName($root, [string] $name, [int] $timeoutMs = 15000, $scope = $TS::Descendants, $type = $null) {
  $cond = New-Object $PC ($AE::NameProperty, $name)
  if ($type) { $cond = New-Object System.Windows.Automation.AndCondition ($cond, (New-Object $PC ($AE::ControlTypeProperty, $type))) }
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt $timeoutMs) {
    try { $el = $root.FindFirst($scope, $cond) } catch [System.Windows.Automation.ElementNotAvailableException] {
      # Chromium re-created its accessibility root: look the main window up again.
      $root = Main-Window $script:procId; $script:win = $root; $el = $null
    }
    if ($el) { return $el }
    Start-Sleep -Milliseconds 150
  }
  return $null
}
function Invoke-El($el) {
  $p = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  $p.Invoke()
}
function Main-Window([int] $procId, [int] $timeoutMs = 30000) {
  $cond = New-Object $PC ($AE::ProcessIdProperty, $procId)
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt $timeoutMs) {
    $w = $AE::RootElement.FindFirst($TS::Children, $cond)
    if ($w) { return $w }
    Start-Sleep -Milliseconds 200
  }
  throw 'main window not found'
}
function Find-Dialog([int] $procId, [int] $timeoutMs = 10000) {
  # The common file dialog is a #32770 window owned by the app process (child of the desktop or of the main window).
  $cond = New-Object System.Windows.Automation.AndCondition (
    (New-Object $PC ($AE::ProcessIdProperty, $procId)),
    (New-Object $PC ($AE::ClassNameProperty, '#32770')))
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt $timeoutMs) {
    $d = $AE::RootElement.FindFirst($TS::Children, $cond)
    if (-not $d -and $script:win) { $d = $script:win.FindFirst($TS::Children, $cond) }
    if ($d) { return $d }
    Start-Sleep -Milliseconds 150
  }
  return $null
}
function Count-Dialogs([int] $procId) {
  $cond = New-Object System.Windows.Automation.AndCondition (
    (New-Object $PC ($AE::ProcessIdProperty, $procId)),
    (New-Object $PC ($AE::ClassNameProperty, '#32770')))
  $n = $AE::RootElement.FindAll($TS::Children, $cond).Count
  if ($script:win) { $n += $script:win.FindAll($TS::Children, $cond).Count }
  return $n
}
# pwsh 7 (.NET) has no UIA client-side Win32 proxies, so the classic dialog controls show up as bare panes. The
# File name box and the Open / Cancel buttons are driven through Win32 messages instead (no focus or keyboard needed).
Add-Type -Namespace VssNative -Name W -MemberDefinition @"
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
[DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr dlg, int id);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, string l);
[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
[DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
public delegate bool EnumProc(IntPtr h, IntPtr l);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder sb, int n);
public static System.Collections.Generic.List<IntPtr> Dialogs(uint[] pids) {
  var found = new System.Collections.Generic.List<IntPtr>();
  var set = new System.Collections.Generic.HashSet<uint>(pids);
  EnumWindows((h, l) => {
    uint pid; GetWindowThreadProcessId(h, out pid);
    if (set.Contains(pid)) { var sb = new System.Text.StringBuilder(64); GetClassName(h, sb, 64); if (sb.ToString() == "#32770") found.Add(h); }
    return true;
  }, IntPtr.Zero);
  return found;
}
"@
function Accept-Dialog($dlg, [string] $path) {
  $h = [IntPtr]$dlg.Current.NativeWindowHandle
  $edit = [IntPtr]::Zero
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($edit -eq [IntPtr]::Zero -and $sw.ElapsedMilliseconds -lt 8000) {
    $cbx = [VssNative.W]::GetDlgItem($h, 1148)
    if ($cbx -ne [IntPtr]::Zero) {
      $cb = [VssNative.W]::FindWindowEx($cbx, [IntPtr]::Zero, 'ComboBox', $null)
      $edit = [VssNative.W]::FindWindowEx($(if ($cb -ne [IntPtr]::Zero) { $cb } else { $cbx }), [IntPtr]::Zero, 'Edit', $null)
    }
    if ($edit -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 150 }
  }
  if ($edit -eq [IntPtr]::Zero) { throw 'file name box not found' }
  [void][VssNative.W]::SendMessage($edit, 0x000C, [IntPtr]::Zero, $path) # WM_SETTEXT
  [void][VssNative.W]::PostMessage($h, 0x0111, [IntPtr]1, [VssNative.W]::GetDlgItem($h, 1)) # WM_COMMAND IDOK
}
function Cancel-Dialog($dlg) {
  $h = [IntPtr]$dlg.Current.NativeWindowHandle
  [void][VssNative.W]::PostMessage($h, 0x0111, [IntPtr]2, [VssNative.W]::GetDlgItem($h, 2)) # WM_COMMAND IDCANCEL
}function Set-WinState($win, [string] $state) {
  # WindowPattern refuses while the window is disabled by the modal dialog; ShowWindow does not.
  $cmd = @{ Minimized = 6; Normal = 9 }[$state]
  [void][VssNative.W]::ShowWindow([IntPtr]$win.Current.NativeWindowHandle, $cmd)
}

$WorktreeRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path.TrimEnd('\') + '\'
function Get-OwnTree([int] $rootPid) {
  # Only processes started by this script: the root pid and its descendants whose exe lives in this worktree.
  $all = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, ExecutablePath
  $ids = [System.Collections.Generic.HashSet[int]]::new(); [void]$ids.Add($rootPid)
  do {
    $added = $false
    foreach ($p in $all) {
      if (-not $ids.Contains([int]$p.ProcessId) -and $ids.Contains([int]$p.ParentProcessId) -and $p.ExecutablePath -and
          $p.ExecutablePath.StartsWith($WorktreeRoot, [StringComparison]::OrdinalIgnoreCase)) { [void]$ids.Add([int]$p.ProcessId); $added = $true }
    }
  } while ($added)
  return @($ids)
}
function Close-AllDialogs([int] $timeoutMs = 6000) {
  # Cancel every file dialog of our process (visible, hidden behind a minimised owner, or queued); WM_CLOSE as a
  # fallback. Returns how many are still there (0 = clean).
  $pids = [uint32[]]@(Get-OwnTree $script:procId)
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $round = 0
  while ($sw.ElapsedMilliseconds -lt $timeoutMs) {
    $hs = [VssNative.W]::Dialogs($pids)
    if ($hs.Count -eq 0) { return 0 }
    foreach ($h in $hs) {
      if ($round -lt 3) { [void][VssNative.W]::PostMessage($h, 0x0111, [IntPtr]2, [VssNative.W]::GetDlgItem($h, 2)) }
      else { [void][VssNative.W]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) } # WM_CLOSE
    }
    $round++
    Start-Sleep -Milliseconds 400
  }
  return ([VssNative.W]::Dialogs($pids)).Count
}
function Stop-OwnTree {
  if (-not $script:procId) { return }
  $ids = Get-OwnTree $script:procId
  foreach ($id in $ids) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
}

$start = Get-Date
$psi = [Diagnostics.ProcessStartInfo]::new($Exe)
$psi.UseShellExecute = $false
$psi.Environment['VSS_DATA_DIR'] = $DataDir
$proc = [Diagnostics.Process]::Start($psi)
Write-Output "launched pid=$($proc.Id)"; $script:procId = $proc.Id
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$watchdog = Start-Job -ArgumentList $proc.Id, ($TimeoutSeconds + 30), $Exe -ScriptBlock {
  param($rootPid, $after, $exe)
  Start-Sleep -Seconds $after
  $p = Get-Process -Id $rootPid -ErrorAction SilentlyContinue
  if ($p -and $p.Path -eq $exe) {
    Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $rootPid -and $_.ExecutablePath -eq $exe } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Stop-Process -Id $rootPid -Force -ErrorAction SilentlyContinue
  }
}
$results = [System.Collections.Generic.List[string]]::new()
try {
  $script:win = Main-Window $proc.Id; $win = $script:win
  $pwBox = $null
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while (-not $pwBox -and $sw.ElapsedMilliseconds -lt 20000) {
    $pwBox = $win.FindFirst($TS::Descendants, (New-Object System.Windows.Automation.AndCondition (
          (New-Object $PC ($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)),
          (New-Object $PC ($AE::IsPasswordProperty, $true)))))
    Start-Sleep -Milliseconds 200
  }
  if (-not $pwBox) { throw 'password box not found' }
  $pwBox.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($Password)
  $BTN = [System.Windows.Automation.ControlType]::Button
  Invoke-El (Find-ByName $win 'Unlock' 5000 $TS::Descendants $BTN)
  $req = Find-ByName $win 'Requests' 30000
  if (-not $req) { throw 'Requests nav not found (unlock failed?)' }
  Invoke-El $req
  Invoke-El (Find-ByName $win 'Import request file' 15000 $TS::Descendants $BTN)

  for ($i = 1; $i -le $Iterations; $i++) {
    $mode = $Modes[($i - 1) % $Modes.Count]
    if ((Get-Date) -gt $deadline) { $results.Add("$i TIMEOUT (hard limit $TimeoutSeconds s)"); break }
    if ($proc.HasExited) { $results.Add("$i $mode EXITED code=0x{0:X8}" -f $proc.ExitCode); break }
    $win = $script:win; $choose = Find-ByName $win 'Choose file' 15000 $TS::Descendants $BTN
    if (-not $choose) { $results.Add("$i $mode NO-CHOOSE-BUTTON"); break }
    $outcome = 'ok'
    switch ($mode) {
      'double' {
        Invoke-El $choose
        try { Invoke-El $choose } catch { }
        Start-Sleep -Milliseconds 800
        $n = Count-Dialogs $proc.Id
        if ($n -gt 1) { $outcome = "TWO-DIALOGS($n)" }
        $dlg = Find-Dialog $proc.Id
        if (-not $dlg) { $outcome = 'no-dialog'; break }
        Accept-Dialog $dlg $Fixture
        # a second dialog queued behind the first would appear now
        Start-Sleep -Milliseconds 800
        $d2 = Find-Dialog $proc.Id 1500
        if ($d2) { $outcome = 'SECOND-DIALOG-AFTER-FIRST'; Cancel-Dialog $d2 }
      }
      'browse' {
        Invoke-El $choose
        $dlg = Find-Dialog $proc.Id
        if (-not $dlg) { $outcome = 'no-dialog'; break }
        Accept-Dialog $dlg ([IO.Path]::GetDirectoryName($Fixture))
        Start-Sleep -Milliseconds 1200
        $dlg = Find-Dialog $proc.Id 3000
        if (-not $dlg) { $outcome = 'dialog-closed-on-folder'; break }
        Accept-Dialog $dlg ([IO.Path]::GetFileName($Fixture))
      }
      'cloud' {
        # Show a cloud-synced folder (placeholders, overlay / thumbnail handlers) first, then pick by full path.
        Invoke-El $choose
        $dlg = Find-Dialog $proc.Id
        if (-not $dlg) { $outcome = 'no-dialog'; break }
        $cloud = @($env:OneDriveCommercial, $env:OneDrive) | Where-Object { $_ } | Select-Object -First 1
        if ($cloud) { Accept-Dialog $dlg $cloud; Start-Sleep -Milliseconds 2500; $dlg = Find-Dialog $proc.Id 3000 }
        if (-not $dlg) { $outcome = 'dialog-closed-on-folder'; break }
        Accept-Dialog $dlg $Fixture
      }
      'burst' {
        # four invocations as fast as UIA allows, then answer every dialog that shows up as soon as it appears
        1..4 | ForEach-Object { try { Invoke-El $choose } catch { } }
        $answered = 0
        for ($k = 0; $k -lt 4; $k++) {
          $d = Find-Dialog $proc.Id 2500
          if (-not $d) { break }
          if ($k % 2 -eq 0) { Accept-Dialog $d $Fixture } else { Cancel-Dialog $d }
          $answered++
          Start-Sleep -Milliseconds 50
        }
        $outcome = "dialogs=$answered"
      }
      'cancel' {
        Invoke-El $choose
        $dlg = Find-Dialog $proc.Id
        if (-not $dlg) { $outcome = 'no-dialog'; break }
        Start-Sleep -Milliseconds 300
        Cancel-Dialog $dlg
      }
      'minimise' {
        Invoke-El $choose
        $dlg = Find-Dialog $proc.Id
        if (-not $dlg) { $outcome = 'no-dialog'; break }
        try { Set-WinState $win 'Minimized' } catch { $outcome = 'minimise-refused' }
        Start-Sleep -Milliseconds 500
        $dlg = Find-Dialog $proc.Id 3000
        if ($dlg) { Accept-Dialog $dlg $Fixture } else { $outcome = 'dialog-gone-on-minimise' }
        Start-Sleep -Milliseconds 500
        try { Set-WinState $win 'Normal' } catch { }
      }
      'idle' {
        Invoke-El $choose
        $dlg = Find-Dialog $proc.Id
        if (-not $dlg) { $outcome = 'no-dialog'; break }
        Start-Sleep -Seconds $IdleSeconds
        $dlg = Find-Dialog $proc.Id 2000
        if ($dlg) { Accept-Dialog $dlg $Fixture } else { $outcome = 'dialog-gone-during-idle' }
      }
      default {
        Invoke-El $choose
        $dlg = Find-Dialog $proc.Id
        if (-not $dlg) { $outcome = 'no-dialog'; break }
        Accept-Dialog $dlg $Fixture
      }
    }
    Start-Sleep -Milliseconds $SettleMs
    if ($proc.HasExited) { $results.Add("$i $mode EXITED code=0x{0:X8}" -f $proc.ExitCode); break }
    try { Set-WinState $script:win 'Normal' } catch { }
    # A queued (second) dialog appears only after the first returned: count and close everything left over.
    $left = @([VssNative.W]::Dialogs([uint32[]]@(Get-OwnTree $proc.Id))).Count
    if ($left -gt 0) { $outcome += " leftover-dialogs=$left" }
    if ((Close-AllDialogs) -gt 0) { $results.Add("$i $mode $outcome DIALOG-WOULD-NOT-CLOSE"); break }
    if ($mode -eq 'idle') {
      $locked = Find-ByName $win 'Unlock' 3000 $TS::Descendants $BTN
      $results.Add("$i $mode $outcome locked=$([bool]$locked)")
      if ($locked) { break }
      continue
    }
    if ($mode -ne 'cancel') {
      $another = Find-ByName $win 'Choose another file' 10000 $TS::Descendants $BTN
      if (-not $another) { $outcome += ' no-summary' } else { Invoke-El $another }
    }
    $results.Add("$i $mode $outcome")
  }
  # Let late shell callbacks fire (the owner's crash came seconds after the summary page appeared).
  Start-Sleep -Seconds 10
  $results.Add("alive-after-cycles=$(-not $proc.HasExited)")
} catch {
  $results.Add("DRIVER-ERROR exited=$($proc.HasExited) code=$(if ($proc.HasExited) { '0x{0:X8}' -f $proc.ExitCode }) $($_.Exception.Message) $($_.ScriptStackTrace -replace "`r?`n", " | ")")
} finally {
  $results | ForEach-Object { Write-Output $_ }
  if (-not $proc.HasExited) {
    try { [void](Close-AllDialogs 4000) } catch { }
    $proc.CloseMainWindow() | Out-Null
    if (-not $proc.WaitForExit(10000)) { Stop-OwnTree }
  }
  Stop-OwnTree
  Stop-Job $watchdog -ErrorAction SilentlyContinue; Remove-Job $watchdog -Force -ErrorAction SilentlyContinue
  $stray = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Id -eq $script:procId }).Count
  Write-Output "own-processes-left=$stray"
  Start-Sleep -Seconds 3
  $ev = Get-WinEvent -FilterHashtable @{ LogName = 'Application'; StartTime = $start } -ErrorAction SilentlyContinue |
    Where-Object { $_.Id -in 1000, 1001 -and $_.Message -match [regex]::Escape([IO.Path]::GetFileName($Exe)) }
  Write-Output "application-error-events=$(@($ev).Count)"
  $ev | ForEach-Object { Write-Output ("{0} {1} {2}" -f $_.TimeCreated, $_.Id, (($_.Message -split "`n") | Select-String 'Faulting module name|P4:' | Select-Object -First 1)) }
}

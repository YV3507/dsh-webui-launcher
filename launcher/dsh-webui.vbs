' DeepSeek Harness Web UI — silent quick-launch entry point.
' Runs scripts\windows\dsh-webui.ps1 hidden (no console window), waits for the
' watchdog to finish (that is, for the harness lifecycle to end), and shows a
' message box only when the watchdog reports a failure. Logs live in the
' scripts\windows\logs folder next to this file.
Option Explicit

Dim shell, fso, scriptDir, ps1, logDir, command, exitCode
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = fso.BuildPath(scriptDir, "dsh-webui.ps1")
logDir = fso.BuildPath(scriptDir, "logs")

If Not fso.FileExists(ps1) Then
  MsgBox "dsh-webui.ps1 not found:" & vbCrLf & ps1, vbExclamation, "DeepSeek Harness Web UI"
  WScript.Quit 1
End If

command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """"
exitCode = shell.Run(command, 0, True)

If exitCode <> 0 Then
  MsgBox "The DeepSeek Harness Web UI watchdog exited with code " & exitCode & "." & vbCrLf & vbCrLf _
    & "See the latest files in:" & vbCrLf & logDir, vbExclamation, "DeepSeek Harness Web UI"
End If

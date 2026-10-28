; ============================================================
;  DSH Fleet Lite installer (single exe, ~35MB)
;  payload: ..\payload-lite  (node.exe + fleet\)
;  silent:  Setup.exe /S
; ============================================================

Unicode true
SetCompressor zlib
SetDatablockOptimize off

!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "installer-config.nsh"

!define APPNAME     "DSH Fleet Node (Lite)"
!define COMPANY     "DSH Fleet"
!define UNINST_KEY  "Software\Microsoft\Windows\CurrentVersion\Uninstall\DSHFleet"

Name "${APPNAME}"
OutFile "..\dist\DSH-Fleet-Lite-Setup.exe"
InstallDir "$PROGRAMFILES64\DSH Fleet"
InstallDirRegKey HKLM "Software\DSHFleet" "InstallDir"
RequestExecutionLevel admin
BrandingText "${COMPANY}"

VIProductVersion "${BUILD_VERSION}.0"
VIAddVersionKey "ProductName"     "${APPNAME}"
VIAddVersionKey "CompanyName"     "${COMPANY}"
VIAddVersionKey "FileDescription" "DSH Fleet Node installer (lite)"
VIAddVersionKey "FileVersion"     "${BUILD_VERSION}.0"
VIAddVersionKey "ProductVersion"  "${BUILD_VERSION}.0"

!define MUI_ICON "..\assets\tray.ico"
!define MUI_UNICON "..\assets\tray.ico"
!define MUI_ABORTWARNING

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

Function .onInit
  ReadRegStr $0 HKLM "Software\DSHFleet" "InstallDir"
  ${If} $0 != ""
    StrCpy $INSTDIR $0
  ${EndIf}
FunctionEnd

Section "DSH Fleet Node (Lite)" SecMain
  SectionIn RO
  SetDetailsPrint both

  DetailPrint "Installing runtime and agent..."
  SetOutPath "$INSTDIR"
  File /r "..\payload-lite\*.*"

  WriteUninstaller "$INSTDIR\Uninstall.exe"

  WriteRegStr HKLM "Software\DSHFleet" "InstallDir" "$INSTDIR"
  WriteRegStr HKLM "Software\DSHFleet" "Control" "${CONTROL_URL}"

  WriteRegStr   HKLM "${UNINST_KEY}" "DisplayName"     "${APPNAME}"
  WriteRegStr   HKLM "${UNINST_KEY}" "DisplayVersion"  "${BUILD_VERSION}"
  WriteRegStr   HKLM "${UNINST_KEY}" "Publisher"       "${COMPANY}"
  WriteRegStr   HKLM "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr   HKLM "${UNINST_KEY}" "DisplayIcon"     "$INSTDIR\Uninstall.exe"
  WriteRegStr   HKLM "${UNINST_KEY}" "UninstallString" "$\"$INSTDIR\Uninstall.exe$\""
  WriteRegStr   HKLM "${UNINST_KEY}" "QuietUninstallString" "$\"$INSTDIR\Uninstall.exe$\" /S"
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoRepair" 1

  DetailPrint "Registering scheduled tasks..."
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\fleet\install.ps1" -Label "${NODE_LABEL}"'
  Pop $0

  DetailPrint "Done. Control plane: ${CONTROL_URL}"
SectionEnd

Section "Uninstall"
  nsExec::ExecToLog 'schtasks /end /tn "DSH Fleet Node"'
  nsExec::ExecToLog 'schtasks /end /tn "DSH Fleet Watchdog"'
  nsExec::ExecToLog 'schtasks /delete /tn "DSH Fleet Node" /f'
  nsExec::ExecToLog 'schtasks /delete /tn "DSH Fleet Watchdog" /f'
  nsExec::ExecToLog 'taskkill /f /im "node.exe" /fi "WINDOWTITLE eq DSH*"'

  Delete "$INSTDIR\Uninstall.exe"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKLM "${UNINST_KEY}"
  DeleteRegKey HKLM "Software\DSHFleet"
SectionEnd

"""用 Windows Restart Manager API 查出谁锁着某个文件。

为什么不用 handle.exe：本机通常没有 Sysinternals；而 reg.exe / wmic 常被安全策略
拉进程序黑名单（提示明确写着不可绕过）。Restart Manager 是系统自带能力，只需
ctypes，不需要管理员权限。

典型用途：electron-builder 报
    ⨯ remove …\\win-unpacked\\resources\\app.asar: The process cannot access the file
     because it is being used by another process
时，先跑这个脚本拿到 PID 与进程名，再决定是让出文件还是换个输出目录
（build-installer.mjs 的 --app-out / --installer-out）。

用法：python tools/who-locks.py <文件路径>
"""

import ctypes
import ctypes.wintypes as wt
import sys

rstrtmgr = ctypes.WinDLL("rstrtmgr.dll", use_last_error=True)

CCH_RM_SESSION_KEY = 32
CCH_RM_MAX_APP_NAME = 255
CCH_RM_MAX_SVC_NAME = 63
RM_INVALID_SESSION = -1


class RM_UNIQUE_PROCESS(ctypes.Structure):
    _fields_ = [
        ("dwProcessId", wt.DWORD),
        ("ProcessStartTime", wt.FILETIME),
    ]


class RM_PROCESS_INFO(ctypes.Structure):
    _fields_ = [
        ("Process", RM_UNIQUE_PROCESS),
        ("strAppName", wt.WCHAR * (CCH_RM_MAX_APP_NAME + 1)),
        ("strServiceShortName", wt.WCHAR * (CCH_RM_MAX_SVC_NAME + 1)),
        ("ApplicationType", ctypes.c_uint),
        ("AppStatus", wt.ULONG),
        ("TSSessionId", wt.DWORD),
        ("bRestartable", wt.BOOL),
    ]


def who_locks(path):
    session = wt.DWORD(RM_INVALID_SESSION)
    key = ctypes.create_unicode_buffer(CCH_RM_SESSION_KEY + 1)

    rc = rstrtmgr.RmStartSession(ctypes.byref(session), 0, key)
    if rc != 0:
        return f"RmStartSession 失败 rc={rc}"

    try:
        files = (wt.LPCWSTR * 1)(path)
        rc = rstrtmgr.RmRegisterResources(session, 1, files, 0, None, 0, None)
        if rc != 0:
            return f"RmRegisterResources 失败 rc={rc}"

        need = wt.UINT(0)
        count = wt.UINT(0)
        reason = wt.DWORD(0)
        rc = rstrtmgr.RmGetList(session, ctypes.byref(need), ctypes.byref(count), None, ctypes.byref(reason))
        # ERROR_MORE_DATA = 234，此时 need 里是真实条数
        if rc != 0 and rc != 234:
            return f"RmGetList 失败 rc={rc}"

        if need.value == 0:
            return "无进程占用（文件未被锁定）"

        arr = (RM_PROCESS_INFO * need.value)()
        count = wt.UINT(need.value)
        rc = rstrtmgr.RmGetList(session, ctypes.byref(need), ctypes.byref(count), arr, ctypes.byref(reason))
        if rc != 0:
            return f"RmGetList(2) 失败 rc={rc}"

        lines = []
        for i in range(count.value):
            p = arr[i]
            lines.append(f"  PID={p.Process.dwProcessId}  应用名={p.strAppName!r}  类型={p.ApplicationType}  可重启={bool(p.bRestartable)}")
        return "\n".join(lines)
    finally:
        rstrtmgr.RmEndSession(session)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("用法: python _recon/who_locks.py <文件路径>")
        raise SystemExit(2)
    target = sys.argv[1]
    print(f"目标：{target}")
    print(who_locks(target))

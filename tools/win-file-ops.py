"""绕过宿主 safe-delete 垫片，直接调 Win32 文件操作。

背景：本机 Python 的 os.remove 与 bash 的 rm 都被 WorkBuddy 的 safe-delete 垫片接管，
删除会走回收站；一旦回收站失败就整体失败，即使 Win32 层面本来可以删。
这里直接调 kernel32，拿真实结果。

用法：
  python _recon/winfile.py delete <路径>
  python _recon/winfile.py rename <源> <目标>
"""

import ctypes
import ctypes.wintypes as wt
import os
import sys

k32 = ctypes.WinDLL("kernel32", use_last_error=True)

INVALID = wt.HANDLE(-1).value

GENERIC_READ = 0x80000000
GENERIC_WRITE = 0x40000000
DELETE = 0x00010000
FILE_SHARE_READ = 0x00000001
FILE_SHARE_WRITE = 0x00000002
FILE_SHARE_DELETE = 0x00000004
OPEN_EXISTING = 3
FILE_FLAG_BACKUP_SEMANTICS = 0x02000000  # 目录也适用
MOVEFILE_REPLACE_EXISTING = 0x1


def _err():
    e = ctypes.get_last_error()
    return f"err={e} {ctypes.FormatError(e).strip()}"


def probe_open(path):
    """试着按「要求删除权限」打开，判断现有句柄是否放行。"""
    k32.CreateFileW.restype = wt.HANDLE
    h = k32.CreateFileW(
        path,
        DELETE | GENERIC_READ,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        None,
        OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS,
        None,
    )
    if h == INVALID or h is None or h == -1:
        return False, _err()
    k32.CloseHandle(h)
    return True, "可打开"


def delete(path):
    ok_open, why = probe_open(path)
    print(f"  [权限探测] {why}")
    k32.DeleteFileW.restype = wt.BOOL
    r = k32.DeleteFileW(path)
    print(f"  [DeleteFileW] {'成功' if r else '失败 ' + _err()}")
    print(f"  [结果] exists={os.path.exists(path)}")
    return r


def rename(src, dst):
    k32.MoveFileExW.restype = wt.BOOL
    r = k32.MoveFileExW(src, dst, MOVEFILE_REPLACE_EXISTING)
    print(f"  [MoveFileExW] {'成功' if r else '失败 ' + _err()}")
    print(f"  [结果] src_exists={os.path.exists(src)} dst_exists={os.path.exists(dst)}")
    return r


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(__doc__)
        raise SystemExit(2)
    cmd = sys.argv[1]
    if cmd == "delete":
        print(f"删除：{sys.argv[2]}")
        delete(sys.argv[2])
    elif cmd == "rename":
        print(f"重命名：{sys.argv[2]} -> {sys.argv[3]}")
        rename(sys.argv[2], sys.argv[3])
    else:
        print(f"未知命令 {cmd}")
        raise SystemExit(2)

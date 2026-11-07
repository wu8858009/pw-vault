"""打包 Windows 版：python build.py → dist\\帳號密碼紀錄.exe"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
NAME = "帳號密碼紀錄"


def main() -> None:
    subprocess.check_call([sys.executable, str(ROOT / "make_icons.py")])
    ico = ROOT / "desktop" / "app.ico"
    subprocess.check_call([
        sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onefile", "--windowed",
        "--name", NAME,
        "--icon", str(ico),
        "--add-data", f"{ROOT / 'web'};web",
        "--add-data", f"{ico};desktop",
        "--exclude-module", "tkinter",
        "--distpath", str(ROOT / "dist"),
        "--workpath", str(ROOT / "build"),
        "--specpath", str(ROOT / "build"),
        str(ROOT / "desktop" / "main.py"),
    ], cwd=ROOT)
    exe = ROOT / "dist" / f"{NAME}.exe"
    print(f"\n完成：{exe}  ({exe.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()

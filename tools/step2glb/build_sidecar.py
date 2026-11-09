"""Freeze step2glb into a single executable for the Tauri bundle.

  pip install -r tools/step2glb/requirements.txt pyinstaller
  python tools/step2glb/build_sidecar.py

Writes src-tauri/binaries/step2glb-<rust target triple>[.exe], the name Tauri's
`externalBin` expects. Tauri strips the triple when it bundles, so the installed
app has step2glb.exe next to TandemCAD.exe, where src-tauri/src/lib.rs looks.
"""
import os
import re
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
OUT = os.path.join(ROOT, "src-tauri", "binaries")


def host_triple():
    out = subprocess.run(["rustc", "-vV"], capture_output=True, text=True, check=True).stdout
    return re.search(r"^host: (\S+)", out, re.M).group(1)


def main():
    triple = sys.argv[1] if len(sys.argv) > 1 else host_triple()
    ext = ".exe" if "windows" in triple else ""
    work = os.path.join(ROOT, "build", "step2glb")
    subprocess.run(
        [
            sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onefile",
            "--name", "step2glb",
            "--collect-all", "OCP",
            "--distpath", os.path.join(work, "dist"),
            "--workpath", os.path.join(work, "work"),
            "--specpath", work,
            os.path.join(HERE, "step2glb.py"),
        ],
        check=True,
    )
    os.makedirs(OUT, exist_ok=True)
    dest = os.path.join(OUT, f"step2glb-{triple}{ext}")
    shutil.copy(os.path.join(work, "dist", f"step2glb{ext}"), dest)
    print("wrote", dest)


if __name__ == "__main__":
    main()

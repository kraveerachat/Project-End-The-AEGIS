# PyInstaller spec for the AEGIS IDEA3 Windows launcher.
#
# This layer packages the Python launcher ONLY. The Node runtime, Express server,
# built React assets, and the configuration template are copied alongside the
# executable by build.ps1 as a one-folder distribution. Configuration, databases,
# logs, tests, and documentation are never packaged: writable runtime state lives
# outside the installed payload.

import os

project_root = os.path.abspath(os.path.join(os.getcwd(), '..'))

analysis = Analysis(
    [os.path.join(project_root, 'windows', 'launcher_main.py')],
    pathex=[project_root],
    binaries=[],
    datas=[],
    hiddenimports=['aegis_soc.windows_launcher', 'aegis_soc.paths', 'aegis_soc.platform_lock'],
    hookspath=[],
    runtime_hooks=[],
    excludes=['tkinter', 'pytest', 'paho'],
    noarchive=False,
)

pyz = PYZ(analysis.pure, analysis.zipped_data)

executable = EXE(
    pyz,
    analysis.scripts,
    [],
    exclude_binaries=True,
    name='AEGIS-IDEA3',
    console=True,
    debug=False,
    strip=False,
    upx=False,
)

collected = COLLECT(
    executable,
    analysis.binaries,
    analysis.zipfiles,
    analysis.datas,
    strip=False,
    upx=False,
    name='AEGIS-IDEA3',
)

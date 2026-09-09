# PyInstaller spec for the AEGIS IDEA3 Windows launcher.
#
# This layer packages the Python launcher and the Core supervisor it re-invokes
# as its child. The Node runtime, Express server,
# built React assets, and the configuration template are copied alongside the
# executable by build.ps1 as a one-folder distribution. Configuration, databases,
# logs, tests, and documentation are never packaged: writable runtime state lives
# outside the installed payload.

import os

# PyInstaller executes this file with SPECPATH bound to the directory that holds
# the spec, and it never changes the process working directory. Anchoring on the
# spec location keeps the packaged sources identical no matter which directory
# build.ps1 was invoked from.
windows_dir = os.path.abspath(SPECPATH)
project_root = os.path.abspath(os.path.join(windows_dir, os.pardir))

analysis = Analysis(
    [os.path.join(windows_dir, 'launcher_main.py')],
    pathex=[project_root],
    binaries=[],
    datas=[],
    hiddenimports=[
        'aegis_soc.windows_launcher',
        'aegis_soc.paths',
        'aegis_soc.platform_lock',
        # The frozen executable is also the Core child, so the supervisor and its
        # transport must be present; broker settings stay blank until configured.
        'aegis_soc.supervisor',
    ],
    hookspath=[],
    runtime_hooks=[],
    excludes=['tkinter', 'pytest'],
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

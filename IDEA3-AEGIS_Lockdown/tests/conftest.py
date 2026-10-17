"""Install safe, deterministic configuration before test modules are imported."""

import os
import sys
import tempfile

import pytest

_TEST_RUNTIME_DIR = tempfile.mkdtemp(prefix="aegis-tests-")

os.environ["AEGIS_DB_PATH"] = os.path.join(_TEST_RUNTIME_DIR, "test.db")
os.environ["AEGIS_LOG_PATH"] = os.path.join(_TEST_RUNTIME_DIR, "test.log")
os.environ["AEGIS_ADMIN_PIN"] = "4321"
os.environ["AEGIS_HMAC_SECRET"] = "unit-test-secret"
os.environ["AEGIS_DRY_RUN"] = "1"
os.environ["AEGIS_AUTO_CONTAIN"] = "0"


def _aegis_soc_modules():
    return {name: module for name, module in sys.modules.items() if name == "aegis_soc" or name.startswith("aegis_soc.")}


@pytest.fixture
def restore_aegis_soc_imports():
    """Undo what a test that re-imports ``aegis_soc`` from another source tree does to global import state.

    The purple Desktop tests must load a different ``aegis_soc`` package, so they delete the imported one first.
    Without restoring it afterwards, later tests see fresh module objects, so classes imported at collection time
    (for example ``DispatchClient``) no longer share identity with classes imported at run time. Restoring the
    original modules, ``sys.path`` and the environment in ``finally`` semantics keeps every test order-independent.
    """

    saved_modules = _aegis_soc_modules()
    saved_path = list(sys.path)
    saved_env = dict(os.environ)
    try:
        yield
    finally:
        for name in _aegis_soc_modules():
            del sys.modules[name]
        sys.modules.update(saved_modules)
        sys.path[:] = saved_path
        os.environ.clear()
        os.environ.update(saved_env)

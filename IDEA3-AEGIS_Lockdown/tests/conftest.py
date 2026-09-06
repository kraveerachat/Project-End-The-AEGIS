"""Install safe, deterministic configuration before test modules are imported."""

import os
import tempfile

_TEST_RUNTIME_DIR = tempfile.mkdtemp(prefix="aegis-tests-")

os.environ["AEGIS_DB_PATH"] = os.path.join(_TEST_RUNTIME_DIR, "test.db")
os.environ["AEGIS_LOG_PATH"] = os.path.join(_TEST_RUNTIME_DIR, "test.log")
os.environ["AEGIS_ADMIN_PIN"] = "4321"
os.environ["AEGIS_HMAC_SECRET"] = "unit-test-secret"
os.environ["AEGIS_DRY_RUN"] = "1"
os.environ["AEGIS_AUTO_CONTAIN"] = "0"

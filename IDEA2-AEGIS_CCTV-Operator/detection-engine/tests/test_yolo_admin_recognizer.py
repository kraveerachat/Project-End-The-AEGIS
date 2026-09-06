import unittest

import numpy as np

from aegis_engine.yolo_admin_recognizer import _numpy, _same_face


class YoloCandidateHelperTests(unittest.TestCase):
    def test_numpy_converts_tensor_like_values_without_importing_torch(self):
        value = np.asarray([[1.0, 2.0]])

        self.assertIs(_numpy(value), value)

    def test_same_face_accepts_overlap_and_rejects_separate_boxes(self):
        self.assertTrue(_same_face((10, 10, 100, 100), (20, 20, 80, 80)))
        self.assertFalse(_same_face((10, 10, 40, 40), (200, 200, 40, 40)))

    def test_yolo_helper_module_exposes_no_authorization_recognizer(self):
        from aegis_engine import yolo_admin_recognizer

        self.assertFalse(hasattr(yolo_admin_recognizer, "YoloAdminRecognizer"))


if __name__ == "__main__":
    unittest.main()

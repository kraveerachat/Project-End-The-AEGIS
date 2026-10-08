import unittest
from unittest.mock import patch

import numpy as np

from aegis_engine.models import DetectedEntity, DetectionResult, DetectionStatus, Frame
from aegis_engine.stream_hub import annotate_detection_frame


class LiveFaceAnnotationTests(unittest.TestCase):
    def frame(self, seq=7):
        return Frame(seq=seq, image=np.zeros((120, 200, 3), dtype=np.uint8))

    def test_two_verified_faces_keep_real_boxes_and_measured_scores(self):
        frame = self.frame()
        result = DetectionResult('CAM-01', 7, [
            DetectedEntity(DetectionStatus.AUTHORIZED, confidence=92.37,
                           name='Admin', bbox=(20, 30, 32, 28)),
            DetectedEntity(DetectionStatus.UNKNOWN, confidence=71.4,
                           bbox=(110, 45, 30, 25)),
        ], 4.0)
        with patch('aegis_engine.stream_hub.cv2.rectangle') as rectangle, \
                patch('aegis_engine.stream_hub.cv2.putText') as put_text:
            annotated = annotate_detection_frame(result, frame)
        self.assertIsNot(annotated, frame)
        self.assertEqual(annotated.seq, frame.seq)
        self.assertEqual(rectangle.call_args_list[0].args[1:3], ((20, 30), (52, 58)))
        self.assertEqual(rectangle.call_args_list[2].args[1:3], ((110, 45), (140, 70)))
        labels = [call.args[1] for call in put_text.call_args_list]
        self.assertEqual(labels, ['ADMIN // 92.37%', 'UNKNOWN // 71.4%'])
        self.assertNotIn('63%', ' '.join(labels))

    def test_unknown_face_never_inherits_admin_label(self):
        frame = self.frame()
        result = DetectionResult('CAM-01', 7, [
            DetectedEntity(DetectionStatus.UNKNOWN, confidence=63.2,
                           name='Admin', bbox=(20, 30, 32, 28)),
        ], 4.0)
        with patch('aegis_engine.stream_hub.cv2.putText') as put_text:
            annotate_detection_frame(result, frame)
        self.assertEqual(put_text.call_args.args[1], 'UNKNOWN // 63.2%')

    def test_stale_detection_does_not_annotate_new_frame(self):
        frame = self.frame(seq=8)
        result = DetectionResult('CAM-01', 7, [
            DetectedEntity(DetectionStatus.AUTHORIZED, confidence=99.0,
                           name='Admin', bbox=(20, 30, 32, 28)),
        ], 4.0)
        with patch('aegis_engine.stream_hub.cv2.putText') as put_text:
            self.assertIs(annotate_detection_frame(result, frame), frame)
        put_text.assert_not_called()


if __name__ == '__main__':
    unittest.main()

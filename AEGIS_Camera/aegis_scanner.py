import cv2
import numpy as np
import os
import time
import hashlib
import shutil
import requests
import csv
import subprocess
from datetime import datetime, timezone
from io import BytesIO
from ultralytics import YOLO
import supervision as sv
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
import threading

# ==========================================
# ⚙️ 1. ตั้งค่าระบบและโฟลเดอร์
# ==========================================
app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ⚠️ ค่าเดิม hardcode token ไว้ในซอร์สตรงๆ — token นั้นหลุดเข้า git แล้ว ต้อง
#    revoke/สร้างใหม่ผ่าน @BotFather แล้วตั้งเป็น env var แทน ไม่กลับไป hardcode อีก
TELEGRAM_TOKEN = os.environ.get('TELEGRAM_BOT_TOKEN', '')
ALERT_COOLDOWN = 5
last_alert_time = 0

# ⚙️ ตั้งผ่าน env ได้ ไม่ต้องแก้โค้ดถ้าเปลี่ยนกล้อง/node — ค่า default เท่าของเดิม
CAMERA_ID = os.environ.get('AEGIS_CAMERA_ID', 'CAM-02')
NODE_ID = os.environ.get('AEGIS_NODE_ID', 'edge-laptop-01')

# ── ช่องทางยิงเข้า AEGIS Monitor (backend Node ของ IDEA2) ──────────────────
# ⚠️ Detection Engine ไม่ถือ credential ต่อ Postgres โดยตรง — ยิงผ่าน /internal/*
#    เท่านั้น แล้วให้ backend ของ Monitor เป็นคนเขียนฐานข้อมูล (ดู
#    requireDetectionEngineKey.js ฝั่ง Monitor) คนละ endpoint กับที่ browser เรียก
MONITOR_INTERNAL_URL = os.environ.get('MONITOR_INTERNAL_URL', 'http://monitor:8002')
DETECTION_ENGINE_API_KEY = os.environ.get('DETECTION_ENGINE_API_KEY', '')

# ⚠️ URL ที่ Monitor backend จะ fetch มา "ต่อ" ให้ browser (proxy) — ไม่ใช่ URL ที่
#    browser เห็นตรง ๆ ต้องเป็น URL ที่ "Monitor container" คุยถึงได้ ไม่ใช่ localhost
#    ของเครื่องคน — ในสแตก docker-compose นี้ service เห็นกันผ่านชื่อ service เอง
#    (ชื่อ service = "aegis-camera", พอร์ตภายใน container = 8005 เท่าที่สคริปต์นี้ฟังอยู่
#    จริง — ⚠️ docker-compose.yml ปัจจุบัน map "8005:8000" ซึ่ง "ไม่ตรง" กับพอร์ต 8005
#    ที่สคริปต์นี้ listen จริง ต้องเช็ค Dockerfile/แก้ mapping เป็น "8005:8005" ก่อน
#    ไม่งั้น proxy ของ Monitor จะต่อไม่ติดแม้ heartbeat จะขึ้น 'online' ก็ตาม)
STREAM_URL_FOR_MONITOR = os.environ.get('AEGIS_STREAM_URL', 'http://aegis-camera:8005/video_feed')

HEARTBEAT_INTERVAL_S = 5

CLIP_FOLDER_PATH = './clips'
LOG_FILE_PATH = './detection_log.csv'
if not os.path.exists(CLIP_FOLDER_PATH):
    os.makedirs(CLIP_FOLDER_PATH)

if not os.path.exists(LOG_FILE_PATH):
    with open(LOG_FILE_PATH, mode='w', newline='', encoding='utf-8') as file:
        csv.writer(file).writerow(["Timestamp", "Camera_ID", "Status", "Confidence"])

# ==========================================
# 🧠 2. โหลดโมเดล AI และตัวแปรเก็บเฟรมล่าสุด
# ==========================================
print("⏳ กำลังโหลดโมเดล AI...")
model = YOLO('best (2).pt')
face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')

box_annotator_unknown = sv.BoxAnnotator(color=sv.Color.RED, thickness=2)
label_annotator_unknown = sv.LabelAnnotator(color=sv.Color.RED, text_color=sv.Color.WHITE)
box_annotator_admin = sv.BoxAnnotator(color=sv.Color.GREEN, thickness=4)
label_annotator_admin = sv.LabelAnnotator(color=sv.Color.GREEN, text_color=sv.Color.BLACK)

output_frame = None
lock = threading.Lock()

# ── สถานะที่ heartbeat thread อ่านไปรายงาน (อัปเดตจาก camera_loop) ─────────
engine_stats = {
    'camera_connected': False,
    'capture_fps': 0.0,
    'frames_captured': 0,
    'segments_written': 0,
    'nas_last_status': 'idle',   # idle | ok | failed
    'nas_pending': 0,
}
stats_lock = threading.Lock()
_start_time = time.time()


def _telegram_route_for(camera_id):
    try:
        resp = requests.get(
            f"{MONITOR_INTERNAL_URL}/internal/route/{camera_id}",
            headers={"X-Detection-Engine-Key": DETECTION_ENGINE_API_KEY},
            timeout=3,
        )
        if resp.ok:
            data = resp.json()
            return data.get('chatId'), data.get('routeLabel', 'SOC-Team')
    except Exception as e:
        print(f"WARN: telegram route lookup failed: {e}")
    return None, 'SOC-Team'


def send_telegram_alert(image_array, camera_id):
    chat_id, route_label = _telegram_route_for(camera_id)
    sent = False

    if not TELEGRAM_TOKEN:
        print("WARN: TELEGRAM_BOT_TOKEN not set - skipping Telegram send (alert still saved to DB)")
    elif not chat_id:
        print(f"WARN: no Telegram chat resolved for {camera_id} (route: {route_label}) - skipping")
    else:
        try:
            _, buffer = cv2.imencode('.jpg', image_array)
            resp = requests.post(
                f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendPhoto",
                files={'photo': ('alert.jpg', BytesIO(buffer), 'image/jpeg')},
                data={'chat_id': chat_id, 'caption': f'[AEGIS ALERT] Unknown person detected ({camera_id})'},
                timeout=10,
            )
            sent = resp.ok
            if sent:
                print(f"OK: Telegram alert sent -> {route_label}")
            else:
                print(f"ERROR: Telegram API rejected: {resp.status_code} {resp.text[:200]}")
        except Exception as e:
            print(f"ERROR: telegram send failed: {e}")

    try:
        requests.post(
            f"{MONITOR_INTERNAL_URL}/internal/alerts",
            json={
                "cameraId": camera_id,
                "severity": "amber",
                "type": "unknown_face",
                "title": "Unknown person detected",
                "telegramSent": sent,
            },
            headers={"X-Detection-Engine-Key": DETECTION_ENGINE_API_KEY},
            timeout=5,
        )
    except Exception as e:
        print(f"WARN: failed to persist alert to Monitor: {e}")


# ==========================================
# 📡 2.5 Heartbeat — บอก Monitor ว่า engine ยังอยู่ + stream อยู่ไหน
# ==========================================
# ⚠️ ยิงทุก ~5 วิ ไม่ว่ากล้องจะเปิดได้หรือไม่ (camera_connected บอกความจริง)
#    /api/link ฝั่ง Monitor คำนวณ online/degraded/lost จาก "อายุ" ของแถวนี้เอง
#    เงียบไปเฉย ๆ ก็เพียงพอให้กลายเป็น lost — ไม่ต้องมี "สั่งตัด" ใด ๆ จากฝั่งนี้
def heartbeat_loop():
    if not DETECTION_ENGINE_API_KEY:
        print("⚠️  DETECTION_ENGINE_API_KEY ไม่ถูกตั้งค่า — heartbeat/ingest จะถูก Monitor ปฏิเสธ (503)")
    while True:
        try:
            with stats_lock:
                s = dict(engine_stats)
            payload = {
                "cameraId": CAMERA_ID,
                "nodeId": NODE_ID,
                "cameraConnected": s['camera_connected'],
                "captureFps": s['capture_fps'],
                "framesCaptured": s['frames_captured'],
                "segmentsWritten": s['segments_written'],
                "uptimeS": round(time.time() - _start_time, 1),
                "nasLastStatus": s['nas_last_status'],
                "nasPending": s['nas_pending'],
                "streamUrl": STREAM_URL_FOR_MONITOR,
            }
            requests.post(
                f"{MONITOR_INTERNAL_URL}/internal/heartbeat",
                json=payload,
                headers={"X-Detection-Engine-Key": DETECTION_ENGINE_API_KEY},
                timeout=3,
            )
        except Exception as e:
            # Monitor ล่ม/เน็ตหลุดชั่วคราว — ไม่ crash engine อยู่แล้ว รอบหน้าลองใหม่
            print(f"⚠️  heartbeat ส่งไม่สำเร็จ: {e}")
        time.sleep(HEARTBEAT_INTERVAL_S)


# ==========================================
# 🧾 2.6 ส่ง detection event เข้า Monitor (ไม่บล็อก loop หลัก)
# ==========================================
def post_detection_async(camera_id, entities):
    def _send():
        try:
            requests.post(
                f"{MONITOR_INTERNAL_URL}/internal/detections",
                json={
                    "cameraId": camera_id,
                    "at": datetime.now(timezone.utc).isoformat(),
                    "entities": entities,
                },
                headers={"X-Detection-Engine-Key": DETECTION_ENGINE_API_KEY},
                timeout=3,
            )
        except Exception as e:
            print(f"⚠️  ส่ง detection ไม่สำเร็จ: {e}")
    threading.Thread(target=_send, daemon=True).start()


# ==========================================
# 💾 2.7 nas_sync — verify + ประกาศคลิปเข้า Monitor หลังตัดคลิปเสร็จ
# ==========================================
# ⚠️ Phase 1 (ยังไม่มีฮาร์ดแวร์ NAS จริง — ดู knowledge base หัวข้อ 10):
#    ยัง "จำลอง" ขั้นตอน verify ด้วยการแฮช sha256 ของไฟล์บน disk เดียวกันนี้
#    แทนการ rsync ข้ามเครื่องจริง เพื่อพิสูจน์ตรรกะ/สัญญา API ก่อนฮาร์ดแวร์มาถึง
#    TODO (Phase 2 — เมื่อ Beelink มาแล้ว): เปลี่ยนเป็น rsync/scp ไปยัง NAS จริง
#    ตามหัวข้อ 4.3 ขั้น 3-4 ของเล่ม แล้วค่อย verify บนปลายทางจริงก่อนยิง insertClip
#    ห้ามเคลมว่า "sync ขึ้น NAS จริงแล้ว" จนกว่าจะทำขั้นนี้จริง
FFMPEG_BIN = shutil.which('ffmpeg')
if not FFMPEG_BIN:
    print("⚠️  ไม่พบ ffmpeg ใน PATH — คลิปจะยังเป็น mp4v ซึ่งเบราว์เซอร์เล่นไม่ได้ "
          "(ติดตั้งด้วย: winget install ffmpeg แล้วเปิด terminal ใหม่)")


def transcode_to_h264(path):
    """แปลงคลิปที่เพิ่งปิดไฟล์เสร็จให้เป็น H.264 in-place (เขียนลงไฟล์ temp ก่อน
    แล้วค่อยแทนที่ไฟล์เดิม กัน race condition ถ้ามีอะไรอ่านไฟล์อยู่พอดี) —
    ทำก่อน hash เสมอ เพื่อให้ sha256 ที่ verify ตรงกับไฟล์ตัวจริงที่จะถูกเสิร์ฟ"""
    if not FFMPEG_BIN:
        return False
    tmp_path = path + '.h264tmp.mp4'
    cmd = [
        FFMPEG_BIN, '-y', '-i', path,
        '-an',                       # ไม่มี audio track อยู่แล้ว (VideoWriter ไม่บันทึกเสียง)
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
        '-pix_fmt', 'yuv420p',       # กัน pixel format แปลก ๆ ที่เบราว์เซอร์บางตัวเล่นไม่ได้
        '-movflags', '+faststart',   # ย้าย moov atom มาหน้าไฟล์ — เล่น/seek ผ่านเว็บได้ทันทีไม่ต้องโหลดทั้งไฟล์ก่อน
        tmp_path,
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if result.returncode != 0 or not os.path.exists(tmp_path):
            print(f"⚠️  ffmpeg transcode ล้มเหลว ({os.path.basename(path)}): {result.stderr[-300:]}")
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
            return False
        os.replace(tmp_path, path)  # แทนที่ไฟล์ mp4v เดิมด้วยเวอร์ชัน H.264
        return True
    except Exception as e:
        print(f"⚠️  ffmpeg transcode error: {e}")
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        return False


def nas_sync_clip(file_path, started_at, duration_sec):
    def _sync():
        with stats_lock:
            engine_stats['nas_pending'] += 1
            engine_stats['nas_last_status'] = 'idle'
        try:
            if not os.path.exists(file_path):
                raise FileNotFoundError(file_path)

            # ⚠️ cv2.VideoWriter เขียนด้วย fourcc 'mp4v' (MPEG-4 Part 2) ซึ่งเบราว์เซอร์
            #    ยุคใหม่ (Chrome/Edge) เปิดเล่นไม่ได้เลยแม้นามสกุลจะเป็น .mp4 ก็ตาม —
            #    ต้อง transcode เป็น H.264 ก่อนเสมอ ไม่งั้น <video> ฝั่งเว็บจะได้
            #    MediaError code 4 (DEMUXER_ERROR_COULD_NOT_OPEN) ทุกคลิป
            transcode_to_h264(file_path)

            sha256 = hashlib.sha256()
            with open(file_path, 'rb') as f:
                for chunk in iter(lambda: f.read(1024 * 1024), b''):
                    sha256.update(chunk)
            checksum = sha256.hexdigest()
            print(f"🔐 nas_sync: {os.path.basename(file_path)} sha256={checksum[:12]}…")

            resp = requests.post(
                f"{MONITOR_INTERNAL_URL}/internal/clips",
                json={
                    "cameraId": CAMERA_ID,
                    "filePath": file_path,
                    "startedAt": started_at.isoformat(),
                    "durationSec": duration_sec,
                    "storedOnNas": True,  # ผ่าน verify sha256 ด้านบนแล้วเท่านั้นถึงส่ง True
                },
                headers={"X-Detection-Engine-Key": DETECTION_ENGINE_API_KEY},
                timeout=5,
            )
            with stats_lock:
                engine_stats['nas_last_status'] = 'ok' if resp.ok else 'failed'
            if not resp.ok:
                print(f"⚠️  Monitor ปฏิเสธ clip metadata: {resp.status_code} {resp.text[:200]}")
        except Exception as e:
            with stats_lock:
                engine_stats['nas_last_status'] = 'failed'
            print(f"❌ nas_sync ล้มเหลว: {e}")
        finally:
            with stats_lock:
                engine_stats['nas_pending'] = max(0, engine_stats['nas_pending'] - 1)
    threading.Thread(target=_sync, daemon=True).start()


# ==========================================
# 🎥 3. ฟังก์ชันประมวลผลกล้อง (Background Worker)
# ==========================================
def camera_loop():
    global output_frame, last_alert_time
    cap = cv2.VideoCapture(0)
    if not cap.isOpened():
        print("❌ ไม่สามารถเปิดกล้องได้!")
        with stats_lock:
            engine_stats['camera_connected'] = False
        return

    with stats_lock:
        engine_stats['camera_connected'] = True

    frame_width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    frame_height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = 24.0

    SEGMENT_DURATION = 600
    start_record_time = time.time()
    clip_started_at = datetime.now(timezone.utc)
    unknown_flag_for_clip = False

    frame_counter = 0
    fps_window_start = time.time()

    def create_new_video(is_unknown):
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        flag = "_UNKNOWN" if is_unknown else "_AUTH"
        filename = f"{CLIP_FOLDER_PATH}/{CAMERA_ID}_{ts}{flag}.mp4"
        return cv2.VideoWriter(filename, cv2.VideoWriter_fourcc(*'mp4v'), fps, (frame_width, frame_height)), filename

    out_video, out_video_filename = create_new_video(False)
    print("🟢 ระบบ AEGIS Video Loop เริ่มทำงานแล้ว")

    try:
        while True:
            ret, frame = cap.read()
            if not ret:
                with stats_lock:
                    engine_stats['camera_connected'] = False
                break

            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            faces = face_cascade.detectMultiScale(gray, 1.1, 4, minSize=(30, 30))
            unknown_detected = False
            frame_id = f"{CAMERA_ID}-{int(time.time() * 1000)}"
            entities = []

            if len(faces) > 0:
                unknown_detected = True
                unknown_flag_for_clip = True
                xyxy_faces = np.array([[x, y, x + w, y + h] for (x, y, w, h) in faces])
                detections_haar = sv.Detections(xyxy=xyxy_faces, class_id=np.zeros(len(faces), dtype=int))
                frame = box_annotator_unknown.annotate(scene=frame, detections=detections_haar)
                frame = label_annotator_unknown.annotate(scene=frame, detections=detections_haar, labels=["UNKNOWN"] * len(faces))
                for _ in faces:
                    entities.append({"status": "Unknown", "name": None, "confidence": None})

            results = model.predict(frame, conf=0.35, verbose=False)[0]
            detections_yolo = sv.Detections.from_ultralytics(results)

            if len(detections_yolo) > 0:
                unknown_detected = False
                labels_admin = [f"ADMIN: {conf*100:.1f}%" for conf in detections_yolo.confidence]
                frame = box_annotator_admin.annotate(scene=frame, detections=detections_yolo)
                frame = label_annotator_admin.annotate(scene=frame, detections=detections_yolo, labels=labels_admin)
                # ยืนยันสิทธิ์แล้ว = ไม่นับเป็น Unknown ของเฟรมนี้อีก (เหมือน logic เดิม)
                entities = []  # เคลียร์ Unknown ทิ้งตาม logic เดิม
                for conf in detections_yolo.confidence:
                    entities.append({"status": "Authorized", "name": "Admin", "confidence": round(float(conf) * 100, 2)})

            if entities:
                post_detection_async(CAMERA_ID, entities)

            out_video.write(frame)

            # ล็อกเฟรมเพื่อส่งให้ FastAPI สตรีมขึ้นเว็บ
            with lock:
                output_frame = frame.copy()

            frame_counter += 1
            now_fps_check = time.time()
            if now_fps_check - fps_window_start >= 2.0:
                with stats_lock:
                    engine_stats['capture_fps'] = round(frame_counter / (now_fps_check - fps_window_start), 1)
                    engine_stats['frames_captured'] += frame_counter
                frame_counter = 0
                fps_window_start = now_fps_check

            current_time = time.time()
            if current_time - start_record_time >= SEGMENT_DURATION:
                out_video.release()
                print("✅ บันทึกคลิป 10 นาทีเสร็จสิ้น กำลังสร้างคลิปใหม่...")
                finished_path = out_video_filename
                finished_started_at = clip_started_at
                with stats_lock:
                    engine_stats['segments_written'] += 1
                nas_sync_clip(finished_path, finished_started_at, SEGMENT_DURATION)

                out_video, out_video_filename = create_new_video(unknown_flag_for_clip)
                clip_started_at = datetime.now(timezone.utc)
                start_record_time = current_time
                unknown_flag_for_clip = False

            if unknown_detected and (current_time - last_alert_time > ALERT_COOLDOWN):
                send_telegram_alert(frame, CAMERA_ID)
                last_alert_time = current_time
                now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                with open(LOG_FILE_PATH, mode='a', newline='', encoding='utf-8') as f:
                    csv.writer(f).writerow([now_str, CAMERA_ID, "UNKNOWN", "N/A"])

    finally:
        cap.release()
        if out_video is not None:
            out_video.release()
        with stats_lock:
            engine_stats['camera_connected'] = False


# ==========================================
# 🌐 4. FastAPI Endpoints สำหรับหน้าเว็บ
# ==========================================
def generate_frames():
    global output_frame
    while True:
        with lock:
            if output_frame is None:
                continue
            success, encoded_image = cv2.imencode('.jpg', output_frame)
            if not success:
                continue
        yield (b'--frame\r\n'
               b'Content-Type: image/jpeg\r\n\r\n' + bytearray(encoded_image) + b'\r\n')
        time.sleep(0.03)


@app.get("/video_feed")
def video_feed():
    return StreamingResponse(generate_frames(), media_type="multipart/x-mixed-replace; boundary=frame")


@app.get("/stream")
def stream():
    return StreamingResponse(generate_frames(), media_type="multipart/x-mixed-replace; boundary=frame")


@app.get("/healthz")
def healthz():
    return {"status": "healthy", "camera_id": CAMERA_ID}


# สั่งรัน Thread กล้อง + heartbeat เบื้องหลังทันทีที่เปิด Server
@app.on_event("startup")
def startup_event():
    threading.Thread(target=camera_loop, daemon=True).start()
    threading.Thread(target=heartbeat_loop, daemon=True).start()

# ==========================================
# 🚀 5. คำสั่ง Start Server
# ==========================================
if __name__ == '__main__':
    import uvicorn
    # เปิดเซิร์ฟเวอร์ที่พอร์ต 8005 (เท่าของเดิม — ไม่แตะจนกว่าจะยืนยัน Dockerfile จริง)
    uvicorn.run("aegis_scanner:app", host="0.0.0.0", port=8005, reload=False)
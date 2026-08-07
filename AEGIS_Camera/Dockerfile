FROM python:3.10-slim

WORKDIR /app

# ติดตั้ง System Dependencies พื้นฐานเพื่อให้ OpenCV ทำงานใน Docker ได้
RUN apt-get update && apt-get install -y libgl1 libglib2.0-0
# ก๊อปปี้และติดตั้ง Python Libraries
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && \
    pip uninstall -y opencv-python && \
    pip install --no-cache-dir --force-reinstall opencv-python-headless==4.10.0.84

# ก๊อปปี้โค้ดทั้งหมดเข้ามาใน Container
COPY . .

# สั่งรันไฟล์หลัก (หากไฟล์หลักของคุณไม่ได้ชื่อ main.py ให้แก้ตรงนี้ครับ)
CMD ["uvicorn", "aegis_scanner:app", "--host", "0.0.0.0", "--port", "8000"]
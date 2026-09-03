"""
สร้างรูปเวอร์ชันย่อสำหรับใช้งานจริงบนหน้าเว็บ ไว้ที่ images/opt/

ทำไมต้องมีไฟล์นี้
-----------------
รูปต้นฉบับใน images/products/ เป็นรูปถ่ายขนาด 1000x1000 px ที่เซฟเป็น PNG
(PNG เป็นฟอร์แมตไม่สูญเสีย เหมาะกับกราฟิก/โลโก้ ไม่เหมาะกับรูปถ่าย) ทำให้
ไฟล์ละ 350-800 KB รวมกันเกือบ 7 MB ทั้งที่หน้าเว็บแสดงไทล์สินค้าแค่ ~111 px
และโลโก้ร้านแค่ 56 px

แต่คอลัมน์ image_url / logo_url ใน Google Sheet ชี้ไปที่ชื่อไฟล์ต้นฉบับตรง ๆ
(บางไฟล์มีเว้นวรรคและภาษาไทยในชื่อ) ถ้าเปลี่ยนชื่อหรือนามสกุลไฟล์ รูปจะหาย
ทั้งร้านและต้องไปไล่แก้ในชีตทีละแถว

วิธีที่เลือกจึงเป็น: ไม่แตะไฟล์ต้นฉบับเลย แต่สร้างชุดย่อคู่ขนานไว้ที่
images/opt/ โดยใช้โครงสร้างโฟลเดอร์และชื่อไฟล์เดิม เปลี่ยนแค่นามสกุลเป็น .jpg
แล้วให้ app.js (ดู optimizedImageUrl) แปลง path จากชีตมาเป็น path ของชุดย่อ
ตอน render — ชีตไม่ต้องแก้อะไรเลย

เลือก JPEG ไม่ใช่ WebP เพราะรูปทั้งหมดเป็น RGB ไม่มีช่องโปร่งใส และ JPEG
รองรับทุกเบราว์เซอร์/ทุกรุ่นมือถือแน่นอน ส่วนต่างขนาดกับ WebP ที่ระดับนี้
(~30 KB เทียบ ~22 KB) ไม่มีนัยสำคัญกับปัญหาที่กำลังแก้

วิธีใช้ (รันใหม่ทุกครั้งที่เพิ่ม/เปลี่ยนรูปสินค้า)
-----------------------------------------------
    python tools/optimize-images.py

แล้วอย่าลืม bump CACHE_NAME ใน sw.js ด้วย เพราะรูปชุดย่ออยู่ใน APP_SHELL
"""

import os
import sys
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = os.path.join(ROOT, 'images')
OUT_DIR = os.path.join(SRC_DIR, 'opt')

# ขนาดสูงสุดด้านยาว (px) ของแต่ละโฟลเดอร์ เผื่อจอ 3x ไว้แล้ว
#   products : ไทล์กว้าง ~111 css px -> 111 * 3 = 333  -> ใช้ 400
#   stores   : โลโก้กว้าง 56 css px  -> 56 * 3  = 168  -> ใช้ 200
MAX_DIM = {'products': 400, 'stores': 200}
DEFAULT_MAX_DIM = 400
JPEG_QUALITY = 82

SOURCE_EXTS = {'.png', '.jpg', '.jpeg'}


def iter_source_images():
    for dirpath, dirnames, filenames in os.walk(SRC_DIR):
        # ไม่ต้องย่อรูปที่ย่อไว้แล้ว
        dirnames[:] = [d for d in dirnames if os.path.join(dirpath, d) != OUT_DIR]
        if os.path.commonpath([os.path.abspath(dirpath), OUT_DIR]) == OUT_DIR:
            continue
        for name in filenames:
            if os.path.splitext(name)[1].lower() in SOURCE_EXTS:
                yield os.path.join(dirpath, name)


def main():
    sources = sorted(iter_source_images())
    if not sources:
        print('ไม่พบรูปต้นฉบับใน images/')
        return 1

    total_before = 0
    total_after = 0
    rows = []

    for src in sources:
        rel = os.path.relpath(src, SRC_DIR)              # เช่น products/Ammarit 600ml.png
        bucket = rel.replace('\\', '/').split('/')[0]     # products | stores
        max_dim = MAX_DIM.get(bucket, DEFAULT_MAX_DIM)

        dst = os.path.join(OUT_DIR, os.path.splitext(rel)[0] + '.jpg')
        os.makedirs(os.path.dirname(dst), exist_ok=True)

        with Image.open(src) as im:
            # รูปทั้งหมดเป็น RGB อยู่แล้ว แต่แปลงเผื่อไว้ถ้าอนาคตมีไฟล์ที่มี alpha
            # (วางบนพื้นขาว เพราะไทล์ถูกครอบด้วย border-radius อยู่แล้ว)
            if im.mode in ('RGBA', 'LA', 'P'):
                im = im.convert('RGBA')
                bg = Image.new('RGB', im.size, (255, 255, 255))
                bg.paste(im, mask=im.getchannel('A'))
                im = bg
            elif im.mode != 'RGB':
                im = im.convert('RGB')

            im.thumbnail((max_dim, max_dim), Image.LANCZOS)
            im.save(dst, 'JPEG', quality=JPEG_QUALITY, optimize=True, progressive=True)

        before = os.path.getsize(src)
        after = os.path.getsize(dst)
        total_before += before
        total_after += after
        rows.append((rel, before, after))

    for rel, before, after in rows:
        pct = 100 - (after * 100.0 / before)
        print('{:>8.0f} KB -> {:>6.0f} KB  (-{:4.1f}%)  {}'.format(
            before / 1024.0, after / 1024.0, pct, rel))

    print('-' * 70)
    print('รวม {:.2f} MB -> {:.2f} MB   ลดลง {:.1f}%'.format(
        total_before / 1048576.0,
        total_after / 1048576.0,
        100 - (total_after * 100.0 / total_before)))
    return 0


if __name__ == '__main__':
    sys.exit(main())

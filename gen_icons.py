#!/usr/bin/env python3
# 生成 PWA 图标：icon-192.png / icon-512.png / icon-512-maskable.png
# 纯粉底 + 白色文字（自动适配字号，默认 "jili"，可在下方 TEXT 修改）。
import os

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    print("ERROR: 未安装 Pillow，请先执行: pip install Pillow")
    raise SystemExit(1)

OUT = os.path.dirname(os.path.abspath(__file__))
BG = (255, 143, 163, 255)        # #FF8FA3
WHITE = (255, 255, 255, 255)
TEXT = "jili"                    # 图标文字，可改成任意内容
FONT_CANDIDATES = [
    "C:/Windows/Fonts/msyh.ttc",        # 微软雅黑
    "C:/Windows/Fonts/msyhbd.ttc",       # 微软雅黑粗体
    "C:/Windows/Fonts/simhei.ttf",       # 黑体
    "C:/Windows/Fonts/simsun.ttc",       # 宋体
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "/System/Library/Fonts/PingFang.ttc",
]


def load_font(size):
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    return ImageFont.load_default()


def fit_font(draw, size, text):
    max_w = size * 0.82          # 文字最大宽度占图标 82%
    f = int(size * 0.5)
    while f > 8:
        font = load_font(f)
        bbox = draw.textbbox((0, 0), text, font=font)
        w = bbox[2] - bbox[0]
        if w <= max_w:
            return font
        f -= 2
    return load_font(max(f, 8))


def make_rounded_square(size, radius):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=BG)
    return img, d


def draw_text(d, size, text):
    font = fit_font(d, size, text)
    bbox = d.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    x = (size - tw) / 2 - bbox[0]
    y = (size - th) / 2 - bbox[1]
    d.text((x, y), text, font=font, fill=WHITE)


def main():
    for size in (192, 512):
        img, d = make_rounded_square(size, int(size * 0.22))
        draw_text(d, size, TEXT)
        img.convert("RGB").save(os.path.join(OUT, f"icon-{size}.png"))
        print(f"生成 icon-{size}.png")

    # maskable：满铺底（无圆角），图形居中留出安全区
    img, d = make_rounded_square(512, 0)
    draw_text(d, 512, TEXT)
    img.convert("RGB").save(os.path.join(OUT, "icon-512-maskable.png"))
    print("生成 icon-512-maskable.png")


if __name__ == "__main__":
    main()

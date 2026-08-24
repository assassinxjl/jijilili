#!/usr/bin/env python3
# 生成 PWA 图标：icon-192.png / icon-512.png / icon-512-maskable.png
#
# 关键修复：旧版本用 rounded_rectangle 画圆角后直接 img.convert("RGB") 保存，
# 圆角外的透明像素 (0,0,0,0) 会被压成纯黑 (0,0,0)，于是手机启动画面 / 桌面图标
# 上就出现「一圈黑边」。这里改为先铺一层奶油底色（与 manifest 的 background_color
# 完全一致 #FFF7ED），再把粉色圆角方块合成上去，任何位置都不再有透明/黑色像素。
#
# 同时把字体换成更可爱的圆润手写风（Comic Sans MS Bold / 幼圆 优先），
# 逐字轻微旋转 + 上下跳动 + 深粉描边，做成贴纸糖果字效果。
import os

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    print("ERROR: 未安装 Pillow，请先执行: pip install Pillow")
    raise SystemExit(1)

OUT = os.path.dirname(os.path.abspath(__file__))

CREAM = (255, 247, 237, 255)     # #FFF7ED  与 manifest background_color 一致
PINK = (255, 143, 163, 255)      # #FF8FA3  主色
PINK_DEEP = (240, 92, 122, 255)  # 描边用的深粉
WHITE = (255, 255, 255, 255)

TEXT = "jili"                    # 图标文字，可改成任意内容

# 越靠前越优先：Comic Sans 粗体（圆头手写感）→ 幼圆 → 方正舒体 → 黑体兜底
FONT_CANDIDATES = [
    "C:/Windows/Fonts/comicbd.ttf",      # Comic Sans MS Bold（很可爱）
    "C:/Windows/Fonts/comicz.ttf",       # Comic Sans MS Bold Italic
    "C:/Windows/Fonts/SIMYOU.TTF",       # 幼圆（圆润）
    "C:/Windows/Fonts/FZSTK.TTF",        # 方正舒体
    "C:/Windows/Fonts/msyhbd.ttc",       # 微软雅黑粗体
    "C:/Windows/Fonts/msyh.ttc",
    "C:/Windows/Fonts/simhei.ttf",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "/System/Library/Fonts/PingFang.ttc",
]

TILT = [-9, 7, -6, 10, -4, 8]    # 每个字的旋转角度（度），循环使用
BOUNCE = [0.0, -0.055, 0.03, -0.045, 0.015, -0.03]   # 每个字的上下偏移（相对图标尺寸）


def load_font(size):
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    return ImageFont.load_default()


def text_size(font, text):
    tmp = Image.new("RGBA", (8, 8))
    d = ImageDraw.Draw(tmp)
    box = d.textbbox((0, 0), text, font=font)
    return box[2] - box[0], box[3] - box[1], box


def fit_font(size, text):
    """让整串文字宽度不超过图标的 52%（旋转、描边后仍完整落在圆角内）"""
    max_w = size * 0.52
    f = int(size * 0.34)
    while f > 8:
        font = load_font(f)
        w, _, _ = text_size(font, text)
        if w <= max_w:
            return font
        f -= 2
    return load_font(max(f, 8))


def char_sticker(ch, font, stroke):
    """把单个字渲染成带深粉描边的白色贴纸（透明底小图）"""
    pad = stroke * 3 + 6
    w, h, box = text_size(font, ch)
    layer = Image.new("RGBA", (max(w, 1) + pad * 2, max(h, 1) + pad * 2), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.text((pad - box[0], pad - box[1]), ch, font=font, fill=WHITE,
           stroke_width=stroke, stroke_fill=PINK_DEEP)
    return layer


def draw_cute_text(base, size, text):
    font = fit_font(size, text)
    stroke = max(2, int(size * 0.017))

    stickers = []
    for i, ch in enumerate(text):
        s = char_sticker(ch, font, stroke)
        s = s.rotate(TILT[i % len(TILT)], resample=Image.BICUBIC, expand=True)
        stickers.append(s)

    gap = int(size * 0.006)
    total_w = sum(s.width for s in stickers) + gap * (len(stickers) - 1)
    # 逐字宽度里含 padding，整体再往中间收一点，避免看起来偏散
    x = int((size - total_w) / 2)
    cy = int(size * 0.5)

    for i, s in enumerate(stickers):
        dy = int(BOUNCE[i % len(BOUNCE)] * size)
        y = cy - s.height // 2 + dy
        base.alpha_composite(s, (x, y))
        x += s.width + gap


def draw_heart(base, cx, cy, r, color=WHITE):
    """用两个圆 + 一个三角拼出小爱心"""
    layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.ellipse([cx - r, cy - r * 0.85, cx, cy + r * 0.15], fill=color)
    d.ellipse([cx, cy - r * 0.85, cx + r, cy + r * 0.15], fill=color)
    d.polygon([(cx - r * 0.96, cy - r * 0.12), (cx + r * 0.96, cy - r * 0.12), (cx, cy + r * 1.05)],
              fill=color)
    base.alpha_composite(layer)


def draw_sparkle(base, cx, cy, r, color=(255, 255, 255, 205)):
    layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.polygon([(cx, cy - r), (cx + r * 0.3, cy - r * 0.3), (cx + r, cy),
               (cx + r * 0.3, cy + r * 0.3), (cx, cy + r), (cx - r * 0.3, cy + r * 0.3),
               (cx - r, cy), (cx - r * 0.3, cy - r * 0.3)], fill=color)
    base.alpha_composite(layer)


def build_icon(size, full_bleed=False):
    """full_bleed=True 用于 maskable：整张铺满粉色，交给系统裁形状。
       full_bleed=False 用于普通图标：奶油底 + 粉色圆角方块，绝不留透明像素。"""
    base = Image.new("RGBA", (size, size), CREAM)
    d = ImageDraw.Draw(base)
    if full_bleed:
        d.rectangle([0, 0, size - 1, size - 1], fill=PINK)
        inset, radius = 0, 0
    else:
        inset = int(size * 0.035)
        radius = int(size * 0.24)
        d.rounded_rectangle([inset, inset, size - 1 - inset, size - 1 - inset],
                           radius=radius, fill=PINK)

    # 高光：左上角一层淡淡的白，让粉色不那么平
    gloss = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gd = ImageDraw.Draw(gloss)
    gd.ellipse([inset - size * 0.28, inset - size * 0.42, size * 0.72, size * 0.46],
               fill=(255, 255, 255, 26))
    base.alpha_composite(gloss)

    draw_cute_text(base, size, TEXT)

    # 小装饰：右上一颗爱心，左下 + 右下各一颗小星星
    draw_heart(base, size * 0.775, size * 0.245, size * 0.062)
    draw_sparkle(base, size * 0.215, size * 0.755, size * 0.042)
    draw_sparkle(base, size * 0.82, size * 0.71, size * 0.032)
    return base


def main():
    for size in (192, 512):
        img = build_icon(size, full_bleed=False)
        # 先合到奶油底上再转 RGB，确保没有任何透明像素被压成黑色
        flat = Image.new("RGB", (size, size), CREAM[:3])
        flat.paste(img, (0, 0), img)
        flat.save(os.path.join(OUT, "icon-%d.png" % size))
        print("生成 icon-%d.png" % size)

    img = build_icon(512, full_bleed=True)
    flat = Image.new("RGB", (512, 512), PINK[:3])
    flat.paste(img, (0, 0), img)
    flat.save(os.path.join(OUT, "icon-512-maskable.png"))
    print("生成 icon-512-maskable.png")


if __name__ == "__main__":
    main()

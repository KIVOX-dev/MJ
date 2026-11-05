"""Builds every app/notification icon from ONE source image (a square PNG, ideally 1024px+ on a white or transparent background).

    python scripts/make_icons.py public/brand/icon-source.png

Outputs (into public/):
  icon-192.png, icon-512.png            install / notification icon (artwork on white, rounded)
  icon-maskable-512.png                 Android adaptive icon (extra padding so nothing is cropped)
  apple-touch-icon.png                  iPhone home screen (180px, opaque)
  favicon-32.png                        browser tab
  logo.png                              in-app header logo (transparent corners)
  badge-96.png                          Android status-bar badge: white silhouette on transparent
"""
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

src = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('public/brand/icon-source.png')
out = Path('public')
img = Image.open(src).convert('RGBA')


def on_white(im):
    bg = Image.new('RGBA', im.size, (255, 255, 255, 255))
    bg.alpha_composite(im)
    rgb = bg.convert('RGB')
    # JPEG noise leaves a faint off-white box around the artwork: snap near-white to pure white (and soften the edge into it).
    r, g, b = rgb.split()
    lightest = ImageChops.darker(ImageChops.darker(r, g), b)  # per-pixel minimum of the channels
    keep = lightest.point(lambda v: 0 if v >= 238 else (255 if v <= 205 else int((238 - v) * 255 / 33)))
    return Image.composite(rgb, Image.new('RGB', rgb.size, (255, 255, 255)), keep)


def square_art(im, pad):
    """Crops to the artwork, centres it on a white square with `pad` fraction of padding on each side."""
    flat = on_white(im)
    inv = ImageChops.invert(flat.convert('L')).point(lambda v: 255 if v > 18 else 0)
    box = inv.getbbox() or (0, 0, *flat.size)
    art = flat.crop(box)
    side = max(art.size)
    canvas_side = int(side / (1 - 2 * pad))
    canvas = Image.new('RGB', (canvas_side, canvas_side), (255, 255, 255))
    canvas.paste(art, ((canvas_side - art.width) // 2, (canvas_side - art.height) // 2))
    return canvas


def rounded(im, radius_frac=0.22, transparent_corners=True):
    im = im.convert('RGBA')
    mask = Image.new('L', im.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, *im.size), radius=int(im.width * radius_frac), fill=255)
    if transparent_corners:
        im.putalpha(mask)
    return im


def save(im, name, size):
    im.resize((size, size), Image.LANCZOS).save(out / name, optimize=True)
    print('wrote', name)


art = square_art(img, 0.07)  # tighter margin: the brain fills more of the icon
save(art.convert('RGB'), 'apple-touch-icon.png', 180)
save(rounded(art), 'icon-192.png', 192)
save(rounded(art), 'icon-512.png', 512)
save(rounded(art), 'logo.png', 160)
save(art.resize((32, 32), Image.LANCZOS).convert('RGB'), 'favicon-32.png', 32)
save(square_art(img, 0.15), 'icon-maskable-512.png', 512)  # opaque; Android crops this to a circle, so keep the art just inside the safe zone

# Status-bar badge: Android only uses the alpha channel, so make the artwork opaque white on transparent.
flat = square_art(img, 0.08).resize((192, 192), Image.LANCZOS).convert('L')
alpha = ImageChops.invert(flat).point(lambda v: 0 if v < 24 else min(255, int(v * 1.6)))
badge = Image.new('RGBA', flat.size, (255, 255, 255, 0))
badge.putalpha(alpha)
badge.resize((96, 96), Image.LANCZOS).save(out / 'badge-96.png', optimize=True)
print('wrote badge-96.png')

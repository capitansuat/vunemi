"""Prepares the site's images from the reviewed app screenshots.

Run from the repository root: python3 website/src/images.py
Sources are website/assets/screenshots (sample data only); output goes to
website/public. Screenshots are scaled to 1600 px wide; the hero is a
crop of the plan card; og.png is a 1200x630 link-preview image with no text.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

site = Path(__file__).resolve().parents[1]
src = site / "assets/screenshots"
out = site / "public"
app = site.parent
shots = ["01-home", "02-permissions", "03-connections", "05-vault",
         "06-scheduled-tasks", "07-model", "08-browser", "09-plan-card",
         "10-mention"]

(out / "screenshots").mkdir(parents=True, exist_ok=True)
for name in shots:
    im = Image.open(src / f"{name}.png").convert("RGB")
    im = im.resize((1600, round(im.height * 1600 / im.width)), Image.LANCZOS)
    im.save(out / "screenshots" / f"{name}.png", optimize=True)

# Hero: the chat column of the plan-card screen, readable at hero size.
plan = Image.open(src / "09-plan-card.png").convert("RGB")
hero = plan.crop((122, 0, 1382, 845))
hero.save(out / "screenshots/hero-plan.png", optimize=True)

# Link preview: warm background, the app icon and the hero crop on a card.
W, H = 1200, 630
og = Image.new("RGB", (W, H), "#f7f3ec")
glow = Image.new("RGB", (W, H), "#ffe2cb")
mask = Image.new("L", (W, H), 0)
ImageDraw.Draw(mask).ellipse((650, -260, 1450, 480), fill=255)
og.paste(glow, (0, 0), mask.filter(ImageFilter.GaussianBlur(120)))
icon = Image.open(app / "apps/desktop/build/icon.png").convert("RGBA").resize((300, 300), Image.LANCZOS)
og.paste(icon, (95, 165), icon)
card_w = 640
card = hero.resize((card_w, round(hero.height * card_w / hero.width)), Image.LANCZOS)
x, y = 470, 80
shadow = Image.new("L", (W, H), 0)
ImageDraw.Draw(shadow).rounded_rectangle((x + 6, y + 18, x + card_w + 6, y + card.height + 18), 28, fill=70)
og.paste(Image.new("RGB", (W, H), "#8a6a55"), (0, 0), shadow.filter(ImageFilter.GaussianBlur(22)))
frame = Image.new("L", card.size, 0)
ImageDraw.Draw(frame).rounded_rectangle((0, 0, card.width, card.height), 22, fill=255)
og.paste(card, (x, y), frame)
og.save(out / "og.png", optimize=True)
print("images written")

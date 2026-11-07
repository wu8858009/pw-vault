"""產生 PWA 圖示與 exe 的 app.ico（鎖頭 + 鑰匙孔）。"""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).parent
OUT = ROOT / "web" / "icons"


def draw(size: int) -> Image.Image:
    s = 1024
    im = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((0, 0, s - 1, s - 1), radius=220, fill=(31, 58, 95, 255))
    # 鎖環
    d.rounded_rectangle((300, 170, 724, 620), radius=212, outline=(226, 234, 245, 255), width=78)
    # 鎖身
    d.rounded_rectangle((210, 440, 814, 880), radius=70, fill=(245, 190, 60, 255))
    # 鑰匙孔
    d.ellipse((452, 560, 572, 680), fill=(31, 58, 95, 255))
    d.polygon([(482, 650), (542, 650), (562, 790), (462, 790)], fill=(31, 58, 95, 255))
    return im.resize((size, size), Image.LANCZOS)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for n in (180, 192, 512):
        draw(n).save(OUT / f"icon-{n}.png")
    draw(256).save(ROOT / "desktop" / "app.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    ext = ROOT / "extension" / "icons"
    ext.mkdir(parents=True, exist_ok=True)
    for n in (16, 32, 48, 128):
        draw(n).save(ext / f"{n}.png")
    print("icons ok")


if __name__ == "__main__":
    main()

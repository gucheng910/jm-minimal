#!/usr/bin/env python3
"""把一张源图渲染成 iOS AppIcon 需要的全套 PNG。

为什么不用 macOS 自带的 sips：sips 对 **任何** PNG 都拒绝 `--setProperty hasAlpha`，
报 `Error: Cannot do --setProperty hasAlpha on file` / Error 13（hasAlpha 对 PNG 是只读属性），
实测 CI 上先后试过 `-s hasAlpha no` 与 `--padColor FFFFFF` 组合，两次都被挡回来。
另外"PNG → JPEG → PNG 中转"虽然 sips 会报成功，但产出的 PNG 仍然是 hasAlpha=yes
（通道没真的丢掉）—— 看起来成功、实际没做到，比直接报错更危险。

Pillow 能一次把事情做对：显式 `convert("RGB")` 会真正去掉 alpha 通道，
再按目标尺寸高质量缩放。每张落地后重新打开自检 mode==RGB，不满足直接非零退出。

⚠ Contents.json 的 scale 有讲究（两个方向都踩过）：
  · "2"（字符串无后缀）→ actool: warning: Unknown scale value "2"，条目不生效
  · 2  （数字）        → actool: error: invalid content for the "scale" key ... should be a string（归档失败）
  · "2x"（字符串带 x） → 正确，Capacitor 模板自己也是这么写的

用法（在仓库根跑）：
    python3 tools/gen-ios-icons.py ios/App/App/Assets.xcassets/AppIcon.appiconset build/icon.png
"""
import json
import os
import sys

from PIL import Image

# (idiom, point 尺寸, scale) —— 与 Xcode 要求的 iOS AppIcon 全集一致
ENTRIES = [
    ("iphone", 20, 2), ("iphone", 20, 3),
    ("iphone", 29, 2), ("iphone", 29, 3),
    ("iphone", 38, 2), ("iphone", 38, 3),
    ("iphone", 40, 2), ("iphone", 40, 3),
    ("iphone", 60, 2), ("iphone", 60, 3),
    ("iphone", 64, 2), ("iphone", 64, 3),
    ("iphone", 68, 2),
    ("ipad", 20, 1), ("ipad", 20, 2),
    ("ipad", 29, 1), ("ipad", 29, 2),
    ("ipad", 40, 1), ("ipad", 40, 2),
    ("ipad", 76, 1), ("ipad", 76, 2),
    ("ipad", 83.5, 2),
    ("ios-marketing", 1024, 1),
]


def size_str(pt):
    """20 -> '20x20'；83.5 -> '83.5x83.5'（不能出现 83.50）"""
    s = ("%g" % pt)
    return s + "x" + s


def main():
    if len(sys.argv) < 3:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    out_dir, src = sys.argv[1], sys.argv[2]
    if not os.path.isfile(src):
        print("✗ 素材不存在：%s" % src, file=sys.stderr)
        return 1

    orig = Image.open(src)
    print("素材 %s  %sx%s  模式 %s" % (src, orig.width, orig.height, orig.mode))
    if orig.width != orig.height:
        print("✗ 素材必须是正方形（当前 %dx%d）" % (orig.width, orig.height), file=sys.stderr)
        return 1
    if orig.width < 1024:
        print("⚠ 素材只有 %dpx，1024 那一档是**升采样**得来的 —— 不糊就行，别指望更清晰。" % orig.width)

    os.makedirs(out_dir, exist_ok=True)

    images = []
    for idiom, pt, scale in ENTRIES:
        px = int(round(pt * scale))
        name = "icon-%s@%dx.png" % (str(pt).replace(".", "_"), scale) if px != 1024 else "icon-1024.png"
        dest = os.path.join(out_dir, name)
        # ★ 关键两步：① 有 alpha 就先按白底合成（避免透明区变黑）；
        #           ② convert("RGB") 把 alpha 通道彻底去掉（iOS 图标不接受透明）
        frame = orig
        if frame.mode in ("RGBA", "LA", "P"):
            frame = frame.convert("RGBA")
            bg = Image.new("RGBA", frame.size, (255, 255, 255, 255))
            frame = Image.alpha_composite(bg, frame)
        frame = frame.convert("RGB")
        frame = frame.resize((px, px), Image.LANCZOS)
        frame.save(dest, format="PNG", optimize=True)

        # 自检：重新打开确认没有 alpha 通道
        with Image.open(dest) as check:
            if check.mode != "RGB" or check.size != (px, px):
                print("✗ %s 自检失败：mode=%s size=%s（期望 RGB %dx%d）" % (name, check.mode, check.size, px, px), file=sys.stderr)
                return 1
        images.append({
            "filename": name,
            "idiom": idiom,
            # ⚠ scale 必须是**字符串**且**带 x 后缀**（"2x"）。这里踩过两个坑：
            #   `"2"`（无后缀）→ actool 报 `warning: Unknown scale value "2"`，且该条目不生效；
            #   `2`（数字）  → actool 报 `error: ... invalid content for the "scale" key.
            #                  The content should be a string.` 并让归档直接失败（exit 65）。
            # Capacitor 模板自带的 Contents.json 用的就是 "2x"，以此为准。
            "scale": "%gx" % scale,
            "size": size_str(pt),
        })
        print("  ✓ %-26s %dx%d  RGB" % (name, px, px))

    with open(os.path.join(out_dir, "Contents.json"), "w", encoding="utf-8") as f:
        json.dump({"images": images, "info": {"author": "xcode", "version": 1}}, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print("\n✓ AppIcon 资源集已生成：%s（%d 张，全部 RGB 无 alpha）" % (out_dir, len(images)))
    return 0


if __name__ == "__main__":
    sys.exit(main())

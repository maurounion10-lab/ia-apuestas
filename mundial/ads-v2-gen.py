"""
Ads v2 Editorial Pro - 1080x1920
Look ESPN/MARCA: foto duotone arriba, texto editorial abajo, paleta sobria.
"""
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageEnhance

# --- Setup ---
ROOT = "/tmp/gambeta-work/mundial"
FONTS = "/tmp/gambeta-work/fonts-ads"
IMG = f"{ROOT}/img"
OUT = f"{ROOT}/ads"
os.makedirs(OUT, exist_ok=True)

W, H = 1080, 1920

# Paleta Editorial Pro
BLACK = (10, 10, 15)
DARK = (15, 15, 22)
GOLD = (212, 175, 55)
GOLD_BRIGHT = (245, 205, 71)
WHITE = (255, 255, 255)
WHITE_DIM = (255, 255, 255, 180)
RED = (200, 16, 46)
GREEN_DEEP = (8, 60, 35)
CARD_BORDER = (255, 255, 255, 25)

# Fuentes
def font(size, weight="anton"):
    if weight == "anton":
        return ImageFont.truetype(f"{FONTS}/Anton-Regular.ttf", size)
    if weight == "oswald":
        return ImageFont.truetype(f"{FONTS}/Oswald-Bold.ttf", size)
    if weight == "inter":
        return ImageFont.truetype(f"{FONTS}/Inter-Bold.ttf", size)
    return ImageFont.truetype(f"{FONTS}/Anton-Regular.ttf", size)

def font_inter(size):
    return ImageFont.truetype("/usr/share/fonts/truetype/google-fonts/Poppins-Bold.ttf", size)

def font_poppins(size, weight="bold"):
    files = {
        "regular": "Poppins-Regular.ttf",
        "medium": "Poppins-Medium.ttf",
        "bold": "Poppins-Bold.ttf",
    }
    return ImageFont.truetype(f"/usr/share/fonts/truetype/google-fonts/{files.get(weight, files['bold'])}", size)


def measure(text, fnt):
    bbox = fnt.getbbox(text)
    return bbox[2] - bbox[0], bbox[3] - bbox[1]


def open_photo(name, size, crop_focus="center"):
    """Carga foto, recorta al tamaño objetivo manteniendo aspecto."""
    p = f"{IMG}/{name}"
    im = Image.open(p).convert("RGB")
    tw, th = size
    ow, oh = im.size
    # fit cover
    rs = max(tw / ow, th / oh)
    nw, nh = int(ow * rs), int(oh * rs)
    im = im.resize((nw, nh), Image.LANCZOS)
    if crop_focus == "top":
        left = (nw - tw) // 2
        top = 0
    elif crop_focus == "face":
        left = (nw - tw) // 2
        top = int(nh * 0.05)
    else:
        left = (nw - tw) // 2
        top = (nh - th) // 2
    return im.crop((left, top, left + tw, top + th))


def apply_grading(im, gold_tint=False, darken=0.25, contrast=1.15):
    """Aplica color grading editorial: contraste + leve tint + vignette."""
    im = im.convert("RGB")
    # Contraste y brillo
    im = ImageEnhance.Contrast(im).enhance(contrast)
    im = ImageEnhance.Brightness(im).enhance(0.95)
    im = ImageEnhance.Color(im).enhance(0.92)
    # Tint dorado sutil
    if gold_tint:
        tint = Image.new("RGB", im.size, GOLD)
        im = Image.blend(im, tint, 0.04)
    # Oscurecer
    if darken > 0:
        overlay = Image.new("RGB", im.size, BLACK)
        im = Image.blend(im, overlay, darken)
    return im


def gradient_overlay(img, top_alpha=0, bot_alpha=255, color=BLACK):
    """Gradiente vertical desde transparente arriba hasta negro abajo."""
    w, h = img.size
    overlay = Image.new("RGBA", (1, h))
    for y in range(h):
        a = int(top_alpha + (bot_alpha - top_alpha) * (y / h))
        overlay.putpixel((0, y), color + (a,))
    overlay = overlay.resize((w, h))
    img.paste(overlay, (0, 0), overlay)
    return img


def draw_pill(draw, xy, text, fnt, bg, fg, padx=28, pady=14, border=None):
    tw, th = measure(text, fnt)
    x, y = xy
    box = (x, y, x + tw + padx * 2, y + th + pady * 2)
    if border:
        draw.rounded_rectangle(box, radius=(th + pady * 2) // 2, fill=bg, outline=border, width=2)
    else:
        draw.rounded_rectangle(box, radius=(th + pady * 2) // 2, fill=bg)
    bbox = fnt.getbbox(text)
    draw.text((x + padx - bbox[0], y + pady - bbox[1]), text, fill=fg, font=fnt)
    return box[2] - box[0], box[3] - box[1]


def draw_text_anchor(draw, xy, text, fnt, fill, anchor="lt"):
    """Wrapper draw.text con offset compensado por bbox."""
    bbox = fnt.getbbox(text)
    if anchor == "lt":
        draw.text((xy[0] - bbox[0], xy[1] - bbox[1]), text, fill=fill, font=fnt)
    elif anchor == "mm":
        tw = bbox[2] - bbox[0]
        th = bbox[3] - bbox[1]
        draw.text((xy[0] - bbox[0] - tw // 2, xy[1] - bbox[1] - th // 2), text, fill=fill, font=fnt)
    elif anchor == "mt":
        tw = bbox[2] - bbox[0]
        draw.text((xy[0] - bbox[0] - tw // 2, xy[1] - bbox[1]), text, fill=fill, font=fnt)


def draw_bolt(draw, x, y, h=40, color=None):
    """Dibuja un rayo (bolt) como poligono, altura h."""
    if color is None:
        color = GOLD_BRIGHT
    w = int(h * 0.55)
    pts = [
        (x + int(w * 0.55), y),
        (x, y + int(h * 0.55)),
        (x + int(w * 0.40), y + int(h * 0.55)),
        (x + int(w * 0.20), y + h),
        (x + w, y + int(h * 0.42)),
        (x + int(w * 0.55), y + int(h * 0.42)),
        (x + int(w * 0.80), y),
    ]
    draw.polygon(pts, fill=color)


def draw_brand(draw, position="top-right"):
    """Brand badge minimal: rayo dibujado + GAMBETA.AI"""
    fnt = font_poppins(34, "bold")
    text_main = "GAMBETA.AI"
    tw, th = measure(text_main, fnt)
    margin = 60
    bolt_h = 50
    bolt_w = int(bolt_h * 0.55)
    if position == "top-left":
        bx = margin
        by = margin
        draw_bolt(draw, bx, by, h=bolt_h)
        tx = bx + bolt_w + 18
        ty = by + 8
        draw.text((tx - fnt.getbbox(text_main)[0], ty - fnt.getbbox(text_main)[1]), text_main, fill=WHITE, font=fnt)
    elif position == "top-right":
        bx = W - margin - tw - bolt_w - 20
        by = margin
        draw_bolt(draw, bx, by, h=bolt_h)
        tx = bx + bolt_w + 18
        ty = by + 8
        draw.text((tx - fnt.getbbox(text_main)[0], ty - fnt.getbbox(text_main)[1]), text_main, fill=WHITE, font=fnt)


def draw_footer(draw, url="gambeta.ai/mundial"):
    fnt = font_poppins(26, "medium")
    tw, th = measure(url, fnt)
    draw.text((W // 2 - tw // 2 - fnt.getbbox(url)[0], H - 60), url, fill=(255, 255, 255, 160), font=fnt)


def draw_arrow(draw, x, y, h=30, color=None):
    """Dibuja una flecha pequena hacia la derecha, altura h."""
    if color is None:
        color = BLACK
    head = int(h * 0.55)
    # Linea horizontal
    draw.rectangle((x, y + h // 2 - h // 14, x + int(h * 0.95), y + h // 2 + h // 14), fill=color)
    # Cabeza
    pts = [
        (x + int(h * 0.85), y),
        (x + int(h * 0.85), y + h),
        (x + int(h * 1.30), y + h // 2),
    ]
    draw.polygon(pts, fill=color)


def draw_cta(draw, text, cta_y, fill=GOLD_BRIGHT, text_color=BLACK):
    # Quitar flecha unicode si la trae
    text = text.replace("→", "").rstrip()
    fnt = font_poppins(38, "bold")
    tw, th = measure(text, fnt)
    pad_x = 56
    pad_y = 30
    arrow_h = 36
    arrow_gap = 22
    box_w = tw + pad_x * 2 + int(arrow_h * 1.5) + arrow_gap
    x = (W - box_w) // 2
    box = (x, cta_y, x + box_w, cta_y + th + pad_y * 2)
    draw.rounded_rectangle(box, radius=22, fill=fill)
    bbox = fnt.getbbox(text)
    draw.text((x + pad_x - bbox[0], cta_y + pad_y - bbox[1]), text, fill=text_color, font=fnt)
    arrow_y = cta_y + pad_y + (th - arrow_h) // 2 + 2
    arrow_x = x + pad_x + tw + arrow_gap
    draw_arrow(draw, arrow_x, arrow_y, h=arrow_h, color=text_color)


def draw_eyebrow(draw, text, y, color=GOLD_BRIGHT):
    fnt = font_poppins(24, "bold")
    spaced = " ".join(list(text))
    tw, _ = measure(spaced, fnt)
    x = (W - tw) // 2
    draw_text_anchor(draw, (x, y), spaced, fnt, color, "lt")


def draw_big_title(draw, lines, y, fnt_size=130, color=WHITE, line_h_factor=0.95):
    fnt = font(fnt_size, "anton")
    for i, line in enumerate(lines):
        tw, th = measure(line, fnt)
        x = (W - tw) // 2
        ly = y + int(i * fnt_size * line_h_factor)
        draw_text_anchor(draw, (x, ly), line, fnt, color, "lt")


def draw_subtitle(draw, text, y, fnt_size=42, color=(255, 255, 255, 200), max_width=920):
    """Subtitle con wrap automático."""
    fnt = font_poppins(fnt_size, "medium")
    # Wrap simple por palabras
    words = text.split()
    lines = []
    cur = []
    for w in words:
        test = " ".join(cur + [w])
        tw, _ = measure(test, fnt)
        if tw > max_width and cur:
            lines.append(" ".join(cur))
            cur = [w]
        else:
            cur.append(w)
    if cur:
        lines.append(" ".join(cur))
    for i, line in enumerate(lines):
        tw, _ = measure(line, fnt)
        ly = y + i * (fnt_size + 10)
        draw_text_anchor(draw, ((W - tw) // 2, ly), line, fnt, color, "lt")
    return len(lines) * (fnt_size + 10)


# ============================================================
# AD GENERATOR
# ============================================================

def base_canvas():
    img = Image.new("RGB", (W, H), BLACK)
    return img


def render_with_photo(photo_name, title_lines, eyebrow, subtitle, cta, big_num=None,
                       gold_tint=False, photo_crop="face", subtitle_color=(255,255,255,210)):
    """Layout estándar Editorial: foto top 55% + texto bottom 45%."""
    img = base_canvas()
    PH_H = int(H * 0.62)

    photo = open_photo(photo_name, (W, PH_H), crop_focus=photo_crop)
    photo = apply_grading(photo, gold_tint=gold_tint, darken=0.18, contrast=1.18)

    img.paste(photo, (0, 0))

    # Gradiente del medio hacia abajo (fade a negro)
    fade = Image.new("RGBA", (W, PH_H), (0, 0, 0, 0))
    fade = gradient_overlay(fade, top_alpha=0, bot_alpha=255, color=BLACK)
    img.paste(fade, (0, 0), fade)

    # Top vignette suave para que el brand bagde se lea
    top_fade = Image.new("RGBA", (W, 240), (0, 0, 0, 0))
    fd = ImageDraw.Draw(top_fade)
    for y in range(240):
        a = int(180 * (1 - y / 240))
        fd.line([(0, y), (W, y)], fill=(0, 0, 0, a))
    img.paste(top_fade, (0, 0), top_fade)

    draw = ImageDraw.Draw(img, "RGBA")

    # Branding
    draw_brand(draw, "top-left")

    # Eyebrow
    draw_eyebrow(draw, eyebrow, 730)

    # Linea decorativa sobre titulo
    draw.line([(W // 2 - 60, 790), (W // 2 + 60, 790)], fill=GOLD_BRIGHT, width=4)

    # Big number opcional
    if big_num:
        fnt_num = font(280, "anton")
        tw, th = measure(big_num, fnt_num)
        x = (W - tw) // 2
        draw_text_anchor(draw, (x, 830), big_num, fnt_num, GOLD_BRIGHT, "lt")
        title_y = 1180
    else:
        title_y = 830

    # Titulo
    draw_big_title(draw, title_lines, title_y, fnt_size=100)

    # Subtitle
    sub_y = title_y + len(title_lines) * 100 + 30
    draw_subtitle(draw, subtitle, sub_y, fnt_size=36, color=subtitle_color)

    # CTA
    draw_cta(draw, cta, H - 280)

    # Footer URL
    draw_footer(draw)

    return img


def render_data_card(title, eyebrow, rows, cta, gold=True):
    """Layout 'Data': sin foto, cards minimalistas + bar chart."""
    img = base_canvas()
    draw = ImageDraw.Draw(img, "RGBA")

    # Fondo decoración sutil: gradient radial dorado en esquina
    if gold:
        for y in range(0, 900, 3):
            a = int(28 * (1 - y / 900))
            color = (GOLD_BRIGHT[0], GOLD_BRIGHT[1], GOLD_BRIGHT[2], a)
            draw.line([(W // 2 - 600, y), (W // 2 + 600, y)], fill=color)

    draw_brand(draw, "top-left")

    # Eyebrow
    draw_eyebrow(draw, eyebrow, 200)
    draw.line([(W // 2 - 50, 260), (W // 2 + 50, 260)], fill=GOLD_BRIGHT, width=4)

    # Titulo
    title_lines = title if isinstance(title, list) else [title]
    draw_big_title(draw, title_lines, 290, fnt_size=110)

    # Tabla de datos con barchart visual
    table_y = 290 + len(title_lines) * 110 + 80
    max_val = max(r[1] for r in rows)
    fnt_name = font_poppins(40, "bold")
    fnt_pct = font(60, "anton")
    fnt_rank = font(48, "anton")

    row_h = 130
    table_w = 920
    table_x = (W - table_w) // 2

    for i, (name, val, flag) in enumerate(rows):
        ry = table_y + i * row_h

        # Card background
        draw.rounded_rectangle(
            (table_x, ry, table_x + table_w, ry + row_h - 20),
            radius=18,
            fill=(255, 255, 255, 12),
            outline=(255, 255, 255, 30),
            width=1
        )

        # Rank pill
        rank = f"#{i+1}"
        rfnt = font(46, "anton")
        rw, rh = measure(rank, rfnt)
        rpad = 18
        rank_box = (table_x + 20, ry + 22, table_x + 20 + rw + rpad * 2, ry + 22 + rh + 14)
        draw.rounded_rectangle(rank_box, radius=14,
                               fill=GOLD_BRIGHT if i == 0 else (255, 255, 255, 30))
        bbox = rfnt.getbbox(rank)
        draw.text((table_x + 20 + rpad - bbox[0], ry + 22 + 7 - bbox[1]),
                  rank, fill=BLACK if i == 0 else WHITE, font=rfnt)

        # Nombre
        name_x = table_x + 20 + rw + rpad * 2 + 30
        draw_text_anchor(draw, (name_x, ry + 38), name, fnt_name, WHITE, "lt")

        # Bar de fondo (progress)
        bar_x = name_x
        bar_y = ry + row_h - 50
        bar_max_w = table_w - (bar_x - table_x) - 200
        bar_w = int(bar_max_w * (val / max_val))
        draw.rounded_rectangle((bar_x, bar_y, bar_x + bar_w, bar_y + 14),
                               radius=7, fill=GOLD_BRIGHT if i == 0 else (245, 205, 71, 130))

        # Valor
        val_str = f"{val}%"
        vw, vh = measure(val_str, fnt_pct)
        draw_text_anchor(draw, (table_x + table_w - vw - 25, ry + 30), val_str, fnt_pct,
                         GOLD_BRIGHT if i == 0 else WHITE, "lt")

    # CTA
    draw_cta(draw, cta, H - 280)

    draw_footer(draw)
    return img


def render_versus(team_a, val_a, team_b, val_b, eyebrow, title, cta):
    """Layout versus: cards verticales con banderas/equipos opuestos."""
    img = base_canvas()
    draw = ImageDraw.Draw(img, "RGBA")

    # Mitades de fondo: izq oro / der rojo
    half_h = H - 400
    for x in range(0, W // 2):
        a = int(80 * (1 - x / (W // 2)))
        draw.line([(x, 0), (x, half_h)], fill=(GOLD[0], GOLD[1], GOLD[2], a))
    for x in range(W // 2, W):
        a = int(80 * ((x - W // 2) / (W // 2)))
        draw.line([(x, 0), (x, half_h)], fill=(RED[0], RED[1], RED[2], a))

    draw_brand(draw, "top-left")

    # Eyebrow
    draw_eyebrow(draw, eyebrow, 220)
    draw.line([(W // 2 - 50, 280), (W // 2 + 50, 280)], fill=GOLD_BRIGHT, width=4)

    # Title
    title_lines = title if isinstance(title, list) else [title]
    draw_big_title(draw, title_lines, 310, fnt_size=90)

    # Fuentes mas chicas para evitar overlap definitivo
    fnt_team = font(100, "anton")
    fnt_pct = font(130, "anton")
    fnt_label = font_poppins(26, "bold")

    # Y-coords con separacion total
    Y_TEAM = 720
    Y_PCT = 1000    # +280 separacion clara
    Y_LABEL = 1200
    Y_VS = 870      # entre team (720) y pct (1000), perfectamente al medio
    cx = W // 2

    # Equipo A
    twA, thA = measure(team_a, fnt_team)
    draw_text_anchor(draw, (W // 4 - twA // 2, Y_TEAM), team_a, fnt_team, WHITE, "lt")
    pctA = f"{val_a}%"
    tpA, hpA = measure(pctA, fnt_pct)
    draw_text_anchor(draw, (W // 4 - tpA // 2, Y_PCT), pctA, fnt_pct, GOLD_BRIGHT, "lt")

    # VS pill (entre nombre y pct, en el centro de la imagen, no de la columna)
    vs_fnt = font(60, "anton")
    vs_text = "VS"
    vs_size = 75
    draw.ellipse((cx - vs_size, Y_VS - vs_size, cx + vs_size, Y_VS + vs_size),
                 fill=BLACK, outline=GOLD_BRIGHT, width=5)
    draw_text_anchor(draw, (cx, Y_VS), vs_text, vs_fnt, GOLD_BRIGHT, "mm")

    # Equipo B
    twB, thB = measure(team_b, fnt_team)
    draw_text_anchor(draw, (3 * W // 4 - twB // 2, Y_TEAM), team_b, fnt_team, WHITE, "lt")
    pctB = f"{val_b}%"
    tpB, hpB = measure(pctB, fnt_pct)
    draw_text_anchor(draw, (3 * W // 4 - tpB // 2, Y_PCT), pctB, fnt_pct, (255, 255, 255, 200), "lt")

    # Labels
    label_a = "según la IA"
    lwA, lhA = measure(label_a, fnt_label)
    draw_text_anchor(draw, (W // 4 - lwA // 2, Y_LABEL), label_a, fnt_label, (255, 255, 255, 160), "lt")
    label_b = "según la IA"
    lwB, lhB = measure(label_b, fnt_label)
    draw_text_anchor(draw, (3 * W // 4 - lwB // 2, Y_LABEL), label_b, fnt_label, (255, 255, 255, 160), "lt")

    # Insight de ventaja, mas abajo
    insight_fnt = font_poppins(32, "medium")
    diff = abs(val_a - val_b)
    if val_a > val_b:
        insight = f"+{diff:.1f}pts a favor de {team_a}"
    else:
        insight = f"+{diff:.1f}pts a favor de {team_b}"
    iw, ih = measure(insight, insight_fnt)
    draw_text_anchor(draw, ((W - iw) // 2, 1330), insight, insight_fnt, (255, 255, 255, 200), "lt")

    # CTA
    draw_cta(draw, cta, H - 280)
    draw_footer(draw)
    return img


# ============================================================
# CONFIGURACIÓN DE LAS 15 ADS
# ============================================================

ADS = []

# === PREDICCIONES (5) ===
ADS.append(("pred-1-bignumber",
            "render_with_photo",
            dict(photo_name="trofeo.jpg",
                 eyebrow="PREDICCIÓN IA",
                 big_num="18.2%",
                 title_lines=["ESPAÑA CAMPEONA"],
                 subtitle="La IA proyecta a España como favorita del Mundial 2026.",
                 cta="VER PREDICCIONES →",
                 gold_tint=True,
                 photo_crop="center")))

ADS.append(("pred-2-playerhero",
            "render_with_photo",
            dict(photo_name="mbappe.jpg",
                 eyebrow="ANÁLISIS IA",
                 title_lines=["FRANCIA SEGÚN", "EL MODELO"],
                 subtitle="16.5% de probabilidad de levantar el trofeo en NJ.",
                 cta="VER PROYECCIONES →",
                 gold_tint=False,
                 photo_crop="face")))

ADS.append(("pred-3-versus",
            "render_versus",
            dict(team_a="ESPAÑA", val_a=18.2, team_b="FRANCIA", val_b=16.5,
                 eyebrow="DUELO IA",
                 title=["EL FAVORITO", "DEL MUNDIAL"],
                 cta="VER TOP 5 →")))

ADS.append(("pred-4-data",
            "render_data_card",
            dict(title=["TOP 5", "AL TÍTULO"],
                 eyebrow="RANKING IA",
                 rows=[
                     ("España", 18.2, None),
                     ("Francia", 16.5, None),
                     ("Argentina", 12.4, None),
                     ("Inglaterra", 11.8, None),
                     ("Brasil", 10.1, None),
                 ],
                 cta="VER RANKING COMPLETO →")))

ADS.append(("pred-5-hottake",
            "render_with_photo",
            dict(photo_name="trofeo.jpg",
                 eyebrow="HOT TAKE IA",
                 title_lines=["UN CAMPEÓN", "INESPERADO"],
                 subtitle="El modelo IA detecta un favorito que nadie está mirando.",
                 cta="DESCUBRILO →",
                 gold_tint=True,
                 photo_crop="center")))

# === CALENDARIO (5) ===
ADS.append(("cal-1-bignumber",
            "render_with_photo",
            dict(photo_name="azteca.jpg",
                 eyebrow="CALENDARIO MUNDIAL",
                 big_num="104",
                 title_lines=["PARTIDOS"],
                 subtitle="Cada uno analizado por la IA desde la fase de grupos hasta la final.",
                 cta="VER CALENDARIO →",
                 gold_tint=False,
                 photo_crop="center")))

ADS.append(("cal-2-playerhero",
            "render_with_photo",
            dict(photo_name="bellingham.jpg",
                 eyebrow="DÍA A DÍA",
                 title_lines=["CADA PARTIDO,", "UNA LECTURA IA"],
                 subtitle="Probabilidades, favoritos y sorpresas previo a cada cruce.",
                 cta="VER PRÓXIMOS PARTIDOS →",
                 gold_tint=False,
                 photo_crop="face")))

ADS.append(("cal-3-versus",
            "render_versus",
            dict(team_a="MÉXICO", val_a=42.1, team_b="ARG", val_b=31.4,
                 eyebrow="APERTURA MUNDIAL",
                 title=["11 JUNIO", "AZTECA"],
                 cta="VER ANÁLISIS →")))

ADS.append(("cal-4-data",
            "render_data_card",
            dict(title=["PRIMERA", "SEMANA"],
                 eyebrow="JUN 11-17",
                 rows=[
                     ("México vs ARG", 42, None),
                     ("España vs CRO", 64, None),
                     ("FRA vs Australia", 58, None),
                     ("Inglaterra vs SUI", 47, None),
                     ("Brasil vs Camerún", 71, None),
                 ],
                 cta="VER CALENDARIO COMPLETO →")))

ADS.append(("cal-5-hottake",
            "render_with_photo",
            dict(photo_name="metlife.jpg",
                 eyebrow="HOT TAKE IA",
                 title_lines=["16 SORPRESAS", "EN GRUPOS"],
                 subtitle="El modelo señala los partidos donde el favorito puede caer.",
                 cta="VER SORPRESAS →",
                 gold_tint=False,
                 photo_crop="center")))

# === ESTADÍSTICAS (5) ===
ADS.append(("est-1-bignumber",
            "render_with_photo",
            dict(photo_name="trofeo.jpg",
                 eyebrow="RANKING IA",
                 big_num="48",
                 title_lines=["SELECCIONES"],
                 subtitle="Todas analizadas, todas rankeadas por probabilidad de éxito.",
                 cta="VER RANKING →",
                 gold_tint=True,
                 photo_crop="center")))

ADS.append(("est-2-playerhero",
            "render_with_photo",
            dict(photo_name="haaland.jpg",
                 eyebrow="TOP 8 IA",
                 title_lines=["NORUEGA", "ENTRA AL TOP"],
                 subtitle="Haaland y compañía sorprenden en la proyección IA del Mundial.",
                 cta="VER TOP 8 →",
                 gold_tint=False,
                 photo_crop="face")))

ADS.append(("est-3-versus",
            "render_versus",
            dict(team_a="ESPAÑA", val_a=18.2, team_b="BRA", val_b=10.1,
                 eyebrow="TOP IA",
                 title=["RANKING DE", "LOS GRANDES"],
                 cta="VER TOP COMPLETO →")))

ADS.append(("est-4-data",
            "render_data_card",
            dict(title=["TOP 5", "SEGÚN IA"],
                 eyebrow="PROYECCIÓN MUNDIAL",
                 rows=[
                     ("España", 18.2, None),
                     ("Francia", 16.5, None),
                     ("Argentina", 12.4, None),
                     ("Inglaterra", 11.8, None),
                     ("Brasil", 10.1, None),
                 ],
                 cta="VER LAS 48 →")))

ADS.append(("est-5-hottake",
            "render_with_photo",
            dict(photo_name="mbappe.jpg",
                 eyebrow="DARK HORSE",
                 title_lines=["EL 9° FAVORITO", "QUE NADIE VE"],
                 subtitle="Una selección con 7.8% de chance que el resto está subestimando.",
                 cta="DESCUBRILO →",
                 gold_tint=False,
                 photo_crop="face")))


# ============================================================
# EXECUTE
# ============================================================

import sys

renderers = {
    "render_with_photo": render_with_photo,
    "render_data_card": render_data_card,
    "render_versus": render_versus,
}

count = 0
for name, kind, args in ADS:
    try:
        fn = renderers[kind]
        img = fn(**args)
        out_path = f"{OUT}/{name}.jpg"
        img.save(out_path, "JPEG", quality=88, optimize=True)
        count += 1
        print(f"OK {name}: {os.path.getsize(out_path)//1024}KB")
    except Exception as e:
        print(f"FAIL {name}: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()

print(f"\nGenerado {count}/15 ads v2 Editorial Pro")

"""
Ads v4 BILLBOARD - 1080x1920
Layout fundamentalmente distinto:
- Foto top 55%, sin texto encima
- Panel solido bottom 45% con TODO el contenido
- Hooks irresistibles con curiosity gap
- Cero espacios negros, cero superposicion con caras
"""
import os
from PIL import Image, ImageDraw, ImageFont, ImageEnhance

ROOT = "/tmp/gambeta-work/mundial"
FONTS = "/tmp/gambeta-work/fonts-ads"
POPPINS = "/usr/share/fonts/truetype/google-fonts"
IMG = f"{ROOT}/img"
OUT = f"{ROOT}/ads"
os.makedirs(OUT, exist_ok=True)

W, H = 1080, 1920

# Paleta
BLACK = (10, 10, 15)
DARK_PANEL = (12, 12, 18)   # Panel inferior
GOLD = (212, 175, 55)
GOLD_BRIGHT = (245, 205, 71)
WHITE = (255, 255, 255)
RED = (200, 16, 46)

# Zonas
PHOTO_H = 1060               # Foto ocupa 1060px de 1920 = 55%
PANEL_Y = PHOTO_H            # Panel empieza donde termina foto
PANEL_H = H - PANEL_Y        # 860px de panel solido

def font_anton(size):
    return ImageFont.truetype(f"{FONTS}/Anton-Regular.ttf", size)

def font_poppins(size, weight="bold"):
    files = {
        "regular": "Poppins-Regular.ttf",
        "medium": "Poppins-Medium.ttf",
        "bold": "Poppins-Bold.ttf",
    }
    return ImageFont.truetype(f"{POPPINS}/{files.get(weight, files['bold'])}", size)

def measure(text, fnt):
    bbox = fnt.getbbox(text)
    return bbox[2] - bbox[0], bbox[3] - bbox[1]

def draw_lt(draw, xy, text, fnt, fill):
    bbox = fnt.getbbox(text)
    draw.text((xy[0] - bbox[0], xy[1] - bbox[1]), text, fill=fill, font=fnt)

def draw_mm(draw, xy, text, fnt, fill):
    bbox = fnt.getbbox(text)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    draw.text((xy[0] - bbox[0] - tw // 2, xy[1] - bbox[1] - th // 2), text, fill=fill, font=fnt)

def open_photo(name, size, crop_focus="face"):
    p = f"{IMG}/{name}"
    im = Image.open(p).convert("RGB")
    tw, th = size
    ow, oh = im.size
    rs = max(tw / ow, th / oh)
    nw, nh = int(ow * rs), int(oh * rs)
    im = im.resize((nw, nh), Image.LANCZOS)
    if crop_focus == "top":
        left = (nw - tw) // 2
        top = 0
    elif crop_focus == "face":
        left = (nw - tw) // 2
        # Bias hacia arriba para mostrar la cara, no el torso
        top = int(nh * 0.05)
    else:
        left = (nw - tw) // 2
        top = (nh - th) // 2
    return im.crop((left, top, left + tw, top + th))

def grade_photo(im, contrast=1.15, darken=0.10):
    im = ImageEnhance.Contrast(im).enhance(contrast)
    im = ImageEnhance.Brightness(im).enhance(0.95)
    im = ImageEnhance.Color(im).enhance(0.95)
    if darken > 0:
        overlay = Image.new("RGB", im.size, BLACK)
        im = Image.blend(im, overlay, darken)
    return im

def draw_bolt(draw, x, y, h=46, color=None):
    if color is None: color = GOLD_BRIGHT
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

def draw_arrow(draw, x, y, h=30, color=BLACK):
    head = int(h * 0.55)
    draw.rectangle((x, y + h // 2 - h // 14, x + int(h * 0.95), y + h // 2 + h // 14), fill=color)
    pts = [
        (x + int(h * 0.85), y),
        (x + int(h * 0.85), y + h),
        (x + int(h * 1.30), y + h // 2),
    ]
    draw.polygon(pts, fill=color)

def draw_brand_top(draw):
    """Brand en esquina superior izquierda."""
    fnt = font_poppins(34, "bold")
    text = "GAMBETA.AI"
    margin_left = 60
    y = 56
    bolt_h = 50
    bolt_w = int(bolt_h * 0.55)
    draw_bolt(draw, margin_left, y, h=bolt_h)
    bbox = fnt.getbbox(text)
    draw.text((margin_left + bolt_w + 18 - bbox[0], y + 8 - bbox[1]), text, fill=WHITE, font=fnt)

def draw_url_footer(draw):
    """URL en el bottom del panel."""
    fnt = font_poppins(28, "medium")
    url = "gambeta.ai/mundial"
    tw, th = measure(url, fnt)
    bbox = fnt.getbbox(url)
    draw.text(((W - tw) // 2 - bbox[0], H - 70 - bbox[1]), url, fill=(255, 255, 255, 170), font=fnt)

def wrap_text(text, fnt, max_w):
    """Split text into lines that fit max_w."""
    words = text.split()
    lines = []
    cur = []
    for w in words:
        test = " ".join(cur + [w])
        tw, _ = measure(test, fnt)
        if tw > max_w and cur:
            lines.append(" ".join(cur))
            cur = [w]
        else:
            cur.append(w)
    if cur:
        lines.append(" ".join(cur))
    return lines

def draw_cta_button(draw, text, cta_y, fill=GOLD_BRIGHT, text_color=BLACK):
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
    return cta_y + th + pad_y * 2

# ============================================================
# BILLBOARD RENDERER
# ============================================================

def render_billboard(photo_name, hook, subtitle, cta, eyebrow="ACCESO GRATIS · 2 IAS",
                     big_num=None, photo_crop="face", panel_color=DARK_PANEL):
    """
    Layout BILLBOARD:
    - Top 55% (1060px): foto pura, sin texto encima
    - Bottom 45% (860px): panel solido con eyebrow + hook + (big_num) + subtitle + CTA + URL
    """
    img = Image.new("RGB", (W, H), BLACK)

    # === FOTO ===
    photo = open_photo(photo_name, (W, PHOTO_H), crop_focus=photo_crop)
    photo = grade_photo(photo, contrast=1.18, darken=0.10)
    img.paste(photo, (0, 0))

    # Gradient suave SOLO en el bottom 15% de la foto, para transicion limpia al panel
    fade_h = 240
    fade = Image.new("RGBA", (W, fade_h), (0, 0, 0, 0))
    fd = ImageDraw.Draw(fade)
    for y in range(fade_h):
        a = int(255 * (y / fade_h))
        fd.line([(0, y), (W, y)], fill=panel_color + (a,))
    img.paste(fade, (0, PHOTO_H - fade_h), fade)

    # === PANEL INFERIOR SOLIDO ===
    draw = ImageDraw.Draw(img, "RGBA")
    draw.rectangle((0, PANEL_Y, W, H), fill=panel_color)

    # Brand en top
    draw_brand_top(draw)

    # === CONTENIDO DEL PANEL — MINIMAL ===
    cursor_y = PANEL_Y + 60

    # Big number (opcional, gigante)
    if big_num:
        num_fnt = font_anton(220)
        nw, nh = measure(big_num, num_fnt)
        draw_lt(draw, ((W - nw) // 2, cursor_y), big_num, num_fnt, GOLD_BRIGHT)
        cursor_y += nh + 20

    # Hook GIGANTE (sin eyebrow, sin subtitle)
    hook_fnt = font_anton(110)
    hook_lines = wrap_text(hook, hook_fnt, max_w=960)
    if len(hook_lines) > 3:
        hook_fnt = font_anton(88)
        hook_lines = wrap_text(hook, hook_fnt, max_w=960)
    line_h = int(hook_fnt.size * 1.05)
    for i, line in enumerate(hook_lines):
        lw, lh = measure(line, hook_fnt)
        draw_lt(draw, ((W - lw) // 2, cursor_y + i * line_h), line, hook_fnt, WHITE)
    cursor_y += len(hook_lines) * line_h + 70

    # CTA
    cta_y = min(cursor_y, H - 220)
    draw_cta_button(draw, cta, cta_y)

    draw_url_footer(draw)
    return img


def render_billboard_data(rows, hook, eyebrow, cta, big_num=None):
    """Variante data card: ranking visual en lugar de foto."""
    img = Image.new("RGB", (W, H), BLACK)

    # Top dark con decoracion sutil
    draw = ImageDraw.Draw(img, "RGBA")
    # Gradient sutil dorado al top
    for y in range(0, 600, 2):
        a = int(20 * (1 - y / 600))
        draw.line([(0, y), (W, y)], fill=(GOLD[0], GOLD[1], GOLD[2], a))

    draw_brand_top(draw)

    cursor_y = 220

    # Hook GIGANTE (sin eyebrow)
    hook_fnt = font_anton(100)
    hook_lines = wrap_text(hook, hook_fnt, max_w=960)
    if len(hook_lines) > 2:
        hook_fnt = font_anton(76)
        hook_lines = wrap_text(hook, hook_fnt, max_w=960)
    line_h = int(hook_fnt.size * 1.05)
    for i, line in enumerate(hook_lines):
        lw, lh = measure(line, hook_fnt)
        draw_lt(draw, ((W - lw) // 2, cursor_y + i * line_h), line, hook_fnt, WHITE)
    cursor_y += len(hook_lines) * line_h + 60

    # Tabla
    table_x = 80
    table_w = W - 160
    row_h = 175
    max_val = max(r[1] for r in rows)

    fnt_name = font_poppins(46, "bold")
    fnt_pct = font_anton(70)
    rfnt = font_anton(46)

    for i, (name, val, _) in enumerate(rows):
        ry = cursor_y + i * row_h
        draw.rounded_rectangle(
            (table_x, ry, table_x + table_w, ry + row_h - 20),
            radius=18,
            fill=(255, 255, 255, 12),
            outline=(255, 255, 255, 28),
            width=1
        )
        # Rank pill
        rank = f"#{i+1}"
        rw, rh = measure(rank, rfnt)
        rpad = 22
        rank_box = (table_x + 24, ry + 38, table_x + 24 + rw + rpad * 2, ry + 38 + rh + 18)
        draw.rounded_rectangle(rank_box, radius=14,
                               fill=GOLD_BRIGHT if i == 0 else (255, 255, 255, 30))
        bbox = rfnt.getbbox(rank)
        draw.text((table_x + 24 + rpad - bbox[0], ry + 38 + 9 - bbox[1]),
                  rank, fill=BLACK if i == 0 else WHITE, font=rfnt)

        name_x = table_x + 24 + rw + rpad * 2 + 34
        draw_lt(draw, (name_x, ry + 52), name, fnt_name, WHITE)

        bar_x = name_x
        bar_y = ry + row_h - 62
        bar_max_w = table_w - (bar_x - table_x) - 240
        bar_w = int(bar_max_w * (val / max_val))
        draw.rounded_rectangle((bar_x, bar_y, bar_x + bar_w, bar_y + 16),
                               radius=8, fill=GOLD_BRIGHT if i == 0 else (245, 205, 71, 130))

        val_str = f"{val}%"
        vw, vh = measure(val_str, fnt_pct)
        draw_lt(draw, (table_x + table_w - vw - 30, ry + 44), val_str, fnt_pct,
                GOLD_BRIGHT if i == 0 else WHITE)

    cursor_y = cursor_y + len(rows) * row_h + 60
    cta_y = min(cursor_y, H - 220)
    draw_cta_button(draw, cta, cta_y)
    draw_url_footer(draw)
    return img


def render_billboard_versus(team_a, val_a, team_b, val_b, hook, eyebrow, cta, insight=None, photo_name="trofeo.jpg"):
    """VS en layout BILLBOARD: foto top 55%, VS en panel bottom 45%."""
    img = Image.new("RGB", (W, H), BLACK)

    # FOTO top
    photo = open_photo(photo_name, (W, PHOTO_H), crop_focus="center")
    photo = grade_photo(photo, contrast=1.2, darken=0.18)
    img.paste(photo, (0, 0))

    # Gradient transicion al panel
    fade_h = 240
    fade = Image.new("RGBA", (W, fade_h), (0, 0, 0, 0))
    fd = ImageDraw.Draw(fade)
    for y in range(fade_h):
        a = int(255 * (y / fade_h))
        fd.line([(0, y), (W, y)], fill=DARK_PANEL + (a,))
    img.paste(fade, (0, PHOTO_H - fade_h), fade)

    # PANEL bottom con dos columnas tinted
    draw = ImageDraw.Draw(img, "RGBA")
    # Panel base
    draw.rectangle((0, PANEL_Y, W, H), fill=DARK_PANEL)
    # Tint dividido
    draw.rectangle((0, PANEL_Y, W // 2, H), fill=(GOLD[0], GOLD[1], GOLD[2], 18))
    draw.rectangle((W // 2, PANEL_Y, W, H), fill=(RED[0], RED[1], RED[2], 18))

    draw_brand_top(draw)

    cursor_y = PANEL_Y + 50

    # Hook (1 linea)
    hook_fnt = font_anton(56)
    hook_lines = wrap_text(hook, hook_fnt, max_w=980)
    for i, line in enumerate(hook_lines):
        lw, _ = measure(line, hook_fnt)
        draw_lt(draw, ((W - lw) // 2, cursor_y + i * 60), line, hook_fnt, WHITE)
    cursor_y += len(hook_lines) * 60 + 30

    # VS layout
    fnt_team = font_anton(80)
    fnt_pct = font_anton(105)
    fnt_label = font_poppins(22, "bold")

    Y_TEAM = cursor_y
    Y_PCT = Y_TEAM + 100
    Y_LABEL = Y_PCT + 130
    Y_VS = Y_TEAM + 60
    cx = W // 2

    twA, _ = measure(team_a, fnt_team)
    draw_lt(draw, (W // 4 - twA // 2, Y_TEAM), team_a, fnt_team, WHITE)
    pctA = f"{val_a}%"
    tpA, _ = measure(pctA, fnt_pct)
    draw_lt(draw, (W // 4 - tpA // 2, Y_PCT), pctA, fnt_pct, GOLD_BRIGHT)

    vs_fnt = font_anton(50)
    vs_size = 60
    draw.ellipse((cx - vs_size, Y_VS - vs_size, cx + vs_size, Y_VS + vs_size),
                 fill=DARK_PANEL, outline=GOLD_BRIGHT, width=4)
    draw_mm(draw, (cx, Y_VS), "VS", vs_fnt, GOLD_BRIGHT)

    twB, _ = measure(team_b, fnt_team)
    draw_lt(draw, (3 * W // 4 - twB // 2, Y_TEAM), team_b, fnt_team, WHITE)
    pctB = f"{val_b}%"
    tpB, _ = measure(pctB, fnt_pct)
    draw_lt(draw, (3 * W // 4 - tpB // 2, Y_PCT), pctB, fnt_pct, (255, 255, 255, 200))

    cursor_y = Y_LABEL - 30

    # CTA
    cta_y = min(cursor_y + 60, H - 220)
    draw_cta_button(draw, cta, cta_y)
    draw_url_footer(draw)
    return img


# ============================================================
# 15 ADS con HOOKS IRRESISTIBLES
# ============================================================

ADS = []

# === PREDICCIONES (5) ===
ADS.append(("pred-1-bignumber", render_billboard, dict(
    photo_name="trofeo.jpg",
    eyebrow="ACCESO GRATIS · 2 IAS",
    big_num="18.2%",
    hook="LA SELECCIÓN QUE NADIE TIENE EN SU QUINIELA",
    subtitle="La IA ya eligió campeón del Mundial. No es la que estás pensando.",
    cta="VER LA RESPUESTA",
    photo_crop="center"
)))

ADS.append(("pred-2-playerhero", render_billboard, dict(
    photo_name="mbappe.jpg",
    eyebrow="2 IAS · ACCESO GRATIS",
    hook="FRANCIA NO LEVANTA LA COPA",
    subtitle="16.5% según la IA. Hay otra que supera ese número con holgura.",
    cta="VER AL VERDADERO FAVORITO",
    photo_crop="face"
)))

ADS.append(("pred-3-versus", render_billboard_versus, dict(
    photo_name="trofeo.jpg",
    team_a="ESPAÑA", val_a=18.2, team_b="FRANCIA", val_b=16.5,
    eyebrow="DUELO IA",
    hook="EL MODELO TIENE UN FAVORITO CLARO",
    insight="+1.7pts de ventaja para ESPAÑA — pero no son las únicas en el top",
    cta="VER TOP 5"
)))

ADS.append(("pred-4-data", render_billboard_data, dict(
    eyebrow="ACCESO GRATIS · 2 IAS",
    hook="3 DEL TOP 5 NO SON EUROPEAS",
    rows=[
        ("España", 18.2, None),
        ("Francia", 16.5, None),
        ("Argentina", 12.4, None),
        ("Inglaterra", 11.8, None),
        ("Brasil", 10.1, None),
    ],
    cta="DESBLOQUEAR RANKING"
)))

ADS.append(("pred-5-hottake", render_billboard, dict(
    photo_name="trofeo.jpg",
    eyebrow="2 IAS · GRATIS",
    hook="EL CAMPEÓN QUE NO ESTÁ EN TU QUINIELA",
    subtitle="La IA detectó un dark horse con probabilidad mayor a la que te imaginás.",
    cta="ACCEDER GRATIS",
    photo_crop="center"
)))

# === CALENDARIO (5) ===
ADS.append(("cal-1-bignumber", render_billboard, dict(
    photo_name="azteca.jpg",
    eyebrow="ACCESO GRATIS · 2 IAS",
    big_num="104",
    hook="PARTIDOS LEÍDOS POR LA IA",
    subtitle="La misma IA que acertó 73% de Libertadores. Cada partido del Mundial, listado.",
    cta="VER CALENDARIO",
    photo_crop="center"
)))

ADS.append(("cal-2-playerhero", render_billboard, dict(
    photo_name="bellingham.jpg",
    eyebrow="2 IAS · ACCESO GRATIS",
    hook="EL PRIMER PARTIDO ES EL MÁS PREDECIBLE",
    subtitle="La IA tiene 64% de confianza en el opening del Mundial. ¿Conviene?",
    cta="VER MI PARTIDO",
    photo_crop="face"
)))

ADS.append(("cal-3-versus", render_billboard_versus, dict(
    photo_name="azteca.jpg",
    team_a="MÉXICO", val_a=42.1, team_b="ARG", val_b=31.4,
    eyebrow="APERTURA · 11 JUN · AZTECA",
    hook="EL PRIMER PARTIDO YA TIENE LECTURA",
    insight="México arrancan con +10.7pts de ventaja según la IA",
    cta="VER ANÁLISIS COMPLETO"
)))

ADS.append(("cal-4-data", render_billboard_data, dict(
    eyebrow="JUN 11-17 · 2 IAS",
    hook="LOS 5 PARTIDOS PARA MIRAR ESTA SEMANA",
    rows=[
        ("México vs ARG", 42, None),
        ("España vs CRO", 64, None),
        ("FRA vs Australia", 58, None),
        ("Inglaterra vs SUI", 47, None),
        ("Brasil vs Camerún", 71, None),
    ],
    cta="VER CALENDARIO COMPLETO"
)))

ADS.append(("cal-5-hottake", render_billboard, dict(
    photo_name="metlife.jpg",
    eyebrow="2 IAS · GRATIS",
    hook="16 BATACAZOS POSIBLES EN FASE DE GRUPOS",
    subtitle="La IA listó los partidos donde el favorito cae. ¿Vas a mirar igual?",
    cta="VER LOS 16",
    photo_crop="center"
)))

# === ESTADÍSTICAS (5) ===
ADS.append(("est-1-bignumber", render_billboard, dict(
    photo_name="trofeo.jpg",
    eyebrow="ACCESO GRATIS · 2 IAS",
    big_num="48",
    hook="SELECCIONES RANKEADAS",
    subtitle="El #8 del ranking IA es una sorpresa que no esperabas. Top 8 completo adentro.",
    cta="VER EL RANKING",
    photo_crop="center"
)))

ADS.append(("est-2-playerhero", render_billboard, dict(
    photo_name="haaland.jpg",
    eyebrow="2 IAS · ACCESO GRATIS",
    hook="NORUEGA ENTRA AL TOP 8 SEGÚN LA IA",
    subtitle="Haaland en su primer Mundial. La IA dice que va a romper sondeos.",
    cta="VER TOP 8",
    photo_crop="face"
)))

ADS.append(("est-3-versus", render_billboard_versus, dict(
    photo_name="trofeo.jpg",
    team_a="ESPAÑA", val_a=18.2, team_b="BRA", val_b=10.1,
    eyebrow="LA IA NO PIENSA COMO LAS CASAS",
    hook="BRASIL ESTÁ LEJOS DEL TOP",
    insight="Solo 10.1% según la IA — la mitad que España",
    cta="VER RANKING IA"
)))

ADS.append(("est-4-data", render_billboard_data, dict(
    eyebrow="ACCESO GRATIS · 2 IAS",
    hook="EL TOP 5 IA NO ES EL DE LAS CASAS",
    rows=[
        ("España", 18.2, None),
        ("Francia", 16.5, None),
        ("Argentina", 12.4, None),
        ("Inglaterra", 11.8, None),
        ("Brasil", 10.1, None),
    ],
    cta="DESBLOQUEAR RANKING"
)))

ADS.append(("est-5-hottake", render_billboard, dict(
    photo_name="mbappe.jpg",
    eyebrow="DARK HORSE · 2 IAS",
    hook="EL #9 DEL RANKING TE VA A SORPRENDER",
    subtitle="Una selección con 7.8% que el resto del mundo está subestimando.",
    cta="DESCUBRIR EL #9",
    photo_crop="face"
)))


# ============================================================
# EXECUTE
# ============================================================
import sys
count = 0
for name, fn, args in ADS:
    try:
        img = fn(**args)
        out = f"{OUT}/{name}.jpg"
        img.save(out, "JPEG", quality=88, optimize=True)
        count += 1
        print(f"OK {name}: {os.path.getsize(out)//1024}KB")
    except Exception as e:
        print(f"FAIL {name}: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
print(f"\nGenerado {count}/15 ads v4 BILLBOARD")

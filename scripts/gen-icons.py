"""Gera todos os ícones do telecord a partir de UMA arte (scripts/icon-source.jpg).

Uso, da raiz do repositório (precisa de Pillow: `pip install pillow`):

    python scripts/gen-icons.py

Sai daqui o favicon do site, o ícone do app instalado (Windows, macOS, Linux) e
o ícone da bandeja. Trocar a arte é trocar o .jpg e rodar de novo — nenhum
ícone é editado à mão.

## Por que três recortes, e não um só reduzido

A arte é um T de tubo de neon dentro de um anel. O tubo tem ~28 px num quadro
de 1024: reduzido direto para 16 px ele vira meio pixel e some no fundo. Então
o recorte acompanha o tamanho, como qualquer conjunto de ícones faz:

- até 24 px (bandeja, aba do navegador): só o T, que ainda se lê;
- de 32 a 64 px: o anel inteiro, cortado rente;
- acima disso: a arte inteira.

Os recortes pequenos também engrossam o tubo antes de reduzir (`thicken`),
pelo mesmo motivo.
"""

from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SOURCE = Image.open(ROOT / "scripts" / "icon-source.jpg").convert("RGB")

# Medido na arte: o anel tem centro em (507, 495) e raio ~394; o T ocupa
# x 312–708, y 309–747. Trocar a arte por outra com geometria diferente pede
# remedir estes dois quadros.
RING = (61, 49, 953, 941)
GLYPH = (238, 256, 782, 800)

# Canto arredondado do "azulejo". ~22% é o que os três sistemas usam hoje.
CORNER = 0.225


def crop_for(size: int) -> Image.Image:
    if size <= 24:
        return SOURCE.crop(GLYPH)
    if size <= 64:
        return SOURCE.crop(RING)
    return SOURCE


def thicken(image: Image.Image, size: int) -> Image.Image:
    """Engrossa o tubo para ele sobreviver à redução (ver o topo do arquivo)."""
    ratio = image.width / size
    if ratio < 6:
        return image
    kernel = max(3, int(ratio * 0.45) | 1)
    return image.filter(ImageFilter.MaxFilter(kernel))


def rounded_mask(size: int) -> Image.Image:
    # Desenhado em 4x e reduzido: o `rounded_rectangle` do Pillow não suaviza
    # a borda, e canto serrilhado em ícone de 16 px aparece.
    big = size * 4
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, big - 1, big - 1), radius=big * CORNER, fill=255)
    return mask.resize((size, size), Image.LANCZOS)


def tile(size: int, rounded: bool = True) -> Image.Image:
    """Um ícone quadrado de `size` px, com o recorte certo para o tamanho."""
    image = thicken(crop_for(size), size).resize((size, size), Image.LANCZOS).convert("RGBA")
    if rounded:
        image.putalpha(rounded_mask(size))
    return image


def padded(size: int, inner: float) -> Image.Image:
    """Azulejo com margem transparente — a grade de ícone do macOS pede ~80%."""
    body = round(size * inner)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    offset = (size - body) // 2
    # O recorte segue o tamanho do CORPO, que é o que de fato se vê.
    art = thicken(crop_for(body), body).resize((body, body), Image.LANCZOS).convert("RGBA")
    art.putalpha(rounded_mask(body))
    canvas.paste(art, (offset, offset), art)
    return canvas


def save_ico(path: Path, sizes: list[int]) -> None:
    images = [tile(size) for size in sizes]
    largest = images[-1]
    # BMP, e não PNG embutido: o NSIS (instalador do Windows) e leitores
    # antigos de .ico tropeçam em entrada PNG menor que 256 px.
    largest.save(
        path,
        format="ICO",
        sizes=[(s, s) for s in sizes],
        append_images=images[:-1],
        bitmap_format="bmp",
    )


def main() -> None:
    web = ROOT / "apps" / "web" / "public"
    build = ROOT / "desktop" / "build"
    assets = ROOT / "desktop" / "assets"
    for folder in (web, build, assets):
        folder.mkdir(parents=True, exist_ok=True)

    # --- site ---------------------------------------------------------------
    save_ico(web / "favicon.ico", [16, 32, 48])
    tile(192).save(web / "icon-192.png")
    # iOS arredonda sozinho e pinta de preto o que vier transparente: aqui o
    # quadrado vai inteiro e opaco.
    tile(180, rounded=False).convert("RGB").save(web / "apple-touch-icon.png")

    # --- app instalado (lido pelo electron-builder, não vai no pacote) -------
    save_ico(build / "icon.ico", [16, 24, 32, 48, 64, 128, 256])
    tile(1024).save(build / "icon.png")
    mac = padded(1024, 0.805)
    mac.save(
        build / "icon.icns",
        format="ICNS",
        append_images=[padded(size, 0.805) for size in (16, 32, 64, 128, 256, 512)],
    )

    # --- em execução (vai no pacote: bandeja e ícone da janela) --------------
    save_ico(assets / "tray.ico", [16, 20, 24, 32, 48])
    tile(16).save(assets / "tray.png")
    tile(32).save(assets / "tray@2x.png")
    tile(512).save(assets / "icon.png")

    for folder in (web, build, assets):
        for file in sorted(folder.iterdir()):
            if file.suffix in {".ico", ".png", ".icns"}:
                print(f"{file.relative_to(ROOT)}  {file.stat().st_size} bytes")


if __name__ == "__main__":
    main()

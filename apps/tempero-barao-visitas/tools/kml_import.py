#!/usr/bin/env python3
"""Converte um KML/KMZ (Google Earth, Google My Maps) no formato de importar_estabelecimentos().

Só biblioteca padrão. Uso:

    python3 -I tools/kml_import.py arquivo.kmz --formato sql  --saida importar.sql
    python3 -I tools/kml_import.py arquivo.kml --formato json --saida importar.json

O modo `sql` gera um `select importar_estabelecimentos(...)` pronto para colar no SQL Editor
do Supabase (ou rodar com psql). É idempotente: reimportar atualiza nome/endereço/localização
e NÃO sobrescreve status, tier, carteira nem segmento.

Mapeamento:
  Placemark com Point     -> estabelecimento (nome, lat, lng)
  Pasta (Folder)          -> grupo_origem ("A / B") e categoria (última pasta)
  Placemark com Polygon   -> região; pontos dentro dela recebem essa região (a menor, se houver várias)
  ExtendedData/description-> telefone, endereço, bairro, cidade, UF quando houver; resto em atributos
  LineString / sem coord. -> ignorados (contados no resumo)
"""
import argparse
import hashlib
import html
import json
import re
import sys
import unicodedata
import zipfile
import xml.etree.ElementTree as ET

LIMITE_BYTES = 100 * 1024 * 1024  # trava contra arquivo/zip gigante

CHAVES_CAMPOS = {
    "telefone": {"telefone", "fone", "phone", "celular", "whatsapp", "tel"},
    "endereco": {"endereco", "address", "logradouro", "rua"},
    "bairro": {"bairro", "neighborhood"},
    "cidade": {"cidade", "city", "municipio"},
    "uf": {"uf", "estado", "state"},
}


def local(tag):
    return tag.rsplit("}", 1)[-1]


def sem_acento(s):
    return "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c))


def normaliza(s):
    return re.sub(r"\s+", " ", sem_acento(s).lower()).strip()


def texto_limpo(s):
    if not s:
        return ""
    s = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</li>", "\n", s)
    s = re.sub(r"<[^>]+>", "", s)
    s = html.unescape(s)
    return "\n".join(l.strip() for l in s.splitlines() if l.strip())


def chave_externa(nome, lat, lng):
    base = f"{normaliza(nome)}|{lat:.5f}|{lng:.5f}"
    return "kml:" + hashlib.sha1(base.encode("utf-8")).hexdigest()[:16]


def ler_bytes(caminho):
    if zipfile.is_zipfile(caminho):
        with zipfile.ZipFile(caminho) as z:
            kmls = [i for i in z.infolist() if i.filename.lower().endswith(".kml")]
            if not kmls:
                raise ValueError("KMZ sem arquivo .kml dentro")
            info = next((i for i in kmls if i.filename.lower().endswith("doc.kml")), kmls[0])
            if info.file_size > LIMITE_BYTES:
                raise ValueError("KML dentro do KMZ é grande demais")
            return z.read(info)
    with open(caminho, "rb") as f:
        dados = f.read(LIMITE_BYTES + 1)
    if len(dados) > LIMITE_BYTES:
        raise ValueError("Arquivo grande demais")
    return dados


def parse_coords(texto):
    """'lng,lat[,alt] lng,lat ...' -> [(lng, lat), ...] (KML usa longitude primeiro)."""
    pontos = []
    for trecho in (texto or "").split():
        partes = trecho.split(",")
        if len(partes) >= 2:
            try:
                pontos.append((float(partes[0]), float(partes[1])))
            except ValueError:
                pass
    return pontos


def coord_valida(lng, lat):
    return -180 <= lng <= 180 and -90 <= lat <= 90


def ponto_no_anel(lng, lat, anel):
    dentro = False
    j = len(anel) - 1
    for i in range(len(anel)):
        xi, yi = anel[i]
        xj, yj = anel[j]
        if (yi > lat) != (yj > lat) and lng < (xj - xi) * (lat - yi) / (yj - yi) + xi:
            dentro = not dentro
        j = i
    return dentro


def area_anel(anel):
    s = 0.0
    for i in range(len(anel)):
        x1, y1 = anel[i]
        x2, y2 = anel[(i + 1) % len(anel)]
        s += x1 * y2 - x2 * y1
    return abs(s) / 2


def filhos(el, nome):
    return [c for c in el if local(c.tag) == nome]


def dados_estendidos(pm):
    saida = {}
    for ed in filhos(pm, "ExtendedData"):
        for d in ed.iter():
            tag = local(d.tag)
            if tag == "Data":
                v = next((c.text for c in d if local(c.tag) == "value"), None)
                if d.get("name") and v and v.strip():
                    saida[d.get("name").strip()] = v.strip()
            elif tag == "SimpleData" and d.get("name") and d.text and d.text.strip():
                saida[d.get("name").strip()] = d.text.strip()
    return saida


def percorrer(el, pasta, placemarks):
    for c in el:
        t = local(c.tag)
        if t in ("Document", "Folder"):
            nome = next((x.text.strip() for x in filhos(c, "name") if x.text), None)
            # a raiz <Document> não conta como pasta
            percorrer(c, pasta + ([nome] if nome and t == "Folder" else []), placemarks)
        elif t == "Placemark":
            placemarks.append((pasta, c))


def converter(dados):
    cabeca = dados[:4096].lower()
    if b"<!doctype" in cabeca or b"<!entity" in cabeca:
        raise ValueError("KML com DOCTYPE/ENTITY recusado por segurança")
    raiz = ET.fromstring(dados)

    placemarks = []
    percorrer(raiz, [], placemarks)

    resumo = dict(placemarks=len(placemarks), pontos_validos=0, duplicados_no_arquivo=0,
                  linhas_ignoradas=0, sem_geometria=0, coordenadas_invalidas=0,
                  regioes=0, com_regiao=0)
    itens, regioes, vistos = [], [], set()

    for pasta, pm in placemarks:
        nome = next((x.text.strip() for x in filhos(pm, "name") if x.text and x.text.strip()), None)
        geoms = [g for g in pm.iter() if local(g.tag) in ("Point", "Polygon", "LineString")]
        if not geoms:
            resumo["sem_geometria"] += 1
            continue
        g = geoms[0]
        tipo = local(g.tag)

        if tipo == "LineString":
            resumo["linhas_ignoradas"] += 1
            continue

        if tipo == "Polygon":
            anel = []
            for ob in g.iter():
                if local(ob.tag) == "outerBoundaryIs":
                    for cc in ob.iter():
                        if local(cc.tag) == "coordinates":
                            anel = parse_coords(cc.text)
                            break
            if len(anel) >= 3:
                regioes.append({"nome": nome or f"Região sem nome {len(regioes) + 1}", "poligono": anel})
            continue

        # Point
        coords = next((parse_coords(c.text) for c in g.iter() if local(c.tag) == "coordinates"), [])
        if not coords:
            resumo["sem_geometria"] += 1
            continue
        lng, lat = coords[0]
        if not coord_valida(lng, lat):
            resumo["coordenadas_invalidas"] += 1
            continue
        if not nome:
            nome = f"Sem nome ({lat:.5f}, {lng:.5f})"

        chave = chave_externa(nome, lat, lng)
        if chave in vistos:
            resumo["duplicados_no_arquivo"] += 1
            continue
        vistos.add(chave)

        item = {"chave_externa": chave, "nome": nome, "lat": lat, "lng": lng,
                "endereco": None, "bairro": None, "cidade": None, "uf": None, "telefone": None,
                "categoria": pasta[-1] if pasta else None,
                "grupo_origem": " / ".join(pasta) if pasta else None,
                "regiao": None, "atributos": {}}

        extras = dados_estendidos(pm)
        desc = texto_limpo(next((x.text for x in filhos(pm, "description")), ""))
        for k, v in extras.items():
            campo = next((c for c, apelidos in CHAVES_CAMPOS.items() if normaliza(k) in apelidos), None)
            if campo and not item[campo]:
                item[campo] = v
            else:
                item["atributos"][k] = v
        if desc:
            item["atributos"]["descricao"] = desc
        itens.append(item)

    # região: o ponto recebe a MENOR região que o contém
    regioes_ord = sorted(regioes, key=lambda r: area_anel(r["poligono"]))
    for item in itens:
        for r in regioes_ord:
            if ponto_no_anel(item["lng"], item["lat"], r["poligono"]):
                item["regiao"] = r["nome"]
                resumo["com_regiao"] += 1
                break

    resumo["pontos_validos"] = len(itens)
    resumo["regioes"] = len(regioes)
    return {"resumo": resumo, "itens": itens, "regioes": regioes}


def gerar_sql(resultado):
    itens = json.dumps(resultado["itens"], ensure_ascii=False)
    regioes = json.dumps(resultado["regioes"], ensure_ascii=False)
    n = 0
    while True:
        tag = f"$kml{hashlib.sha1((itens + regioes + str(n)).encode()).hexdigest()[:8]}$"
        if tag not in itens and tag not in regioes:
            break
        n += 1
    return f"select importar_estabelecimentos({tag}{itens}{tag}::jsonb, {tag}{regioes}{tag}::jsonb);\n"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("arquivo", help="KML ou KMZ exportado do Google Earth / My Maps")
    ap.add_argument("--formato", choices=["json", "sql"], default="sql")
    ap.add_argument("--saida", help="arquivo de saída (padrão: stdout)")
    args = ap.parse_args(argv)

    try:
        resultado = converter(ler_bytes(args.arquivo))
    except (ValueError, ET.ParseError, zipfile.BadZipFile, OSError) as e:
        print(f"Erro: {e}", file=sys.stderr)
        return 1

    conteudo = (gerar_sql(resultado) if args.formato == "sql"
                else json.dumps(resultado, ensure_ascii=False, indent=2) + "\n")
    if args.saida:
        with open(args.saida, "w", encoding="utf-8") as f:
            f.write(conteudo)
    else:
        sys.stdout.write(conteudo)

    r = resultado["resumo"]
    print("Resumo: " + ", ".join(f"{k}={v}" for k, v in r.items()), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())

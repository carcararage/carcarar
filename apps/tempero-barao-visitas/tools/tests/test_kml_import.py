"""Testes do importador KML. Rodar:  python3 -I tools/tests/test_kml_import.py"""
import importlib.util
import json
import os
import re
import tempfile
import unittest
import zipfile

AQUI = os.path.dirname(os.path.abspath(__file__))
FIXTURE = os.path.join(AQUI, "fixtures", "exemplo.kml")

spec = importlib.util.spec_from_file_location("kml_import", os.path.join(AQUI, "..", "kml_import.py"))
kml = importlib.util.module_from_spec(spec)
spec.loader.exec_module(kml)


def converter_fixture():
    return kml.converter(kml.ler_bytes(FIXTURE))


class ResumoTest(unittest.TestCase):
    def test_contagens(self):
        r = converter_fixture()["resumo"]
        self.assertEqual(r["pontos_validos"], 5)
        self.assertEqual(r["duplicados_no_arquivo"], 2, "idêntico + variação de acento/caixa")
        self.assertEqual(r["linhas_ignoradas"], 1)
        self.assertEqual(r["sem_geometria"], 1)
        self.assertEqual(r["coordenadas_invalidas"], 1)
        self.assertEqual(r["regioes"], 1)
        self.assertEqual(r["com_regiao"], 4)


class CamposTest(unittest.TestCase):
    def setUp(self):
        self.por_nome = {i["nome"]: i for i in converter_fixture()["itens"]}

    def test_ordem_das_coordenadas(self):
        i = self.por_nome["Restaurante Exemplo 1"]
        self.assertAlmostEqual(i["lat"], -2.9050)   # KML guarda lng,lat — não pode inverter
        self.assertAlmostEqual(i["lng"], -41.7760)

    def test_pastas(self):
        i = self.por_nome["Restaurante Exemplo 1"]
        self.assertEqual(i["categoria"], "Restaurantes")
        self.assertEqual(i["grupo_origem"], "Parnaíba / Restaurantes")
        self.assertIsNone(self.por_nome["Lanchonete Sem Pasta"]["categoria"])

    def test_extended_data_mapeia_campos_e_guarda_o_resto(self):
        i = self.por_nome["Restaurante Exemplo 2"]
        self.assertEqual(i["telefone"], "86 90000-0002")
        self.assertEqual(i["endereco"], "Av. Fictícia, 200")
        self.assertEqual(i["bairro"], "Centro")
        self.assertEqual(i["atributos"], {"Obs": "Fecha às segundas"})

    def test_descricao_html_vira_texto(self):
        d = self.por_nome["Restaurante Exemplo 1"]["atributos"]["descricao"]
        self.assertNotIn("<", d)
        self.assertIn("Fone: (86) 90000-0001", d)
        self.assertIn("Rua Fictícia, 100", d)

    def test_regiao(self):
        self.assertEqual(self.por_nome["Restaurante Exemplo 1"]["regiao"], "Região Centro")
        self.assertIsNone(self.por_nome["Mercado Distante"]["regiao"])

    def test_chave_estavel_e_insensivel_a_acento_e_caixa(self):
        a = kml.chave_externa("Mercadinho São José", -2.915, -41.775)
        b = kml.chave_externa("  MERCADINHO   sao jose ", -2.915, -41.775)
        self.assertEqual(a, b)
        self.assertNotEqual(a, kml.chave_externa("Mercadinho São José", -2.916, -41.775))
        again = {i["chave_externa"] for i in converter_fixture()["itens"]}
        self.assertEqual(again, {i["chave_externa"] for i in self.por_nome.values()})


class GeometriaTest(unittest.TestCase):
    def test_menor_regiao_vence(self):
        grande = {"nome": "Grande", "poligono": [(0, 0), (10, 0), (10, 10), (0, 10)]}
        pequena = {"nome": "Pequena", "poligono": [(4, 4), (6, 4), (6, 6), (4, 6)]}
        kmlxml = (
            '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>'
            + "".join(
                f"<Placemark><name>{r['nome']}</name><Polygon><outerBoundaryIs><LinearRing><coordinates>"
                + " ".join(f"{x},{y},0" for x, y in r["poligono"])
                + "</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>"
                for r in (grande, pequena)
            )
            + "<Placemark><name>P</name><Point><coordinates>5,5,0</coordinates></Point></Placemark>"
            "</Document></kml>"
        )
        res = kml.converter(kmlxml.encode())
        self.assertEqual(res["itens"][0]["regiao"], "Pequena")


class ArquivoTest(unittest.TestCase):
    def test_kmz(self):
        with tempfile.TemporaryDirectory() as d:
            kmz = os.path.join(d, "mapa.kmz")
            with zipfile.ZipFile(kmz, "w") as z:
                z.write(FIXTURE, "doc.kml")
                z.writestr("images/icone.png", b"\x89PNG")
            r = kml.converter(kml.ler_bytes(kmz))
            self.assertEqual(r["resumo"]["pontos_validos"], 5)

    def test_recusa_doctype(self):
        malicioso = b'<?xml version="1.0"?><!DOCTYPE kml [<!ENTITY a "x">]><kml/>'
        with self.assertRaises(ValueError):
            kml.converter(malicioso)

    def test_kmz_sem_kml(self):
        with tempfile.TemporaryDirectory() as d:
            kmz = os.path.join(d, "vazio.kmz")
            with zipfile.ZipFile(kmz, "w") as z:
                z.writestr("leia.txt", "nada")
            with self.assertRaises(ValueError):
                kml.ler_bytes(kmz)


class SaidaTest(unittest.TestCase):
    def test_sql_tem_json_valido_e_tag_segura(self):
        sql = kml.gerar_sql(converter_fixture())
        m = re.match(r"select importar_estabelecimentos\((\$kml[0-9a-f]{8}\$)(.*)\1::jsonb, \1(.*)\1::jsonb\);\n$",
                     sql, re.S)
        self.assertIsNotNone(m)
        self.assertEqual(len(json.loads(m.group(2))), 5)
        self.assertEqual(len(json.loads(m.group(3))), 1)

    def test_aspas_e_cifrao_no_nome_nao_quebram_o_sql(self):
        xml = ('<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark>'
               "<name>Bar do Zé's $kml00000000$ \"top\"</name>"
               "<Point><coordinates>-41.7,-2.9,0</coordinates></Point></Placemark></Document></kml>")
        sql = kml.gerar_sql(kml.converter(xml.encode()))
        tag = re.match(r"select importar_estabelecimentos\((\$kml[0-9a-f]{8}\$)", sql).group(1)
        self.assertEqual(sql.count(tag), 4)


if __name__ == "__main__":
    unittest.main(verbosity=1)

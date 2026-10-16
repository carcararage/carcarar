import { unzipSync } from 'fflate';

const LIMITE = 100 * 1024 * 1024; // trava contra arquivo/zip gigante

/** Aceita .kml ou .kmz (zip) e devolve o texto do KML. */
export function lerKmlDeBytes(bytes: Uint8Array): string {
  if (bytes.length > LIMITE) throw new Error('Arquivo grande demais');
  const ehZip = bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  let kml = bytes;
  if (ehZip) {
    const arquivos = unzipSync(bytes, {
      // só descompacta .kml e respeita o limite informado no cabeçalho do zip
      filter: (f) => f.name.toLowerCase().endsWith('.kml') && f.originalSize <= LIMITE,
    });
    const nomes = Object.keys(arquivos);
    if (!nomes.length) throw new Error('KMZ sem arquivo .kml dentro');
    const nome = nomes.find((n) => n.toLowerCase().endsWith('doc.kml')) ?? nomes[0];
    kml = arquivos[nome];
  }
  return new TextDecoder('utf-8').decode(kml);
}

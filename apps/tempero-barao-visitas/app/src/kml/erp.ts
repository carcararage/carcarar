/**
 * Lê o bloco de texto do cadastro do ERP que vem na descrição de cada ponto do mapa, p.ex.:
 *
 *   MARIA SOUZA LTDA 101679 Fantasia: CHALANA
 *   Endereço: AV X, Nº 188 Bairro: CENTRO
 *   Cidade: Parnaíba UF: PI CEP: 64.200-040 Telefone: (86) 3322-2825
 *   Região: Contato: Celular: ...
 *
 * O export tem ~20 variações de ordem dos rótulos (e às vezes a cidade cai no fim do bairro),
 * então não dá para usar posição: quebramos por rótulo.
 *
 * LGPD / minimização: CPF, RG/IE, limite de crédito e e-mail são DESCARTADOS aqui.
 */

const ROTULOS =
  'Endereço|Bairro|Cidade|UF|CEP|Telefone|Região|Contato|Celular|Classe|Email|CPF\\/CNPJ|RG\\/IE|Responsável|Limite|Observações|Fantasia|Apelido';
const RE_ROTULO = new RegExp(`(?:^|[\\s])(${ROTULOS})\\s*:`, 'g');

const RE_CNPJ = /\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/;
const RE_CPF = /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g;
const RE_NUM_LONGO = /\b\d{9,13}\b/g; // CPF sem pontuação, RG, etc.

export interface DadosErp {
  codigo?: string;
  razaoSocial?: string;
  fantasia?: string;
  endereco?: string;
  bairro?: string;
  cidade?: string;
  uf?: string;
  cep?: string;
  telefone?: string;
  celular?: string;
  contato?: string;
  cnpj?: string;
  observacoes?: string;
  /** havia rótulos do ERP no texto? (senão é texto livre) */
  estruturado: boolean;
}

/** Remove CPF/RG/números longos de um texto livre. */
export function redigir(texto: string): string {
  return texto.replace(RE_CPF, '[CPF omitido]').replace(RE_NUM_LONGO, '[nº omitido]');
}

export function textoLimpo(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

const vazioParaUndef = (s: string | undefined) => {
  const t = s?.replace(/\s+/g, ' ').trim();
  return t ? t : undefined;
};

export function parseDescricaoErp(textoBruto: string): DadosErp {
  const texto = textoLimpo(textoBruto);
  const marcas = [...texto.matchAll(RE_ROTULO)];
  if (marcas.length < 2) return { estruturado: false };

  // cabeça: tudo antes do primeiro rótulo ("RAZÃO SOCIAL CÓDIGO", às vezes com notas acima)
  const cabeca = texto.slice(0, marcas[0].index!);

  const valores = new Map<string, string>();
  marcas.forEach((m, i) => {
    const ini = m.index! + m[0].length;
    const fim = i + 1 < marcas.length ? marcas[i + 1].index! : texto.length;
    const rot = m[1];
    if (!valores.has(rot)) valores.set(rot, texto.slice(ini, fim).trim());
  });

  const out: DadosErp = { estruturado: true };

  // --- cabeça: [notas...] RAZÃO SOCIAL CÓDIGO
  const linhasCabeca = cabeca.split('\n').map((l) => l.trim()).filter(Boolean);
  const idx = linhasCabeca.findIndex((l) => /(?<![\d.\-/])\d{6}(?![\d.\-/])/.test(l));
  const notas: string[] = [];
  if (idx >= 0) {
    const linha = linhasCabeca[idx];
    const m = linha.match(/(?<![\d.\-/])(\d{6})(?![\d.\-/])/)!;
    out.codigo = m[1];
    let razao = linha.slice(0, m.index!).replace(RE_NUM_LONGO, '').trim();
    razao = razao.replace(/^[\d.\-/\s]+(?=[A-Za-zÀ-ú])/, '').trim(); // "26.314.597 FULANO" -> "FULANO"
    out.razaoSocial = vazioParaUndef(razao);
    notas.push(...linhasCabeca.slice(0, idx));
  } else if (linhasCabeca.length) {
    out.razaoSocial = vazioParaUndef(linhasCabeca[linhasCabeca.length - 1].replace(RE_NUM_LONGO, ''));
    notas.push(...linhasCabeca.slice(0, -1));
  }

  // --- campos rotulados
  const v = (r: string) => valores.get(r);
  out.fantasia = vazioParaUndef(v('Fantasia')) ?? vazioParaUndef(v('Apelido'));

  const endereco = v('Endereço');
  if (endereco) out.endereco = vazioParaUndef(endereco.split('\n')[0]);

  let bairro = v('Bairro');
  let cidade = vazioParaUndef(v('Cidade')?.split('\n')[0]);
  if (bairro) {
    const partes = bairro.split('\n').map((p) => p.trim()).filter(Boolean);
    bairro = partes[0];
    // quando "Cidade:" vem vazia, o nome da cidade cai na linha seguinte ao bairro
    if (!cidade && partes.length > 1) cidade = partes[partes.length - 1];
  }
  out.bairro = vazioParaUndef(bairro);
  out.cidade = cidade;

  const uf = v('UF')?.match(/\b[A-Z]{2}\b/);
  out.uf = uf?.[0];
  out.cep = v('CEP')?.match(/\d{2}\.?\d{3}-?\d{3}/)?.[0];
  out.telefone = telefoneValido(v('Telefone'));
  out.celular = telefoneValido(v('Celular'));
  out.contato = vazioParaUndef(v('Contato'));

  // CNPJ: em alguns layouts aparece solto numa linha do endereço, em outros em "CPF/CNPJ:"
  out.cnpj = texto.match(RE_CNPJ)?.[0];

  const obs = [...notas, vazioParaUndef(v('Observações'))].filter(Boolean).join(' · ');
  out.observacoes = obs ? redigir(obs) : undefined;

  return out;
}

export function telefoneValido(s: string | undefined): string | undefined {
  const t = vazioParaUndef(s?.split('\n')[0]);
  if (!t) return undefined;
  const digitos = t.replace(/\D/g, '');
  return digitos.length >= 8 && digitos.length <= 13 ? t : undefined;
}

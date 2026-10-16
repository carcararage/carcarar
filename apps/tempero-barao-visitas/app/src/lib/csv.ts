/** CSV pensado para abrir direto no Excel brasileiro: ponto e vírgula, aspas e BOM UTF-8. */
export type Celula = string | number | null | undefined | Date;

const fmt = (c: Celula): string => {
  if (c == null) return '';
  const t = c instanceof Date ? c.toISOString() : String(c);
  return /[";\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

export const paraCsv = (linhas: Celula[][]): string => '﻿' + linhas.map((l) => l.map(fmt).join(';')).join('\r\n') + '\r\n';

export function baixar(nomeArquivo: string, conteudo: string, tipo = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([conteudo], { type: tipo }));
  const a = document.createElement('a');
  a.href = url;
  a.download = nomeArquivo;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const nomeSeguro = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 40) || 'arquivo';

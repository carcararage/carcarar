/** Leitor de CSV tolerante: detecta ; , ou tab, aceita aspas e quebra de linha dentro de aspas. */
export function lerCsv(texto: string): string[][] {
  const t = texto.replace(/^﻿/, '');
  const primeira = t.split(/\r?\n/, 1)[0] ?? '';
  const sep = [';', '\t', ','].map((s) => [s, primeira.split(s).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const linhas: string[][] = [];
  let linha: string[] = [];
  let campo = '';
  let aspas = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (aspas) {
      if (c === '"' && t[i + 1] === '"') { campo += '"'; i++; }
      else if (c === '"') aspas = false;
      else campo += c;
    } else if (c === '"') aspas = true;
    else if (c === sep) { linha.push(campo); campo = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i++;
      linha.push(campo); campo = '';
      linhas.push(linha); linha = [];
    } else campo += c;
  }
  if (campo || linha.length) { linha.push(campo); linhas.push(linha); }
  return linhas;
}

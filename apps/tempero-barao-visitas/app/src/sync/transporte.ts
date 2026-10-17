/**
 * Canal com o servidor. Só duas coisas importam para o resto do app: "falhou por falta de rede"
 * (a ação continua na fila) e "o servidor recusou" (a ação sai da fila com o motivo).
 */
export class ErroRede extends Error {
  constructor(msg = 'Sem conexão com o servidor') {
    super(msg);
    this.name = 'ErroRede';
  }
}

export class ErroAuth extends Error {
  constructor(msg = 'Sessão expirada: entre de novo') {
    super(msg);
    this.name = 'ErroAuth';
  }
}

export class ErroServidor extends Error {
  code: string | null;
  constructor(msg: string, code: string | null = null) {
    super(msg);
    this.name = 'ErroServidor';
    this.code = code;
  }
}

export interface Transporte {
  /** Chama uma função (RPC) do Postgres com argumentos nomeados. */
  rpc<T>(nome: string, args?: Record<string, unknown>): Promise<T>;
}

let atual: Transporte | null = null;
export const definirTransporte = (t: Transporte | null) => {
  atual = t;
};
export const transporteAtual = () => atual;

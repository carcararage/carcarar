// As MESMAS migrações que vão para o Supabase, importadas como texto.
// O stub imita o que o Supabase já entrega (papéis, auth.uid()); no Supabase real ele não é usado.
import stub from '../../../supabase/local/stub_supabase.sql?raw';
import m0001 from '../../../supabase/migrations/0001_base.sql?raw';
import m0002 from '../../../supabase/migrations/0002_importacao_erp.sql?raw';
import m0003 from '../../../supabase/migrations/0003_inicio_da_cadencia.sql?raw';
import m0004 from '../../../supabase/migrations/0004_cadastro_e_visibilidade.sql?raw';
import m0005 from '../../../supabase/migrations/0005_importacao_de_planilha.sql?raw';
import m0006 from '../../../supabase/migrations/0006_planilha_casa_com_mapa.sql?raw';

export const MIGRACOES: { nome: string; sql: string }[] = [
  { nome: '0001_base', sql: m0001 },
  { nome: '0002_importacao_erp', sql: m0002 },
  { nome: '0003_inicio_da_cadencia', sql: m0003 },
  { nome: '0004_cadastro_e_visibilidade', sql: m0004 },
  { nome: '0005_importacao_de_planilha', sql: m0005 },
  { nome: '0006_planilha_casa_com_mapa', sql: m0006 },
];

export const STUB_SUPABASE = stub;

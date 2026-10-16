import contorno from '../brand/logo-contorno.webp';
import vermelho from '../brand/logo-vermelho.webp';

/** Logo oficial. Versão vermelha no tema claro; versão com contorno no tema escuro (troca por CSS). */
export function Logo({ className = 'logo' }: { className?: string }) {
  const alt = 'Temperos Barão — a sua melhor opção';
  return (
    <>
      <img className={`${className} logo-claro`} src={vermelho} alt={alt} width={1200} height={446} />
      <img className={`${className} logo-escuro`} src={contorno} alt={alt} width={1200} height={446} />
    </>
  );
}

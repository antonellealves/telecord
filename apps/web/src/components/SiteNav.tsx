import { NavLink } from 'react-router-dom';
import styles from './SiteNav.module.css';

const LINKS: { to: string; label: string; end?: boolean }[] = [
  { to: '/', label: 'início', end: true },
  { to: '/arquitetura', label: 'arquitetura' },
  { to: '/download', label: 'download' },
];

/**
 * O menu do site: os três lugares para onde dá para ir sem estar numa sala.
 *
 * Discreto de propósito — quem chega quer criar uma sala, e o menu não pode
 * disputar atenção com isso. Mas os três links ficam SEMPRE à vista, sem
 * botão de abrir: antes a página de arquitetura só era alcançada por um link
 * apagado no rodapé, e o instalador do app só existia no README.
 *
 * Fica fora das salas. Lá dentro a tela inteira é da conversa.
 */
export function SiteNav(): JSX.Element {
  return (
    <nav className={styles.nav} aria-label="Navegação do site">
      {LINKS.map((link) => (
        <NavLink
          key={link.to}
          to={link.to}
          end={link.end}
          className={({ isActive }) => `${styles.link} ${isActive ? styles.active : ''}`}
        >
          {link.label}
        </NavLink>
      ))}
    </nav>
  );
}

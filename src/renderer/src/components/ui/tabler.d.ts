/** Deep imports of single Tabler icon modules (see icons.ts) ship without per-file typings. */
declare module '@tabler/icons-react/dist/esm/icons/*.mjs' {
  import type { ForwardRefExoticComponent, RefAttributes, SVGProps } from 'react';
  interface IconProps extends Partial<Omit<SVGProps<SVGSVGElement>, 'ref'>> {
    size?: string | number;
    stroke?: string | number;
    title?: string;
  }
  const Icon: ForwardRefExoticComponent<IconProps & RefAttributes<SVGSVGElement>>;
  export default Icon;
}
